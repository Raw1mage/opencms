import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import { Rpc } from "@/util/rpc"
import { type rpc } from "./worker"
import path from "path"
import { UI } from "@/cli/ui"
import { iife } from "@/util/iife"
import { Log } from "@/util/log"
import { withNetworkOptions, resolveNetworkOptions } from "@/cli/network"
import type { Event } from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"
import { Env } from "@/env"
import { ProcessSupervisor } from "@/process/supervisor"
import { TerminalMonitor } from "@/process/terminal-monitor"
import { Daemon } from "@/server/daemon"

declare global {
  const OPENCODE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

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
        try {
          const res = await fetch(sseUrl, {
            signal: abort.signal,
            headers: { Accept: "text/event-stream" },
            unix: socketPath,
          } as RequestInit & { unix: string })
          if (!res.ok || !res.body) return
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
          // SSE disconnected — caller will handle reconnect
        }
      })()
      return () => abort.abort()
    },
  }
}

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient): EventSource {
  return {
    on: (handler) => client.on<Event>("event", handler),
  }
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
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
        describe: "attach to a running opencode daemon via Unix socket (discovered automatically)",
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

    // @event_20260319_daemonization Phase γ.4a-c: --attach mode
    if (args.attach) {
      const daemonInfo = await Daemon.readDiscovery()
      if (!daemonInfo) {
        UI.error("No running daemon found.")
        UI.error("The per-user daemon is managed by the gateway service.")
        UI.error("Access the web UI first to trigger daemon spawn, then retry --attach.")
        process.exit(1)
      }
      const { socketPath } = daemonInfo
      const url = "http://opencode.daemon"
      const customFetch = createUnixFetch(socketPath)
      const events = createUnixEventSource(socketPath, url)
      await tui({
        url,
        fetch: customFetch,
        events,
        args: {
          continue: args.continue,
          sessionID: args.session,
          agent: args.agent,
          model: args.model,
          prompt: undefined,
          fork: args.fork,
        },
        onExit: async () => {
          // γ.5d: TUI disconnect only — daemon keeps running
        },
      })
      return
    }

    // γ.4d: No --attach — maintain existing Worker thread mode
    // Resolve relative paths against PWD to preserve behavior when using --cwd flag
    const baseCwd = Env.get("PWD") ?? process.cwd()
    const cwd = args.project ? path.resolve(baseCwd, args.project) : process.cwd()
    const localWorker = new URL("./worker.ts", import.meta.url)
    const distWorker = new URL("./cli/cmd/tui/worker.js", import.meta.url)
    const workerPath = await iife(async () => {
      if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
      if (await Bun.file(distWorker).exists()) return distWorker
      return localWorker
    })
    try {
      process.chdir(cwd)
    } catch (e) {
      UI.error("Failed to change directory to " + cwd)
      return
    }

    const worker = new Worker(workerPath, {
      env: Object.fromEntries(
        Object.entries({ ...Env.all(), OPENCODE_CLI_TOKEN: process.env.OPENCODE_CLI_TOKEN }).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    })
    worker.onerror = (e) => {
      Log.Default.error(e)
    }
    const client = Rpc.client<typeof rpc>(worker)
    process.on("SIGUSR2", async () => {
      await client.call("reload", undefined)
    })

    // @event_2026-02-07_terminal-cleanup: Reset terminal state on unexpected exit
    // This prevents mouse tracking and alternate screen buffer from persisting
    // after opencode is killed or crashes
    const resetTerminal = () => {
      // Disable mouse tracking modes
      process.stdout.write("\x1b[?1000l") // Basic mouse tracking
      process.stdout.write("\x1b[?1002l") // Button event tracking
      process.stdout.write("\x1b[?1003l") // All motion tracking
      process.stdout.write("\x1b[?1006l") // SGR extended mouse mode
      // Exit alternate screen buffer
      process.stdout.write("\x1b[?1049l")
      // Show cursor
      process.stdout.write("\x1b[?25h")
      // Reset character attributes
      process.stdout.write("\x1b[0m")
      // Disable raw mode if active
      if (process.stdin.isTTY && process.stdin.isRaw) {
        process.stdin.setRawMode(false)
      }
    }

    process.on("uncaughtException", (e) => {
      Log.Default.error(e)
      resetTerminal()
      worker.terminate()
      process.exit(1)
    })
    process.on("unhandledRejection", (e) => {
      Log.Default.error(e)
      resetTerminal()
      worker.terminate()
      process.exit(1)
    })

    const handleTerminalExit = (signal: string) => {
      resetTerminal()

      // Attempt clean shutdown with timeout to ensure subagents/LSPs are cleaned up
      const exit = () => {
        worker.terminate()
        process.exit(signal === "SIGINT" ? 130 : 143)
      }

      // Hard timeout in case shutdown hangs
      const timeout = setTimeout(exit, 1000)

      client
        .call("shutdown", undefined)
        .catch(() => { }) // Ignore errors during shutdown
        .finally(() => {
          clearTimeout(timeout)
          exit()
        })
    }

    process.on("SIGINT", () => handleTerminalExit("SIGINT"))
    process.on("SIGTERM", () => handleTerminalExit("SIGTERM"))
    process.on("SIGHUP", () => handleTerminalExit("SIGHUP"))
    process.on("exit", resetTerminal)

    const prompt = await iife(async () => {
      const piped = !process.stdin.isTTY ? await Bun.stdin.text() : undefined
      if (!args.prompt) return piped
      return piped ? piped + "\n" + args.prompt : args.prompt
    })

    // Check if server should be started (port or hostname explicitly set in CLI or config)
    const networkOpts = await resolveNetworkOptions(args)
    const shouldStartServer =
      process.argv.includes("--port") ||
      process.argv.includes("--hostname") ||
      process.argv.includes("--mdns") ||
      networkOpts.mdns ||
      networkOpts.port !== 0 ||
      networkOpts.hostname !== "127.0.0.1"

    let url: string
    let customFetch: typeof fetch | undefined
    let events: EventSource | undefined

    if (shouldStartServer) {
      // Start HTTP server for external access
      const server = await client.call("server", networkOpts)
      url = server.url
    } else {
      // Use direct RPC communication (no HTTP)
      url = "http://opencode.internal"
      customFetch = createWorkerFetch(client)
      events = createEventSource(client)
    }

    const tuiPromise = tui({
      url,
      fetch: customFetch,
      events,
      args: {
        continue: args.continue,
        sessionID: args.session,
        agent: args.agent,
        model: args.model,
        prompt,
        fork: args.fork,
      },
      onExit: async () => {
        await client.call("shutdown", undefined)
      },
    })

    // @event_2026-02-10_disable-autoupgrade: CMS branch 不需要與官網同步
    // setTimeout(() => {
    //   client.call("checkUpgrade", { directory: cwd }).catch(() => {})
    // }, 1000)

    await tuiPromise
  },
})
