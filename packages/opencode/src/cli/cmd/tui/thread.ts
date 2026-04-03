import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import path from "path"
import { UI } from "@/cli/ui"
import { iife } from "@/util/iife"
import { Log } from "@/util/log"
import type { Event } from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"
import { Env } from "@/env"
import { Daemon } from "@/server/daemon"

// @event_20260319_daemonization Phase γ.3
// Custom fetch that routes HTTP requests over a Unix domain socket.
function createUnixFetch(socketPath: string): typeof fetch {
  const fn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return fetch(input, { ...init, unix: socketPath } as RequestInit & { unix: string })
  }
  return Object.assign(fn, { preconnect: fetch.preconnect }) as typeof fetch
}

// @event_20260319_daemonization Phase γ.3
// SSE-based EventSource over Unix domain socket.
function createUnixEventSource(socketPath: string, baseUrl: string): EventSource {
  return {
    on: (handler: (event: Event) => void) => {
      const abort = new AbortController()
      const sseUrl = baseUrl.replace(/\/$/, "") + "/v2/event"
      ;(async () => {
        while (!abort.signal.aborted) {
          try {
            const res = await fetch(sseUrl, {
              signal: abort.signal,
              headers: { Accept: "text/event-stream" },
              unix: socketPath,
            } as RequestInit & { unix: string })
            if (!res.ok || !res.body) {
              await new Promise((r) => setTimeout(r, 2000))
              continue
            }
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buf = ""
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buf += decoder.decode(value, { stream: true })
              const lines = buf.split("\n")
              buf = lines.pop() ?? ""
              let data = ""
              for (const line of lines) {
                if (line.startsWith("data:")) {
                  data += line.slice(5).trimStart()
                } else if (line === "" && data) {
                  try { handler(JSON.parse(data) as Event) } catch {}
                  data = ""
                }
              }
            }
          } catch {
            // SSE disconnected — retry after backoff
          }
          if (!abort.signal.aborted) {
            await new Promise((r) => setTimeout(r, 2000))
          }
        }
      })()
      return () => abort.abort()
    },
  }
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    yargs
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("attach", {
        type: "boolean",
        describe: "(deprecated: now the default behavior) attach to a running opencode daemon",
      }),
  handler: async (args) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      UI.error("OpenCode TUI requires an interactive terminal (TTY).")
      UI.error("Please run in a real terminal and avoid output panels/piped execution.")
      process.exit(1)
    }

    if (args.fork && !args.continue && !args.session) {
      UI.error("--fork requires --continue or --session")
      process.exit(1)
    }

    // Resolve project directory for the daemon's Instance.provide() context
    const baseCwd = Env.get("PWD") ?? process.cwd()
    const directory = args.project ? path.resolve(baseCwd, args.project) : process.cwd()

    // @event_20260324_daemonization-v2: always-attach mode
    // Spawn a daemon if none exists, or adopt an existing one.
    UI.println("Connecting to daemon...")
    const daemonInfo = await Daemon.spawnOrAdopt({ spawnedBy: "tui" })
    const { socketPath } = daemonInfo
    const url = "http://opencode.daemon"
    const customFetch = createUnixFetch(socketPath)
    const events = createUnixEventSource(socketPath, url)

    const prompt = await iife(async () => {
      const piped = !process.stdin.isTTY ? await Bun.stdin.text() : undefined
      if (!args.prompt) return piped
      return piped ? piped + "\n" + args.prompt : args.prompt
    })

    // @event_2026-02-07_terminal-cleanup: Reset terminal state on unexpected exit
    const resetTerminal = () => {
      process.stdout.write("\x1b[?1000l") // Basic mouse tracking
      process.stdout.write("\x1b[?1002l") // Button event tracking
      process.stdout.write("\x1b[?1003l") // All motion tracking
      process.stdout.write("\x1b[?1006l") // SGR extended mouse mode
      process.stdout.write("\x1b[?1049l") // Exit alternate screen buffer
      process.stdout.write("\x1b[?25h")   // Show cursor
      process.stdout.write("\x1b[0m")     // Reset character attributes
      if (process.stdin.isTTY && process.stdin.isRaw) {
        process.stdin.setRawMode(false)
      }
    }

    process.on("uncaughtException", (e) => {
      Log.Default.error(e)
      resetTerminal()
      process.exit(1)
    })
    process.on("unhandledRejection", (e) => {
      Log.Default.error(e)
      resetTerminal()
      process.exit(1)
    })

    const handleTerminalExit = (_signal: string) => {
      resetTerminal()
      // TUI disconnect only — daemon keeps running
      process.exit(_signal === "SIGINT" ? 130 : 143)
    }

    process.on("SIGINT", () => handleTerminalExit("SIGINT"))
    process.on("SIGTERM", () => handleTerminalExit("SIGTERM"))
    process.on("SIGHUP", () => handleTerminalExit("SIGHUP"))
    process.on("exit", resetTerminal)

    await tui({
      url,
      fetch: customFetch,
      events,
      directory,
      args: {
        continue: args.continue,
        sessionID: args.session,
        agent: args.agent,
        model: args.model,
        prompt,
        fork: args.fork,
      },
      onExit: async () => {
        // TUI disconnect only — daemon keeps running
      },
    })
  },
})
