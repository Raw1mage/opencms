import path from "path"
import os from "os"
import { Global } from "../global"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Flag } from "@/flag/flag"
import { RebindEpoch } from "./rebind-epoch"

// @event_2026-02-16_instruction_simplify:
// Instruction loading simplified to deterministic 2-source model:
//   1. Global: ~/.config/opencode/AGENTS.md (single file, no fallback)
//   2. Project: <project-root>/AGENTS.md (fixed path, no findUp)
//   3. opencode.json `instructions` field (user-explicit only)
// Removed: CLAUDE.md/CONTEXT.md compat, ~/.claude/ fallback, OPENCODE_CONFIG_DIR
//          fallback, sub-directory resolve() walk-up auto-injection.
//
// @event_2026-04-20_session_rebind_capability_refresh:
// systemCache was 10s TTL (time-based) — replaced with per-session rebind
// epoch invalidation. Cache now lives indefinitely within a rebind epoch; a
// bump on the session (daemon start / session resume / provider switch /
// slash /reload / refresh_capability_layer tool) invalidates on next read.
// Cache key now includes `epoch`; callers passing sessionID get per-session
// isolation; legacy callers without sessionID share a "none" namespace
// that behaves like a stable cache (until flushSystemCache is called).

export namespace InstructionPrompt {
  type CacheEntry = { value: string[]; cachedAtEpoch: number; cachedAtTimeMs: number }

  function createState() {
    return {
      systemCache: new Map<string, CacheEntry>(),
    }
  }

  let stateGetter: (() => ReturnType<typeof createState>) | undefined
  let fallbackState: ReturnType<typeof createState> | undefined

  function state() {
    if (typeof Instance.state === "function") {
      stateGetter ||= Instance.state(createState)
      return stateGetter()
    }

    fallbackState ||= createState()
    return fallbackState
  }

  export async function systemPaths() {
    const config = await Config.get()
    const paths = new Set<string>()

    // 1. Global: single XDG config AGENTS.md
    const globalFile = path.join(Global.Path.config, "AGENTS.md")
    if (await Bun.file(globalFile).exists()) {
      paths.add(path.resolve(globalFile))
    }

    // 2. Project: fixed path <project-root>/AGENTS.md
    if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
      const projectFile = path.join(Instance.directory, "AGENTS.md")
      if (await Bun.file(projectFile).exists()) {
        paths.add(path.resolve(projectFile))
      }
    }

    // 3. opencode.json `instructions` field (user-explicit paths and URLs)
    if (config.instructions) {
      for (let instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) continue
        if (instruction.startsWith("~/")) {
          instruction = path.join(os.homedir(), instruction.slice(2))
        }
        if (path.isAbsolute(instruction)) {
          const matches = await Array.fromAsync(
            new Bun.Glob(path.basename(instruction)).scan({
              cwd: path.dirname(instruction),
              absolute: true,
              onlyFiles: true,
            }),
          ).catch(() => [])
          matches.forEach((p) => {
            paths.add(path.resolve(p))
          })
        }
      }
    }

    return paths
  }

  /**
   * Load AGENTS.md + user-configured instruction files into a string[].
   *
   * The cache is keyed by (directory, instructions shape, disableProject flag,
   * per-session rebind epoch). When `sessionID` is supplied the epoch comes
   * from `RebindEpoch.current`; legacy callers that omit sessionID share a
   * stable "none" namespace (epoch=0). See DD-3 in
   * `specs/session-rebind-capability-refresh/design.md`.
   */
  export async function system(sessionID?: string) {
    const config = await Config.get()
    const epoch = sessionID ? RebindEpoch.current(sessionID) : 0
    const cacheKey = JSON.stringify({
      directory: Instance.directory,
      instructions: config.instructions ?? [],
      disableProject: !!Flag.OPENCODE_DISABLE_PROJECT_CONFIG,
      sessionID: sessionID ?? "none",
      epoch,
    })
    const cached = state().systemCache.get(cacheKey)
    if (cached) return cached.value

    const paths = await systemPaths()

    const files = Array.from(paths).map(async (p) => {
      const content = await Bun.file(p)
        .text()
        .catch(() => "")
      return content ? "Instructions from: " + p + "\n" + content : ""
    })

    const urls: string[] = []
    if (config.instructions) {
      for (const instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) {
          urls.push(instruction)
        }
      }
    }
    const fetches = urls.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? res.text() : ""))
        .catch(() => "")
        .then((x) => (x ? "Instructions from: " + url + "\n" + x : "")),
    )

    const value = await Promise.all([...files, ...fetches]).then((result) => result.filter(Boolean))
    state().systemCache.set(cacheKey, { value, cachedAtEpoch: epoch, cachedAtTimeMs: Date.now() })
    return value
  }

  /**
   * Explicit cache invalidation, primarily used by tests and callers that want
   * to reset cached state without going through RebindEpoch. Production code
   * should drive invalidation through `RebindEpoch.bumpEpoch` so other
   * capability-layer consumers see the new epoch too.
   */
  export function flushSystemCache() {
    state().systemCache.clear()
  }
}
