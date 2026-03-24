import path from "path"
import { ManagedAppRegistry } from "@/mcp/app-registry"
import { Global } from "@/global"
import { GoogleCalendarClient } from "./client"
import { Log } from "@/util/log"

const log = Log.create({ service: "google-calendar-app" })

interface GAuthTokens {
  access_token: string
  refresh_token: string
  expires_at: number
  token_type: string
  updated_at: number
}

export namespace GoogleCalendarApp {
  const APP_ID = "google-calendar"

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
        message: "Google Calendar OAuth tokens not found in gauth.json",
      })
    }

    return tokens.access_token
  }

  function formatCalendarList(calendars: GoogleCalendarClient.CalendarListEntry[]): string {
    if (calendars.length === 0) return "No calendars found for this account."
    const lines = calendars.map((c) => {
      const primary = c.primary ? " (primary)" : ""
      const tz = c.timeZone ? ` [${c.timeZone}]` : ""
      return `- **${c.summary}**${primary}${tz}\n  ID: \`${c.id}\`\n  Role: ${c.accessRole ?? "unknown"}`
    })
    return `Found ${calendars.length} calendar(s):\n\n${lines.join("\n\n")}`
  }

  function formatEvent(e: GoogleCalendarClient.CalendarEvent): string {
    const start = e.start.dateTime ?? e.start.date ?? "?"
    const end = e.end.dateTime ?? e.end.date ?? "?"
    const lines = [
      `**${e.summary ?? "(no title)"}**`,
      `ID: \`${e.id}\``,
      `When: ${start} → ${end}`,
    ]
    if (e.location) lines.push(`Location: ${e.location}`)
    if (e.description) lines.push(`Description: ${e.description}`)
    if (e.attendees?.length) {
      lines.push(`Attendees: ${e.attendees.map((a) => a.email).join(", ")}`)
    }
    if (e.htmlLink) lines.push(`Link: ${e.htmlLink}`)
    if (e.status) lines.push(`Status: ${e.status}`)
    return lines.join("\n")
  }

  function formatEventList(events: GoogleCalendarClient.CalendarEvent[]): string {
    if (events.length === 0) return "No events found in the specified range."
    return `Found ${events.length} event(s):\n\n${events.map(formatEvent).join("\n\n---\n\n")}`
  }

  function formatFreeBusy(response: GoogleCalendarClient.FreeBusyResponse): string {
    const lines: string[] = [`Free/busy from ${response.timeMin} to ${response.timeMax}:`]
    for (const [calId, data] of Object.entries(response.calendars)) {
      if (data.busy.length === 0) {
        lines.push(`\n**${calId}**: Free (no busy windows)`)
      } else {
        lines.push(`\n**${calId}**: ${data.busy.length} busy window(s)`)
        for (const slot of data.busy) {
          lines.push(`  - ${slot.start} → ${slot.end}`)
        }
      }
      if (data.errors?.length) {
        for (const err of data.errors) {
          lines.push(`  ⚠ Error: ${err.reason} (${err.domain})`)
        }
      }
    }
    return lines.join("\n")
  }

  export type ToolExecutor = (args: Record<string, unknown>) => Promise<string>

  export const tools: Record<string, ToolExecutor> = {
    "list-calendars": async () => {
      const token = await resolveAccessToken()
      const calendars = await GoogleCalendarClient.listCalendars(token)
      return formatCalendarList(calendars)
    },

    "list-events": async (args) => {
      const token = await resolveAccessToken()
      const calendarId = (args.calendarId as string) || "primary"
      const events = await GoogleCalendarClient.listEvents(token, calendarId, {
        timeMin: args.timeMin as string | undefined,
        timeMax: args.timeMax as string | undefined,
        query: args.query as string | undefined,
        limit: args.limit as number | undefined,
      })
      return formatEventList(events)
    },

    "get-event": async (args) => {
      const token = await resolveAccessToken()
      const event = await GoogleCalendarClient.getEvent(
        token,
        args.calendarId as string,
        args.eventId as string,
      )
      return formatEvent(event)
    },

    "create-event": async (args) => {
      const token = await resolveAccessToken()
      const event = await GoogleCalendarClient.createEvent(token, args.calendarId as string, {
        summary: args.summary as string,
        start: args.start as string,
        end: args.end as string,
        description: args.description as string | undefined,
        location: args.location as string | undefined,
        attendees: args.attendees as string[] | undefined,
        timeZone: args.timeZone as string | undefined,
      })
      return `Event created successfully:\n\n${formatEvent(event)}`
    },

    "update-event": async (args) => {
      const token = await resolveAccessToken()
      const event = await GoogleCalendarClient.updateEvent(
        token,
        args.calendarId as string,
        args.eventId as string,
        {
          summary: args.summary as string | undefined,
          start: args.start as string | undefined,
          end: args.end as string | undefined,
          description: args.description as string | undefined,
          location: args.location as string | undefined,
          attendees: args.attendees as string[] | undefined,
        },
      )
      return `Event updated successfully:\n\n${formatEvent(event)}`
    },

    "delete-event": async (args) => {
      const token = await resolveAccessToken()
      await GoogleCalendarClient.deleteEvent(
        token,
        args.calendarId as string,
        args.eventId as string,
        args.sendUpdates as boolean | undefined,
      )
      return `Event \`${args.eventId}\` deleted from calendar \`${args.calendarId}\`.`
    },

    "freebusy": async (args) => {
      const token = await resolveAccessToken()
      const response = await GoogleCalendarClient.freeBusy(
        token,
        args.calendarIds as string[],
        args.timeMin as string,
        args.timeMax as string,
        args.timeZone as string | undefined,
      )
      return formatFreeBusy(response)
    },
  }

  export async function execute(toolId: string, args: Record<string, unknown>): Promise<string> {
    const executor = tools[toolId]
    if (!executor) {
      throw new Error(`Unknown Google Calendar tool: ${toolId}`)
    }
    log.info("executing google calendar tool", { toolId })
    try {
      return await executor(args)
    } catch (error) {
      if (error instanceof ManagedAppRegistry.UsageStateError) throw error
      log.error("google calendar tool execution failed", { toolId, error })
      const message = error instanceof Error ? error.message : String(error)
      await ManagedAppRegistry.markError(APP_ID, {
        code: "GOOGLE_CALENDAR_TOOL_ERROR",
        message: `Tool ${toolId} failed: ${message}`,
      }).catch(() => {})
      throw error
    }
  }
}
