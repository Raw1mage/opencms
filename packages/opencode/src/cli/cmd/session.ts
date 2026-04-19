import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Session } from "../../session"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Locale } from "../../util/locale"
import { Flag } from "../../flag/flag"
import { EOL } from "os"
import path from "path"
import * as fs from "fs"
import { Bus } from "@/bus"
import { createInterface } from "node:readline"
import { Project } from "@/project/project"
import { Log } from "@/util/log"

const log = Log.create({ service: "session-worker" })

/**
 * Pre-bootstrap file logger for worker processes.
 * Writes directly to filesystem, bypassing Bus (which isn't initialized until bootstrap completes).
 * This is the only way to get diagnostics when bootstrap hangs or crashes.
 */
function createWorkerFileLogger() {
  // Resolve log path without depending on Global.Path (requires Instance, not yet available)
  const dataHome = process.env.OPENCODE_DATA_HOME
    || (process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "opencode") : undefined)
    || path.join(process.env.HOME || "/tmp", ".local", "share", "opencode")
  const logDir = path.join(dataHome, "log")
  const logFile = path.join(logDir, `worker-${process.pid}.log`)

  try { fs.mkdirSync(logDir, { recursive: true }) } catch {}

  const write = (phase: string, extra?: Record<string, unknown>) => {
    const entry = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, phase, ...extra })
    try { fs.appendFileSync(logFile, entry + "\n") } catch {}
  }

  const cleanup = () => {
    // On successful bootstrap, truncate to just a "completed" marker to prevent accumulation
    try { fs.writeFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, phase: "completed" }) + "\n") } catch {}
  }

  return { write, cleanup, logFile }
}

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = Bun.which("less")
  if (lessOnPath) {
    if (Bun.file(lessOnPath).size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Bun.file(less).size) return [less, ...lessOptions]
  }

  const git = Bun.which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Bun.file(less).size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionListCommand)
      .command(SessionDeleteCommand)
      .command(SessionStepCommand)
      .command(SessionWorkerCommand)
      .demandCommand(),
  async handler() {},
})

export const SessionDeleteCommand = cmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs: Argv) => {
    return yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      try {
        await Session.get(args.sessionID)
      } catch {
        UI.error(`Session not found: ${args.sessionID}`)
        process.exit(1)
      }
      await Session.remove(args.sessionID)
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
    })
  },
})

export const SessionStepCommand = cmd({
  command: "step <sessionID>",
  describe: "run a session step",
  builder: (yargs: Argv) =>
    yargs.positional("sessionID", {
      type: "string",
      describe: "session id to run",
    }),
  handler: async (args) => {
    // Force non-interactive mode for step command
    process.env.OPENCODE_NON_INTERACTIVE = "1"

    await bootstrap(process.cwd(), async () => {
      // Import SessionPrompt inside handler to avoid circular deps during init
      const { SessionPrompt } = await import("../../session/prompt")
      const sessionID = args.sessionID as string
      const teardownBridge = setupTaskEventBridge(sessionID)

      try {
        await SessionPrompt.loop(sessionID)
      } catch (error) {
        console.error("Session step failed:", error)
        process.exit(1)
      } finally {
        teardownBridge?.()
      }
    })
  },
})

const BRIDGE_PREFIX = "__OPENCODE_BRIDGE_EVENT__ "
const WORKER_PREFIX = "__OPENCODE_WORKER__ "
const BRIDGE_EVENT_TYPES = new Set([
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "session.updated",
  "session.diff",
  "session.status",
  "todo.updated",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "task.rate_limit_escalation",
])

function setupTaskEventBridge(sessionID: string) {
  if (process.env.OPENCODE_TASK_EVENT_BRIDGE !== "1") return

  const extractSessionID = (event: any): string | undefined => {
    const properties = event?.properties
    if (!properties) return
    if (typeof properties.sessionID === "string") return properties.sessionID
    if (typeof properties.info?.sessionID === "string") return properties.info.sessionID
    if (typeof properties.part?.sessionID === "string") return properties.part.sessionID
    if (typeof properties.info?.id === "string" && event?.type?.startsWith("session.")) return properties.info.id
    return
  }

  const unsub = Bus.subscribeAll((event) => {
    if (!BRIDGE_EVENT_TYPES.has(event?.type)) return
    if (extractSessionID(event) !== sessionID) return
    try {
      process.stdout.write(BRIDGE_PREFIX + JSON.stringify(event) + "\n")
    } catch {
      // Ignore transport write failures in child process.
    }
  })

  return () => unsub()
}

export const SessionWorkerCommand = cmd({
  command: "worker",
  describe: "run a long-lived subagent worker",
  handler: async () => {
    process.env.OPENCODE_NON_INTERACTIVE = "1"
    process.env.OPENCODE_TASK_EVENT_BRIDGE = "1"

    const workerLog = createWorkerFileLogger()
    workerLog.write("spawned", { cwd: process.cwd(), ppid: process.ppid })
    workerLog.write("bootstrap_start")

    await bootstrap(process.cwd(), async () => {
      workerLog.write("bootstrap_complete")
      workerLog.cleanup()
      const { SessionPrompt } = await import("../../session/prompt")
      const rl = createInterface({
        input: process.stdin,
        crlfDelay: Infinity,
      })

      let activeRun:
        | {
            id: string
            sessionID: string
            cancelRequested: boolean
          }
        | undefined

      const cleanup = async () => {
        if (activeRun) {
          SessionPrompt.cancel(activeRun.sessionID, "manual-stop")
          // Wait for async tool cleanup (child processes)
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        process.exit(0)
      }

      process.on("SIGTERM", cleanup)
      process.on("SIGINT", cleanup)

      const send = (payload: Record<string, unknown>) => {
        process.stdout.write("\n" + WORKER_PREFIX + JSON.stringify(payload) + "\n")
      }

      send({ type: "ready" })
      const heartbeat = setInterval(() => {
        send({ type: "heartbeat", pid: process.pid, ts: Date.now() })
      }, 5000)
      if (typeof heartbeat.unref === "function") heartbeat.unref()

      const parentWatchdog = setInterval(() => {
        // If parent is gone, exit proactively to avoid orphan/zombie lingering workers.
        if (process.ppid === 1) {
          send({ type: "error", error: "parent_orphaned", pid: process.pid })
          void cleanup()
        }
      }, 5000)
      if (typeof parentWatchdog.unref === "function") parentWatchdog.unref()

      for await (const raw of rl) {
        const line = raw.trim()
        if (!line) continue
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          send({ type: "error", error: "invalid_json", raw: line.slice(0, 200) })
          continue
        }

        if (msg?.type === "run" && typeof msg.id === "string" && typeof msg.sessionID === "string") {
          if (activeRun) {
            send({
              type: "error",
              id: msg.id,
              sessionID: msg.sessionID,
              error: "worker_busy",
              activeSessionID: activeRun.sessionID,
            })
            continue
          }
          activeRun = {
            id: msg.id,
            sessionID: msg.sessionID,
            cancelRequested: false,
          }
          const runRef = activeRun
          const teardownBridge = setupTaskEventBridge(runRef.sessionID)
          void (async () => {
            try {
              console.error(`[WORKER] worker session loop starting for ${runRef.sessionID}`)
              log.info("worker session loop starting", { sessionID: runRef.sessionID, runID: runRef.id })
              await SessionPrompt.loop(runRef.sessionID)
              console.error(`[WORKER] worker session loop finished for ${runRef.sessionID}`)
              log.info("worker session loop finished", { sessionID: runRef.sessionID, runID: runRef.id, cancelRequested: runRef.cancelRequested })
              
              if (runRef.cancelRequested) {
                log.info("worker sending canceled signal", { sessionID: runRef.sessionID, runID: runRef.id })
                send({ type: "done", id: runRef.id, sessionID: runRef.sessionID, ok: false, error: "canceled" })
              } else {
                log.info("worker sending done signal", { sessionID: runRef.sessionID, runID: runRef.id })
                send({ type: "done", id: runRef.id, sessionID: runRef.sessionID, ok: true })
              }
            } catch (error) {
              send({
                type: "done",
                id: runRef.id,
                sessionID: runRef.sessionID,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              })
            } finally {
              teardownBridge?.()
              if (activeRun === runRef) activeRun = undefined
            }
          })()
          continue
        }

        if (msg?.type === "cancel" && typeof msg.sessionID === "string") {
          if (activeRun && activeRun.sessionID === msg.sessionID) {
            activeRun.cancelRequested = true
          }
          SessionPrompt.cancel(msg.sessionID, "manual-stop")
          send({ type: "canceled", sessionID: msg.sessionID })
          continue
        }

        if (
          msg?.type === "model_update" &&
          typeof msg.sessionID === "string" &&
          typeof msg.providerId === "string" &&
          typeof msg.modelID === "string"
        ) {
          // [rot-rca] Phase A instrument — worker receipt of parent's model_update
          const __rotRcaRecvTs = Date.now()
          const { resolve } = await import("../../session/model-update-signal")
          const resolved = resolve(msg.sessionID, {
            providerId: msg.providerId,
            modelID: msg.modelID,
            accountId: typeof msg.accountId === "string" ? msg.accountId : undefined,
          })
          process.stderr.write(
            `[rot-rca] worker stdin-recv session=${msg.sessionID} resolved=${resolved} ts=${__rotRcaRecvTs}${
              resolved ? "" : " (RW-1: no pending wait, payload dropped)"
            }\n`,
          )
          send({ type: "model_updated", sessionID: msg.sessionID, resolved })
          continue
        }

        send({ type: "error", error: "unknown_command", command: msg?.type })
      }
      clearInterval(heartbeat)
      clearInterval(parentWatchdog)
    })
  },
})

export const SessionListCommand = cmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs: Argv) => {
    return yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessions = []
      for await (const session of Session.listGlobal({ roots: true, limit: args.maxCount })) {
        sessions.push(session)
      }

      if (sessions.length === 0) {
        return
      }

      const projects = await Project.list().catch(() => [])
      const projectNameByID = new Map(
        projects
          .map((project) => [project.id, readableProjectName(project.name, project.worktree)] as const)
          .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
      )

      let output: string
      if (args.format === "json") {
        output = formatSessionJSON(sessions, projectNameByID)
      } else {
        output = formatSessionTable(sessions, projectNameByID)
      }

      const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

      if (shouldPaginate) {
        const proc = Bun.spawn({
          cmd: pagerCmd(),
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      } else {
        console.log(output)
      }
    })
  },
})

function formatSessionTable(sessions: Session.Info[], projectNameByID: Map<string, string>): string {
  const lines: string[] = []
  const projectLabel = (session: Session.Info) =>
    projectNameByID.get(session.projectID) ?? readableProjectName(undefined, session.directory) ?? "-"

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))
  const includeProjectColumn = sessions.some((s) => projectLabel(s) !== "-")
  const maxProjectWidth = Math.max(10, ...sessions.map((s) => `[${projectLabel(s)}]`.length))

  const header = includeProjectColumn
    ? `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Project${" ".repeat(maxProjectWidth - 7)}  Updated`
    : `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const project = Locale.truncate(`[${projectLabel(session)}]`, maxProjectWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = includeProjectColumn
      ? `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${project.padEnd(maxProjectWidth)}  ${timeStr}`
      : `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[], projectNameByID: Map<string, string>): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    projectName: projectNameByID.get(session.projectID) ?? readableProjectName(undefined, session.directory) ?? null,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}

function readableProjectName(name?: string | null, directory?: string): string | undefined {
  const explicit = name?.trim()
  if (explicit) return explicit
  if (!directory) return
  const base = path.basename(path.resolve(directory))
  if (!base || base === path.sep || base === ".") return
  return base
}
