import { Database } from "bun:sqlite"
import type { Argv } from "yargs"

import { bootstrap } from "../bootstrap"
import { cmd } from "./cmd"
import { Router } from "../../session/storage/router"
import { ConnectionPool } from "../../session/storage/pool"
import { runIntegrityCheckUncached } from "../../session/storage/integrity"
import type { MessageV2 } from "../../session/message-v2"

interface InspectResult {
  stdout: string
  exitCode: number
}

function totalTokens(info: MessageV2.Info): number {
  if (info.role !== "assistant") return 0
  return typeof info.tokens.total === "number"
    ? info.tokens.total
    : info.tokens.input + info.tokens.output + info.tokens.reasoning + info.tokens.cache.read + info.tokens.cache.write
}

function finishValue(info: MessageV2.Info): string {
  return info.role === "assistant" ? (info.finish ?? "") : ""
}

function formatTable(rows: MessageV2.WithParts[]): string {
  const table = [
    ["id", "role", "time_created", "finish", "tokens_total"],
    ...rows.map((row) => [
      row.info.id,
      row.info.role,
      String(row.info.time.created),
      finishValue(row.info),
      String(totalTokens(row.info)),
    ]),
  ]
  const widths = table[0].map((_, column) => Math.max(...table.map((row) => row[column].length)))
  return table
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
}

export namespace SessionInspect {
  export async function list(sessionID: string): Promise<InspectResult> {
    const rows: MessageV2.WithParts[] = []
    for await (const message of Router.stream(sessionID)) rows.push(message)
    return { stdout: formatTable(rows) + "\n", exitCode: 0 }
  }

  export async function show(sessionID: string, messageID: string): Promise<InspectResult> {
    const message = await Router.get({ sessionID, messageID })
    return { stdout: JSON.stringify(message, null, 2) + "\n", exitCode: 0 }
  }

  export async function check(sessionID: string): Promise<InspectResult> {
    const dbPath = ConnectionPool.resolveDbPath(sessionID)
    const db = new Database(dbPath, { readonly: true, create: false })
    try {
      const verdict = await runIntegrityCheckUncached(db, sessionID, dbPath)
      return { stdout: verdict + "\n", exitCode: verdict === "ok" ? 0 : 1 }
    } finally {
      db.close()
    }
  }
}

async function run(action: string, sessionID: string, messageID?: string): Promise<void> {
  let result: InspectResult
  if (action === "list") result = await SessionInspect.list(sessionID)
  else if (action === "show") {
    if (!messageID) throw new Error("session-inspect show requires <messageID>")
    result = await SessionInspect.show(sessionID, messageID)
  } else if (action === "check") result = await SessionInspect.check(sessionID)
  else throw new Error(`unknown session-inspect action: ${action}`)

  process.stdout.write(result.stdout)
  if (result.exitCode !== 0) process.exitCode = result.exitCode
}

export const SessionInspectCommand = cmd({
  command: "session-inspect <action> <sessionID> [messageID]",
  describe: "inspect session storage (list, show, check)",
  builder: (yargs: Argv) =>
    yargs
      .positional("action", {
        describe: "subcommand to run",
        type: "string",
        choices: ["list", "show", "check"] as const,
        demandOption: true,
      })
      .positional("sessionID", {
        describe: "session ID to inspect",
        type: "string",
        demandOption: true,
      })
      .positional("messageID", {
        describe: "message ID for show",
        type: "string",
      })
      .example("opencode session-inspect list ses_abc", "list message rows")
      .example("opencode session-inspect show ses_abc msg_abc", "dump one message with parts")
      .example("opencode session-inspect check ses_abc", "run SQLite integrity_check or legacy readability check"),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(args.action as string, args.sessionID as string, args.messageID as string | undefined)
    })
  },
})
