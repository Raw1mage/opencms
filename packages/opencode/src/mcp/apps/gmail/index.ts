import path from "path"
import { ManagedAppRegistry } from "@/mcp/app-registry"
import { Global } from "@/global"
import { GmailClient } from "./client"
import { Log } from "@/util/log"

const log = Log.create({ service: "gmail-app" })

interface GAuthTokens {
  access_token: string
  refresh_token: string
  expires_at: number
  token_type: string
  updated_at: number
}

export namespace GmailApp {
  const APP_ID = "gmail"

  export async function readGAuthTokens(): Promise<GAuthTokens | null> {
    try {
      const gauthPath = path.join(Global.Path.config, "gauth.json")
      const file = Bun.file(gauthPath)
      if (!(await file.exists())) return null
      return (await file.json()) as GAuthTokens
    } catch {
      return null
    }
  }

  async function resolveAccessToken(): Promise<string> {
    await ManagedAppRegistry.requireReady(APP_ID)

    const tokens = await readGAuthTokens()
    if (!tokens || !tokens.access_token) {
      throw new ManagedAppRegistry.UsageStateError({
        appId: APP_ID,
        status: "pending_auth",
        reason: "unauthenticated",
        code: "MANAGED_APP_AUTH_REQUIRED",
        message: "Gmail OAuth tokens not found in gauth.json",
      })
    }

    return tokens.access_token
  }

  // ---------- Formatters ----------

  function formatLabelList(labels: GmailClient.Label[]): string {
    if (labels.length === 0) return "No labels found."
    const system = labels.filter((l) => l.type === "system")
    const user = labels.filter((l) => l.type === "user")

    const lines: string[] = []
    if (system.length) {
      lines.push(`**System Labels** (${system.length}):`)
      for (const l of system) {
        const unread = l.messagesUnread != null ? ` (${l.messagesUnread} unread)` : ""
        lines.push(`- ${l.name}${unread} — ID: \`${l.id}\``)
      }
    }
    if (user.length) {
      lines.push(`\n**User Labels** (${user.length}):`)
      for (const l of user) {
        const unread = l.messagesUnread != null ? ` (${l.messagesUnread} unread)` : ""
        lines.push(`- ${l.name}${unread} — ID: \`${l.id}\``)
      }
    }
    return lines.join("\n")
  }

  function formatMessageSummary(msg: GmailClient.Message, opts?: { maxBodyLen?: number }): string {
    const from = GmailClient.getHeader(msg, "From") ?? "?"
    const to = GmailClient.getHeader(msg, "To") ?? "?"
    const subject = GmailClient.getHeader(msg, "Subject") ?? "(no subject)"
    const date = GmailClient.getHeader(msg, "Date") ?? "?"

    const lines = [
      `**${subject}**`,
      `ID: \`${msg.id}\` | Thread: \`${msg.threadId}\``,
      `From: ${from}`,
      `To: ${to}`,
      `Date: ${date}`,
    ]

    const body = GmailClient.decodeTextBody(msg)
    if (body) {
      const maxLen = opts?.maxBodyLen ?? 0 // 0 = no limit
      const trimmed = maxLen > 0 && body.length > maxLen
        ? body.slice(0, maxLen) + "\n...(truncated)"
        : body
      lines.push(`\n${trimmed}`)
    } else if (msg.snippet) {
      lines.push(`\nSnippet: ${msg.snippet}`)
    }

    return lines.join("\n")
  }

  function formatMessageList(messages: GmailClient.Message[]): string {
    if (messages.length === 0) return "No messages found."
    // List view: truncate each message body to keep overview readable
    return `Found ${messages.length} message(s):\n\n${messages.map((m) => formatMessageSummary(m, { maxBodyLen: 500 })).join("\n\n---\n\n")}`
  }

  function formatDraftList(drafts: GmailClient.Message[]): string {
    if (drafts.length === 0) return "No drafts found."
    return `Found ${drafts.length} draft(s):\n\n${drafts.map((m) => formatMessageSummary(m, { maxBodyLen: 500 })).join("\n\n---\n\n")}`
  }

  // ---------- Helpers ----------

  /** Run promises with limited concurrency to avoid Gmail API 429 errors. */
  async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length)
    let idx = 0
    async function worker() {
      while (idx < items.length) {
        const i = idx++
        results[i] = await fn(items[i])
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
    return results
  }

  // ---------- Tool Executors ----------

  export type ToolExecutor = (args: Record<string, unknown>) => Promise<string>

  export const tools: Record<string, ToolExecutor> = {
    "list-labels": async () => {
      const token = await resolveAccessToken()
      const labels = await GmailClient.listLabels(token)
      return formatLabelList(labels)
    },

    "list-messages": async (args) => {
      const token = await resolveAccessToken()
      const result = await GmailClient.listMessages(token, {
        query: args.query as string | undefined,
        labelIds: args.labelIds as string[] | undefined,
        maxResults: (args.maxResults as number | undefined) ?? 10,
      })

      if (result.messages.length === 0) return "No messages found matching the query."

      // Fetch full message details with concurrency limit to avoid 429
      const messages = await mapConcurrent(result.messages, 3, (entry) =>
        GmailClient.getMessage(token, entry.id, "full"),
      )

      let out = formatMessageList(messages)
      if (result.nextPageToken) {
        out += `\n\n_More results available. Use pageToken: \`${result.nextPageToken}\`_`
      }
      return out
    },

    "get-message": async (args) => {
      const token = await resolveAccessToken()
      const message = await GmailClient.getMessage(token, args.messageId as string, "full")
      return formatMessageSummary(message)
    },

    "send-message": async (args) => {
      const token = await resolveAccessToken()
      const rfc = GmailClient.buildRfc2822({
        to: args.to as string,
        subject: args.subject as string,
        body: args.body as string,
        cc: args.cc as string | undefined,
        bcc: args.bcc as string | undefined,
      })
      const raw = GmailClient.encodeRawMessage(rfc)
      const sent = await GmailClient.sendMessage(token, raw)
      return `Message sent successfully.\nID: \`${sent.id}\` | Thread: \`${sent.threadId}\``
    },

    "reply-message": async (args) => {
      const token = await resolveAccessToken()
      const original = await GmailClient.getMessage(token, args.messageId as string, "metadata")
      const messageId = GmailClient.getHeader(original, "Message-ID")
      const existingRefs = GmailClient.getHeader(original, "References")
      const subject = GmailClient.getHeader(original, "Subject") ?? ""
      const from = GmailClient.getHeader(original, "From") ?? ""

      const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`
      const references = existingRefs ? `${existingRefs} ${messageId}` : messageId

      const rfc = GmailClient.buildRfc2822({
        to: (args.to as string | undefined) ?? from,
        subject: replySubject,
        body: args.body as string,
        cc: args.cc as string | undefined,
        inReplyTo: messageId,
        references: references,
      })
      const raw = GmailClient.encodeRawMessage(rfc)
      const sent = await GmailClient.sendMessage(token, raw, original.threadId)
      return `Reply sent successfully.\nID: \`${sent.id}\` | Thread: \`${sent.threadId}\``
    },

    "forward-message": async (args) => {
      const token = await resolveAccessToken()
      const original = await GmailClient.getMessage(token, args.messageId as string, "full")
      const subject = GmailClient.getHeader(original, "Subject") ?? ""
      const from = GmailClient.getHeader(original, "From") ?? "?"
      const date = GmailClient.getHeader(original, "Date") ?? "?"
      const originalBody = GmailClient.decodeTextBody(original) ?? original.snippet ?? ""

      const fwdSubject = subject.startsWith("Fwd:") ? subject : `Fwd: ${subject}`
      const fwdBody = [
        args.body ? `${args.body as string}\n\n` : "",
        "---------- Forwarded message ----------",
        `From: ${from}`,
        `Date: ${date}`,
        `Subject: ${subject}`,
        "",
        originalBody,
      ].join("\n")

      const rfc = GmailClient.buildRfc2822({
        to: args.to as string,
        subject: fwdSubject,
        body: fwdBody,
        cc: args.cc as string | undefined,
      })
      const raw = GmailClient.encodeRawMessage(rfc)
      const sent = await GmailClient.sendMessage(token, raw)
      return `Message forwarded successfully.\nID: \`${sent.id}\` | Thread: \`${sent.threadId}\``
    },

    "modify-labels": async (args) => {
      const token = await resolveAccessToken()
      const result = await GmailClient.modifyMessage(
        token,
        args.messageId as string,
        args.addLabelIds as string[] | undefined,
        args.removeLabelIds as string[] | undefined,
      )
      return `Labels modified for message \`${result.id}\`.\nCurrent labels: ${result.labelIds?.join(", ") ?? "none"}`
    },

    "trash-message": async (args) => {
      const token = await resolveAccessToken()
      await GmailClient.trashMessage(token, args.messageId as string)
      return `Message \`${args.messageId}\` moved to trash.`
    },

    "list-drafts": async (args) => {
      const token = await resolveAccessToken()
      const result = await GmailClient.listDrafts(token, {
        maxResults: (args.maxResults as number | undefined) ?? 10,
      })

      if (result.drafts.length === 0) return "No drafts found."

      const messages = await mapConcurrent(result.drafts, 3, (d) =>
        GmailClient.getMessage(token, d.message.id, "full"),
      )
      return formatDraftList(messages)
    },

    "create-draft": async (args) => {
      const token = await resolveAccessToken()
      const rfc = GmailClient.buildRfc2822({
        to: args.to as string,
        subject: args.subject as string,
        body: args.body as string,
        cc: args.cc as string | undefined,
        bcc: args.bcc as string | undefined,
      })
      const raw = GmailClient.encodeRawMessage(rfc)
      const draft = await GmailClient.createDraft(token, raw)
      return `Draft created successfully.\nDraft ID: \`${draft.id}\` | Message ID: \`${draft.message.id}\``
    },
  }

  export async function execute(toolId: string, args: Record<string, unknown>): Promise<string> {
    const executor = tools[toolId]
    if (!executor) {
      throw new Error(`Unknown Gmail tool: ${toolId}`)
    }
    log.info("executing gmail tool", { toolId })
    try {
      return await executor(args)
    } catch (error) {
      if (error instanceof ManagedAppRegistry.UsageStateError) throw error
      log.error("gmail tool execution failed", { toolId, error })
      const message = error instanceof Error ? error.message : String(error)
      await ManagedAppRegistry.markError(APP_ID, {
        code: "GMAIL_TOOL_ERROR",
        message: `Tool ${toolId} failed: ${message}`,
      }).catch(() => {})
      throw error
    }
  }
}
