import z from "zod"
import { spawn } from "child_process"
import { Tool } from "./tool"
import path from "path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language } from "web-tree-sitter"

import { $ } from "bun"
import { Filesystem } from "@/util/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag.ts"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import { Truncate } from "./truncation"
import { ToolBudget } from "./budget"
import { Plugin } from "@/plugin"
import { Env } from "@/env"
import { RequestUser } from "@/runtime/request-user"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000

export const log = Log.create({ service: "bash-tool" })

/* Daemon-spawn denylist — see specs/safe-daemon-restart RESTART-002.
 * Each rule has a regex and a human-readable name for logging. Matches are
 * applied to the raw command string before shell parsing. Design choice
 * (DD-5): fast regex prefilter, not a full AST walk — defence-in-depth,
 * not a security boundary; the hard gate is AGENTS.md + code review. */
const DAEMON_SPAWN_DENYLIST: Array<{ rule: string; pattern: RegExp }> = [
  { rule: "bun-serve-unix-socket", pattern: /\bbun\b[^\n;|&]*\bserve\b[^\n;|&]*--unix-socket\b/ },
  { rule: "opencode-serve-or-web", pattern: /\b(?:opencode|\.\/opencode)\s+(?:serve|web)\b/ },
  { rule: "direct-daemon-signal", pattern: /\bkill\s+(?:-(?:TERM|KILL|9|15|HUP|INT)\s+)?\$?\(\s*(?:cat\s+[^)]*daemon\.lock|pgrep[^)]*opencode[^)]*)\s*\)/ },
  { rule: "systemctl-gateway", pattern: /\bsystemctl\s+\w+\s+opencode-gateway\b/ },
]

function hashArgv(command: string): string {
  // 32-bit FNV-1a — avoid crypto dependency for a log-only identifier.
  let h = 0x811c9dc5
  for (let i = 0; i < command.length; i++) {
    h ^= command.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

export function matchDaemonSpawnDenylist(command: string): { rule: string; argvHash: string } | null {
  for (const entry of DAEMON_SPAWN_DENYLIST) {
    if (entry.pattern.test(command)) {
      return { rule: entry.rule, argvHash: hashArgv(command) }
    }
  }
  return null
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})

// NOTE: @event_bash_shell_support
// Tool is named "bash" for backward compatibility, but it supports any POSIX-compatible shell
// (bash, zsh, fish, sh, ksh, etc.). The actual shell used is detected at runtime via Shell.acceptable().
// For more details, see: src/shell/shell.ts
export const BashTool = Tool.define("bash", async () => {
  const shell = Shell.acceptable()
  log.info("bash tool using shell", { shell })

  // Update description to clarify shell support
  const updatedDescription =
    `Executes a given shell command in a persistent shell session (supports bash, zsh, fish, sh, and other POSIX shells) with optional timeout, ensuring proper handling and security measures.\n\n` +
    `Currently using: ${shell}\n\n` +
    DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES))

  return {
    description: updatedDescription,
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
        )
        .optional(),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
    }),
    async execute(params, ctx) {
      // safe-daemon-restart RESTART-002: block daemon-spawning commands.
      // AI must use the `restart_self` MCP tool instead — that path
      // delegates to gateway + webctl.sh with proper lifecycle authority.
      // See specs/safe-daemon-restart/ for the full rule set.
      const denylistMatch = matchDaemonSpawnDenylist(params.command)
      if (denylistMatch) {
        log.warn("denylist-block rule=" + denylistMatch.rule, {
          rule: denylistMatch.rule,
          argvHash: denylistMatch.argvHash,
        })
        throw new Error(
          `FORBIDDEN_DAEMON_SPAWN: this command matches the daemon-spawn denylist (rule: ${denylistMatch.rule}). ` +
            `AI must not spawn, kill, or restart the opencode daemon or gateway directly. ` +
            `Use the system-manager restart_self tool — it calls the sanctioned /api/v2/global/web/restart endpoint which handles rebuild + restart via webctl.sh.`,
        )
      }
      const cwd = params.workdir || Instance.directory
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const tree = await parser().then((p) => p.parse(params.command))
      if (!tree) {
        throw new Error("Failed to parse command")
      }
      const directories = new Set<string>()
      if (!Instance.containsPath(cwd)) directories.add(cwd)
      const patterns = new Set<string>()
      const always = new Set<string>()

      for (const node of tree.rootNode.descendantsOfType("command")) {
        if (!node) continue

        // Get full command text including redirects if present
        let commandText = node.parent?.type === "redirected_statement" ? node.parent.text : node.text

        const command = []
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)
          if (!child) continue
          if (
            child.type !== "command_name" &&
            child.type !== "word" &&
            child.type !== "string" &&
            child.type !== "raw_string" &&
            child.type !== "concatenation"
          ) {
            continue
          }
          command.push(child.text)
        }

        // not an exhaustive list, but covers most common cases
        if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"].includes(command[0])) {
          for (const arg of command.slice(1)) {
            if (arg.startsWith("-") || (command[0] === "chmod" && arg.startsWith("+"))) continue
            const resolved = await $`realpath ${arg}`
              .cwd(cwd)
              .quiet()
              .nothrow()
              .text()
              .then((x) => x.trim())
            log.info("resolved path", { arg, resolved })
            if (resolved) {
              const normalized =
                process.platform === "win32" ? Filesystem.windowsPath(resolved).replace(/\//g, "\\") : resolved
              if (!Instance.containsPath(normalized)) {
                const dir = (await Filesystem.isDir(normalized)) ? normalized : path.dirname(normalized)
                directories.add(dir)
              }
            }
          }
        }

        // cd covered by above check
        if (command.length && command[0] !== "cd") {
          patterns.add(commandText)
          always.add(BashArity.prefix(command).join(" ") + " *")
        }
      }

      if (directories.size > 0) {
        const globs = Array.from(directories).map((dir) => {
          if (dir.startsWith("/")) return `${dir.replace(/[\\/]+$/, "")}/*`
          return path.join(dir, "*")
        })
        await ctx.ask({
          permission: "external_directory",
          patterns: globs,
          always: globs,
          metadata: {},
        })
      }

      if (patterns.size > 0) {
        await ctx.ask({
          permission: "bash",
          patterns: Array.from(patterns),
          always: Array.from(always),
          metadata: {},
        })
      }

      const shellEnv = await Plugin.trigger("shell.env", { cwd }, { env: {} })
      // @event_20260319_daemonization Phase δ.3a — per-user daemon already runs as
      // the correct UID; sudo invocation removed.

      const proc = spawn(params.command, {
        shell,
        cwd,
        env: {
          ...Env.all(),
          ...shellEnv.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })

      let output = ""

      // Initialize metadata with empty output
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      const append = (chunk: Buffer) => {
        output += chunk.toString()
        ctx.metadata({
          metadata: {
            // truncate the metadata to avoid GIANT blobs of data (has nothing to do w/ what agent can access)
            output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
            description: params.description,
          },
        })
      }

      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      let timedOut = false
      let aborted = false
      let exited = false

      const kill = () => Shell.killTree(proc, { exited: () => exited })

      if (ctx.abort.aborted) {
        aborted = true
        await kill()
      }

      const abortHandler = () => {
        aborted = true
        void kill()
      }

      ctx.abort.addEventListener("abort", abortHandler, { once: true })

      const timeoutTimer = setTimeout(() => {
        timedOut = true
        void kill()
      }, timeout + 100)

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeoutTimer)
          ctx.abort.removeEventListener("abort", abortHandler)
        }

        proc.once("exit", () => {
          exited = true
          cleanup()
          resolve()
        })

        proc.once("error", (error) => {
          exited = true
          cleanup()
          reject(error)
        })
      })

      const resultMetadata: string[] = []

      if (timedOut) {
        resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeout} ms`)
      }

      if (aborted) {
        resultMetadata.push("User aborted the command")
      }

      if (resultMetadata.length > 0) {
        output += "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>"
      }

      // If the command is a search command (grep, rg), we want to be more aggressive
      // about truncation to keep the conversation clean.
      const isSearch = params.command.includes("grep") || params.command.includes("rg")
      const threshold = isSearch ? 2000 : 30000

      // Layer 2 (specs/tool-output-chunking/, DD-2): token-aware bound
      // using bashOverride knob (default 40K tokens ≈ 160K chars). The
      // existing char threshold above is dominant in the typical case;
      // the token check is a defensive lower bound for small-context-
      // model edge cases. INV-8: the natural-fit branch returns output
      // byte-identical to pre-Layer-2 behaviour.
      const budget = ToolBudget.resolve(ctx, "bash")
      const overChars = output.length > threshold
      const overBudget = ToolBudget.estimateTokens(output) > budget.tokens

      if (overChars || overBudget) {
        // For search commands, use maxLines: 0 to return only the hint
        const truncated = await Truncate.output(
          output,
          { maxLines: isSearch ? 0 : 50 },
          ctx.extra?.agent,
          ctx.sessionID,
        )
        const reason = overBudget
          ? `Layer 2 budget (~${budget.tokens} tokens, ${budget.source}) exceeded`
          : `output > ${threshold} chars`
        const hint = truncated.truncated
          ? `This output (${reason}) is redirected to ${truncated.outputPath}. ` +
            `For long-running commands, redirect stdout to a file (e.g. '> /tmp/out.log') ` +
            `then read the file in slices.`
          : "This output is redirected to internal error"

        return {
          title: params.description,
          metadata: {
            output: isSearch ? hint : truncated.content,
            exit: proc.exitCode,
            description: params.description,
            truncated: true,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          },
          output: isSearch ? hint : truncated.content,
        }
      }

      return {
        title: params.description,
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          exit: proc.exitCode,
          description: params.description,
        },
        output,
      }
    },
  }
})
