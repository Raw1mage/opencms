import { LinuxUserExec } from "@/system/linux-user-exec"
import { Log } from "@/util/log"
import { fileURLToPath } from "url"
import { spawn, type ChildProcessByStdio } from "child_process"
import { createInterface } from "node:readline"
import { Identifier } from "@/id/id"
import { UserWorkerRPC } from "./rpc-schema"
import type { Writable, Readable } from "stream"

type WorkerStatus = "planned" | "running" | "stopped"

export type WorkerSnapshot = {
  username: string
  status: WorkerStatus
  firstSeenAt: number
  lastSeenAt: number
}

type WorkerEntry = WorkerSnapshot & {
  plan?: {
    command: string
    args: string[]
  }
  proc?: ChildProcessByStdio<Writable, Readable, null>
  ready?: boolean
  readyPromise?: Promise<void>
  readyResolve?: () => void
  pending?: Map<string, (response: UserWorkerRPC.Response) => void>
  lastPrewarmAt?: number
  prewarmInFlight?: Promise<void>
}

export namespace UserWorkerManager {
  const WORKER_PREFIX = "__OPENCODE_USER_WORKER__ "
  const READY_TIMEOUT_MS = 20_000
  const CALL_TIMEOUT_MS = 12_000
  const PREWARM_COOLDOWN_MS = 30_000
  const log = Log.create({ service: "server.user-worker" })
  const workers = new Map<string, WorkerEntry>()

  export function enabled() {
    return process.env.OPENCODE_USER_WORKER_ENABLED === "1" || process.env.OPENCODE_USER_WORKER_SKELETON === "1"
  }

  export function routingEnabled() {
    return process.env.OPENCODE_USER_WORKER_ROUTE_SESSION_LIST === "1"
  }

  export function routeConfigGetEnabled() {
    return process.env.OPENCODE_USER_WORKER_ROUTE_CONFIG_GET === "1"
  }

  export function routeConfigUpdateEnabled() {
    return process.env.OPENCODE_USER_WORKER_ROUTE_CONFIG_UPDATE === "1"
  }

  export function routeAccountListEnabled() {
    return process.env.OPENCODE_USER_WORKER_ROUTE_ACCOUNT_LIST === "1"
  }

  export function routeAccountMutationEnabled() {
    return process.env.OPENCODE_USER_WORKER_ROUTE_ACCOUNT_MUTATION === "1"
  }

  export function prewarmEnabled() {
    return process.env.OPENCODE_USER_WORKER_PREWARM !== "0"
  }

  function buildWorkerExecutableArgs() {
    const currentExec = process.argv[0]
    const indexScript = process.argv[1] || fileURLToPath(new URL("../../index.ts", import.meta.url))
    const isBun = /(^|\/)bun(\.exe)?$/.test(currentExec)
    if (isBun) {
      return {
        executable: currentExec,
        args: ["--conditions=browser", indexScript, "user-worker", "--stdio"],
      }
    }
    return {
      executable: currentExec,
      args: ["user-worker", "--stdio"],
    }
  }

  export function observe(username: string | undefined) {
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) return

    const now = Date.now()
    const existing = workers.get(safe)
    if (existing) {
      existing.lastSeenAt = now
      return
    }

    const cwd = process.env.OPENCODE_USER_WORKER_CWD || process.cwd()
    const worker = buildWorkerExecutableArgs()
    const plan = LinuxUserExec.buildSudoInvocation({
      user: safe,
      cwd,
      executable: worker.executable,
      args: worker.args,
      env: {
        OPENCODE_WORKER_MODE: "user-home",
      },
    })

    workers.set(safe, {
      username: safe,
      status: "planned",
      firstSeenAt: now,
      lastSeenAt: now,
      plan,
      pending: new Map(),
    })

    log.info("registered user worker plan", {
      username: safe,
      command: plan.command,
      args: plan.args,
    })
  }

  export function list() {
    return [...workers.values()].map(({ plan, ...snapshot }) => snapshot)
  }

  export function planOf(username: string) {
    return workers.get(username)?.plan
  }

  export function prewarm(username: string | undefined) {
    if (!prewarmEnabled()) return
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) return
    observe(safe)
    const entry = workers.get(safe)
    if (!entry) return

    const now = Date.now()
    if (entry.ready && now - (entry.lastPrewarmAt ?? 0) < PREWARM_COOLDOWN_MS) return
    if (entry.prewarmInFlight) return

    entry.prewarmInFlight = (async () => {
      try {
        await ensureWorker(safe)
        entry.lastPrewarmAt = Date.now()
      } catch (error) {
        log.warn("user worker prewarm failed", {
          username: safe,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        entry.prewarmInFlight = undefined
      }
    })()
  }

  async function ensureWorker(username: string) {
    const safe = LinuxUserExec.sanitizeUsername(username)
    if (!safe) throw new Error("invalid username")
    observe(safe)

    const entry = workers.get(safe)
    if (!entry?.plan) throw new Error("worker plan missing")
    entry.lastSeenAt = Date.now()

    if (entry.proc && entry.ready) return entry
    if (entry.proc && entry.readyPromise) {
      await Promise.race([entry.readyPromise, Bun.sleep(READY_TIMEOUT_MS)])
      if (entry.ready) return entry
    }

    const proc = spawn(entry.plan.command, entry.plan.args, {
      stdio: ["pipe", "pipe", "inherit"],
    })
    entry.proc = proc
    entry.status = "running"
    entry.ready = false

    let readyResolve = () => {}
    entry.readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve
    })
    entry.readyResolve = readyResolve
    entry.pending ??= new Map()

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity })
    void (async () => {
      for await (const raw of rl) {
        const line = raw.trim()
        if (!line.startsWith(WORKER_PREFIX)) continue
        const payload = line.slice(WORKER_PREFIX.length)
        let msg: any
        try {
          msg = JSON.parse(payload)
        } catch {
          continue
        }
        if (msg?.type === "ready") {
          entry.ready = true
          entry.readyResolve?.()
          continue
        }
        if (msg?.type === "response" && typeof msg.id === "string") {
          const resolve = entry.pending?.get(msg.id)
          if (!resolve) continue
          entry.pending?.delete(msg.id)
          const parsed = UserWorkerRPC.Response.safeParse(msg.response)
          resolve(
            parsed.success
              ? parsed.data
              : {
                  ok: false,
                  error: {
                    code: "BAD_RESPONSE",
                    message: parsed.error.issues[0]?.message ?? "Invalid worker response",
                  },
                },
          )
        }
      }
    })().catch(() => {})

    proc.once("exit", () => {
      entry.status = "stopped"
      entry.ready = false
      entry.proc = undefined
      entry.readyResolve?.()
      for (const [, resolve] of entry.pending ?? new Map()) {
        resolve({ ok: false, error: { code: "WORKER_EXITED", message: "User worker exited" } })
      }
      entry.pending?.clear()
    })

    await Promise.race([entry.readyPromise, Bun.sleep(READY_TIMEOUT_MS)])
    if (!entry.ready) {
      try {
        entry.proc?.kill("SIGTERM")
      } catch {
        // ignore kill errors on timeout cleanup
      }
      entry.proc = undefined
      entry.status = "stopped"
      throw new Error(`worker not ready for user ${safe}`)
    }

    return entry
  }

  export async function call(username: string, request: UserWorkerRPC.Request): Promise<UserWorkerRPC.Response> {
    let entry: WorkerEntry
    try {
      entry = await ensureWorker(username)
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "WORKER_NOT_READY",
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
    const proc = entry.proc
    if (!proc) {
      return { ok: false, error: { code: "NO_WORKER", message: "Worker process unavailable" } }
    }

    const id = Identifier.ascending("message")
    const payload = JSON.stringify({ id, request }) + "\n"
    const response = await new Promise<UserWorkerRPC.Response>((resolve) => {
      entry.pending?.set(id, resolve)
      const timeout = setTimeout(() => {
        entry.pending?.delete(id)
        resolve({ ok: false, error: { code: "TIMEOUT", message: "Worker call timeout" } })
      }, CALL_TIMEOUT_MS)
      if (typeof timeout.unref === "function") timeout.unref()

      try {
        proc.stdin.write(payload, (err) => {
          if (!err) return
          entry.pending?.delete(id)
          clearTimeout(timeout)
          resolve({ ok: false, error: { code: "WRITE_FAILED", message: err.message } })
        })
      } catch (error) {
        entry.pending?.delete(id)
        clearTimeout(timeout)
        resolve({
          ok: false,
          error: { code: "WRITE_FAILED", message: error instanceof Error ? error.message : String(error) },
        })
      }

      const prev = entry.pending?.get(id)
      if (!prev) return
      entry.pending?.set(id, (result) => {
        clearTimeout(timeout)
        resolve(result)
      })
    })

    if (!response.ok) {
      log.warn("user worker call failed", {
        username,
        method: request.method,
        code: response.error?.code,
        message: response.error?.message,
      })
    }

    return response
  }
}
