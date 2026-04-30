import { Log } from "../util/log"
import path from "path"
import { pathToFileURL } from "url"
import { createRequire } from "module"
import os from "os"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { ModelsDev } from "../provider/models"
import { mergeDeep, pipe, unique } from "remeda"
import { Global } from "../global"
import fs from "fs/promises"
import { lazy } from "../util/lazy"
import { NamedError } from "@opencode-ai/util/error"
import { Flag } from "../flag/flag"
import { Auth } from "../auth"
import {
  type ParseError as JsoncParseError,
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
} from "jsonc-parser"
import { Instance } from "../project/instance"
import { LSPServer } from "../lsp/server"
import { BunProc } from "@/bun"
import { Installation } from "@/installation"
import { ConfigMarkdown } from "./markdown"
import { constants, existsSync } from "fs"
import { Bus } from "@/bus"
import { Event } from "../server/event"
import { Env } from "@/env"
import { iife } from "@/util/iife"

export namespace Config {
  const log = Log.create({ service: "config" })
  const ModelRef = { $ref: "https://models.dev/model-schema.json#/$defs/Model" }

  // Managed settings directory for enterprise deployments (highest priority, admin-controlled)
  // These settings override all user and project settings
  function getManagedConfigDir(): string {
    switch (process.platform) {
      case "darwin":
        return "/Library/Application Support/opencode"
      case "win32":
        return path.join(Env.get("ProgramData") || "C:\\ProgramData", "opencode")
      default:
        return "/etc/opencode"
    }
  }

  const managedConfigDir = Env.get("OPENCODE_TEST_MANAGED_CONFIG_DIR") || getManagedConfigDir()

  // Custom merge function that concatenates array fields instead of replacing them
  function mergeConfigConcatArrays(target: Info, source: Info): Info {
    const merged = mergeDeep(target, source)
    if (target.plugin && source.plugin) {
      merged.plugin = Array.from(new Set([...target.plugin, ...source.plugin]))
    }
    if (target.instructions && source.instructions) {
      merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
    }
    return merged
  }

  function isMemoryServerCommand(command: string[]) {
    return command.some((part) => part.includes("@modelcontextprotocol/server-memory"))
  }

  function getLocalMemoryMcp(config: Info) {
    const memory = config.mcp?.memory
    if (!memory || typeof memory !== "object") return undefined
    if (!("type" in memory) || memory.type !== "local") return undefined
    if (!("command" in memory) || !Array.isArray(memory.command)) return undefined
    if (!isMemoryServerCommand(memory.command)) return undefined
    return memory
  }

  const INTERNAL_MCP_SOURCES = {
    "system-manager": "packages/mcp/system-manager/src/index.ts",
    "refacting-merger": "packages/mcp/refacting-merger/src/index.ts",
    "gcp-grounding": "packages/mcp/gcp-grounding/index.ts",
    "beta-tool": "packages/mcp/branch-cicd/src/index.ts",
  } as const

  type InternalMcpName = keyof typeof INTERNAL_MCP_SOURCES

  function isInternalMcpName(name: string): name is InternalMcpName {
    return name in INTERNAL_MCP_SOURCES
  }

  function getInternalMcpMode(): "source" | "binary" | "auto" {
    // Explicit override takes precedence
    const raw = Env.get("OPENCODE_INTERNAL_MCP_MODE")
    if (raw === "source" || raw === "binary") return raw
    // Running from source repo → always use source (no env juggling required)
    if (detectRepoRoot()) return "source"
    return "auto"
  }

  function getInternalMcpSystemBinary(name: InternalMcpName) {
    return path.join("/usr/local/lib/opencode/mcp", name)
  }

  function detectRepoRoot(): string | undefined {
    const explicit = Env.get("OPENCODE_REPO_ROOT")
    if (explicit) return explicit
    // Auto-detect from this file's location: config.ts is at packages/opencode/src/config/
    const thisDir = path.dirname(new URL(import.meta.url).pathname)
    const candidate = path.resolve(thisDir, "../../../..")
    if (existsSync(path.join(candidate, "packages/mcp"))) return candidate
    return undefined
  }

  function getInternalMcpSourceCommand(name: InternalMcpName) {
    const repoRoot = detectRepoRoot()
    if (!repoRoot) {
      throw new Error(`Cannot resolve repo root for internal MCP ${name} — set OPENCODE_REPO_ROOT`)
    }
    const entry = path.join(repoRoot, INTERNAL_MCP_SOURCES[name])
    if (!existsSync(entry)) {
      throw new Error(`Internal MCP source entry not found for ${name}: ${entry}`)
    }
    return ["bun", entry]
  }

  function isInternalMcpRepoCommand(command: string[], name: InternalMcpName) {
    const sourcePath = INTERNAL_MCP_SOURCES[name]
    return command.some((part) => part.includes(sourcePath) || part.includes("packages/mcp/"))
  }

  function normalizeMcpCommands(config: Info): Info {
    if (!config.mcp) return config
    const mcp = { ...config.mcp }
    const mode = getInternalMcpMode()

    for (const [name, entry] of Object.entries(mcp)) {
      if (!isInternalMcpName(name)) continue
      if (!entry || typeof entry !== "object") continue
      if (!("type" in entry) || entry.type !== "local") continue
      if (!("command" in entry) || !Array.isArray(entry.command)) continue

      const systemBin = getInternalMcpSystemBinary(name)
      const isRepoPath = isInternalMcpRepoCommand(entry.command, name)

      if (mode === "source") {
        mcp[name] = {
          ...entry,
          command: getInternalMcpSourceCommand(name),
        }
        log.debug(`resolved mcp ${name} to source command`, { command: mcp[name].command })
        continue
      }

      if (mode === "binary") {
        mcp[name] = {
          ...entry,
          command: [systemBin],
        }
        log.debug(`resolved mcp ${name} to system binary`, { path: systemBin })
        continue
      }

      if (isRepoPath && existsSync(systemBin)) {
        mcp[name] = {
          ...entry,
          command: [systemBin],
        }
        log.debug(`resolved mcp ${name} to system binary`, { path: systemBin })
      }
    }

    return { ...config, mcp }
  }

  function normalizeMemoryConfig(config: Info): Info {
    const memory = getLocalMemoryMcp(config)
    if (!memory) return config

    // Use XDG data path with project ID to avoid creating ~/.opencode/ in user home
    // when the daemon's cwd is home (non-git directory).
    const projectMemoryPath = path.join(Global.Path.data, "memory", Instance.project.id, "project.jsonl")

    return {
      ...config,
      mcp: {
        ...(config.mcp ?? {}),
        // Keep a single memory MCP entry. Default to repo-scoped memory.
        memory: {
          ...memory,
          environment: {
            ...memory.environment,
            MEMORY_FILE_PATH: projectMemoryPath,
          },
        },
      },
    }
  }

  function validateMemoryConfig(config: Info) {
    const memory = getLocalMemoryMcp(config)
    if (!memory) return

    // Validate that environment variables are properly set
    if (!memory.environment?.MEMORY_FILE_PATH) {
      log.warn("Memory MCP is missing MEMORY_FILE_PATH environment variable")
    }

    // Validate command exists and is executable
    const [cmd] = memory.command
    if (!cmd) {
      log.warn("Memory MCP command is empty")
      return
    }

    try {
      // Check if command is found in PATH
      const resolved = Bun.which(cmd)
      if (!resolved) {
        log.error(`Memory MCP command not found: ${cmd}`)
      }
    } catch (error) {
      log.error(`Error validating Memory MCP command: ${cmd}`, { error })
    }
  }

  const LKG_FILE = "config-lkg.json"

  function lkgPath() {
    return path.join(Global.Path.state, LKG_FILE)
  }

  type LkgSnapshot = {
    writtenAt: number
    directories: string[]
    config: Info
  }

  async function readLkgSnapshot(): Promise<LkgSnapshot | undefined> {
    try {
      const raw = await Bun.file(lkgPath()).text()
      const parsed = JSON.parse(raw) as LkgSnapshot
      if (!parsed || typeof parsed !== "object" || !parsed.config) return
      return parsed
    } catch (err: any) {
      if (err?.code === "ENOENT") return
      log.warn("failed to read last-known-good config", { path: lkgPath(), error: err?.message })
      return
    }
  }

  async function writeLkgSnapshot(snapshot: LkgSnapshot): Promise<void> {
    const target = lkgPath()
    const tmp = `${target}.${process.pid}.tmp`
    try {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await Bun.write(tmp, JSON.stringify(snapshot))
      await fs.rename(tmp, target)
    } catch (err: any) {
      log.warn("failed to write last-known-good config", { path: target, error: err?.message })
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }

  function isConfigParseError(err: unknown): boolean {
    return JsonError.isInstance(err) || InvalidError.isInstance(err) || ConfigDirectoryTypoError.isInstance(err)
  }

  async function createState() {
    try {
      const result = await createStateInner()
      // Fire-and-forget lkg write on success so future parse failures can fall back.
      // AGENTS.md rule #1: any fallback path must log; the read path below logs explicitly.
      void writeLkgSnapshot({
        writtenAt: Date.now(),
        directories: result.directories,
        config: result.config,
      })
      return result
    } catch (err) {
      if (!isConfigParseError(err)) throw err
      const snapshot = await readLkgSnapshot()
      if (!snapshot) {
        log.warn("config parse failed and no last-known-good snapshot available; propagating error", {
          error: (err as any)?.data ?? String(err),
        })
        throw err
      }
      const errData = (err as any)?.data ?? {}
      log.warn("config parse failed — serving last-known-good snapshot", {
        failedPath: errData.path,
        line: errData.line,
        hint: errData.hint,
        lkgWrittenAt: new Date(snapshot.writtenAt).toISOString(),
      })
      return {
        config: snapshot.config,
        directories: snapshot.directories,
        deps: [] as Promise<void>[],
        configStale: true,
      }
    }
  }

  async function createStateInner() {
    const auth = await Auth.all()

    // Load remote/well-known config first as the base layer (lowest precedence)
    // This allows organizations to provide default configs that users can override
    let result: Info = {}
    for (const [key, value] of Object.entries(auth)) {
      if (value.type === "wellknown") {
        process.env[value.key] = value.token
        log.debug("fetching remote config", { url: `${key}/.well-known/opencode` })
        const response = await fetch(`${key}/.well-known/opencode`)
        if (!response.ok) {
          throw new Error(`failed to fetch remote config from ${key}: ${response.status}`)
        }
        const wellknown = z
          .object({
            config: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough()
          .parse(await response.json())
        const remoteConfig = wellknown.config ?? {}
        // Add $schema to prevent load() from trying to write back to a non-existent file
        if (!remoteConfig.$schema) remoteConfig.$schema = "https://opencode.ai/config.json"
        result = mergeConfigConcatArrays(
          result,
          await load(JSON.stringify(remoteConfig), `${key}/.well-known/opencode`),
        )
        log.debug("loaded remote config from well-known", { url: key })
      }
    }

    // Global user config overrides remote config
    result = mergeConfigConcatArrays(result, await global())

    // Custom config path overrides global
    if (Flag.OPENCODE_CONFIG) {
      result = mergeConfigConcatArrays(result, await loadFile(Flag.OPENCODE_CONFIG))
      log.debug("loaded custom config", { path: Flag.OPENCODE_CONFIG })
    }

    // This build disables project-level config by default to keep runtime behavior globally deterministic.
    // In test environment, keep project-level config load path available so legacy/coverage tests can
    // validate merge precedence and migration behavior unless explicitly disabled.
    // @event_2026-02-21_test_baseline_project_config_gate
    const projectConfigEnabled = process.env.NODE_ENV === "test" && !Flag.OPENCODE_DISABLE_PROJECT_CONFIG

    const projectConfigStop = Instance.project.vcs ? Instance.worktree : undefined

    // Project config has highest precedence (overrides global and remote)
    if (projectConfigEnabled) {
      for (const file of ["opencode.jsonc", "opencode.json"]) {
        const found = await Filesystem.findUp(file, Instance.directory, projectConfigStop)
        for (const resolved of found.toReversed()) {
          result = mergeConfigConcatArrays(result, await loadFile(resolved))
        }
      }
      // @plans/config-restructure Phase 3: project-level split files load too,
      // but with section-level isolation so a broken sub-file does not abort
      // daemon boot.
      for (const [subFile, section] of [
        ["providers.json", "providers"],
        ["mcp.json", "mcp"],
      ] as const) {
        const found = await Filesystem.findUp(subFile, Instance.directory, projectConfigStop)
        for (const resolved of found.toReversed()) {
          result = mergeConfigConcatArrays(result, await loadSectionFile(resolved, section))
        }
      }
    }

    result.agent = result.agent || {}
    result.mode = result.mode || {}
    result.plugin = result.plugin || []

    // @event_2026-02-07_install: prefer XDG config/data, keep project .opencode
    const projectOpencodeDirs = projectConfigEnabled
      ? await Array.fromAsync(
          Filesystem.up({
            targets: [".opencode"],
            start: Instance.directory,
            stop: projectConfigStop,
          }),
        )
      : []

    // @event_2026-02-10_xdg_cleanup: Strictly exclude ~/.opencode from implicit loading
    // to prevent legacy global config from bleeding into project configuration.
    const legacyGlobalDir = path.join(os.homedir(), ".opencode")
    const filteredProjectDirs = projectOpencodeDirs.filter((dir) => dir !== legacyGlobalDir)

    const directories = [Global.Path.config, Global.Path.data, ...filteredProjectDirs]

    if (Flag.OPENCODE_CONFIG_DIR) {
      directories.push(Flag.OPENCODE_CONFIG_DIR)
      log.debug("loading config from OPENCODE_CONFIG_DIR", { path: Flag.OPENCODE_CONFIG_DIR })
    }

    const deps: Promise<void>[] = []
    for (const dir of unique(directories)) {
      if (dir === Global.Path.config || dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR) {
        for (const file of ["opencode.jsonc", "opencode.json"]) {
          log.debug(`loading config from ${path.join(dir, file)}`)
          result = mergeConfigConcatArrays(result, await loadFile(path.join(dir, file)))
          // to satisfy the type checker
          result.agent ??= {}
          result.mode ??= {}
          result.plugin ??= []
        }
        // @plans/config-restructure Phase 3: opencode.json is for boot-critical
        // low-frequency keys ($schema, plugin, permissionMode). Providers and
        // MCP live in their own files; a parse failure in either only skips
        // that section (see loadSectionFile). Either file is optional — the
        // legacy all-in-one opencode.json format still works unchanged.
        for (const [subFile, section] of [
          ["providers.json", "providers"],
          ["mcp.json", "mcp"],
        ] as const) {
          const subPath = path.join(dir, subFile)
          const subData = await loadSectionFile(subPath, section)
          result = mergeConfigConcatArrays(result, subData)
          result.agent ??= {}
          result.mode ??= {}
          result.plugin ??= []
        }
      }

      const installing = installDependencies(dir)
      deps.push(installing)
      if (await needsInstall(dir)) await installing

      result.command = mergeDeep(result.command ?? {}, await loadCommand(dir))
      result.agent = mergeDeep(result.agent, await loadAgent(dir))
      result.agent = mergeDeep(result.agent, await loadMode(dir))
      result.plugin.push(...(await loadPlugin(dir)))
    }

    // Inline config content overrides all non-managed config sources.
    // Route through load() to enable {env:} and {file:} token substitution.
    // Use a path within Instance.directory so relative {file:} paths resolve correctly.
    // The filename "OPENCODE_CONFIG_CONTENT" appears in error messages for clarity.
    if (Flag.OPENCODE_CONFIG_CONTENT) {
      result = mergeConfigConcatArrays(
        result,
        await load(Flag.OPENCODE_CONFIG_CONTENT, path.join(Instance.directory, "OPENCODE_CONFIG_CONTENT")),
      )
      log.debug("loaded custom config from OPENCODE_CONFIG_CONTENT")
    }

    // Load managed config files last (highest priority) - enterprise admin-controlled
    // Kept separate from directories array to avoid write operations when installing plugins
    // which would fail on system directories requiring elevated permissions
    // This way it only loads config file and not skills/plugins/commands
    if (existsSync(managedConfigDir)) {
      for (const file of ["opencode.jsonc", "opencode.json"]) {
        result = mergeConfigConcatArrays(result, await loadFile(path.join(managedConfigDir, file)))
      }
    }

    // Migrate deprecated mode field to agent field
    for (const [name, mode] of Object.entries(result.mode ?? {})) {
      result.agent = mergeDeep(result.agent ?? {}, {
        [name]: {
          ...mode,
          mode: "primary" as const,
        },
      })
    }

    if (Flag.OPENCODE_PERMISSION) {
      result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.OPENCODE_PERMISSION))
    }

    // Backwards compatibility: legacy top-level `tools` config
    if (result.tools) {
      const perms: Record<string, Config.PermissionAction> = {}
      for (const [tool, enabled] of Object.entries(result.tools)) {
        const action: Config.PermissionAction = enabled ? "allow" : "deny"
        if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
          perms.edit = action
          continue
        }
        perms[tool] = action
      }
      result.permission = mergeDeep(perms, result.permission ?? {})
    }

    if (!result.username) result.username = os.userInfo().username

    if (result.share === undefined && result.autoshare === true) {
      result.share = "auto"
    }

    if (!result.keybinds) result.keybinds = Info.shape.keybinds.parse({})

    // Apply flag overrides for compaction settings
    if (Flag.OPENCODE_DISABLE_AUTOCOMPACT) {
      result.compaction = { ...result.compaction, auto: false }
    }
    if (Flag.OPENCODE_DISABLE_PRUNE) {
      result.compaction = { ...result.compaction, prune: false }
    }

    // Apply permission mode override from environment variable
    if (Flag.OPENCODE_PERMISSION_MODE) {
      result.permissionMode = Flag.OPENCODE_PERMISSION_MODE as Config.PermissionMode
    }

    result.plugin = deduplicatePlugins(result.plugin ?? [])

    // @event_2026-02-23_single_memory_mcp: keep one memory MCP surface
    result = normalizeMemoryConfig(result)

    // @event_2026-03-03_system_mcp_binary: prioritize system binaries over repo paths
    result = normalizeMcpCommands(result)

    // Validate layered memory configuration
    validateMemoryConfig(result)

    return {
      config: result,
      directories,
      deps,
    }
  }

  let stateGetter: (() => Promise<{ config: Info; directories: string[]; deps: Promise<void>[]; configStale?: boolean }>) | undefined
  let fallbackState: Promise<{ config: Info; directories: string[]; deps: Promise<void>[]; configStale?: boolean }> | undefined

  export function state() {
    if (typeof Instance.state === "function") {
      stateGetter ||= Instance.state(createState)
      return stateGetter()
    }

    fallbackState ||= createState()
    return fallbackState
  }

  export async function waitForDependencies() {
    const deps = await state().then((x) => x.deps)
    await Promise.all(deps)
  }

  function runtimePluginVersionTarget() {
    if (Installation.isLocal()) return "*"

    // CMS/custom build tags (ex: 0.0.0-cms-YYYYMMDDHHmm) are app build identifiers,
    // not guaranteed published npm versions for @opencode-ai/plugin.
    // @event_2026-02-21_runtime_plugin_version_hotfix
    if (Installation.VERSION.startsWith("0.0.0-")) return "latest"

    return Installation.VERSION
  }

  export async function installDependencies(dir: string) {
    // Some config dirs may be read-only.
    // Installing deps there will fail; skip installation in that case.
    if (!(await isWritable(dir))) {
      log.debug("config dir is not writable, skipping dependency install", { dir })
      return
    }

    // @event_2026-02-10_xdg_cleanup: Refuse to install deps in legacy global directory
    const legacyGlobalDir = path.join(os.homedir(), ".opencode")
    if (dir === legacyGlobalDir || dir.startsWith(legacyGlobalDir + path.sep)) {
      log.warn("Refusing to install dependencies in legacy global directory", { dir })
      return
    }

    // Additional safeguard: If dir IS homedir (unlikely for installDependencies but possible in some flows)
    if (dir === os.homedir()) {
      return
    }

    const pkg = path.join(dir, "package.json")
    const targetVersion = runtimePluginVersionTarget()

    const json = await Bun.file(pkg)
      .json()
      .catch(() => ({})) // Default to empty object if package.json missing or invalid
    json.dependencies = {
      ...json.dependencies,
      "@opencode-ai/plugin": targetVersion,
    }
    await Bun.write(pkg, JSON.stringify(json, null, 2))
    if (process.env.NODE_ENV !== "test") {
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }

    const gitignore = path.join(dir, ".gitignore")
    const hasGitIgnore = await Bun.file(gitignore).exists()
    if (!hasGitIgnore) await Bun.write(gitignore, ["node_modules", "package.json", "bun.lock", ".gitignore"].join("\n"))

    // Install any additional dependencies defined in the package.json
    // This allows local plugins and custom tools to use external packages
    await BunProc.run(["install", ...(process.env.CI ? ["--no-cache"] : [])], { cwd: dir }).catch((err) => {
      log.warn("failed to install dependencies", { dir, error: err })
    })
  }

  async function isWritable(dir: string) {
    try {
      await fs.access(dir, constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  async function needsInstall(dir: string) {
    // Some config dirs may be read-only.
    // Installing deps there will fail; skip installation in that case.
    const writable = await isWritable(dir)
    if (!writable) {
      log.debug("config dir is not writable, skipping dependency install", { dir })
      return false
    }

    const nodeModules = path.join(dir, "node_modules")
    if (!existsSync(nodeModules)) return true

    const pkg = path.join(dir, "package.json")
    const pkgFile = Bun.file(pkg)
    const pkgExists = await pkgFile.exists()
    if (!pkgExists) return true

    const parsed = await pkgFile.json().catch(() => null)
    const dependencies = parsed?.dependencies ?? {}
    const depVersion = dependencies["@opencode-ai/plugin"]
    if (!depVersion) return true

    const targetVersion = runtimePluginVersionTarget()
    return depVersion !== targetVersion
  }

  function rel(item: string, patterns: string[]) {
    const normalizedItem = item.replaceAll("\\", "/")
    for (const pattern of patterns) {
      const index = normalizedItem.indexOf(pattern)
      if (index === -1) continue
      return normalizedItem.slice(index + pattern.length)
    }
  }

  function trim(file: string) {
    const ext = path.extname(file)
    return ext.length ? file.slice(0, -ext.length) : file
  }

  const COMMAND_GLOB = new Bun.Glob("{command,commands}/**/*.md")
  async function loadCommand(dir: string) {
    const result: Record<string, Command> = {}
    for await (const item of COMMAND_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse command ${item}`
        const { Session } = await import("@/session")
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load command", { command: item, err })
        return undefined
      })
      if (!md) continue

      const patterns = ["/.opencode/command/", "/.opencode/commands/", "/command/", "/commands/"]
      const file = rel(item, patterns) ?? path.basename(item)
      const name = trim(file)

      const config = {
        name,
        ...md.data,
        template: md.content.trim(),
      }
      const parsed = Command.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }

  const AGENT_GLOB = new Bun.Glob("{agent,agents}/**/*.md")
  async function loadAgent(dir: string) {
    const result: Record<string, Agent> = {}

    for await (const item of AGENT_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse agent ${item}`
        const { Session } = await import("@/session")
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load agent", { agent: item, err })
        return undefined
      })
      if (!md) continue

      const patterns = ["/.opencode/agent/", "/.opencode/agents/", "/agent/", "/agents/"]
      const file = rel(item, patterns) ?? path.basename(item)
      const agentName = trim(file)

      const config = {
        name: agentName,
        ...md.data,
        prompt: md.content.trim(),
      }
      const parsed = Agent.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }

  const MODE_GLOB = new Bun.Glob("{mode,modes}/*.md")
  async function loadMode(dir: string) {
    const result: Record<string, Agent> = {}
    for await (const item of MODE_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse mode ${item}`
        const { Session } = await import("@/session")
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load mode", { mode: item, err })
        return undefined
      })
      if (!md) continue

      const config = {
        name: path.basename(item, ".md"),
        ...md.data,
        prompt: md.content.trim(),
      }
      const parsed = Agent.safeParse(config)
      if (parsed.success) {
        result[config.name] = {
          ...parsed.data,
          mode: "primary" as const,
        }
        continue
      }
    }
    return result
  }

  const PLUGIN_GLOB = new Bun.Glob("{plugin,plugins}/*.{ts,js}")
  async function loadPlugin(dir: string) {
    const plugins: string[] = []

    for await (const item of PLUGIN_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      plugins.push(pathToFileURL(item).href)
    }
    return plugins
  }

  /**
   * Extracts a canonical plugin name from a plugin specifier.
   * - For file:// URLs: extracts filename without extension
   * - For npm packages: extracts package name without version
   *
   * @example
   * getPluginName("file:///path/to/plugin/foo.js") // "foo"
   * getPluginName("oh-my-opencode@2.4.3") // "oh-my-opencode"
   * getPluginName("@scope/pkg@1.0.0") // "@scope/pkg"
   */
  export function getPluginName(plugin: string): string {
    if (plugin.startsWith("file://")) {
      return path.parse(new URL(plugin).pathname).name
    }
    const lastAt = plugin.lastIndexOf("@")
    if (lastAt > 0) {
      return plugin.substring(0, lastAt)
    }
    return plugin
  }

  /**
   * Deduplicates plugins by name, with later entries (higher priority) winning.
   * Priority order (highest to lowest):
   * 1. Local plugin/ directory
   * 2. Local opencode.json
   * 3. Global plugin/ directory
   * 4. Global opencode.json
   *
   * Since plugins are added in low-to-high priority order,
   * we reverse, deduplicate (keeping first occurrence), then restore order.
   */
  export function deduplicatePlugins(plugins: string[]): string[] {
    // seenNames: canonical plugin names for duplicate detection
    // e.g., "oh-my-opencode", "@scope/pkg"
    const seenNames = new Set<string>()

    // uniqueSpecifiers: full plugin specifiers to return
    // e.g., "oh-my-opencode@2.4.3", "file:///path/to/plugin.js"
    const uniqueSpecifiers: string[] = []

    for (const specifier of plugins.toReversed()) {
      const name = getPluginName(specifier)
      if (!seenNames.has(name)) {
        seenNames.add(name)
        uniqueSpecifiers.push(specifier)
      }
    }

    return uniqueSpecifiers.toReversed()
  }

  export const McpLocal = z
    .object({
      type: z.literal("local").describe("Type of MCP server connection"),
      command: z.string().array().describe("Command and arguments to run the MCP server"),
      environment: z
        .record(z.string(), z.string())
        .optional()
        .describe("Environment variables to set when running the MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    })
    .strict()
    .meta({
      ref: "McpLocalConfig",
    })

  export const McpOAuth = z
    .object({
      clientId: z
        .string()
        .optional()
        .describe("OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted."),
      clientSecret: z.string().optional().describe("OAuth client secret (if required by the authorization server)"),
      scope: z.string().optional().describe("OAuth scopes to request during authorization"),
    })
    .strict()
    .meta({
      ref: "McpOAuthConfig",
    })
  export type McpOAuth = z.infer<typeof McpOAuth>

  export const McpRemote = z
    .object({
      type: z.literal("remote").describe("Type of MCP server connection"),
      url: z.string().describe("URL of the remote MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      headers: z.record(z.string(), z.string()).optional().describe("Headers to send with the request"),
      oauth: z
        .union([McpOAuth, z.literal(false)])
        .optional()
        .describe(
          "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    })
    .strict()
    .meta({
      ref: "McpRemoteConfig",
    })

  export const Mcp = z.discriminatedUnion("type", [McpLocal, McpRemote])
  export type Mcp = z.infer<typeof Mcp>

  export const PermissionAction = z.enum(["ask", "allow", "deny"]).meta({
    ref: "PermissionActionConfig",
  })
  export type PermissionAction = z.infer<typeof PermissionAction>

  export const PermissionObject = z.record(z.string(), PermissionAction).meta({
    ref: "PermissionObjectConfig",
  })
  export type PermissionObject = z.infer<typeof PermissionObject>

  export const PermissionRule = z.union([PermissionAction, PermissionObject]).meta({
    ref: "PermissionRuleConfig",
  })
  export type PermissionRule = z.infer<typeof PermissionRule>

  // Capture original key order before zod reorders, then rebuild in original order
  const permissionPreprocess = (val: unknown) => {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      return { __originalKeys: Object.keys(val), ...val }
    }
    return val
  }

  const permissionTransform = (x: unknown): Record<string, PermissionRule> => {
    if (typeof x === "string") return { "*": x as PermissionAction }
    const obj = x as { __originalKeys?: string[] } & Record<string, unknown>
    const { __originalKeys, ...rest } = obj
    if (!__originalKeys) return rest as Record<string, PermissionRule>
    const result: Record<string, PermissionRule> = {}
    for (const key of __originalKeys) {
      if (key in rest) result[key] = rest[key] as PermissionRule
    }
    return result
  }

  export const Permission = z
    .preprocess(
      permissionPreprocess,
      z
        .object({
          __originalKeys: z.string().array().optional(),
          read: PermissionRule.optional(),
          edit: PermissionRule.optional(),
          glob: PermissionRule.optional(),
          grep: PermissionRule.optional(),
          list: PermissionRule.optional(),
          bash: PermissionRule.optional(),
          task: PermissionRule.optional(),
          external_directory: PermissionRule.optional(),
          todowrite: PermissionAction.optional(),
          todoread: PermissionAction.optional(),
          question: PermissionAction.optional(),
          webfetch: PermissionAction.optional(),
          websearch: PermissionAction.optional(),
          codesearch: PermissionAction.optional(),
          lsp: PermissionRule.optional(),
          doom_loop: PermissionAction.optional(),
          skill: PermissionRule.optional(),
        })
        .catchall(PermissionRule)
        .or(PermissionAction),
    )
    .transform(permissionTransform)
    .meta({
      ref: "PermissionConfig",
    })
  export type Permission = z.infer<typeof Permission>

  export const PermissionMode = z.enum(["ask", "auto"]).meta({
    ref: "PermissionMode",
  })
  export type PermissionMode = z.infer<typeof PermissionMode>

  export const Command = z.object({
    template: z.string(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional().meta(ModelRef),
    subtask: z.boolean().optional(),
  })
  export type Command = z.infer<typeof Command>

  export const Skills = z.object({
    paths: z.array(z.string()).optional().describe("Additional paths to skill folders"),
    urls: z.array(z.string()).optional().describe("URLs to download skills from"),
  })
  export type Skills = z.infer<typeof Skills>

  export const Agent = z
    .object({
      model: z.string().optional().meta(ModelRef),
      variant: z
        .string()
        .optional()
        .describe("Default model variant for this agent (applies only when using the agent's configured model)."),
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      prompt: z.string().optional(),
      tools: z.record(z.string(), z.boolean()).optional().describe("@deprecated Use 'permission' field instead"),
      disable: z.boolean().optional(),
      description: z.string().optional().describe("Description of when to use the agent"),
      mode: z.enum(["subagent", "primary", "all"]).optional(),
      hidden: z
        .boolean()
        .optional()
        .describe("Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)"),
      options: z.record(z.string(), z.any()).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color format")
        .optional()
        .describe("Hex color code for the agent (e.g., #FF5733)"),
      steps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of agentic iterations before forcing text-only response"),
      maxSteps: z.number().int().positive().optional().describe("@deprecated Use 'steps' field instead."),
      permission: Permission.optional(),
    })
    .catchall(z.any())
    .transform((agent, ctx) => {
      const knownKeys = new Set([
        "name",
        "model",
        "variant",
        "prompt",
        "description",
        "temperature",
        "top_p",
        "mode",
        "hidden",
        "color",
        "steps",
        "maxSteps",
        "options",
        "permission",
        "disable",
        "tools",
      ])

      // Extract unknown properties into options
      const options: Record<string, unknown> = { ...agent.options }
      for (const [key, value] of Object.entries(agent)) {
        if (!knownKeys.has(key)) options[key] = value
      }

      // Convert legacy tools config to permissions
      const permission: Permission = {}
      for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
        const action = enabled ? "allow" : "deny"
        // write, edit, patch, multiedit all map to edit permission
        if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
          permission.edit = action
        } else {
          permission[tool] = action
        }
      }
      Object.assign(permission, agent.permission)

      // Convert legacy maxSteps to steps
      const steps = agent.steps ?? agent.maxSteps

      return { ...agent, options, permission, steps } as typeof agent & {
        options?: Record<string, unknown>
        permission?: Permission
        steps?: number
      }
    })
    .meta({
      ref: "AgentConfig",
    })
  export type Agent = z.infer<typeof Agent>

  export const Keybinds = z
    .object({
      leader: z.string().optional().default("ctrl+x").describe("Leader key for keybind combinations"),
      app_exit: z.string().optional().default("ctrl+c,ctrl+d,<leader>q").describe("Exit the application"),
      editor_open: z.string().optional().default("<leader>e").describe("Open external editor"),
      theme_list: z.string().optional().default("<leader>t").describe("List available themes"),
      sidebar_toggle: z.string().optional().default("<leader>b").describe("Toggle sidebar"),
      scrollbar_toggle: z.string().optional().default("none").describe("Toggle session scrollbar"),
      username_toggle: z.string().optional().default("none").describe("Toggle username visibility"),
      status_view: z.string().optional().default("<leader>s").describe("View status"),
      session_export: z.string().optional().default("<leader>x").describe("Export session to editor"),
      session_new: z.string().optional().default("<leader>n").describe("Create a new session"),
      session_list: z.string().optional().default("<leader>l").describe("List all sessions"),
      session_timeline: z.string().optional().default("<leader>g").describe("Show session timeline"),
      session_fork: z.string().optional().default("none").describe("Fork session from message"),
      session_rename: z.string().optional().default("ctrl+r").describe("Rename session"),
      session_delete: z.string().optional().default("ctrl+d").describe("Delete session"),
      stash_delete: z.string().optional().default("ctrl+d").describe("Delete stash entry"),
      model_provider_list: z.string().optional().default("ctrl+a").describe("Open provider list from model dialog"),
      model_favorite_toggle: z.string().optional().default("ctrl+f").describe("Toggle model favorite status"),
      session_share: z.string().optional().default("none").describe("Share current session"),
      session_unshare: z.string().optional().default("none").describe("Unshare current session"),
      session_interrupt: z.string().optional().default("escape").describe("Interrupt current session"),
      session_compact: z.string().optional().default("<leader>c").describe("Compact the session"),
      messages_page_up: z.string().optional().default("pageup,ctrl+alt+b").describe("Scroll messages up by one page"),
      messages_page_down: z
        .string()
        .optional()
        .default("pagedown,ctrl+alt+f")
        .describe("Scroll messages down by one page"),
      messages_line_up: z.string().optional().default("ctrl+alt+y").describe("Scroll messages up by one line"),
      messages_line_down: z.string().optional().default("ctrl+alt+e").describe("Scroll messages down by one line"),
      messages_half_page_up: z.string().optional().default("ctrl+alt+u").describe("Scroll messages up by half page"),
      messages_half_page_down: z
        .string()
        .optional()
        .default("ctrl+alt+d")
        .describe("Scroll messages down by half page"),
      messages_first: z.string().optional().default("ctrl+g,home").describe("Navigate to first message"),
      messages_last: z.string().optional().default("ctrl+alt+g,end").describe("Navigate to last message"),
      messages_next: z.string().optional().default("none").describe("Navigate to next message"),
      messages_previous: z.string().optional().default("none").describe("Navigate to previous message"),
      messages_last_user: z.string().optional().default("none").describe("Navigate to last user message"),
      messages_copy: z.string().optional().default("<leader>y").describe("Copy message"),
      messages_undo: z.string().optional().default("<leader>u").describe("Undo message"),
      messages_redo: z.string().optional().default("<leader>r").describe("Redo message"),
      messages_toggle_conceal: z
        .string()
        .optional()
        .default("<leader>h")
        .describe("Toggle code block concealment in messages"),
      tool_details: z.string().optional().default("none").describe("Toggle tool details visibility"),
      model_list: z.string().optional().default("<leader>m").describe("List available models"),
      model_cycle_recent: z.string().optional().default("f2").describe("Next recently used model"),
      model_cycle_recent_reverse: z.string().optional().default("shift+f2").describe("Previous recently used model"),
      model_cycle_favorite: z.string().optional().default("none").describe("Next favorite model"),
      model_cycle_favorite_reverse: z.string().optional().default("none").describe("Previous favorite model"),
      admin_panel: z.string().optional().default("none").describe("Open admin panel"),
      command_list: z.string().optional().default("ctrl+p,<leader>p").describe("List available commands"),
      agent_list: z.string().optional().default("<leader>a").describe("List agents"),
      agent_cycle: z.string().optional().default("tab").describe("Next agent"),
      agent_cycle_reverse: z.string().optional().default("shift+tab").describe("Previous agent"),
      variant_cycle: z.string().optional().default("ctrl+t").describe("Cycle model variants"),
      input_clear: z.string().optional().default("ctrl+c").describe("Clear input field"),
      input_paste: z.string().optional().default("ctrl+v").describe("Paste from clipboard"),
      input_submit: z.string().optional().default("return").describe("Submit input"),
      input_newline: z
        .string()
        .optional()
        .default("shift+return,shift+enter,ctrl+return,ctrl+enter,alt+return,alt+enter,ctrl+j")
        .describe("Insert newline in input"),
      input_move_left: z.string().optional().default("left,ctrl+b").describe("Move cursor left in input"),
      input_move_right: z.string().optional().default("right,ctrl+f").describe("Move cursor right in input"),
      input_move_up: z.string().optional().default("up").describe("Move cursor up in input"),
      input_move_down: z.string().optional().default("down").describe("Move cursor down in input"),
      input_select_left: z.string().optional().default("shift+left").describe("Select left in input"),
      input_select_right: z.string().optional().default("shift+right").describe("Select right in input"),
      input_select_up: z.string().optional().default("shift+up").describe("Select up in input"),
      input_select_down: z.string().optional().default("shift+down").describe("Select down in input"),
      input_line_home: z.string().optional().default("ctrl+a,home").describe("Move to start of line in input"),
      input_line_end: z.string().optional().default("ctrl+e,end").describe("Move to end of line in input"),
      input_select_line_home: z
        .string()
        .optional()
        .default("ctrl+shift+a,shift+home")
        .describe("Select to start of line in input"),
      input_select_line_end: z
        .string()
        .optional()
        .default("ctrl+shift+e,shift+end")
        .describe("Select to end of line in input"),
      input_visual_line_home: z.string().optional().default("alt+a").describe("Move to start of visual line in input"),
      input_visual_line_end: z.string().optional().default("alt+e").describe("Move to end of visual line in input"),
      input_select_visual_line_home: z
        .string()
        .optional()
        .default("alt+shift+a")
        .describe("Select to start of visual line in input"),
      input_select_visual_line_end: z
        .string()
        .optional()
        .default("alt+shift+e")
        .describe("Select to end of visual line in input"),
      input_buffer_home: z.string().optional().default("ctrl+home").describe("Move to start of buffer in input"),
      input_buffer_end: z.string().optional().default("ctrl+end").describe("Move to end of buffer in input"),
      input_select_buffer_home: z
        .string()
        .optional()
        .default("ctrl+shift+home")
        .describe("Select to start of buffer in input"),
      input_select_buffer_end: z
        .string()
        .optional()
        .default("ctrl+shift+end")
        .describe("Select to end of buffer in input"),
      input_delete_line: z.string().optional().default("ctrl+shift+d").describe("Delete line in input"),
      input_delete_to_line_end: z.string().optional().default("ctrl+k").describe("Delete to end of line in input"),
      input_delete_to_line_start: z.string().optional().default("ctrl+u").describe("Delete to start of line in input"),
      input_backspace: z.string().optional().default("backspace,shift+backspace").describe("Backspace in input"),
      input_delete: z.string().optional().default("ctrl+d,delete,shift+delete").describe("Delete character in input"),
      input_undo: z.string().optional().default("ctrl+-,super+z").describe("Undo in input"),
      input_redo: z.string().optional().default("ctrl+.,super+shift+z").describe("Redo in input"),
      input_word_forward: z
        .string()
        .optional()
        .default("alt+f,alt+right,ctrl+right")
        .describe("Move word forward in input"),
      input_word_backward: z
        .string()
        .optional()
        .default("alt+b,alt+left,ctrl+left")
        .describe("Move word backward in input"),
      input_select_word_forward: z
        .string()
        .optional()
        .default("alt+shift+f,alt+shift+right")
        .describe("Select word forward in input"),
      input_select_word_backward: z
        .string()
        .optional()
        .default("alt+shift+b,alt+shift+left")
        .describe("Select word backward in input"),
      input_delete_word_forward: z
        .string()
        .optional()
        .default("alt+d,alt+delete,ctrl+delete")
        .describe("Delete word forward in input"),
      input_delete_word_backward: z
        .string()
        .optional()
        .default("ctrl+w,ctrl+backspace,alt+backspace")
        .describe("Delete word backward in input"),
      history_previous: z.string().optional().default("up").describe("Previous history item"),
      history_next: z.string().optional().default("down").describe("Next history item"),
      session_child_cycle: z.string().optional().default("<leader>right").describe("Next child session"),
      session_child_cycle_reverse: z.string().optional().default("<leader>left").describe("Previous child session"),
      session_parent: z.string().optional().default("<leader>up").describe("Go to parent session"),
      terminal_suspend: z.string().optional().default("ctrl+z").describe("Suspend terminal"),
      terminal_title_toggle: z.string().optional().default("none").describe("Toggle terminal title"),
      tips_toggle: z.string().optional().default("<leader>h").describe("Toggle tips on home screen"),
    })
    .strict()
    .meta({
      ref: "KeybindsConfig",
    })

  export const TUI = z.object({
    scroll_speed: z.number().min(0.001).optional().describe("TUI scroll speed"),
    scroll_acceleration: z
      .object({
        enabled: z.boolean().describe("Enable scroll acceleration"),
      })
      .optional()
      .describe("Scroll acceleration settings"),
    diff_style: z
      .enum(["auto", "stacked"])
      .optional()
      .describe("Control diff rendering style: 'auto' adapts to terminal width, 'stacked' always shows single column"),
  })

  export const Server = z
    .object({
      port: z.number().int().positive().optional().describe("Port to listen on"),
      hostname: z.string().optional().describe("Hostname to listen on"),
      mdns: z.boolean().optional().describe("Enable mDNS service discovery"),
      cors: z.array(z.string()).optional().describe("Additional domains to allow for CORS"),
    })
    .strict()
    .meta({
      ref: "ServerConfig",
    })

  export const Layout = z.enum(["auto", "stretch"]).meta({
    ref: "LayoutConfig",
  })
  export type Layout = z.infer<typeof Layout>

  export const Provider = ModelsDev.Provider.partial()
    .extend({
      billingMode: z
        .enum(["token", "request", "unknown"])
        .optional()
        .describe("Provider billing mode authority for prompt-management policy: token, request, or unknown"),
      freeToUse: z
        .boolean()
        .optional()
        .describe("Mark this provider as usable without any configured account; UI should label it as FreeToUse"),
      lite: z
        .boolean()
        .optional()
        .describe(
          "Lite mode for small local models. Bypasses tool calls, MCP, agents, enablement, and heavy system prompts. Only injects a minimal system prompt suitable for simple Q&A tasks.",
        ),
      whitelist: z.array(z.string()).optional(),
      blacklist: z.array(z.string()).optional(),
      models: z
        .record(
          z.string(),
          ModelsDev.Model.partial().extend({
            variants: z
              .record(
                z.string(),
                z
                  .object({
                    disabled: z.boolean().optional().describe("Disable this variant for the model"),
                  })
                  .catchall(z.any()),
              )
              .optional()
              .describe("Variant-specific configuration"),
            defaultSystemDirective: z
              .string()
              .optional()
              .describe(
                "System prompt directive injected when no variant is selected (e.g. '/no_think' for Qwen3 models)",
              ),
          }),
        )
        .optional(),
      options: z
        .object({
          apiKey: z.string().optional(),
          baseURL: z.string().optional(),
          enterpriseUrl: z.string().optional().describe("GitHub Enterprise URL for copilot authentication"),
          setCacheKey: z.boolean().optional().describe("Enable promptCacheKey for this provider (default false)"),
          timeout: z
            .union([
              z
                .number()
                .int()
                .positive()
                .describe(
                  "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
                ),
              z.literal(false).describe("Disable timeout for this provider entirely."),
            ])
            .optional()
            .describe(
              "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
            ),
        })
        .catchall(z.any())
        .optional(),
    })
    .strict()
    .meta({
      ref: "ProviderConfig",
    })
  export type Provider = z.infer<typeof Provider>

  export const Info = z
    .object({
      $schema: z.string().optional().describe("JSON schema reference for configuration validation"),
      theme: z.string().optional().describe("Theme name to use for the interface"),
      keybinds: Keybinds.optional().describe("Custom keybind configurations"),
      logLevel: Log.Level.optional().describe("Log level"),
      tui: TUI.optional().describe("TUI specific settings"),
      server: Server.optional().describe("Server configuration for opencode serve and web commands"),
      command: z
        .record(z.string(), Command)
        .optional()
        .describe("Command configuration, see https://opencode.ai/docs/commands"),
      skills: Skills.optional().describe("Additional skill folder paths"),
      watcher: z
        .object({
          ignore: z.array(z.string()).optional(),
        })
        .optional(),
      plugin: z.string().array().optional(),
      snapshot: z.boolean().optional(),
      share: z
        .enum(["manual", "auto", "disabled"])
        .optional()
        .describe(
          "Control sharing behavior:'manual' allows manual sharing via commands, 'auto' enables automatic sharing, 'disabled' disables all sharing",
        ),
      autoshare: z
        .boolean()
        .optional()
        .describe("@deprecated Use 'share' field instead. Share newly created sessions automatically"),
      autoupdate: z
        .union([z.boolean(), z.literal("notify")])
        .optional()
        .describe(
          "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
        ),
      disabled_providers: z.array(z.string()).optional().describe("Disable providers that are loaded automatically"),
      enabled_providers: z
        .array(z.string())
        .optional()
        .describe("When set, ONLY these providers will be enabled. All other providers will be ignored"),
      model: z
        .string()
        .describe("Model to use in the format of provider/model, eg anthropic/claude-2")
        .optional()
        .meta(ModelRef),
      small_model: z
        .string()
        .describe("Small model to use for tasks like title generation in the format of provider/model")
        .optional()
        .meta(ModelRef),
      default_agent: z
        .string()
        .optional()
        .describe(
          "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
        ),
      username: z
        .string()
        .optional()
        .describe("Custom username to display in conversations instead of system username"),
      mode: z
        .object({
          build: Agent.optional(),
          plan: Agent.optional(),
        })
        .catchall(Agent)
        .optional()
        .describe("@deprecated Use `agent` field instead."),
      agent: z
        .object({
          // primary
          plan: Agent.optional(),
          build: Agent.optional(),
          // subagent
          general: Agent.optional(),
          explore: Agent.optional(),
          // specialized
          title: Agent.optional(),
          summary: Agent.optional(),
          compaction: Agent.optional(),
        })
        .catchall(Agent)
        .optional()
        .describe("Agent configuration, see https://opencode.ai/docs/agents"),
      provider: z
        .record(z.string(), Provider)
        .optional()
        .describe("Custom provider configurations and model overrides"),
      mcp: z
        .record(
          z.string(),
          z.union([
            Mcp,
            z
              .object({
                enabled: z.boolean(),
              })
              .strict(),
          ]),
        )
        .optional()
        .describe("MCP (Model Context Protocol) server configurations"),
      formatter: z
        .union([
          z.literal(false),
          z.record(
            z.string(),
            z.object({
              disabled: z.boolean().optional(),
              command: z.array(z.string()).optional(),
              environment: z.record(z.string(), z.string()).optional(),
              extensions: z.array(z.string()).optional(),
            }),
          ),
        ])
        .optional(),
      lsp: z
        .union([
          z.literal(false),
          z.record(
            z.string(),
            z.union([
              z.object({
                disabled: z.literal(true),
              }),
              z.object({
                command: z.array(z.string()),
                extensions: z.array(z.string()).optional(),
                disabled: z.boolean().optional(),
                env: z.record(z.string(), z.string()).optional(),
                initialization: z.record(z.string(), z.any()).optional(),
              }),
            ]),
          ),
        ])
        .optional()
        .refine(
          (data) => {
            if (!data) return true
            if (typeof data === "boolean") return true
            const serverIds = new Set(Object.values(LSPServer).map((s) => s.id))

            return Object.entries(data).every(([id, config]) => {
              if (config.disabled) return true
              if (serverIds.has(id)) return true
              return Boolean(config.extensions)
            })
          },
          {
            error: "For custom LSP servers, 'extensions' array is required.",
          },
        ),
      instructions: z.array(z.string()).optional().describe("Additional instruction files or patterns to include"),
      layout: Layout.optional().describe("@deprecated Always uses stretch layout."),
      permission: Permission.optional(),
      permissionMode: PermissionMode.optional().describe(
        "Permission mode: 'ask' to prompt for permissions (default), 'auto' to allow all",
      ),
      tools: z.record(z.string(), z.boolean()).optional(),
      enterprise: z
        .object({
          url: z.string().optional().describe("Enterprise URL"),
        })
        .optional(),
      compaction: z
        .object({
          auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
          prune: z
            .boolean()
            .optional()
            .describe(
              "@deprecated 2026-04-28: tool-output prune retired (cache-hostile). Setting this is silently ignored. Single compaction gate at overflowThreshold (default 90%) handles all context management.",
            ),
          reserved: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Token buffer for compaction. Leaves enough window to avoid overflow during compaction."),
          headroom: z
            .number()
            .int()
            .min(2000)
            .optional()
            .describe(
              "Minimum tokens to keep free before triggering compaction (default: 8000). Lower values delay compaction longer, preserving LLM cache but risking tighter context.",
            ),
          cooldownRounds: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              "Minimum user-visible rounds between compactions (default: 8). Prevents compaction oscillation that destroys LLM server-side cache.",
            ),
          sharedContext: z
            .boolean()
            .optional()
            .describe("Enable shared context space for structured knowledge tracking (default: true)"),
          sharedContextBudget: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Token budget for the shared context space itself (default: 8192)"),
          opportunisticThreshold: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              "Context utilization threshold for idle compaction after task dispatch (default: 0.6). Set to 1.0 to disable.",
            ),
          overflowThreshold: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              "When set, overrides the legacy reserved-based usable budget formula. Compaction fires when count >= context * threshold. Recommended: 0.9 to fire at 90% of context. Default: undefined (legacy reserved-based, ~70% for codex/byToken billing).",
            ),
          pruneUtilizationFloor: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              "@deprecated 2026-04-28: prune retired (see `prune` field). Silently ignored.",
            ),
          targetPromptTokens: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Hard cap on the post-compaction prompt size. Local kinds (narrative / replay-tail) are capped at this budget. If a local kind succeeds but its summary still exceeds this target, run() escalates to the next paid kind in the chain (double-phase). Default: 50000.",
            ),
        })
        .optional(),
      experimental: z
        .object({
          hook: z
            .object({
              file_edited: z
                .record(
                  z.string(),
                  z
                    .object({
                      command: z.string().array(),
                      environment: z.record(z.string(), z.string()).optional(),
                    })
                    .array(),
                )
                .optional(),
              session_completed: z
                .object({
                  command: z.string().array(),
                  environment: z.record(z.string(), z.string()).optional(),
                })
                .array()
                .optional(),
            })
            .optional(),
          chatMaxRetries: z.number().optional().describe("Number of retries for chat completions on failure"),
          disable_paste_summary: z.boolean().optional(),
          batch_tool: z.boolean().optional().describe("Enable the batch tool"),
          openTelemetry: z
            .boolean()
            .optional()
            .describe("Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)"),
          primary_tools: z
            .array(z.string())
            .optional()
            .describe("Tools that should only be available to primary agents."),
          continue_loop_on_deny: z.boolean().optional().describe("Continue the agent loop when a tool call is denied"),
          subagent_workflow: z
            .object({
              enabled: z.boolean().optional().describe("Enable automatic subagent workflow"),
              keywords: z.array(z.string()).optional().describe("Keywords that trigger subagent delegation"),
              roles: z.array(z.string()).optional().describe("Ordered subagent roles to execute"),
              min_chars: z.number().int().positive().optional().describe("Minimum characters to treat as non-trivial"),
              min_lines: z.number().int().positive().optional().describe("Minimum lines to treat as non-trivial"),
              models: z
                .record(z.string(), z.string())
                .optional()
                .describe("Per-role model overrides in provider/model format"),
            })
            .optional(),
          smart_runner: z
            .object({
              enabled: z.boolean().optional().describe("Enable Smart Runner dry-run tracing"),
              assist: z.boolean().optional().describe("Allow Smart Runner to refine low-risk continuation wording"),
            })
            .optional(),
          mcp_timeout: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Timeout in milliseconds for model context protocol (MCP) requests"),
          task_timeout: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Timeout in milliseconds for subagent task execution. Default is 600000 (10 minutes)."),
          lazy_tools: z
            .object({
              enabled: z.boolean().optional().describe("Enable lazy tool loading for primary agents (default: true)"),
              always_present: z
                .array(z.string())
                .optional()
                .describe("Additional tool IDs to always include without needing tool_loader"),
            })
            .optional(),
        })
        .optional(),
    })
    .strict()
    .meta({
      ref: "Config",
    })

  export type Info = z.output<typeof Info>

  export const global = lazy(async () => {
    let result: Info = pipe(
      {},
      mergeDeep(await loadFile(path.join(Global.Path.config, "config.json"))),
      mergeDeep(await loadFile(path.join(Global.Path.config, "opencode.json"))),
      mergeDeep(await loadFile(path.join(Global.Path.config, "opencode.jsonc"))),
    )

    const legacy = path.join(Global.Path.config, "config")
    if (existsSync(legacy)) {
      await import(pathToFileURL(legacy).href, {
        with: {
          type: "toml",
        },
      })
        .then(async (mod) => {
          const { provider, model, ...rest } = mod.default
          if (provider && model) result.model = `${provider}/${model}`
          result["$schema"] = "https://opencode.ai/config.json"
          result = mergeDeep(result, rest)
          await Bun.write(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
          await fs.unlink(legacy)
        })
        .catch(() => {
          // Expected failure if file is not TOML or doesn't exist
        })
    }

    return result
  })

  async function loadFile(filepath: string): Promise<Info> {
    // @event_2026-02-07_install: guard missing config files on startup
    log.info("loading", { path: filepath })
    const file = Bun.file(filepath)
    if (!(await file.exists())) return {}
    const text = await file.text().catch((err) => {
      if (err.code === "ENOENT") return
      throw new JsonError({ path: filepath }, { cause: err })
    })
    if (!text) return {}
    return load(text, filepath)
  }

  /**
   * @plans/config-restructure Phase 3: section-isolated loader for
   * sub-config files (providers.json, mcp.json). Unlike the main
   * opencode.json, a parse/schema failure in a sub-file does NOT abort
   * daemon boot — we log.warn and return empty so the remaining sections
   * still load. AGENTS.md rule #1: the log line identifies which section
   * was skipped and why.
   */
  async function loadSectionFile(filepath: string, section: string): Promise<Info> {
    try {
      return await loadFile(filepath)
    } catch (err) {
      if (JsonError.isInstance(err) || InvalidError.isInstance(err)) {
        const data = (err as any).data ?? {}
        log.warn(`${section} section failed to parse — skipping this section`, {
          path: data.path ?? filepath,
          line: data.line,
          column: data.column,
          hint: data.hint,
        })
        return {}
      }
      throw err
    }
  }

  async function load(text: string, configFilepath: string) {
    const original = text
    text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return Env.get(varName) || ""
    })

    const fileMatches = text.match(/\{file:[^}]+\}/g)
    if (fileMatches) {
      const configDir = path.dirname(configFilepath)
      const lines = text.split("\n")

      for (const match of fileMatches) {
        const lineIndex = lines.findIndex((line) => line.includes(match))
        if (lineIndex !== -1 && lines[lineIndex].trim().startsWith("//")) {
          continue // Skip if line is commented
        }
        let filePath = match.replace(/^\{file:/, "").replace(/\}$/, "")
        if (filePath.startsWith("~/")) {
          filePath = path.join(os.homedir(), filePath.slice(2))
        }
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
        const fileContent = (
          await Bun.file(resolvedPath)
            .text()
            .catch((error) => {
              const errMsg = `bad file reference: "${match}"`
              if (error.code === "ENOENT") {
                throw new InvalidError(
                  {
                    path: configFilepath,
                    message: errMsg + ` ${resolvedPath} does not exist`,
                  },
                  { cause: error },
                )
              }
              throw new InvalidError({ path: configFilepath, message: errMsg }, { cause: error })
            })
        ).trim()
        // escape newlines/quotes, strip outer quotes
        text = text.replace(match, JSON.stringify(fileContent).slice(1, -1))
      }
    }

    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const { payload, debugSnippet, extraCount } = buildJsoncParsePayload(text, configFilepath, errors)
      log.error("config parse failed", { path: configFilepath, snippet: debugSnippet, extra: extraCount })
      throw new JsonError(payload)
    }

    const parsed = Info.safeParse(data)
    if (parsed.success) {
      if (!parsed.data.$schema) {
        parsed.data.$schema = "https://opencode.ai/config.json"
        // Write the $schema to the original text to preserve variables like {env:VAR}
        const updated = original.replace(/^\s*\{/, '{\n  "$schema": "https://opencode.ai/config.json",')
        await Bun.write(configFilepath, updated).catch((err) => {
          log.debug("Failed to auto-insert $schema into config", { configFilepath, err })
        })
      }
      const data = parsed.data
      if (data.plugin) {
        for (let i = 0; i < data.plugin.length; i++) {
          const plugin = data.plugin[i]
          try {
            data.plugin[i] = import.meta.resolve!(plugin, configFilepath)
          } catch (err) {
            try {
              const require = createRequire(configFilepath)
              const resolvedPath = require.resolve(plugin)
              data.plugin[i] = pathToFileURL(resolvedPath).href
            } catch {
              log.debug("Failed to resolve plugin", { plugin, configFilepath, err })
            }
          }
        }
      }
      return data
    }

    throw new InvalidError({
      path: configFilepath,
      issues: parsed.error.issues,
    })
  }
  export const JsonError = NamedError.create(
    "ConfigJsonError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      line: z.number().optional(),
      column: z.number().optional(),
      code: z.string().optional(),
      problemLine: z.string().optional(),
      hint: z.string().optional(),
    }),
  )

  function buildJsoncParsePayload(text: string, filepath: string, errors: JsoncParseError[]) {
    const lines = text.split("\n")
    const first = errors[0]
    const beforeOffset = text.substring(0, first.offset).split("\n")
    const line = beforeOffset.length
    const column = beforeOffset[beforeOffset.length - 1].length + 1
    const code = printParseErrorCode(first.error)
    const problemLine = (lines[line - 1] ?? "").slice(0, 200)
    const hint = `${code} at line ${line}, column ${column}`

    const ctxStart = Math.max(0, line - 4)
    const ctxEnd = Math.min(lines.length, line + 3)
    const snippet = lines
      .slice(ctxStart, ctxEnd)
      .map((l, i) => {
        const n = ctxStart + i + 1
        const marker = n === line ? ">" : " "
        return `${marker} ${String(n).padStart(4)}: ${l.slice(0, 200)}`
      })
      .join("\n")

    return {
      payload: {
        path: filepath,
        message: hint,
        line,
        column,
        code,
        problemLine,
        hint,
      },
      debugSnippet: `${hint}\n${snippet}`,
      extraCount: errors.length - 1,
    }
  }

  export const ConfigDirectoryTypoError = NamedError.create(
    "ConfigDirectoryTypoError",
    z.object({
      path: z.string(),
      dir: z.string(),
      suggestion: z.string(),
    }),
  )

  export const InvalidError = NamedError.create(
    "ConfigInvalidError",
    z.object({
      path: z.string(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
      message: z.string().optional(),
    }),
  )

  export async function get() {
    return state().then((x) => x.config)
  }

  export async function getGlobal() {
    return global()
  }

  export async function update(config: Info) {
    const filepath = path.join(Instance.directory, "config.json")
    const existing = await loadFile(filepath)
    await Bun.write(filepath, JSON.stringify(mergeDeep(existing, config), null, 2))
    await Instance.dispose()
  }

  function globalConfigFile() {
    const candidates = ["opencode.jsonc", "opencode.json", "config.json"].map((file) =>
      path.join(Global.Path.config, file),
    )
    for (const file of candidates) {
      if (existsSync(file)) return file
    }
    return candidates[0]
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }

  function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
    if (!isRecord(patch)) {
      const edits = modify(input, path, patch, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
        },
      })
      return applyEdits(input, edits)
    }

    return Object.entries(patch).reduce((result, [key, value]) => {
      if (value === undefined) return result
      return patchJsonc(result, value, [...path, key])
    }, input)
  }

  async function finalizeGlobalConfigMutation() {
    global.reset()

    try {
      await Instance.disposeAll()
    } catch {
      // Best-effort disposal; still emit disposed event to trigger downstream refresh.
    } finally {
      await Bus.publish(Event.Disposed, {}, { directory: "global" })
    }
  }

  function parseConfig(text: string, filepath: string): Info {
    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const { payload, debugSnippet, extraCount } = buildJsoncParsePayload(text, filepath, errors)
      log.error("config parse failed", { path: filepath, snippet: debugSnippet, extra: extraCount })
      throw new JsonError(payload)
    }

    const parsed = Info.safeParse(data)
    if (parsed.success) return parsed.data

    throw new InvalidError({
      path: filepath,
      issues: parsed.error.issues,
    })
  }

  export async function updateGlobal(config: Info) {
    const filepath = globalConfigFile()
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    const before = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (err.code === "ENOENT") return "{}"
        throw new JsonError({ path: filepath }, { cause: err })
      })

    const next = await (async () => {
      if (!filepath.endsWith(".jsonc")) {
        const existing = parseConfig(before, filepath)
        const merged = mergeDeep(existing, config)
        await Bun.write(filepath, JSON.stringify(merged, null, 2))
        return merged
      }

      const updated = patchJsonc(before, config)
      const merged = parseConfig(updated, filepath)
      await Bun.write(filepath, updated)
      return merged
    })()

    await finalizeGlobalConfigMutation()

    return next
  }

  export async function removeGlobalProvider(providerId: string) {
    const filepath = globalConfigFile()
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    const before = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (err.code === "ENOENT") return "{}"
        throw new JsonError({ path: filepath }, { cause: err })
      })

    const existing = parseConfig(before, filepath)
    const next = { ...existing }

    if (next.provider) {
      const provider = { ...next.provider }
      delete provider[providerId]
      next.provider = Object.keys(provider).length > 0 ? provider : undefined
    }

    if (Array.isArray(next.disabled_providers)) {
      const filtered = next.disabled_providers.filter((id) => id !== providerId)
      next.disabled_providers = filtered.length > 0 ? filtered : undefined
    }

    if (!filepath.endsWith(".jsonc")) {
      await Bun.write(filepath, JSON.stringify(next, null, 2))
    } else {
      let updated = before
      updated = applyEdits(
        updated,
        modify(updated, ["provider", providerId], undefined, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      )
      updated = applyEdits(
        updated,
        modify(updated, ["disabled_providers"], next.disabled_providers, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      )
      await Bun.write(filepath, updated)
    }

    await finalizeGlobalConfigMutation()
    return next
  }

  export async function updateRuntime(config: Info) {
    // Runtime config is globally unified in this build.
    return updateGlobal(config)
  }

  export async function directories() {
    return state().then((x) => x.directories)
  }
}
