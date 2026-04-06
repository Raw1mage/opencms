#!/usr/bin/env bun
/**
 * Google Calendar MCP Server — Standalone stdio binary
 *
 * Built with: bun build --compile --target=bun-linux-x64 server.ts --outfile gcal-server
 *
 * Reads GOOGLE_ACCESS_TOKEN from environment.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const log = {
  info: (msg: string, extra?: Record<string, unknown>) =>
    console.error(`[gcal-server] INFO: ${msg}`, extra ? JSON.stringify(extra) : ""),
  warn: (msg: string, extra?: Record<string, unknown>) =>
    console.error(`[gcal-server] WARN: ${msg}`, extra ? JSON.stringify(extra) : ""),
  error: (msg: string, extra?: Record<string, unknown>) =>
    console.error(`[gcal-server] ERROR: ${msg}`, extra ? JSON.stringify(extra) : ""),
}

// ── Calendar HTTP Client ──────────────────────────────────────────────

const BASE_URL = "https://www.googleapis.com/calendar/v3"

function getToken(): string {
  const token = process.env.GOOGLE_ACCESS_TOKEN
  if (!token) throw new Error("GOOGLE_ACCESS_TOKEN environment variable is required")
  return token
}

async function calFetch(path: string, opts?: RequestInit): Promise<any> {
  const token = getToken()
  const url = path.startsWith("https://") ? path : `${BASE_URL}${path}`
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Calendar API ${res.status}: ${body.slice(0, 200)}`)
  }
  if (res.status === 204) return undefined
  return res.json()
}

function formatEvent(e: any): string {
  const start = e.start?.dateTime ?? e.start?.date ?? "?"
  const end = e.end?.dateTime ?? e.end?.date ?? "?"
  const lines = [`**${e.summary ?? "(no title)"}}**`, `  ID: ${e.id}`, `  Time: ${start} → ${end}`]
  if (e.location) lines.push(`  Location: ${e.location}`)
  if (e.description) lines.push(`  Description: ${e.description.slice(0, 200)}`)
  if (e.attendees?.length) lines.push(`  Attendees: ${e.attendees.map((a: any) => a.email).join(", ")}`)
  return lines.join("\n")
}

// ── Tool implementations ──────────────────────────────────────────────

const tools: Record<string, (args: any) => Promise<string>> = {
  "list-calendars": async () => {
    const data = await calFetch("/users/me/calendarList?maxResults=250")
    const items = data.items ?? []
    if (items.length === 0) return "No calendars found."
    return items.map((c: any) =>
      `- ${c.summary}${c.primary ? " (primary)" : ""} | ID: ${c.id} | TZ: ${c.timeZone ?? "?"}`
    ).join("\n")
  },

  "list-events": async (args: any) => {
    const calendarId = args.calendarId || "primary"
    const params = new URLSearchParams({ singleEvents: "true", orderBy: "startTime" })
    if (args.timeMin) params.set("timeMin", args.timeMin)
    if (args.timeMax) params.set("timeMax", args.timeMax)
    if (args.query) params.set("q", args.query)
    if (args.limit) params.set("maxResults", String(args.limit))
    const data = await calFetch(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`)
    const items = data.items ?? []
    if (items.length === 0) return "No events found."
    return items.map((e: any) => formatEvent(e)).join("\n\n")
  },

  "get-event": async (args: any) => {
    const e = await calFetch(`/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.eventId)}`)
    return formatEvent(e)
  },

  "create-event": async (args: any) => {
    const tz = args.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const body: any = {
      summary: args.summary,
      start: { dateTime: args.start, timeZone: tz },
      end: { dateTime: args.end, timeZone: tz },
    }
    if (args.description) body.description = args.description
    if (args.location) body.location = args.location
    if (args.attendees) body.attendees = args.attendees.map((email: string) => ({ email }))
    const e = await calFetch(`/calendars/${encodeURIComponent(args.calendarId)}/events`, {
      method: "POST", body: JSON.stringify(body),
    })
    return `Event created:\n${formatEvent(e)}`
  },

  "update-event": async (args: any) => {
    const patch: any = {}
    if (args.summary !== undefined) patch.summary = args.summary
    if (args.description !== undefined) patch.description = args.description
    if (args.location !== undefined) patch.location = args.location
    if (args.start !== undefined) patch.start = { dateTime: args.start }
    if (args.end !== undefined) patch.end = { dateTime: args.end }
    if (args.attendees !== undefined) patch.attendees = args.attendees.map((email: string) => ({ email }))
    const e = await calFetch(
      `/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.eventId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    )
    return `Event updated:\n${formatEvent(e)}`
  },

  "delete-event": async (args: any) => {
    const sendParam = args.sendUpdates ? "?sendUpdates=all" : ""
    await calFetch(
      `/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.eventId)}${sendParam}`,
      { method: "DELETE" },
    )
    return `Event ${args.eventId} deleted from ${args.calendarId}.`
  },

  "freebusy": async (args: any) => {
    const tz = args.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const data = await calFetch("/freeBusy", {
      method: "POST",
      body: JSON.stringify({
        timeMin: args.timeMin, timeMax: args.timeMax, timeZone: tz,
        items: args.calendarIds.map((id: string) => ({ id })),
      }),
    })
    const calendars = data.calendars ?? {}
    const lines = Object.entries(calendars).map(([calId, cal]: [string, any]) => {
      const busy = cal.busy ?? []
      if (busy.length === 0) return `${calId}: free`
      return `${calId}:\n${busy.map((b: any) => `  busy ${b.start} → ${b.end}`).join("\n")}`
    })
    return lines.join("\n\n")
  },
}

// ── MCP Server ────────────────────────────────────────────────────────

const TOOL_SCHEMAS: Array<{ name: string; description: string; inputSchema: any }> = [
  { name: "list-calendars", description: "List all accessible calendars.", inputSchema: { type: "object", properties: {} } },
  { name: "list-events", description: "Query events in a calendar.", inputSchema: { type: "object", properties: {
    calendarId: { type: "string", description: "Calendar ID (default: primary)" },
    timeMin: { type: "string", description: "Start time (RFC3339)" },
    timeMax: { type: "string", description: "End time (RFC3339)" },
    query: { type: "string", description: "Free-text filter" },
    limit: { type: "number", description: "Max events" },
  } } },
  { name: "get-event", description: "Get a single event.", inputSchema: { type: "object", properties: {
    calendarId: { type: "string" }, eventId: { type: "string" },
  }, required: ["calendarId", "eventId"] } },
  { name: "create-event", description: "Create a calendar event.", inputSchema: { type: "object", properties: {
    calendarId: { type: "string" }, summary: { type: "string" },
    start: { type: "string" }, end: { type: "string" },
    description: { type: "string" }, location: { type: "string" },
    attendees: { type: "array", items: { type: "string" } },
    timeZone: { type: "string" },
  }, required: ["calendarId", "summary", "start", "end"] } },
  { name: "update-event", description: "Update an existing event.", inputSchema: { type: "object", properties: {
    calendarId: { type: "string" }, eventId: { type: "string" },
    summary: { type: "string" }, start: { type: "string" }, end: { type: "string" },
    description: { type: "string" }, location: { type: "string" },
    attendees: { type: "array", items: { type: "string" } },
  }, required: ["calendarId", "eventId"] } },
  { name: "delete-event", description: "Delete a calendar event.", inputSchema: { type: "object", properties: {
    calendarId: { type: "string" }, eventId: { type: "string" },
    sendUpdates: { type: "boolean" },
  }, required: ["calendarId", "eventId"] } },
  { name: "freebusy", description: "Check free/busy availability.", inputSchema: { type: "object", properties: {
    calendarIds: { type: "array", items: { type: "string" } },
    timeMin: { type: "string" }, timeMax: { type: "string" },
    timeZone: { type: "string" },
  }, required: ["calendarIds", "timeMin", "timeMax"] } },
]

const server = new Server({ name: "gcal-mcp", version: "1.0.0" }, { capabilities: { tools: {} } })

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

log.info("starting gcal-mcp server")
const transport = new StdioServerTransport()
await server.connect(transport)
