#!/usr/bin/env bun
/**
 * Gmail MCP Server — Standalone stdio binary
 *
 * Built with: bun build --compile --target=bun-linux-x64 server.ts --outfile gmail-server
 *
 * Reads GOOGLE_ACCESS_TOKEN from environment. Exposes all Gmail tools via
 * MCP protocol (tools/list + tools/call over stdio).
 *
 * This server is designed to be registered in mcp-apps.json and launched by
 * the opencode runtime via StdioClientTransport.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

// ── Minimal logger (no internal bus dependency) ───────────────────────

const log = {
  info: (msg: string, extra?: Record<string, unknown>) =>
    console.error(`[gmail-server] INFO: ${msg}`, extra ? JSON.stringify(extra) : ""),
  warn: (msg: string, extra?: Record<string, unknown>) =>
    console.error(`[gmail-server] WARN: ${msg}`, extra ? JSON.stringify(extra) : ""),
  error: (msg: string, extra?: Record<string, unknown>) =>
    console.error(`[gmail-server] ERROR: ${msg}`, extra ? JSON.stringify(extra) : ""),
}

// ── Gmail HTTP Client (inline to avoid @/ path alias deps) ────────────

const BASE_URL = "https://gmail.googleapis.com/gmail/v1"

function getToken(): string {
  const token = process.env.GOOGLE_ACCESS_TOKEN
  if (!token) throw new Error("GOOGLE_ACCESS_TOKEN environment variable is required")
  return token
}

async function gmailFetch(path: string, opts?: RequestInit): Promise<any> {
  const token = getToken()
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Gmail API ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

function getHeader(msg: any, name: string): string | undefined {
  return msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value
}

function decodeBase64(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
}

function decodeTextBody(msg: any): string | undefined {
  const payload = msg.payload
  if (!payload) return undefined
  if (payload.body?.data) return decodeBase64(payload.body.data)
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64(part.body.data)
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) return decodeBase64(part.body.data)
    }
  }
  return undefined
}

function buildRfc2822(opts: {
  to: string; subject: string; body: string
  cc?: string; bcc?: string; inReplyTo?: string; references?: string
}): string {
  const lines = [`To: ${opts.to}`, `Subject: ${opts.subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8"]
  if (opts.cc) lines.push(`Cc: ${opts.cc}`)
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`)
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`)
  if (opts.references) lines.push(`References: ${opts.references}`)
  lines.push("", opts.body)
  return lines.join("\r\n")
}

function encodeRawMessage(rfc: string): string {
  return Buffer.from(rfc).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// ── Tool implementations ──────────────────────────────────────────────

const tools: Record<string, (args: any) => Promise<string>> = {
  "list-labels": async () => {
    const data = await gmailFetch("/users/me/labels")
    const labels = data.labels ?? []
    if (labels.length === 0) return "No labels found."
    return labels.map((l: any) => `- ${l.name} (${l.type}) ID: ${l.id}`).join("\n")
  },

  "list-messages": async (args: any) => {
    const params = new URLSearchParams()
    if (args.query) params.set("q", args.query)
    if (args.maxResults) params.set("maxResults", String(args.maxResults))
    if (args.pageToken) params.set("pageToken", args.pageToken)
    if (args.labelIds) for (const id of args.labelIds) params.append("labelIds", id)

    const data = await gmailFetch(`/users/me/messages?${params}`)
    if (!data.messages?.length) return "No messages found."

    const messages = await Promise.all(
      data.messages.slice(0, args.maxResults || 10).map((m: any) =>
        gmailFetch(`/users/me/messages/${m.id}?format=full`)
      )
    )
    return messages.map((msg: any) => {
      const from = getHeader(msg, "From") ?? "?"
      const subject = getHeader(msg, "Subject") ?? "(no subject)"
      const date = getHeader(msg, "Date") ?? "?"
      const body = decodeTextBody(msg)?.slice(0, 500) ?? msg.snippet ?? ""
      return `**${subject}**\nFrom: ${from} | Date: ${date}\nID: ${msg.id}\n${body}\n`
    }).join("\n---\n")
  },

  "get-message": async (args: any) => {
    const msg = await gmailFetch(`/users/me/messages/${args.messageId}?format=full`)
    const from = getHeader(msg, "From") ?? "?"
    const to = getHeader(msg, "To") ?? "?"
    const subject = getHeader(msg, "Subject") ?? "(no subject)"
    const date = getHeader(msg, "Date") ?? "?"
    const body = decodeTextBody(msg) ?? msg.snippet ?? ""
    return `**${subject}**\nFrom: ${from}\nTo: ${to}\nDate: ${date}\nID: ${msg.id}\n\n${body}`
  },

  "send-message": async (args: any) => {
    const rfc = buildRfc2822({ to: args.to, subject: args.subject, body: args.body, cc: args.cc, bcc: args.bcc })
    const raw = encodeRawMessage(rfc)
    const sent = await gmailFetch("/users/me/messages/send", { method: "POST", body: JSON.stringify({ raw }) })
    return `Message sent. ID: ${sent.id} | Thread: ${sent.threadId}`
  },

  "reply-message": async (args: any) => {
    const original = await gmailFetch(`/users/me/messages/${args.messageId}?format=metadata`)
    const messageId = getHeader(original, "Message-ID")
    const existingRefs = getHeader(original, "References")
    const subject = getHeader(original, "Subject") ?? ""
    const from = getHeader(original, "From") ?? ""
    const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`
    const references = existingRefs ? `${existingRefs} ${messageId}` : messageId

    const rfc = buildRfc2822({
      to: args.to ?? from, subject: replySubject, body: args.body,
      cc: args.cc, inReplyTo: messageId, references: references ?? undefined,
    })
    const raw = encodeRawMessage(rfc)
    const sent = await gmailFetch("/users/me/messages/send", {
      method: "POST", body: JSON.stringify({ raw, threadId: original.threadId }),
    })
    return `Reply sent. ID: ${sent.id} | Thread: ${sent.threadId}`
  },

  "forward-message": async (args: any) => {
    const original = await gmailFetch(`/users/me/messages/${args.messageId}?format=full`)
    const subject = getHeader(original, "Subject") ?? ""
    const from = getHeader(original, "From") ?? "?"
    const date = getHeader(original, "Date") ?? "?"
    const originalBody = decodeTextBody(original) ?? original.snippet ?? ""
    const fwdSubject = subject.startsWith("Fwd:") ? subject : `Fwd: ${subject}`
    const fwdBody = [
      args.body ? `${args.body}\n\n` : "",
      "---------- Forwarded message ----------",
      `From: ${from}`, `Date: ${date}`, `Subject: ${subject}`, "", originalBody,
    ].join("\n")
    const rfc = buildRfc2822({ to: args.to, subject: fwdSubject, body: fwdBody, cc: args.cc })
    const raw = encodeRawMessage(rfc)
    const sent = await gmailFetch("/users/me/messages/send", { method: "POST", body: JSON.stringify({ raw }) })
    return `Message forwarded. ID: ${sent.id} | Thread: ${sent.threadId}`
  },

  "modify-labels": async (args: any) => {
    const result = await gmailFetch(`/users/me/messages/${args.messageId}/modify`, {
      method: "POST",
      body: JSON.stringify({ addLabelIds: args.addLabelIds, removeLabelIds: args.removeLabelIds }),
    })
    return `Labels modified for ${result.id}. Current: ${result.labelIds?.join(", ") ?? "none"}`
  },

  "trash-message": async (args: any) => {
    await gmailFetch(`/users/me/messages/${args.messageId}/trash`, { method: "POST" })
    return `Message ${args.messageId} moved to trash.`
  },

  "list-drafts": async (args: any) => {
    const params = new URLSearchParams()
    if (args.maxResults) params.set("maxResults", String(args.maxResults))
    const data = await gmailFetch(`/users/me/drafts?${params}`)
    if (!data.drafts?.length) return "No drafts found."
    const drafts = await Promise.all(
      data.drafts.map((d: any) => gmailFetch(`/users/me/messages/${d.message.id}?format=full`))
    )
    return drafts.map((msg: any) => {
      const subject = getHeader(msg, "Subject") ?? "(no subject)"
      const to = getHeader(msg, "To") ?? "?"
      return `- ${subject} → ${to} (ID: ${msg.id})`
    }).join("\n")
  },

  "create-draft": async (args: any) => {
    const rfc = buildRfc2822({ to: args.to, subject: args.subject, body: args.body, cc: args.cc, bcc: args.bcc })
    const raw = encodeRawMessage(rfc)
    const draft = await gmailFetch("/users/me/drafts", {
      method: "POST", body: JSON.stringify({ message: { raw } }),
    })
    return `Draft created. Draft ID: ${draft.id} | Message ID: ${draft.message.id}`
  },
}

// ── MCP Server ────────────────────────────────────────────────────────

const TOOL_SCHEMAS: Array<{ name: string; description: string; inputSchema: any }> = [
  { name: "list-labels", description: "Return all Gmail labels with unread counts.", inputSchema: { type: "object", properties: {} } },
  { name: "list-messages", description: "Search and list Gmail messages.", inputSchema: { type: "object", properties: {
    query: { type: "string", description: "Gmail search query" },
    labelIds: { type: "array", items: { type: "string" }, description: "Filter by label IDs" },
    maxResults: { type: "number", description: "Max messages (default 10)" },
    pageToken: { type: "string", description: "Pagination token" },
  } } },
  { name: "get-message", description: "Fetch a single email.", inputSchema: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"] } },
  { name: "send-message", description: "Send a new email.", inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, bcc: { type: "string" } }, required: ["to", "subject", "body"] } },
  { name: "reply-message", description: "Reply to an email thread.", inputSchema: { type: "object", properties: { messageId: { type: "string" }, body: { type: "string" }, to: { type: "string" }, cc: { type: "string" } }, required: ["messageId", "body"] } },
  { name: "forward-message", description: "Forward an email.", inputSchema: { type: "object", properties: { messageId: { type: "string" }, to: { type: "string" }, body: { type: "string" }, cc: { type: "string" } }, required: ["messageId", "to"] } },
  { name: "modify-labels", description: "Add/remove labels on a message.", inputSchema: { type: "object", properties: { messageId: { type: "string" }, addLabelIds: { type: "array", items: { type: "string" } }, removeLabelIds: { type: "array", items: { type: "string" } } }, required: ["messageId"] } },
  { name: "trash-message", description: "Move a message to trash.", inputSchema: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"] } },
  { name: "list-drafts", description: "List email drafts.", inputSchema: { type: "object", properties: { maxResults: { type: "number" } } } },
  { name: "create-draft", description: "Create an email draft.", inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, bcc: { type: "string" } }, required: ["to", "subject", "body"] } },
]

const server = new Server({ name: "gmail-mcp", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_SCHEMAS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const handler = tools[name]
  if (!handler) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true }
  }
  try {
    const text = await handler(args ?? {})
    return { content: [{ type: "text", text }] }
  } catch (err: any) {
    log.error(`tool ${name} failed`, { error: err.message })
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true }
  }
})

log.info("starting gmail-mcp server")
const transport = new StdioServerTransport()
await server.connect(transport)
