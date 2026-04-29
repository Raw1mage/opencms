import crypto from "crypto"
import yargs from "yargs"
import type { CommandModule } from "yargs"
import { hideBin } from "yargs/helpers"

import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { Log } from "./util/log"
import { AuthCommand } from "./cli/cmd/auth"
import { AccountsCommand } from "./cli/cmd/accounts"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { ModelCheckCommand } from "./cli/cmd/model-check"
import { ModelSmokeCommand } from "./cli/cmd/model-smoke"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { NamedError } from "@opencode-ai/util/error"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { SessionInspectCommand } from "./cli/cmd/session-inspect"
import { StorageCommand } from "./cli/cmd/storage"
import { AdminCommand } from "./cli/cmd/admin"
import { KillSwitchCommand } from "./cli/cmd/killswitch"
import { MigrateStripDiffsCommand } from "./cli/cmd/maintenance/migrate-strip-diffs"
import { debugCheckpoint } from "./util/debug"
import { ProcessSupervisor } from "./process/supervisor"
import { registerDebugWriter } from "./bus/subscribers/debug-writer"
import { registerTelemetryRuntimePersistence } from "./bus/subscribers/telemetry-runtime"
import { registerTaskWorkerContinuationSubscriber } from "./bus/subscribers/task-worker-continuation"
import { registerPendingNoticeAppenderSubscriber } from "./bus/subscribers/pending-notice-appender"
import { registerSubagentBusyIndicatorSubscriber } from "./bus/subscribers/subagent-busy-indicator"
import { registerActiveChildChecker } from "./session/prompt-runtime"
import { SessionActiveChild } from "./tool/task"
import { Session } from "./session"
import { registerAutorunDisarmObserver } from "./session/autorun/observer"
import { SessionCache } from "./server/session-cache"
import { RateLimit } from "./server/rate-limit"

registerDebugWriter()
registerTelemetryRuntimePersistence()
registerTaskWorkerContinuationSubscriber()
registerPendingNoticeAppenderSubscriber()
registerSubagentBusyIndicatorSubscriber()
registerActiveChildChecker((sessionID) => !!SessionActiveChild.get(sessionID))
registerAutorunDisarmObserver()
Session.startDreamingWorker()
SessionCache.registerInvalidationSubscriber()
void RateLimit.logStartup()
debugCheckpoint("app", "start", { args: process.argv.slice(2) })

process.on("unhandledRejection", (e) => {
  const msg = e instanceof Error ? e.stack || e.message : String(e)
  // NamedError carries its real payload in `.data` (Zod-shaped); the bare
  // `.message` is just the class tag (e.g. "NotFoundError"). Without dumping
  // `.data` here, every rejection looks identical in the log and the actual
  // resource path / context is lost.
  const data = (e as any)?.data
  debugCheckpoint("error", "unhandledRejection", { error: msg, data })
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
    data,
  })
})

process.on("uncaughtException", (e) => {
  const msg = e instanceof Error ? e.stack || e.message : e
  debugCheckpoint("error", "uncaughtException", { error: msg })
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

const cli = yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", Installation.VERSION)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .middleware(async (opts) => {
    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        const envLevel = process.env.OPENCODE_LOG_LEVEL?.toUpperCase()
        if (envLevel && Log.Level.safeParse(envLevel).success) return envLevel as Log.Level
        if (Installation.isLocal()) return "INFO"
        return "INFO"
      })(),
    })

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)

    if (!process.env.OPENCODE_CLI_TOKEN) {
      process.env.OPENCODE_CLI_TOKEN = crypto.randomBytes(32).toString("hex")
    }

    Log.Default.info("opencode", {
      version: Installation.VERSION,
      args: process.argv.slice(2),
    })
  })
  .usage("\n" + UI.logo())
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(AuthCommand)
  .command(AccountsCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(ModelCheckCommand)
  .command(ModelSmokeCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(SessionInspectCommand)
  .command(StorageCommand)
  .command(AdminCommand)
  .command(KillSwitchCommand)
  .command(MigrateStripDiffsCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp("log")
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

const isHeadless = process.argv.includes("serve") || process.argv.includes("web")
const tui = await (async () => {
  if (isHeadless || process.env.OPENCODE_SKIP_TUI === "1") return []
  const attach = await import("./cli/cmd/tui/attach")
  const thread = await import("./cli/cmd/tui/thread")
  return [thread.TuiThreadCommand, attach.AttachCommand]
})()

for (const cmd of tui) {
  cli.command(cmd as unknown as CommandModule)
}

try {
  await cli.parseAsync()
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    console.error(e instanceof Error ? e.message : String(e))
  }
  process.exitCode = 1
} finally {
  // FIX: @event_20260211_bun_orphan_fix
  // Graceful shutdown: cleanup all registered child processes
  // before exiting to prevent orphan processes
  await ProcessSupervisor.disposeAll()
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
