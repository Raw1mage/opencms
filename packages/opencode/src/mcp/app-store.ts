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
 * Merge rule: system-level wins on id collision.
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
    command: z.array(z.string()).min(1),
    enabled: z.boolean(),
    installedAt: z.string(),
    source: AppSource,
    tools: z.array(AppToolInfo).optional(),
  })
  export type AppEntry = z.infer<typeof AppEntry>

  export const AppsConfig = z.object({
    version: z.literal(1),
    apps: z.record(z.string(), AppEntry),
  })
  export type AppsConfig = z.infer<typeof AppsConfig>

  export const StoreError = NamedError.create(
    "McpAppStoreError",
    z.object({ operation: z.string(), reason: z.string() }),
  )

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
   * Load and merge two-tier config. System-level wins on id collision.
   */
  export async function loadConfig(): Promise<AppsConfig> {
    const [system, user] = await Promise.all([
      readConfigFile(SYSTEM_CONFIG_PATH),
      readConfigFile(userConfigPath()),
    ])

    // System takes priority: start with user, then overwrite with system
    const merged: AppsConfig = {
      version: 1,
      apps: { ...user.apps, ...system.apps },
    }

    return merged
  }

  // ── User-level write (daemon direct write) ──────────────────────────

  async function saveUserConfig(config: AppsConfig): Promise<void> {
    const filePath = userConfigPath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(config, null, 2))
    await fs.chmod(filePath, 0o644).catch(() => {})
  }

  // ── System-level write (via sudo wrapper) ───────────────────────────

  function sudoWrapper(args: string[]): string {
    const cmd = `sudo ${SUDO_WRAPPER} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`
    try {
      return execSync(cmd, { encoding: "utf-8", timeout: 60_000 }).trim()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn("sudo wrapper failed", { args, error: msg })
      throw new StoreError({ operation: args[0] ?? "unknown", reason: msg })
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
    const probeEnv: Record<string, string> = { ...Env.all(), ...manifest?.env }
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
   * Build a complete AppEntry with resolved command and probed tools.
   */
  async function buildEntry(appPath: string, manifest: McpAppManifest.Manifest): Promise<AppEntry> {
    const resolvedCmd = resolveCommand(appPath, manifest.command)

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
      // Read system config, update, write back via sudo register
      // (register is idempotent — it updates if exists)
      const config = await readConfigFile(SYSTEM_CONFIG_PATH)
      const entry = config.apps[id]
      if (!entry) throw new StoreError({ operation: "setEnabled", reason: `App not found: ${id}` })
      // For system-level toggle, we use register with the existing path
      // The wrapper's register command overwrites the entry
      sudoWrapper(["register", id, entry.path])
    } else {
      const config = await readConfigFile(userConfigPath())
      const entry = config.apps[id]
      if (!entry) throw new StoreError({ operation: "setEnabled", reason: `App not found in user config: ${id}` })
      entry.enabled = enabled
      await saveUserConfig(config)
    }
    log.info("app state changed", { id, enabled, target })
  }

  /**
   * List all registered Apps with their manifest metadata.
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

    const result: Array<{
      id: string
      entry: AppEntry
      manifest: McpAppManifest.Manifest | null
      tier: "system" | "user"
    }> = []

    // System entries first
    for (const [id, entry] of Object.entries(system.apps)) {
      let manifest: McpAppManifest.Manifest | null = null
      try {
        manifest = await McpAppManifest.load(entry.path)
      } catch {
        log.warn("failed to load manifest for registered app", { id, path: entry.path })
      }
      result.push({ id, entry, manifest, tier: "system" })
    }

    // User entries (skip if already in system)
    for (const [id, entry] of Object.entries(user.apps)) {
      if (system.apps[id]) continue // system takes priority
      let manifest: McpAppManifest.Manifest | null = null
      try {
        manifest = await McpAppManifest.load(entry.path)
      } catch {
        log.warn("failed to load manifest for registered app", { id, path: entry.path })
      }
      result.push({ id, entry, manifest, tier: "user" })
    }

    return result
  }
}
