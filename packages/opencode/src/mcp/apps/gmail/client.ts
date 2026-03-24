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

  /** Decode the text/plain body from a message. */
  export function decodeTextBody(message: Message): string | null {
    if (!message.payload) return null

    function findPlainPart(part: MessagePart): MessagePart | null {
      if (part.mimeType === "text/plain" && part.body?.data) return part
      if (part.parts) {
        for (const sub of part.parts) {
          const found = findPlainPart(sub)
          if (found) return found
        }
      }
      return null
    }

    const plain = findPlainPart(message.payload)
    if (!plain?.body?.data) return null

    const padded = plain.body.data.replace(/-/g, "+").replace(/_/g, "/")
    return new TextDecoder().decode(
      Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
    )
  }
}
