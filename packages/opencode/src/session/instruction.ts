import path from "path"
import os from "os"
import { Global } from "../global"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Flag } from "@/flag/flag"

// @event_2026-02-16_instruction_simplify:
// Instruction loading simplified to deterministic 2-source model:
//   1. Global: ~/.config/opencode/AGENTS.md (single file, no fallback)
//   2. Project: <project-root>/.opencode/AGENTS.md (fixed path, no findUp)
//   3. opencode.json `instructions` field (user-explicit only)
// Removed: CLAUDE.md/CONTEXT.md compat, ~/.claude/ fallback, OPENCODE_CONFIG_DIR
//          fallback, sub-directory resolve() walk-up auto-injection.

export namespace InstructionPrompt {
  const state = Instance.state(() => {
    return {
      systemCache: new Map<string, { value: string[]; at: number }>(),
    }
  })
  const SYSTEM_CACHE_TTL_MS = 10_000

  export async function systemPaths() {
    const config = await Config.get()
    const paths = new Set<string>()

    // 1. Global: single XDG config AGENTS.md
    const globalFile = path.join(Global.Path.config, "AGENTS.md")
    if (await Bun.file(globalFile).exists()) {
      paths.add(path.resolve(globalFile))
    }

    // 2. Project: fixed path <project-root>/.opencode/AGENTS.md
    if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
      const projectFile = path.join(Instance.directory, ".opencode", "AGENTS.md")
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

  export async function system() {
    const config = await Config.get()
    const cacheKey = JSON.stringify({
      directory: Instance.directory,
      instructions: config.instructions ?? [],
      disableProject: !!Flag.OPENCODE_DISABLE_PROJECT_CONFIG,
    })
    const cached = state().systemCache.get(cacheKey)
    if (cached && Date.now() - cached.at < SYSTEM_CACHE_TTL_MS) return cached.value

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
    state().systemCache.set(cacheKey, { value, at: Date.now() })
    return value
  }
}
