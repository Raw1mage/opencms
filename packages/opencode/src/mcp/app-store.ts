import fs from "fs/promises"
import path from "path"
import { execSync } from "child_process"
import z from "zod/v4"
import { NamedError } from "@opencode-ai/util/error"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { McpAppManifest } from "./manifest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { withTimeout } from "@/util/timeout"
import { Env } from "@/env"
import { Installation } from "@/installation"

/**
 * MCP App Store — Two-tier registry + lifecycle management (Layer 2)
 *
 * System-level: /etc/opencode/mcp-apps.json  (managed by sudo wrapper)
 * User-level:   ~/.config/opencode/mcp-apps.json  (managed by per-user daemon)
 *
 * Merge rule (layered, per plans/mcp_per_user_socket_rca DD-1):
 *   - System tier owns app identity: `path`, `command`, `source`, `tools`,
 *     `settingsSchema`, `modelProcess`, `installedAt`, `transport`.
 *   - User tier may override runtime fields: `url`, `enabled`, `config`.
 *   - User-only / system-only apps pass through unchanged.
 *   - User-tier attempts to override system-immutable fields are dropped
 *     silently with a debug log (error class E2 — `mcp_app_user_override_rejected`).
 */
export namespace McpAppStore {
  const log = Log.create({ service: "mcp-app-store" })

  const SYSTEM_CONFIG_PATH = "/etc/opencode/mcp-apps.json"
  const SUDO_WRAPPER = "/usr/local/bin/opencode-app-install"

  function userConfigPath(): string {
    return path.join(Global.Path.config, "mcp-apps.json")
  }

  // ── Schema ──────────────────────────────────────────────────────────

  export const AppSource = z.discriminatedUnion("type", [
    z.object({ type: z.literal("github"), repo: z.string(), ref: z.string().optional() }),
    z.object({ type: z.literal("local") }),
  ])
  export type AppSource = z.infer<typeof AppSource>

  export const AppToolInfo = z.object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  export type AppToolInfo = z.infer<typeof AppToolInfo>

  export const AppEntry = z.object({
    path: z.string(),
    // /specs/docxmcp-http-transport: command is optional now; entries
    // with transport=streamable-http use `url` instead.
    command: z.array(z.string()).min(1).optional(),
    enabled: z.boolean(),
    installedAt: z.string(),
    source: AppSource,
    tools: z.array(AppToolInfo).optional(),
    settingsSchema: McpAppManifest.Settings.optional(),
    config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    modelProcess: z.array(z.string()).optional(),
    // /specs/docxmcp-http-transport DD-8 / DD-12: per-app transport.
    // When `streamable-http`, opencode connects via StreamableHTTPClientTransport
    // using `url` (which may be a unix:// scheme URL pointing at a Unix socket).
    transport: z.enum(["stdio", "streamable-http", "sse"]).optional(),
    url: z.string().optional(),
  })
  export type AppEntry = z.infer<typeof AppEntry>

  export const AppsConfig = z.object({
    version: z.literal(1),
    apps: z.record(z.string(), AppEntry),
  })
  export type AppsConfig = z.infer<typeof AppsConfig>

  /**
   * Structured cause for install / persistence failures.
   * Per plans/mcp_per_user_socket_rca DD-8 / errors.md E4.
   *
   * `fs_permission`       — chosen tier file not writable / readable by daemon.
   * `json_parse`          — existing tier file is corrupt JSON.
   * `schema_validation`   — new entry violates `AppsConfig` schema.
   * `tier_conflict`       — operation requires a tier-incompatible field set.
   * `unknown`             — fallback when no specific cause can be inferred.
   */
  export const StoreErrorCause = z.enum([
    "fs_permission",
    "json_parse",
    "schema_validation",
    "tier_conflict",
    "unknown",
  ])
  export type StoreErrorCause = z.infer<typeof StoreErrorCause>

  export const StoreError = NamedError.create(
    "McpAppStoreError",
    z.object({
      operation: z.string(),
      reason: z.string(),
      cause: StoreErrorCause.optional(),
      tier: z.enum(["system", "user"]).optional(),
    }),
  )

  /**
   * Classify a low-level error into a structured cause. Best-effort; defaults
   * to `unknown` when the error shape is opaque.
   */
  export function classifyStoreError(err: unknown): StoreErrorCause {
    if (err instanceof SyntaxError) return "json_parse"
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "fs_permission"
    if (err instanceof z.ZodError) return "schema_validation"
    return "unknown"
  }

  // ── Read ────────────────────────────────────────────────────────────

  async function readConfigFile(filePath: string): Promise<AppsConfig> {
    try {
      const content = await fs.readFile(filePath, "utf-8")
      const parsed = AppsConfig.safeParse(JSON.parse(content))
      if (!parsed.success) {
        const errors = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        log.warn("mcp-apps.json schema error, treating as empty", { path: filePath, errors })
        return { version: 1, apps: {} }
      }
      return parsed.data
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, apps: {} }
      }
      log.warn("failed to read mcp-apps.json", { path: filePath, error: String(err) })
      return { version: 1, apps: {} }
    }
  }

  /**
   * Fields a user-tier entry may override on a system-declared app.
   * Per plans/mcp_per_user_socket_rca DD-1 / DD-4.
   *
   * `url` — per-user socket path (templated tokens resolved at dial time).
   * `enabled` — per-user opt-in.
   * `config` — per-user settings values.
   *
   * Everything else (`path`, `command`, `source`, `tools`, `settingsSchema`,
   * `modelProcess`, `installedAt`, `transport`) is system-owned.
   * `transport` stays system-owned per DD-4 (OQ-1 resolved 2026-05-28).
   */
  const USER_OVERRIDABLE_FIELDS = ["url", "enabled", "config"] as const
  type UserOverridableField = (typeof USER_OVERRIDABLE_FIELDS)[number]

  /**
   * Pure layered merge of two-tier registry. Exported for testability.
   *
   * - System-only apps pass through.
   * - User-only apps pass through.
   * - On id collision: system identity wins, user runtime fields
   *   (`url`, `enabled`, `config`) override; user-tier attempts to set
   *   immutable fields are dropped silently with a debug log.
   */
  export function mergeAppsConfigs(system: AppsConfig, user: AppsConfig): AppsConfig {
    const apps: Record<string, AppEntry> = {}

    for (const [id, sysEntry] of Object.entries(system.apps)) {
      const usrEntry = user.apps[id]
      if (!usrEntry) {
        apps[id] = sysEntry
        continue
      }
      const rejected: string[] = []
      for (const key of Object.keys(usrEntry)) {
        if (!(USER_OVERRIDABLE_FIELDS as readonly string[]).includes(key)) {
          rejected.push(key)
        }
      }
      if (rejected.length > 0) {
        log.debug("mcp_app.user_override_rejected", { appId: id, fields: rejected })
      }
      const overrides: Partial<AppEntry> = {}
      for (const field of USER_OVERRIDABLE_FIELDS) {
        if (usrEntry[field as UserOverridableField] !== undefined) {
          ;(overrides as Record<string, unknown>)[field] = usrEntry[field as UserOverridableField]
        }
      }
      apps[id] = { ...sysEntry, ...overrides }
    }

    for (const [id, usrEntry] of Object.entries(user.apps)) {
      if (id in apps) continue
      apps[id] = usrEntry
    }

    return { version: 1, apps }
  }

  /**
   * Load and merge two-tier config using the layered merge.
   * See `mergeAppsConfigs` for the rule; see plans/mcp_per_user_socket_rca/design.md DD-1.
   */
  export async function loadConfig(): Promise<AppsConfig> {
    const [system, user] = await Promise.all([
      readConfigFile(SYSTEM_CONFIG_PATH),
      readConfigFile(userConfigPath()),
    ])
    return mergeAppsConfigs(system, user)
  }

  // ── User-level write (daemon direct write) ──────────────────────────

  async function saveUserConfig(config: AppsConfig): Promise<void> {
    const filePath = userConfigPath()
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, JSON.stringify(config, null, 2))
      await fs.chmod(filePath, 0o644).catch(() => {})
    } catch (err) {
      throw new StoreError({
        operation: "saveUserConfig",
        reason: err instanceof Error ? err.message : String(err),
        cause: classifyStoreError(err),
        tier: "user",
      })
    }
  }

  // ── System-level write (via sudo wrapper) ───────────────────────────

  function sudoWrapper(args: string[]): string {
    const cmd = `sudo ${SUDO_WRAPPER} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`
    try {
      return execSync(cmd, { encoding: "utf-8", timeout: 60_000 }).trim()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn("sudo wrapper failed", { args, error: msg })
      throw new StoreError({
        operation: args[0] ?? "unknown",
        reason: msg,
        cause: classifyStoreError(err),
        tier: "system",
      })
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  export type InstallTarget = "system" | "user"

  /**
   * Resolve manifest command to absolute paths at registration time.
   * Single point of truth — runtime uses entry.command directly, no re-resolution.
   */
  function resolveCommand(appPath: string, command: string[]): string[] {
    return command.map((arg, i) => {
      if (i === 0 && !arg.startsWith("/")) {
        return path.resolve(appPath, arg)
      }
      return arg
    })
  }

  /**
   * Probe an App via stdio spawn → tools/list. Returns tool metadata.
   * Disposes the connection after probing.
   */
  async function probeTools(command: string[], manifest?: McpAppManifest.Manifest): Promise<AppToolInfo[]> {
    // Build probe env: inject dummy auth tokens so the server doesn't crash
    // before tools/list. We only need the tool schema, not actual API access.
    const probeEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(Env.all())) {
      if (typeof v === "string") probeEnv[k] = v
    }
    if (manifest?.env) Object.assign(probeEnv, manifest.env)
    if (manifest?.auth?.type === "oauth" || manifest?.auth?.type === "api-key") {
      const tokenEnv = (manifest.auth as { tokenEnv?: string }).tokenEnv
      if (tokenEnv && !probeEnv[tokenEnv]) {
        probeEnv[tokenEnv] = "probe-dummy-token"
      }
    }

    const transport = new StdioClientTransport({
      command: command[0],
      args: command.slice(1),
      env: probeEnv,
      stderr: "pipe",
      // Use /tmp as cwd to avoid bun standalone binaries picking up
      // project-level bunfig.toml preload from cwd ancestors
      cwd: "/tmp",
    })
    const client = new Client({ name: "opencode-probe", version: Installation.VERSION })

    try {
      await withTimeout(client.connect(transport), 30_000)
      const result = await withTimeout(client.listTools(), 10_000)
      return result.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      }))
    } finally {
      await client.close().catch(() => {})
    }
  }

  /**
   * /specs/docxmcp-http-transport DD-13: bind-mount lint with IPC exception.
   *
   * Predicate over a docker `command` array: returns the offending mount
   * arg(s) that violate the policy. An empty array means the command is
   * either non-docker or all bind mounts are within the IPC exception.
   *
   * Allowed bind mount: host path matches
   *   ^/run/user/\d+/opencode/sockets/[a-z0-9-]+/?$
   * AND container path matches
   *   ^/run/[a-z0-9-]+/?$
   * (the IPC rendezvous dir convention from DD-12 / DD-15).
   */
  const IPC_HOST_RE = /^\/run\/user\/\d+\/opencode\/sockets\/[a-z0-9-]+\/?$/
  const IPC_CONTAINER_RE = /^\/run\/[a-z0-9-]+\/?$/

  export function findBindMountViolations(command: readonly string[]): string[] {
    const violations: string[] = []
    for (let i = 0; i < command.length; i++) {
      const tok = command[i]
      let mountSpec: string | undefined
      if ((tok === "-v" || tok === "--volume") && i + 1 < command.length) {
        mountSpec = command[i + 1]
        i++
      } else if (typeof tok === "string" && tok.startsWith("--mount=") && tok.includes("type=bind")) {
        mountSpec = tok.slice("--mount=".length)
      } else if (tok === "--mount" && i + 1 < command.length && command[i + 1].includes("type=bind")) {
        mountSpec = command[i + 1]
        i++
      }
      if (!mountSpec) continue

      // Parse: -v hostPath:containerPath[:flags] OR --mount type=bind,src=...,dst=...
      let hostPath: string | undefined
      let containerPath: string | undefined
      if (mountSpec.includes(":") && !mountSpec.startsWith("type=")) {
        const parts = mountSpec.split(":")
        // Skip if it's just a named volume (no leading slash on host part).
        if (!parts[0]?.startsWith("/")) continue
        hostPath = parts[0]
        containerPath = parts[1]
      } else if (mountSpec.startsWith("type=bind")) {
        const fields = Object.fromEntries(
          mountSpec.split(",").map((kv) => {
            const eq = kv.indexOf("=")
            return eq < 0 ? [kv, ""] : [kv.slice(0, eq), kv.slice(eq + 1)]
          }),
        )
        hostPath = (fields.src ?? fields.source) as string | undefined
        containerPath = (fields.dst ?? fields.destination ?? fields.target) as string | undefined
      }

      if (!hostPath || !containerPath) continue

      const hostOk = IPC_HOST_RE.test(hostPath)
      const ctrOk = IPC_CONTAINER_RE.test(containerPath)
      if (!(hostOk && ctrOk)) {
        violations.push(`${tok === "--mount" || tok.startsWith("--mount=") ? "--mount " : "-v "}${mountSpec}`)
      }
    }
    return violations
  }

  /**
   * Build a complete AppEntry with resolved command and probed tools.
   */
  async function buildEntry(appPath: string, manifest: McpAppManifest.Manifest): Promise<AppEntry> {
    // /specs/docxmcp-http-transport DD-1 / DD-12: HTTP transport branch.
    // Manifests with transport=streamable-http carry a url instead of a
    // command; nothing to bind-mount-lint, no probe via stdio (we'd need
    // to bring up the container first which is out of band).
    if (manifest.transport === "streamable-http" || manifest.transport === "sse") {
      if (!manifest.url) {
        throw new StoreError({
          operation: "buildEntry",
          reason: "transport=streamable-http requires url",
          cause: "schema_validation",
        })
      }
      return {
        path: appPath,
        enabled: false,
        installedAt: new Date().toISOString(),
        source: { type: "local" },
        tools: [],
        settingsSchema: manifest.settings,
        modelProcess: manifest.modelProcess,
        transport: manifest.transport,
        url: manifest.url,
      }
    }

    const resolvedCmd = resolveCommand(appPath, manifest.command!)

    // /specs/docxmcp-http-transport R8-S1 / DD-13: lint guard.
    const violations = findBindMountViolations(resolvedCmd)
    if (violations.length > 0) {
      throw new StoreError({
        operation: "addApp.bindMountLint",
        reason:
          `bind_mount_forbidden: ${violations.length} violation(s) — ${violations.join("; ")}` +
          ` (policy: specs/docxmcp-http-transport)`,
        cause: "schema_validation",
      })
    }

    let tools: AppToolInfo[] = []
    try {
      tools = await probeTools(resolvedCmd, manifest)
      log.info("probed app tools", { id: manifest.id, count: tools.length })
    } catch (err) {
      log.warn("probe failed, registering without tool list", {
        id: manifest.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    return {
      path: appPath,
      command: resolvedCmd,
      enabled: false,
      installedAt: new Date().toISOString(),
      source: { type: "local" },
      tools,
      settingsSchema: manifest.settings,
      modelProcess: manifest.modelProcess,
    }
  }

  /**
   * Write a complete entry to system-level mcp-apps.json via sudo.
   * Uses write-entry command: passes full JSON entry via tmp file.
   */
  async function writeSystemEntry(id: string, entry: AppEntry): Promise<void> {
    // Use XDG_RUNTIME_DIR (not /tmp) because per-user daemons run with
    // PrivateTmp=true — their /tmp is isolated from root's /tmp.
    const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`
    const tmpFile = `${runtimeDir}/mcp-entry-${id}-${Date.now()}.json`
    try {
      await fs.writeFile(tmpFile, JSON.stringify(entry, null, 2))
      sudoWrapper(["write-entry", id, tmpFile])
    } finally {
      await fs.unlink(tmpFile).catch(() => {})
    }
  }

  /**
   * Register an App by path. Reads manifest, probes tools, persists full entry
   * with resolved command and tool list.
   */
  export async function addApp(
    id: string,
    appPath: string,
    target: InstallTarget = "system",
  ): Promise<McpAppManifest.Manifest> {
    const manifest = await McpAppManifest.load(appPath)
    const entry = await buildEntry(appPath, manifest)

    // Preserve existing enabled state and installedAt if re-registering
    const configPath = target === "system" ? SYSTEM_CONFIG_PATH : userConfigPath()
    const existing = (await readConfigFile(configPath)).apps[id]
    if (existing) {
      entry.enabled = existing.enabled
      entry.installedAt = existing.installedAt
    }

    if (target === "system") {
      await writeSystemEntry(id, entry)
    } else {
      const config = await readConfigFile(userConfigPath())
      config.apps[id] = entry
      await saveUserConfig(config)
    }

    log.info("app registered", { id, path: appPath, tools: entry.tools?.length ?? 0, target })
    return manifest
  }

  /**
   * Clone a GitHub repo to /opt/opencode-apps/<id>/ and register it.
   * System-level only (requires sudo).
   */
  export async function cloneAndRegister(githubUrl: string, id: string): Promise<McpAppManifest.Manifest> {
    sudoWrapper(["clone", githubUrl, id])
    const appPath = `/opt/opencode-apps/${id}`
    const manifest = await McpAppManifest.load(appPath)
    const entry = await buildEntry(appPath, manifest)
    await writeSystemEntry(id, entry)
    log.info("app cloned and registered", { id, url: githubUrl })
    return manifest
  }

  /**
   * Remove an App from the registry.
   */
  export async function removeApp(id: string, target: InstallTarget = "system"): Promise<void> {
    if (target === "system") {
      sudoWrapper(["remove", id])
    } else {
      const config = await readConfigFile(userConfigPath())
      delete config.apps[id]
      await saveUserConfig(config)
    }
    log.info("app removed", { id, target })
  }

  /**
   * Set enabled/disabled state for an App.
   */
  export async function setEnabled(id: string, enabled: boolean, target: InstallTarget = "system"): Promise<void> {
    if (target === "system") {
      // Read current entry, flip enabled, write back via write-entry
      const config = await readConfigFile(SYSTEM_CONFIG_PATH)
      const entry = config.apps[id]
      if (!entry) throw new StoreError({ operation: "setEnabled", reason: `App not found: ${id}`, cause: "tier_conflict", tier: "system" })
      entry.enabled = enabled
      await writeSystemEntry(id, entry)
    } else {
      const config = await readConfigFile(userConfigPath())
      const entry = config.apps[id]
      if (!entry) throw new StoreError({ operation: "setEnabled", reason: `App not found in user config: ${id}`, cause: "tier_conflict", tier: "user" })
      entry.enabled = enabled
      await saveUserConfig(config)
    }
    log.info("app state changed", { id, enabled, target })
  }

  /**
   * Set user config values for an App. Validates against settingsSchema if present.
   */
  export async function setConfig(
    id: string,
    values: Record<string, string | number | boolean>,
    target: InstallTarget = "system",
  ): Promise<void> {
    const configPath = target === "system" ? SYSTEM_CONFIG_PATH : userConfigPath()
    const config = await readConfigFile(configPath)
    const entry = config.apps[id]
    if (!entry) throw new StoreError({ operation: "setConfig", reason: `App not found: ${id}`, cause: "tier_conflict", tier: target })

    // Validate required fields if schema exists
    if (entry.settingsSchema) {
      const missing = entry.settingsSchema.fields
        .filter((f) => f.required && !(f.key in values) && values[f.key] === undefined)
        .map((f) => f.key)
      if (missing.length > 0) {
        throw new StoreError({
          operation: "setConfig",
          reason: `Missing required settings: ${missing.join(", ")}`,
          cause: "schema_validation",
        })
      }
    }

    entry.config = { ...entry.config, ...values }

    if (target === "system") {
      await writeSystemEntry(id, entry)
    } else {
      await saveUserConfig(config)
    }
    log.info("app config updated", { id, keys: Object.keys(values), target })
  }

  /**
   * List all registered Apps with their manifest metadata.
   *
   * Uses the same layered-merge rule as `loadConfig` — entry shown is the
   * post-merge view (system identity + user runtime overrides). `tier` is
   * `system` when the app's identity comes from the system tier, even if
   * runtime fields were user-overridden; `user` when the app is user-only.
   */
  export async function listApps(): Promise<
    Array<{
      id: string
      entry: AppEntry
      manifest: McpAppManifest.Manifest | null
      tier: "system" | "user"
    }>
  > {
    const [system, user] = await Promise.all([
      readConfigFile(SYSTEM_CONFIG_PATH),
      readConfigFile(userConfigPath()),
    ])
    const merged = mergeAppsConfigs(system, user)

    const result: Array<{
      id: string
      entry: AppEntry
      manifest: McpAppManifest.Manifest | null
      tier: "system" | "user"
    }> = []

    for (const [id, entry] of Object.entries(merged.apps)) {
      const tier: "system" | "user" = id in system.apps ? "system" : "user"
      let manifest: McpAppManifest.Manifest | null = null
      try {
        manifest = await McpAppManifest.load(entry.path)
      } catch {
        log.warn("failed to load manifest for registered app", { id, path: entry.path })
      }
      result.push({ id, entry, manifest, tier })
    }

    return result
  }
}
