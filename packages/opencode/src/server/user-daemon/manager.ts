import fs from "fs"
import path from "path"
import { spawn } from "child_process"
import { request as httpRequest } from "node:http"
import { LinuxUserExec } from "@/system/linux-user-exec"
import { Log } from "@/util/log"

type DaemonStatus = "planned" | "starting" | "ready" | "missing"

export type DaemonSnapshot = {
  username: string
  uid: number
  port: number
  socketPath: string
  status: DaemonStatus
  firstSeenAt: number
  lastSeenAt: number
  lastStartAttemptAt?: number
  startAttempts: number
  lastStartError?: string
}

type DaemonEntry = DaemonSnapshot

type DaemonCallResult<T> =
  | { ok: true; data: T }
  | {
      ok: false
      error: {
        code: string
        message: string
      }
    }

export namespace UserDaemonManager {
  const log = Log.create({ service: "server.user-daemon" })
  const daemons = new Map<string, DaemonEntry>()
  const startInFlight = new Set<string>()
  let modeLogged = false

  function lazyStartEnabled() {
    return process.env.OPENCODE_PER_USER_DAEMON_LAZY_START !== "0"
  }

  function startCooldownMs() {
    const raw = Number(process.env.OPENCODE_PER_USER_DAEMON_START_COOLDOWN_MS ?? "30000")
    if (!Number.isFinite(raw) || raw < 0) return 30000
    return raw
  }

  function serviceUnitName() {
    return process.env.OPENCODE_PER_USER_DAEMON_SYSTEMD_UNIT || "opencode-user-daemon@.service"
  }

  function serviceUnitNameFor(username: string) {
    const pattern = serviceUnitName()
    if (pattern.includes("@.service")) return pattern.replace("@.service", `@${username}.service`)
    if (pattern.includes("%u")) return pattern.replaceAll("%u", username)
    return pattern
  }

  function daemonPortFor(uid: number) {
    const baseRaw = Number(process.env.OPENCODE_PER_USER_DAEMON_PORT_BASE ?? "41000")
    const spanRaw = Number(process.env.OPENCODE_PER_USER_DAEMON_PORT_SPAN ?? "20000")
    const base = Number.isFinite(baseRaw) ? baseRaw : 41000
    const span = Number.isFinite(spanRaw) && spanRaw > 0 ? spanRaw : 20000
    return base + (uid % span)
  }

  export function enabled() {
    return process.env.OPENCODE_PER_USER_DAEMON_EXPERIMENTAL === "1"
  }

  export function routeConfigEnabled() {
    return enabled() && process.env.OPENCODE_PER_USER_DAEMON_ROUTE_CONFIG === "1"
  }

  export function routeAccountListEnabled() {
    return enabled() && process.env.OPENCODE_PER_USER_DAEMON_ROUTE_ACCOUNT_LIST === "1"
  }

  export function routeAccountMutationEnabled() {
    return enabled() && process.env.OPENCODE_PER_USER_DAEMON_ROUTE_ACCOUNT_MUTATION === "1"
  }

  export function routeSessionListEnabled() {
    return enabled() && process.env.OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_LIST === "1"
  }

  export function routeSessionStatusEnabled() {
    return enabled() && process.env.OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_STATUS === "1"
  }

  export function routeSessionReadEnabled() {
    return enabled() && process.env.OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_READ === "1"
  }

  export function routeSessionTopEnabled() {
    return enabled() && process.env.OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_TOP === "1"
  }

  export function routeModelPreferencesEnabled() {
    return enabled() && process.env.OPENCODE_PER_USER_DAEMON_ROUTE_MODEL_PREFERENCES === "1"
  }

  export function routeSessionMutationEnabled() {
    return enabled() && process.env.OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_MUTATION === "1"
  }

  export function logRuntimeModeOnce() {
    if (modeLogged) return
    modeLogged = true
    if (enabled()) {
      log.warn("per-user daemon experimental mode enabled")
    }
  }

  function socketPathFor(uid: number) {
    return path.join("/run/user", String(uid), "opencode.sock")
  }

  export function observe(username: string | undefined) {
    if (!enabled()) return
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) return
    const uid = LinuxUserExec.resolveLinuxUserUID(safe)
    if (uid === undefined) return

    const now = Date.now()
    const socketPath = socketPathFor(uid)
    const port = daemonPortFor(uid)
    const status: DaemonStatus = "planned"
    const existing = daemons.get(safe)

    if (existing) {
      existing.lastSeenAt = now
      existing.socketPath = socketPath
      existing.port = port
      if (existing.status !== "ready") maybeTriggerLazyStart(existing)
      return
    }

    const entry: DaemonEntry = {
      username: safe,
      uid,
      port,
      socketPath,
      status,
      firstSeenAt: now,
      lastSeenAt: now,
      startAttempts: 0,
    }
    daemons.set(safe, entry)

    log.info("per-user daemon observed", {
      username: safe,
      uid,
      port,
      socketPath,
    })
    maybeTriggerLazyStart(entry)
  }

  function maybeTriggerLazyStart(entry: DaemonEntry) {
    if (!lazyStartEnabled()) return
    const key = `${entry.username}:${entry.uid}`
    if (startInFlight.has(key)) return
    const now = Date.now()
    const cooldown = startCooldownMs()
    if (entry.lastStartAttemptAt && now - entry.lastStartAttemptAt < cooldown) return

    startInFlight.add(key)
    entry.lastStartAttemptAt = now
    entry.startAttempts += 1
    entry.status = "starting"

    const unitName = serviceUnitNameFor(entry.username)
    const systemctlBin = process.env.OPENCODE_PER_USER_DAEMON_SYSTEMCTL_BIN || "systemctl"
    const invocation = {
      command: "sudo",
      args: ["-n", systemctlBin, "start", unitName],
    }

    const child = spawn(invocation.command, invocation.args, {
      stdio: ["ignore", "ignore", "pipe"],
    })

    let stderr = ""
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    child.on("close", (code) => {
      startInFlight.delete(key)
      if (code === 0) {
        entry.lastStartError = undefined
        entry.status = "planned"
        log.info("per-user daemon lazy-start requested", {
          username: entry.username,
          uid: entry.uid,
          unit: unitName,
          port: entry.port,
          socketPath: entry.socketPath,
        })
        return
      }

      entry.lastStartError = stderr.trim() || `exit_${code ?? "unknown"}`
      entry.status = "missing"
      log.warn("per-user daemon lazy-start failed", {
        username: entry.username,
        uid: entry.uid,
        unit: unitName,
        error: entry.lastStartError,
      })
    })
  }

  export function list() {
    return [...daemons.values()]
  }

  async function callJSON<T>(input: {
    entry: DaemonEntry
    method: "GET" | "PATCH" | "POST" | "DELETE"
    path: string
    body?: unknown
  }): Promise<DaemonCallResult<T>> {
    const timeoutMs = Number(process.env.OPENCODE_PER_USER_DAEMON_REQUEST_TIMEOUT_MS ?? "5000")
    const startedAt = Date.now()
    const traceCtx = {
      username: input.entry.username,
      method: input.method,
      path: input.path,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 5000,
    }
    log.info("daemon-call start", traceCtx)

    return await new Promise<DaemonCallResult<T>>((resolve) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: input.entry.port,
          path: input.path,
          method: input.method,
          timeout: Number.isFinite(timeoutMs) ? timeoutMs : 5000,
          headers: {
            "content-type": "application/json",
          },
        },
        (res) => {
          let raw = ""
          res.on("data", (chunk) => {
            raw += chunk.toString()
          })
          res.on("end", () => {
            const status = res.statusCode ?? 500
            const elapsedMs = Date.now() - startedAt
            if (status < 200 || status >= 300) {
              log.warn("daemon-call http-error", { ...traceCtx, status, elapsedMs })
              resolve({
                ok: false,
                error: {
                  code: "DAEMON_HTTP_ERROR",
                  message: `status ${status}`,
                },
              })
              return
            }
            try {
              input.entry.status = "ready"
              input.entry.lastStartError = undefined
              log.info("daemon-call ok", { ...traceCtx, status, elapsedMs })
              resolve({
                ok: true,
                data: raw ? (JSON.parse(raw) as T) : ({} as T),
              })
            } catch {
              log.warn("daemon-call invalid-json", { ...traceCtx, status, elapsedMs })
              resolve({
                ok: false,
                error: {
                  code: "DAEMON_INVALID_JSON",
                  message: "daemon response is not valid JSON",
                },
              })
            }
          })
        },
      )

      req.on("error", (error) => {
        const elapsedMs = Date.now() - startedAt
        input.entry.status = "missing"
        input.entry.lastStartError = error.message
        log.warn("daemon-call error", { ...traceCtx, elapsedMs, error: error.message })
        maybeTriggerLazyStart(input.entry)
        resolve({
          ok: false,
          error: {
            code: "DAEMON_REQUEST_FAILED",
            message: error.message,
          },
        })
      })

      req.on("timeout", () => {
        const elapsedMs = Date.now() - startedAt
        log.warn("daemon-call timeout", { ...traceCtx, elapsedMs })
        req.destroy(new Error("daemon request timeout"))
      })

      if (input.body !== undefined) {
        req.write(JSON.stringify(input.body))
      }
      req.end()
    })
  }

  export async function callConfigGet<T>(username: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) {
      return {
        ok: false,
        error: {
          code: "DAEMON_INVALID_USER",
          message: "invalid username",
        },
      } satisfies DaemonCallResult<T>
    }
    const entry = daemons.get(safe)
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "DAEMON_NOT_OBSERVED",
          message: "daemon not observed",
        },
      } satisfies DaemonCallResult<T>
    }
    return callJSON<T>({
      entry,
      method: "GET",
      path: "/config",
    })
  }

  export async function callConfigUpdate<T>(username: string, config: unknown) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) {
      return {
        ok: false,
        error: {
          code: "DAEMON_INVALID_USER",
          message: "invalid username",
        },
      } satisfies DaemonCallResult<T>
    }
    const entry = daemons.get(safe)
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "DAEMON_NOT_OBSERVED",
          message: "daemon not observed",
        },
      } satisfies DaemonCallResult<T>
    }
    return callJSON<T>({
      entry,
      method: "PATCH",
      path: "/config",
      body: config,
    })
  }

  export async function callAccountList<T>(username: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) {
      return {
        ok: false,
        error: {
          code: "DAEMON_INVALID_USER",
          message: "invalid username",
        },
      } satisfies DaemonCallResult<T>
    }
    const entry = daemons.get(safe)
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "DAEMON_NOT_OBSERVED",
          message: "daemon not observed",
        },
      } satisfies DaemonCallResult<T>
    }
    return callJSON<T>({
      entry,
      method: "GET",
      path: "/account",
    })
  }

  export async function callAccountSetActive<T>(username: string, providerKey: string, accountId: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) {
      return {
        ok: false,
        error: {
          code: "DAEMON_INVALID_USER",
          message: "invalid username",
        },
      } satisfies DaemonCallResult<T>
    }
    const entry = daemons.get(safe)
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "DAEMON_NOT_OBSERVED",
          message: "daemon not observed",
        },
      } satisfies DaemonCallResult<T>
    }
    return callJSON<T>({
      entry,
      method: "POST",
      path: `/account/${encodeURIComponent(providerKey)}/active`,
      body: { accountId },
    })
  }

  export async function callAccountRemove<T>(username: string, providerKey: string, accountId: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) {
      return {
        ok: false,
        error: {
          code: "DAEMON_INVALID_USER",
          message: "invalid username",
        },
      } satisfies DaemonCallResult<T>
    }
    const entry = daemons.get(safe)
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "DAEMON_NOT_OBSERVED",
          message: "daemon not observed",
        },
      } satisfies DaemonCallResult<T>
    }
    return callJSON<T>({
      entry,
      method: "DELETE",
      path: `/account/${encodeURIComponent(providerKey)}/${encodeURIComponent(accountId)}`,
    })
  }

  export async function callAccountUpdate<T>(
    username: string,
    providerKey: string,
    accountId: string,
    updates: unknown,
  ) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) {
      return {
        ok: false,
        error: {
          code: "DAEMON_INVALID_USER",
          message: "invalid username",
        },
      } satisfies DaemonCallResult<T>
    }
    const entry = daemons.get(safe)
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "DAEMON_NOT_OBSERVED",
          message: "daemon not observed",
        },
      } satisfies DaemonCallResult<T>
    }
    return callJSON<T>({
      entry,
      method: "PATCH",
      path: `/account/${encodeURIComponent(providerKey)}/${encodeURIComponent(accountId)}`,
      body: updates,
    })
  }

  export async function callSessionList<T>(
    username: string,
    query: {
      directory?: string
      roots?: boolean
      start?: number
      search?: string
      limit?: number
    },
  ) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) {
      return {
        ok: false,
        error: {
          code: "DAEMON_INVALID_USER",
          message: "invalid username",
        },
      } satisfies DaemonCallResult<T>
    }
    const entry = daemons.get(safe)
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "DAEMON_NOT_OBSERVED",
          message: "daemon not observed",
        },
      } satisfies DaemonCallResult<T>
    }

    const params = new URLSearchParams()
    if (query.directory) params.set("directory", query.directory)
    if (query.roots !== undefined) params.set("roots", String(query.roots))
    if (query.start !== undefined) params.set("start", String(query.start))
    if (query.search) params.set("search", query.search)
    if (query.limit !== undefined) params.set("limit", String(query.limit))
    const qs = params.toString()

    return callJSON<T>({
      entry,
      method: "GET",
      path: qs ? `/session?${qs}` : "/session",
    })
  }

  export async function callSessionGet<T>(username: string, sessionID: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({ entry, method: "GET", path: `/session/${encodeURIComponent(sessionID)}` })
  }

  export async function callSessionChildren<T>(username: string, sessionID: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({ entry, method: "GET", path: `/session/${encodeURIComponent(sessionID)}/children` })
  }

  export async function callSessionTodo<T>(username: string, sessionID: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({ entry, method: "GET", path: `/session/${encodeURIComponent(sessionID)}/todo` })
  }

  export async function callSessionSkillLayerList<T>(username: string, sessionID: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "GET",
      path: `/session/${encodeURIComponent(sessionID)}/skill-layer`,
    })
  }

  export async function callSessionSkillLayerAction<T>(
    username: string,
    sessionID: string,
    name: string,
    body: unknown,
  ) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "POST",
      path: `/session/${encodeURIComponent(sessionID)}/skill-layer/${encodeURIComponent(name)}/action`,
      body,
    })
  }

  export async function callSessionStatus<T>(username: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) {
      return {
        ok: false,
        error: {
          code: "DAEMON_INVALID_USER",
          message: "invalid username",
        },
      } satisfies DaemonCallResult<T>
    }
    const entry = daemons.get(safe)
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "DAEMON_NOT_OBSERVED",
          message: "daemon not observed",
        },
      } satisfies DaemonCallResult<T>
    }
    return callJSON<T>({
      entry,
      method: "GET",
      path: "/session/status",
    })
  }

  export async function callSessionTop<T>(
    username: string,
    query: {
      sessionID?: string
      includeDescendants?: boolean
      maxMessages?: number
    },
  ) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) {
      return {
        ok: false,
        error: {
          code: "DAEMON_INVALID_USER",
          message: "invalid username",
        },
      } satisfies DaemonCallResult<T>
    }
    const entry = daemons.get(safe)
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "DAEMON_NOT_OBSERVED",
          message: "daemon not observed",
        },
      } satisfies DaemonCallResult<T>
    }

    const params = new URLSearchParams()
    if (query.sessionID) params.set("sessionID", query.sessionID)
    if (query.includeDescendants !== undefined) params.set("includeDescendants", String(query.includeDescendants))
    if (query.maxMessages !== undefined) params.set("maxMessages", String(query.maxMessages))
    const qs = params.toString()

    return callJSON<T>({
      entry,
      method: "GET",
      path: qs ? `/session/top?${qs}` : "/session/top",
    })
  }

  export async function callSessionDiff<T>(username: string, sessionID: string, messageID?: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    const qs = new URLSearchParams()
    if (messageID) qs.set("messageID", messageID)
    const suffix = qs.toString()
    return callJSON<T>({
      entry,
      method: "GET",
      path: suffix
        ? `/session/${encodeURIComponent(sessionID)}/diff?${suffix}`
        : `/session/${encodeURIComponent(sessionID)}/diff`,
    })
  }

  /**
   * CMS/user-daemon proxy for the tail-first messages contract. Accepts
   * `limit` (tail size) and `before` (cursor for older-history pagination).
   */
  export async function callSessionMessages<T>(
    username: string,
    sessionID: string,
    opts?:
      | number
      | {
          limit?: number
          before?: string
        },
  ) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>

    const normalised = typeof opts === "number" ? { limit: opts } : opts ?? {}
    const params = new URLSearchParams()
    if (normalised.limit !== undefined) params.set("limit", String(normalised.limit))
    if (normalised.before !== undefined) params.set("before", normalised.before)
    const qs = params.toString() ? `?${params.toString()}` : ""
    return callJSON<T>({ entry, method: "GET", path: `/session/${encodeURIComponent(sessionID)}/message${qs}` })
  }

  export async function callSessionMessageGet<T>(username: string, sessionID: string, messageID: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "GET",
      path: `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`,
    })
  }

  export async function callModelPreferencesGet<T>(username: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) {
      return {
        ok: false,
        error: {
          code: "DAEMON_INVALID_USER",
          message: "invalid username",
        },
      } satisfies DaemonCallResult<T>
    }
    const entry = daemons.get(safe)
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "DAEMON_NOT_OBSERVED",
          message: "daemon not observed",
        },
      } satisfies DaemonCallResult<T>
    }
    return callJSON<T>({
      entry,
      method: "GET",
      path: "/model/preferences",
    })
  }

  export async function callModelPreferencesUpdate<T>(username: string, preferences: unknown) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) {
      return {
        ok: false,
        error: {
          code: "DAEMON_INVALID_USER",
          message: "invalid username",
        },
      } satisfies DaemonCallResult<T>
    }
    const entry = daemons.get(safe)
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "DAEMON_NOT_OBSERVED",
          message: "daemon not observed",
        },
      } satisfies DaemonCallResult<T>
    }
    return callJSON<T>({
      entry,
      method: "PATCH",
      path: "/model/preferences",
      body: preferences,
    })
  }

  export async function callSessionCreate<T>(username: string, body: unknown) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({ entry, method: "POST", path: "/session", body })
  }

  export async function callSessionDelete<T>(username: string, sessionID: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({ entry, method: "DELETE", path: `/session/${encodeURIComponent(sessionID)}` })
  }

  export async function callSessionUpdate<T>(username: string, sessionID: string, updates: unknown) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({ entry, method: "PATCH", path: `/session/${encodeURIComponent(sessionID)}`, body: updates })
  }

  export async function callSessionAutonomous<T>(username: string, sessionID: string, body: unknown) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "POST",
      path: `/session/${encodeURIComponent(sessionID)}/autonomous`,
      body,
    })
  }

  export async function callSessionAutonomousHealth<T>(username: string, sessionID: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "GET",
      path: `/session/${encodeURIComponent(sessionID)}/autonomous/health`,
    })
  }

  export async function callSessionAutonomousQueue<T>(username: string, sessionID: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "GET",
      path: `/session/${encodeURIComponent(sessionID)}/autonomous/queue`,
    })
  }

  export async function callSessionAutonomousQueueControl<T>(username: string, sessionID: string, body: unknown) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "POST",
      path: `/session/${encodeURIComponent(sessionID)}/autonomous/queue`,
      body,
    })
  }

  export async function callSessionInit<T>(username: string, sessionID: string, body: unknown) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({ entry, method: "POST", path: `/session/${encodeURIComponent(sessionID)}/init`, body })
  }

  export async function callSessionFork<T>(username: string, sessionID: string, body: unknown) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({ entry, method: "POST", path: `/session/${encodeURIComponent(sessionID)}/fork`, body })
  }

  export async function callSessionAbort<T>(username: string, sessionID: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({ entry, method: "POST", path: `/session/${encodeURIComponent(sessionID)}/abort` })
  }

  export async function callSessionShare<T>(username: string, sessionID: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({ entry, method: "POST", path: `/session/${encodeURIComponent(sessionID)}/share` })
  }

  export async function callSessionUnshare<T>(username: string, sessionID: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({ entry, method: "DELETE", path: `/session/${encodeURIComponent(sessionID)}/share` })
  }

  export async function callSessionSummarize<T>(
    username: string,
    sessionID: string,
    body: { providerId: string; modelID: string; auto?: boolean },
  ) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({ entry, method: "POST", path: `/session/${encodeURIComponent(sessionID)}/summarize`, body })
  }

  export async function callSessionMessageDelete<T>(username: string, sessionID: string, messageID: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "DELETE",
      path: `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`,
    })
  }

  export async function callSessionPartDelete<T>(
    username: string,
    sessionID: string,
    messageID: string,
    partID: string,
  ) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "DELETE",
      path: `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}/part/${encodeURIComponent(partID)}`,
    })
  }

  export async function callSessionPartUpdate<T>(
    username: string,
    sessionID: string,
    messageID: string,
    partID: string,
    part: unknown,
  ) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "PATCH",
      path: `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}/part/${encodeURIComponent(partID)}`,
      body: part,
    })
  }

  export async function callSessionPrompt<T>(username: string, sessionID: string, body: unknown) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "POST",
      path: `/session/${encodeURIComponent(sessionID)}/message`,
      body,
    })
  }

  export async function callSessionPromptAsync<T>(username: string, sessionID: string, body: unknown) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "POST",
      path: `/session/${encodeURIComponent(sessionID)}/prompt_async`,
      body,
    })
  }

  export async function callSessionCommand<T>(username: string, sessionID: string, body: unknown) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "POST",
      path: `/session/${encodeURIComponent(sessionID)}/command`,
      body,
    })
  }

  export async function callSessionShell<T>(username: string, sessionID: string, body: unknown) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "POST",
      path: `/session/${encodeURIComponent(sessionID)}/shell`,
      body,
    })
  }

  export async function callSessionRevert<T>(username: string, sessionID: string, body: unknown) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({
      entry,
      method: "POST",
      path: `/session/${encodeURIComponent(sessionID)}/revert`,
      body,
    })
  }

  export async function callSessionUnrevert<T>(username: string, sessionID: string) {
    observe(username)
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe)
      return {
        ok: false,
        error: { code: "DAEMON_INVALID_USER", message: "invalid username" },
      } satisfies DaemonCallResult<T>
    const entry = daemons.get(safe)
    if (!entry)
      return {
        ok: false,
        error: { code: "DAEMON_NOT_OBSERVED", message: "daemon not observed" },
      } satisfies DaemonCallResult<T>
    return callJSON<T>({ entry, method: "POST", path: `/session/${encodeURIComponent(sessionID)}/unrevert` })
  }
}
