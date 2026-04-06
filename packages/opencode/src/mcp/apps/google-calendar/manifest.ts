import type { ManagedAppRegistry } from "@/mcp/app-registry"

export const manifest: ManagedAppRegistry.CatalogEntry = {
  id: "google-calendar",
  name: "Google Calendar",
  description: "Managed MCP app for Google Calendar operations under opencode runtime ownership.",
  version: "0.1.0",
  source: {
    type: "builtin",
    owner: "opencode",
    package: "@opencode-ai/google-calendar",
    entrypoint: "packages/opencode/src/mcp/apps/google-calendar",
    localOnly: true,
  },
  capabilities: [
    {
      id: "google-calendar.oauth",
      label: "Google account binding",
      kind: "oauth",
      description:
        "Binds the managed app to an explicitly authenticated Google account under canonical account ownership.",
      operations: ["read"],
    },
    {
      id: "google-calendar.calendars.read",
      label: "Calendar discovery",
      kind: "tool",
      description:
        "Enumerates calendars available to the authenticated Google account for downstream scheduling operations.",
      operations: ["list", "read"],
    },
    {
      id: "google-calendar.events.read",
      label: "Event inspection",
      kind: "tool",
      description: "Reads event details and queries event windows for LLM planning and summarization flows.",
      operations: ["list", "read", "query"],
    },
    {
      id: "google-calendar.events.write",
      label: "Event mutation",
      kind: "tool",
      description: "Creates, updates, and deletes calendar events without implicit fallback account selection.",
      operations: ["create", "update", "delete"],
    },
    {
      id: "google-calendar.availability.read",
      label: "Availability lookup",
      kind: "tool",
      description: "Checks free/busy windows across one or more calendars for scheduling decisions.",
      operations: ["query", "read"],
    },
  ],
  permissions: [
    { id: "google-calendar.read", label: "Read calendar metadata and events", required: true },
    { id: "google-calendar.write", label: "Create and modify calendar events", required: true },
  ],
  requiredConfig: ["googleOAuth"],
  auth: {
    providerKey: "google-calendar",
    ownership: "canonical-account",
    type: "oauth",
    required: true,
    allowImplicitActiveAccount: false,
    scopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.events"],
  },
  configContract: {
    fields: [{ key: "googleOAuth", label: "Google OAuth client", required: true, secret: true }],
  },
  toolContract: {
    namespace: "google-calendar",
    tools: [
      {
        id: "list-calendars",
        label: "List calendars",
        capabilityId: "google-calendar.calendars.read",
        description:
          "Return calendars the authenticated account can access, including calendar IDs needed by follow-up tools.",
        mutates: false,
        requiresConfirmation: false,
        arguments: [],
      },
      {
        id: "list-events",
        label: "List events",
        capabilityId: "google-calendar.events.read",
        description:
          "Query events within a calendar and optional time window. Defaults to the user's primary calendar — no need to call list-calendars first for typical queries.",
        mutates: false,
        requiresConfirmation: false,
        arguments: [
          {
            name: "calendarId",
            type: "string",
            description: "Target calendar identifier. Defaults to 'primary' if omitted.",
            required: false,
          },
          {
            name: "timeMin",
            type: "datetime",
            description: "Inclusive lower bound for event start filtering.",
            required: false,
          },
          {
            name: "timeMax",
            type: "datetime",
            description: "Exclusive upper bound for event start filtering.",
            required: false,
          },
          {
            name: "query",
            type: "string",
            description: "Free-text query to filter returned events.",
            required: false,
          },
          { name: "limit", type: "number", description: "Maximum number of events to return.", required: false },
        ],
      },
      {
        id: "get-event",
        label: "Get event",
        capabilityId: "google-calendar.events.read",
        description: "Fetch a single event with canonical fields needed for reasoning or later mutation.",
        mutates: false,
        requiresConfirmation: false,
        arguments: [
          { name: "calendarId", type: "string", description: "Calendar containing the event.", required: true },
          { name: "eventId", type: "string", description: "Google Calendar event identifier.", required: true },
        ],
      },
      {
        id: "create-event",
        label: "Create event",
        capabilityId: "google-calendar.events.write",
        description: "Create a calendar event from structured scheduling intent supplied by the LLM or operator.",
        mutates: true,
        requiresConfirmation: false,
        arguments: [
          {
            name: "calendarId",
            type: "string",
            description: "Calendar that will receive the new event.",
            required: true,
          },
          { name: "summary", type: "string", description: "Human-readable event title.", required: true },
          {
            name: "start",
            type: "datetime",
            description: "Event start timestamp in RFC3339 form.",
            required: true,
          },
          { name: "end", type: "datetime", description: "Event end timestamp in RFC3339 form.", required: true },
          { name: "description", type: "string", description: "Optional rich description/body.", required: false },
          { name: "location", type: "string", description: "Optional event location.", required: false },
          { name: "attendees", type: "string[]", description: "Optional attendee email list.", required: false },
          {
            name: "timeZone",
            type: "string",
            description: "Optional timezone override for start/end values.",
            required: false,
          },
        ],
      },
      {
        id: "update-event",
        label: "Update event",
        capabilityId: "google-calendar.events.write",
        description:
          "Apply structured changes to an existing event while preserving explicit account binding and target calendar.",
        mutates: true,
        requiresConfirmation: false,
        arguments: [
          { name: "calendarId", type: "string", description: "Calendar containing the event.", required: true },
          { name: "eventId", type: "string", description: "Event to update.", required: true },
          { name: "summary", type: "string", description: "Replacement event title.", required: false },
          { name: "start", type: "datetime", description: "Replacement start timestamp.", required: false },
          { name: "end", type: "datetime", description: "Replacement end timestamp.", required: false },
          { name: "description", type: "string", description: "Replacement event description.", required: false },
          { name: "location", type: "string", description: "Replacement location.", required: false },
          { name: "attendees", type: "string[]", description: "Replacement attendee email list.", required: false },
        ],
      },
      {
        id: "delete-event",
        label: "Delete event",
        capabilityId: "google-calendar.events.write",
        description:
          "Delete an event from a specific calendar with no implicit fallback to another account or calendar.",
        mutates: true,
        requiresConfirmation: true,
        arguments: [
          { name: "calendarId", type: "string", description: "Calendar containing the event.", required: true },
          { name: "eventId", type: "string", description: "Event to remove.", required: true },
          {
            name: "sendUpdates",
            type: "boolean",
            description: "Whether Google should notify attendees about the deletion.",
            required: false,
          },
        ],
      },
      {
        id: "freebusy",
        label: "Check availability",
        capabilityId: "google-calendar.availability.read",
        description: "Check busy windows for one or more calendars before proposing or creating a meeting.",
        mutates: false,
        requiresConfirmation: false,
        arguments: [
          {
            name: "calendarIds",
            type: "string[]",
            description: "Calendars to query for busy intervals.",
            required: true,
          },
          {
            name: "timeMin",
            type: "datetime",
            description: "Inclusive lower bound for availability lookup.",
            required: true,
          },
          {
            name: "timeMax",
            type: "datetime",
            description: "Exclusive upper bound for availability lookup.",
            required: true,
          },
          {
            name: "timeZone",
            type: "string",
            description: "Optional timezone for response normalization.",
            required: false,
          },
        ],
      },
    ],
  },
}
