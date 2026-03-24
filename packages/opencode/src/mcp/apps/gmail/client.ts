import { Log } from "@/util/log"

const log = Log.create({ service: "gmail-client" })
const BASE_URL = "https://gmail.googleapis.com/gmail/v1"

export namespace GmailClient {
  export interface Label {
    id: string
    name: string
    type: string
    messageListVisibility?: string
    labelListVisibility?: string
    messagesTotal?: number
    messagesUnread?: number
    threadsTotal?: number
    threadsUnread?: number
  }

  export interface MessageHeader {
    name: string
    value: string
  }

  export interface MessagePart {
    partId: string
    mimeType: string
    filename: string
    headers: MessageHeader[]
    body: MessagePartBody
    parts?: MessagePart[]
  }

  export interface MessagePartBody {
    attachmentId?: string
    size: number
    data?: string
  }

  export interface Message {
    id: string
    threadId: string
    labelIds?: string[]
    snippet: string
    historyId?: string
    internalDate?: string
    payload?: MessagePart
    sizeEstimate?: number
    raw?: string
  }

  export interface MessageListEntry {
    id: string
    threadId: string
  }

  export interface Draft {
    id: string
    message: Message
  }

  export interface DraftListEntry {
    id: string
    message: { id: string; threadId: string }
  }

  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      const msg =
        typeof body === "object" && body !== null && "error" in body
          ? JSON.stringify((body as Record<string, unknown>).error)
          : String(body)
      super(`Gmail API error ${status}: ${msg}`)
      this.name = "GmailApiError"
    }
  }

  async function request<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
    const url = path.startsWith("https://") ? path : `${BASE_URL}${path}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    }

    log.info("gmail api request", { method: init?.method ?? "GET", path })

    const response = await fetch(url, { ...init, headers })
    if (!response.ok) {
      const body = await response.json().catch(() => response.text())
      throw new ApiError(response.status, body)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  // ---------- Labels ----------

  export async function listLabels(accessToken: string): Promise<Label[]> {
    const data = await request<{ labels?: Label[] }>(accessToken, "/users/me/labels")
    return data.labels ?? []
  }

  export async function getLabel(accessToken: string, labelId: string): Promise<Label> {
    return request<Label>(accessToken, `/users/me/labels/${encodeURIComponent(labelId)}`)
  }

  // ---------- Messages ----------

  export async function listMessages(
    accessToken: string,
    opts?: {
      query?: string
      labelIds?: string[]
      maxResults?: number
      pageToken?: string
    },
  ): Promise<{ messages: MessageListEntry[]; nextPageToken?: string; resultSizeEstimate?: number }> {
    const params = new URLSearchParams()
    if (opts?.query) params.set("q", opts.query)
    if (opts?.labelIds?.length) {
      for (const id of opts.labelIds) params.append("labelIds", id)
    }
    if (opts?.maxResults) params.set("maxResults", String(opts.maxResults))
    if (opts?.pageToken) params.set("pageToken", opts.pageToken)

    const qs = params.toString()
    const data = await request<{
      messages?: MessageListEntry[]
      nextPageToken?: string
      resultSizeEstimate?: number
    }>(accessToken, `/users/me/messages${qs ? `?${qs}` : ""}`)
    return {
      messages: data.messages ?? [],
      nextPageToken: data.nextPageToken,
      resultSizeEstimate: data.resultSizeEstimate,
    }
  }

  export async function getMessage(
    accessToken: string,
    messageId: string,
    format: "full" | "metadata" | "minimal" = "full",
  ): Promise<Message> {
    return request<Message>(
      accessToken,
      `/users/me/messages/${encodeURIComponent(messageId)}?format=${format}`,
    )
  }

  export async function modifyMessage(
    accessToken: string,
    messageId: string,
    addLabelIds?: string[],
    removeLabelIds?: string[],
  ): Promise<Message> {
    const body: Record<string, string[]> = {}
    if (addLabelIds?.length) body.addLabelIds = addLabelIds
    if (removeLabelIds?.length) body.removeLabelIds = removeLabelIds
    return request<Message>(
      accessToken,
      `/users/me/messages/${encodeURIComponent(messageId)}/modify`,
      { method: "POST", body: JSON.stringify(body) },
    )
  }

  export async function trashMessage(accessToken: string, messageId: string): Promise<Message> {
    return request<Message>(
      accessToken,
      `/users/me/messages/${encodeURIComponent(messageId)}/trash`,
      { method: "POST" },
    )
  }

  export async function sendMessage(
    accessToken: string,
    raw: string,
    threadId?: string,
  ): Promise<Message> {
    const body: Record<string, string> = { raw }
    if (threadId) body.threadId = threadId
    return request<Message>(accessToken, "/users/me/messages/send", {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  // ---------- Drafts ----------

  export async function listDrafts(
    accessToken: string,
    opts?: { maxResults?: number; pageToken?: string },
  ): Promise<{ drafts: DraftListEntry[]; nextPageToken?: string }> {
    const params = new URLSearchParams()
    if (opts?.maxResults) params.set("maxResults", String(opts.maxResults))
    if (opts?.pageToken) params.set("pageToken", opts.pageToken)

    const qs = params.toString()
    const data = await request<{ drafts?: DraftListEntry[]; nextPageToken?: string }>(
      accessToken,
      `/users/me/drafts${qs ? `?${qs}` : ""}`,
    )
    return { drafts: data.drafts ?? [], nextPageToken: data.nextPageToken }
  }

  export async function createDraft(accessToken: string, raw: string): Promise<Draft> {
    return request<Draft>(accessToken, "/users/me/drafts", {
      method: "POST",
      body: JSON.stringify({ message: { raw } }),
    })
  }

  // ---------- Helpers ----------

  /** Encode an RFC 2822 message as web-safe base64 for the Gmail API. */
  export function encodeRawMessage(rfc2822: string): string {
    const bytes = new TextEncoder().encode(rfc2822)
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  }

  /** Build a minimal RFC 2822 message string. */
  export function buildRfc2822(opts: {
    to: string
    subject: string
    body: string
    cc?: string
    bcc?: string
    inReplyTo?: string
    references?: string
    from?: string
  }): string {
    const lines: string[] = []
    if (opts.from) lines.push(`From: ${opts.from}`)
    lines.push(`To: ${opts.to}`)
    if (opts.cc) lines.push(`Cc: ${opts.cc}`)
    if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`)
    lines.push(`Subject: ${opts.subject}`)
    if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`)
    if (opts.references) lines.push(`References: ${opts.references}`)
    lines.push("MIME-Version: 1.0")
    lines.push("Content-Type: text/plain; charset=UTF-8")
    lines.push("")
    lines.push(opts.body)
    return lines.join("\r\n")
  }

  /** Extract a header value from a message payload. */
  export function getHeader(message: Message, name: string): string | undefined {
    return message.payload?.headers?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase(),
    )?.value
  }

  /** Decode base64url data from a message part. */
  function decodePartData(data: string): string {
    const padded = data.replace(/-/g, "+").replace(/_/g, "/")
    return new TextDecoder().decode(
      Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
    )
  }

  /** Decode common HTML entities. */
  function decodeEntities(text: string): string {
    return text
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
  }

  /** Extract cell text from a <td> or <th> element string. */
  function cellText(cell: string): string {
    return decodeEntities(cell.replace(/<[^>]+>/g, "")).trim()
  }

  /** Convert HTML <table> blocks to markdown tables. */
  function convertTables(html: string): string {
    return html.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableBody: string) => {
      const rows: string[][] = []
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
      let rowMatch: RegExpExecArray | null
      while ((rowMatch = rowRegex.exec(tableBody)) !== null) {
        const cells: string[] = []
        const cellRegex = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi
        let cellMatch: RegExpExecArray | null
        while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
          cells.push(cellText(cellMatch[1]))
        }
        if (cells.length > 0) rows.push(cells)
      }
      if (rows.length === 0) return ""

      // Normalize column count
      const colCount = Math.max(...rows.map((r) => r.length))
      for (const row of rows) {
        while (row.length < colCount) row.push("")
      }

      // Build markdown table
      const colWidths = Array.from({ length: colCount }, (_, i) =>
        Math.max(3, ...rows.map((r) => r[i].length)),
      )
      const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length))
      const lines: string[] = []
      for (let r = 0; r < rows.length; r++) {
        lines.push("| " + rows[r].map((c, i) => pad(c, colWidths[i])).join(" | ") + " |")
        if (r === 0) {
          lines.push("| " + colWidths.map((w) => "-".repeat(w)).join(" | ") + " |")
        }
      }
      return "\n" + lines.join("\n") + "\n"
    })
  }

  /** Convert HTML to readable markdown-flavoured plain text. */
  function stripHtml(html: string): string {
    // Remove non-content blocks
    let text = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")

    // Convert tables to markdown before stripping tags
    text = convertTables(text)

    // Convert structural tags
    text = text
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?(p|div|li)[^>]*>/gi, "\n")
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
        const hashes = "#".repeat(Number(level))
        return `\n${hashes} ${cellText(content)}\n`
      })
      .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
        const t = cellText(label)
        return t === href ? t : `[${t}](${href})`
      })
      .replace(/<\/?(?:b|strong)[^>]*>/gi, "**")
      .replace(/<\/?(?:i|em)[^>]*>/gi, "_")

    // Strip remaining tags
    text = text.replace(/<[^>]+>/g, "")

    // Decode entities and clean up whitespace
    text = decodeEntities(text)
      .replace(/\n{3,}/g, "\n\n")
      .trim()

    return text
  }

  /** Find a part by mime type recursively. */
  function findPart(part: MessagePart, mimeType: string): MessagePart | null {
    if (part.mimeType === mimeType && part.body?.data) return part
    if (part.parts) {
      for (const sub of part.parts) {
        const found = findPart(sub, mimeType)
        if (found) return found
      }
    }
    return null
  }

  /** Decode the body from a message. Prefers text/plain, falls back to text/html (stripped). */
  export function decodeTextBody(message: Message): string | null {
    if (!message.payload) return null

    const plain = findPart(message.payload, "text/plain")
    if (plain?.body?.data) return decodePartData(plain.body.data)

    const html = findPart(message.payload, "text/html")
    if (html?.body?.data) return stripHtml(decodePartData(html.body.data))

    return null
  }
}
