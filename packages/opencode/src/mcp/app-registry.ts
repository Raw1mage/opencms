import fs from "fs/promises"
import path from "path"
import z from "zod/v4"
import { NamedError } from "@opencode-ai/util/error"
import { Auth } from "@/auth"
import { Account } from "@/account"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Global } from "@/global"
import { Log } from "@/util/log"

export namespace ManagedAppRegistry {
  const log = Log.create({ service: "managed-app-registry" })
  const filepath = path.join(Global.Path.user, "managed-apps.json")
  const VERSION = 1 as const

  export const BuiltInAppSource = z.object({
    type: z.literal("builtin"),
    owner: z.literal("opencode"),
    package: z.string(),
    entrypoint: z.string(),
    localOnly: z.literal(true),
  })
  export type BuiltInAppSource = z.infer<typeof BuiltInAppSource>

  export const Capability = z.object({
    id: z.string(),
    label: z.string(),
    kind: z.enum(["tool", "oauth", "resource", "service"]),
    description: z.string(),
    operations: z.array(z.enum(["list", "read", "create", "update", "delete", "query"])),
  })
  export type Capability = z.infer<typeof Capability>

  export const Permission = z.object({
    id: z.string(),
    label: z.string(),
    required: z.boolean(),
  })
  export type Permission = z.infer<typeof Permission>

  export const AuthOwnership = z.enum(["canonical-account"])
  export type AuthOwnership = z.infer<typeof AuthOwnership>

  export const AuthType = z.enum(["oauth"])
  export type AuthType = z.infer<typeof AuthType>

  export const AuthContract = z.object({
    providerKey: z.string(),
    ownership: AuthOwnership,
    type: AuthType,
    required: z.boolean(),
    allowImplicitActiveAccount: z.boolean(),
    scopes: z.array(z.string()),
  })
  export type AuthContract = z.infer<typeof AuthContract>

  export const ConfigField = z.object({
    key: z.string(),
    label: z.string(),
    required: z.boolean(),
    secret: z.boolean(),
  })
  export type ConfigField = z.infer<typeof ConfigField>

  export const ConfigContract = z.object({
    fields: z.array(ConfigField),
  })
  export type ConfigContract = z.infer<typeof ConfigContract>

  export const ToolArgument = z.object({
    name: z.string(),
    type: z.enum(["string", "string[]", "datetime", "datetime[]", "number", "boolean", "object"]),
    description: z.string(),
    required: z.boolean(),
  })
  export type ToolArgument = z.infer<typeof ToolArgument>

  export const ToolDescriptor = z.object({
    id: z.string(),
    label: z.string(),
    capabilityId: z.string(),
    description: z.string(),
    mutates: z.boolean(),
    requiresConfirmation: z.boolean(),
    arguments: z.array(ToolArgument),
  })
  export type ToolDescriptor = z.infer<typeof ToolDescriptor>

  export const ToolContract = z.object({
    namespace: z.string(),
    tools: z.array(ToolDescriptor),
  })
  export type ToolContract = z.infer<typeof ToolContract>

  export const AuthBindingStatus = z.enum(["not_required", "required", "authenticated", "invalid"])
  export type AuthBindingStatus = z.infer<typeof AuthBindingStatus>

  export const AuthBinding = z.object({
    providerKey: z.string(),
    accountId: z.string().optional(),
    status: AuthBindingStatus,
  })
  export type AuthBinding = z.infer<typeof AuthBinding>

  export const CatalogEntry = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    version: z.string(),
    source: BuiltInAppSource,
    capabilities: z.array(Capability),
    permissions: z.array(Permission),
    requiredConfig: z.array(z.string()),
    auth: AuthContract,
    configContract: ConfigContract,
    toolContract: ToolContract,
  })
  export type CatalogEntry = z.infer<typeof CatalogEntry>

  export const PersistedConfig = z.object({
    keys: z.array(z.string()),
    updatedAt: z.number(),
  })
  export type PersistedConfig = z.infer<typeof PersistedConfig>

  export const InstallState = z.enum(["available", "installing", "installed", "uninstalling"])
  export type InstallState = z.infer<typeof InstallState>

  export const EnableState = z.enum(["disabled", "enabled"])
  export type EnableState = z.infer<typeof EnableState>

  export const ConfigStatus = z.enum(["unknown", "required", "configured", "invalid"])
  export type ConfigStatus = z.infer<typeof ConfigStatus>

  export const ErrorStatus = z.object({
    code: z.string(),
    message: z.string(),
    ts: z.number(),
  })
  export type ErrorStatus = z.infer<typeof ErrorStatus>

  export const RuntimeStatus = z.enum([
    "ready",
    "disabled",
    "error",
    "pending_config",
    "pending_install",
    "pending_auth",
  ])
  export type RuntimeStatus = z.infer<typeof RuntimeStatus>

  export const OperatorInstallState = z.enum(["available", "installed"])
  export type OperatorInstallState = z.infer<typeof OperatorInstallState>

  export const OperatorConfigState = z.enum(["not_required", "required", "configured", "invalid"])
  export type OperatorConfigState = z.infer<typeof OperatorConfigState>

  export const OperatorAuthState = z.enum(["not_required", "required", "authenticated", "invalid"])
  export type OperatorAuthState = z.infer<typeof OperatorAuthState>

  export const OperatorRuntimeState = z.enum(["inactive", "ready", "error"])
  export type OperatorRuntimeState = z.infer<typeof OperatorRuntimeState>

  export const OperatorErrorState = z.enum(["none", "auth_required", "invalid_auth", "invalid_config", "runtime_error"])
  export type OperatorErrorState = z.infer<typeof OperatorErrorState>

  export const OperatorState = z.object({
    install: OperatorInstallState,
    auth: OperatorAuthState,
    config: OperatorConfigState,
    runtime: OperatorRuntimeState,
    error: OperatorErrorState,
  })
  export type OperatorState = z.infer<typeof OperatorState>

  export const UsageErrorReason = z.enum(["unauthenticated", "misconfigured", "runtime_error"])
  export type UsageErrorReason = z.infer<typeof UsageErrorReason>

  export const UsageError = z.object({
    appId: z.string(),
    status: RuntimeStatus,
    reason: UsageErrorReason,
    code: z.string(),
    message: z.string(),
  })
  export type UsageError = z.infer<typeof UsageError>

  export const AppNotFoundError = NamedError.create(
    "ManagedAppNotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  export const UsageStateError = NamedError.create("ManagedAppUsageStateError", UsageError)

  export const AppState = z.object({
    appId: z.string(),
    source: BuiltInAppSource,
    installState: InstallState,
    enableState: EnableState,
    configStatus: ConfigStatus,
    config: PersistedConfig.optional(),
    error: ErrorStatus.optional(),
    installedAt: z.number().optional(),
    updatedAt: z.number(),
  })
  export type AppState = z.infer<typeof AppState>

  export const RuntimeOwner = z.enum(["system", "session"])
  export type RuntimeOwner = z.infer<typeof RuntimeOwner>

  export const RuntimeAttachment = z.object({
    owner: RuntimeOwner,
    ownerId: z.string(),
    attachedAt: z.number(),
  })
  export type RuntimeAttachment = z.infer<typeof RuntimeAttachment>

  export const AppSnapshot = CatalogEntry.extend({
    state: AppState,
    authBinding: AuthBinding,
    runtimeStatus: RuntimeStatus,
    operator: OperatorState,
  })
  export type AppSnapshot = z.infer<typeof AppSnapshot>

  export const RuntimeSnapshot = z.object({
    appId: z.string(),
    status: RuntimeStatus,
    attachment: RuntimeAttachment.optional(),
  })
  export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshot>

  export const ManagedAppSnapshot = z.object({
    catalog: CatalogEntry,
    persisted: AppState,
    authBinding: AuthBinding,
    runtime: RuntimeSnapshot,
    operator: OperatorState,
  })
  export type ManagedAppSnapshot = z.infer<typeof ManagedAppSnapshot>

  export const ReadyToolBinding = z.object({
    appId: z.string(),
    namespace: z.string(),
    tool: ToolDescriptor,
  })
  export type ReadyToolBinding = z.infer<typeof ReadyToolBinding>

  export const Storage = z.object({
    version: z.literal(VERSION),
    apps: z.record(z.string(), AppState),
  })
  export type Storage = z.infer<typeof Storage>

  const runtimeAttachments = new Map<string, RuntimeAttachment>()

  export const Event = {
    Updated: BusEvent.define(
      "managed_app.updated",
      z.object({
        app: AppSnapshot,
      }),
    ),
  }

  const BUILTIN_CATALOG: Record<string, CatalogEntry> = {
    "google-calendar": {
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
              { name: "calendarId", type: "string", description: "Target calendar identifier. Defaults to 'primary' if omitted.", required: false },
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
    },
    "gmail": {
      id: "gmail",
      name: "Gmail",
      description: "Managed MCP app for Gmail operations under opencode runtime ownership.",
      version: "0.1.0",
      source: {
        type: "builtin",
        owner: "opencode",
        package: "@opencode-ai/gmail",
        entrypoint: "packages/opencode/src/mcp/apps/gmail",
        localOnly: true,
      },
      capabilities: [
        {
          id: "gmail.oauth",
          label: "Google account binding",
          kind: "oauth",
          description:
            "Binds the managed app to an explicitly authenticated Google account under canonical account ownership.",
          operations: ["read"],
        },
        {
          id: "gmail.labels.read",
          label: "Label discovery",
          kind: "tool",
          description: "Enumerates system and user labels with unread counts.",
          operations: ["list", "read"],
        },
        {
          id: "gmail.messages.read",
          label: "Message inspection",
          kind: "tool",
          description: "Searches, lists, and reads Gmail messages with full body decoding.",
          operations: ["list", "read", "query"],
        },
        {
          id: "gmail.messages.write",
          label: "Message composition",
          kind: "tool",
          description: "Sends new messages, replies to threads, and forwards messages.",
          operations: ["create"],
        },
        {
          id: "gmail.messages.manage",
          label: "Message management",
          kind: "tool",
          description: "Modifies labels on messages and moves messages to trash.",
          operations: ["update", "delete"],
        },
        {
          id: "gmail.drafts",
          label: "Draft management",
          kind: "tool",
          description: "Lists and creates email drafts.",
          operations: ["list", "create"],
        },
      ],
      permissions: [
        { id: "gmail.read", label: "Read emails, labels, and drafts", required: true },
        { id: "gmail.write", label: "Send, reply, forward, and manage emails", required: true },
      ],
      requiredConfig: ["googleOAuth"],
      auth: {
        providerKey: "gmail",
        ownership: "canonical-account",
        type: "oauth",
        required: true,
        allowImplicitActiveAccount: false,
        scopes: ["https://mail.google.com/"],
      },
      configContract: {
        fields: [{ key: "googleOAuth", label: "Google OAuth client", required: true, secret: true }],
      },
      toolContract: {
        namespace: "gmail",
        tools: [
          {
            id: "list-labels",
            label: "List labels",
            capabilityId: "gmail.labels.read",
            description: "Return all Gmail labels (system and user) with unread counts.",
            mutates: false,
            requiresConfirmation: false,
            arguments: [],
          },
          {
            id: "list-messages",
            label: "List messages",
            capabilityId: "gmail.messages.read",
            description:
              "Search and list Gmail messages using Gmail query syntax (e.g. from:someone, is:unread, subject:keyword). Returns up to 10 messages by default with full headers and body.",
            mutates: false,
            requiresConfirmation: false,
            arguments: [
              {
                name: "query",
                type: "string",
                description: "Gmail search query (same syntax as Gmail search bar). Examples: 'from:user@example.com', 'is:unread', 'subject:invoice after:2026/01/01'.",
                required: false,
              },
              {
                name: "labelIds",
                type: "string[]",
                description: "Filter by label IDs (e.g. INBOX, SENT, STARRED).",
                required: false,
              },
              {
                name: "maxResults",
                type: "number",
                description: "Maximum number of messages to return. Defaults to 10.",
                required: false,
              },
              {
                name: "pageToken",
                type: "string",
                description: "Pagination token from a previous list-messages response.",
                required: false,
              },
            ],
          },
          {
            id: "get-message",
            label: "Get message",
            capabilityId: "gmail.messages.read",
            description: "Fetch a single email with full headers, body, and metadata.",
            mutates: false,
            requiresConfirmation: false,
            arguments: [
              { name: "messageId", type: "string", description: "Gmail message identifier.", required: true },
            ],
          },
          {
            id: "send-message",
            label: "Send message",
            capabilityId: "gmail.messages.write",
            description: "Send a new email to one or more recipients.",
            mutates: true,
            requiresConfirmation: false,
            arguments: [
              { name: "to", type: "string", description: "Recipient email address(es), comma-separated.", required: true },
              { name: "subject", type: "string", description: "Email subject line.", required: true },
              { name: "body", type: "string", description: "Plain text email body.", required: true },
              { name: "cc", type: "string", description: "CC recipients, comma-separated.", required: false },
              { name: "bcc", type: "string", description: "BCC recipients, comma-separated.", required: false },
            ],
          },
          {
            id: "reply-message",
            label: "Reply to message",
            capabilityId: "gmail.messages.write",
            description: "Reply to an existing email thread. Automatically sets In-Reply-To, References, and threadId for correct threading.",
            mutates: true,
            requiresConfirmation: false,
            arguments: [
              { name: "messageId", type: "string", description: "ID of the message to reply to.", required: true },
              { name: "body", type: "string", description: "Plain text reply body.", required: true },
              { name: "to", type: "string", description: "Override reply recipient (defaults to original sender).", required: false },
              { name: "cc", type: "string", description: "CC recipients, comma-separated.", required: false },
            ],
          },
          {
            id: "forward-message",
            label: "Forward message",
            capabilityId: "gmail.messages.write",
            description: "Forward an existing email to a new recipient, including original message content.",
            mutates: true,
            requiresConfirmation: false,
            arguments: [
              { name: "messageId", type: "string", description: "ID of the message to forward.", required: true },
              { name: "to", type: "string", description: "Forward recipient email address(es).", required: true },
              { name: "body", type: "string", description: "Optional message to prepend before the forwarded content.", required: false },
              { name: "cc", type: "string", description: "CC recipients, comma-separated.", required: false },
            ],
          },
          {
            id: "modify-labels",
            label: "Modify labels",
            capabilityId: "gmail.messages.manage",
            description: "Add or remove labels on a message. Use to mark read (remove UNREAD), star (add STARRED), archive (remove INBOX), etc.",
            mutates: true,
            requiresConfirmation: false,
            arguments: [
              { name: "messageId", type: "string", description: "Gmail message identifier.", required: true },
              { name: "addLabelIds", type: "string[]", description: "Label IDs to add (e.g. STARRED, IMPORTANT).", required: false },
              { name: "removeLabelIds", type: "string[]", description: "Label IDs to remove (e.g. UNREAD, INBOX).", required: false },
            ],
          },
          {
            id: "trash-message",
            label: "Trash message",
            capabilityId: "gmail.messages.manage",
            description: "Move a message to the trash. This is reversible from the Gmail UI within 30 days.",
            mutates: true,
            requiresConfirmation: true,
            arguments: [
              { name: "messageId", type: "string", description: "Gmail message identifier to trash.", required: true },
            ],
          },
          {
            id: "list-drafts",
            label: "List drafts",
            capabilityId: "gmail.drafts",
            description: "List email drafts with message summaries.",
            mutates: false,
            requiresConfirmation: false,
            arguments: [
              { name: "maxResults", type: "number", description: "Maximum number of drafts to return. Defaults to 10.", required: false },
            ],
          },
          {
            id: "create-draft",
            label: "Create draft",
            capabilityId: "gmail.drafts",
            description: "Create a new email draft that can be sent later from Gmail.",
            mutates: true,
            requiresConfirmation: false,
            arguments: [
              { name: "to", type: "string", description: "Recipient email address(es), comma-separated.", required: true },
              { name: "subject", type: "string", description: "Email subject line.", required: true },
              { name: "body", type: "string", description: "Plain text email body.", required: true },
              { name: "cc", type: "string", description: "CC recipients, comma-separated.", required: false },
              { name: "bcc", type: "string", description: "BCC recipients, comma-separated.", required: false },
            ],
          },
        ],
      },
    },
  }

  let cache: Storage | undefined
  let mtime: number | undefined
  let mutex: Promise<void> = Promise.resolve()

  function withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const result = mutex.then(fn, fn)
    mutex = result.then(
      () => {},
      () => {},
    )
    return result
  }

  async function getDiskMtime(): Promise<number | undefined> {
    const file = Bun.file(filepath)
    if (!(await file.exists())) return undefined
    const value = file.lastModified
    return typeof value === "number" ? value : undefined
  }

  function defaultState(entry: CatalogEntry, now = Date.now()): AppState {
    return {
      appId: entry.id,
      source: entry.source,
      installState: "available",
      enableState: "disabled",
      configStatus: entry.requiredConfig.length > 0 ? "required" : "configured",
      updatedAt: now,
    }
  }

  function requireInstalledState(appId: string, entry: CatalogEntry, current: Storage): AppState {
    const stored = current.apps[appId] ?? defaultState(entry)
    if (stored.installState !== "installed") {
      throw new Error(`Managed app is not installed: ${appId}`)
    }
    return stored
  }

  async function authBindingOf(entry: CatalogEntry): Promise<AuthBinding> {
    if (!entry.auth.required) {
      return {
        providerKey: entry.auth.providerKey,
        status: "not_required",
      }
    }

    // For managed apps, check gauth.json directly instead of Account system
    if (entry.id === "google-calendar") {
      try {
        const { GoogleCalendarApp } = await import("./apps/google-calendar")
        const tokens = await GoogleCalendarApp.readGAuthTokens()
        if (tokens && tokens.access_token) {
          return {
            providerKey: entry.auth.providerKey,
            accountId: "gauth-google-calendar",
            status: "authenticated",
          }
        }
      } catch {
        // fall through to required
      }
      return {
        providerKey: entry.auth.providerKey,
        status: "required",
      }
    }

    // Fallback for other managed apps — use Account system
    const providerKey = await Account.resolveProviderOrSelf(entry.auth.providerKey)
    const providerAccounts = await Account.list(providerKey)
    const accountIds = Object.keys(providerAccounts)
    if (accountIds.length !== 1) {
      return {
        providerKey: entry.auth.providerKey,
        status: "required",
      }
    }

    const [accountId] = accountIds
    const auth = await Auth.get(accountId)
    if (!auth || !accountId) {
      return {
        providerKey: entry.auth.providerKey,
        status: "required",
      }
    }

    if (auth.type !== entry.auth.type) {
      return {
        providerKey: entry.auth.providerKey,
        accountId,
        status: "invalid",
      }
    }

    return {
      providerKey: entry.auth.providerKey,
      accountId,
      status: "authenticated",
    }
  }

  function runtimeStatusOf(state: AppState, authBinding: AuthBinding): RuntimeStatus {
    if (state.installState !== "installed") return "pending_install"
    if (state.error) return "error"
    if (authBinding.status === "required" || authBinding.status === "invalid") return "pending_auth"
    if (state.configStatus !== "configured") return "pending_config"
    if (state.enableState !== "enabled") return "disabled"
    return "ready"
  }

  function operatorStateOf(entry: CatalogEntry, state: AppState, authBinding: AuthBinding): OperatorState {
    return {
      install: state.installState === "installed" ? "installed" : "available",
      auth:
        authBinding.status === "not_required"
          ? "not_required"
          : authBinding.status === "required"
            ? "required"
            : authBinding.status === "invalid"
              ? "invalid"
              : "authenticated",
      config:
        entry.requiredConfig.length === 0
          ? "not_required"
          : state.configStatus === "required"
            ? "required"
            : state.configStatus === "invalid"
              ? "invalid"
              : "configured",
      runtime: state.error ? "error" : runtimeStatusOf(state, authBinding) === "ready" ? "ready" : "inactive",
      error: state.error
        ? state.configStatus === "invalid"
          ? "invalid_config"
          : "runtime_error"
        : authBinding.status === "required"
          ? "auth_required"
          : authBinding.status === "invalid"
            ? "invalid_auth"
            : "none",
    }
  }

  function requireCatalogEntry(appId: string): CatalogEntry {
    const entry = BUILTIN_CATALOG[appId]
    if (!entry) throw new AppNotFoundError({ message: `Unknown managed app: ${appId}` })
    return entry
  }

  function usageErrorOf(snapshot: ManagedAppSnapshot): UsageError | undefined {
    if (snapshot.runtime.status === "pending_auth") {
      return {
        appId: snapshot.catalog.id,
        status: snapshot.runtime.status,
        reason: "unauthenticated",
        code: snapshot.authBinding.status === "invalid" ? "MANAGED_APP_INVALID_AUTH" : "MANAGED_APP_AUTH_REQUIRED",
        message:
          snapshot.authBinding.status === "invalid"
            ? `Managed app ${snapshot.catalog.id} has invalid authentication binding`
            : `Managed app ${snapshot.catalog.id} requires exactly one authenticated account binding`,
      }
    }
    if (snapshot.runtime.status === "pending_config") {
      return {
        appId: snapshot.catalog.id,
        status: snapshot.runtime.status,
        reason: "misconfigured",
        code: "MANAGED_APP_CONFIG_REQUIRED",
        message: `Managed app ${snapshot.catalog.id} is misconfigured and cannot be used`,
      }
    }
    if (snapshot.runtime.status === "error") {
      return {
        appId: snapshot.catalog.id,
        status: snapshot.runtime.status,
        reason: "runtime_error",
        code: snapshot.persisted.error?.code ?? "MANAGED_APP_RUNTIME_ERROR",
        message: snapshot.persisted.error?.message ?? `Managed app ${snapshot.catalog.id} hit a runtime error`,
      }
    }
    return undefined
  }

  async function load(): Promise<Storage> {
    const file = Bun.file(filepath)
    if (!(await file.exists())) return { version: VERSION, apps: {} }
    try {
      const parsed = Storage.safeParse(await file.json())
      if (!parsed.success) throw new Error(parsed.error.message)
      return parsed.data
    } catch (error) {
      log.error("failed to load managed apps state", { error })
      throw error
    }
  }

  async function state(): Promise<Storage> {
    if (cache) {
      const nextMtime = await getDiskMtime()
      if (nextMtime === mtime) return cache
    }
    cache = await load()
    mtime = await getDiskMtime()
    return cache
  }

  async function save(next: Storage): Promise<void> {
    await fs.mkdir(path.dirname(filepath), { recursive: true }).catch(() => {})
    await Bun.write(filepath, JSON.stringify(next, null, 2))
    await fs.chmod(filepath, 0o600).catch(() => {})
    cache = next
    mtime = await getDiskMtime()
  }

  async function toSnapshot(entry: CatalogEntry, stored?: AppState): Promise<AppSnapshot> {
    const state = stored ?? defaultState(entry)
    const authBinding = await authBindingOf(entry)
    return {
      ...entry,
      state,
      authBinding,
      runtimeStatus: runtimeStatusOf(state, authBinding),
      operator: operatorStateOf(entry, state, authBinding),
    }
  }

  async function runtimeSnapshotOf(entry: CatalogEntry, state: AppState): Promise<RuntimeSnapshot> {
    const authBinding = await authBindingOf(entry)
    return {
      appId: state.appId,
      status: runtimeStatusOf(state, authBinding),
      attachment: runtimeAttachments.get(state.appId),
    }
  }

  async function managedSnapshotOf(entry: CatalogEntry, stored?: AppState): Promise<ManagedAppSnapshot> {
    const persisted = stored ?? defaultState(entry)
    const authBinding = await authBindingOf(entry)
    return {
      catalog: entry,
      persisted,
      authBinding,
      runtime: await runtimeSnapshotOf(entry, persisted),
      operator: operatorStateOf(entry, persisted, authBinding),
    }
  }

  async function persistAndPublish(next: Storage, appId: string) {
    await save(next)
    await Bus.publish(Event.Updated, { app: await toSnapshot(requireCatalogEntry(appId), next.apps[appId]) }).catch(
      () => {},
    )
  }

  export function catalog(): CatalogEntry[] {
    return Object.values(BUILTIN_CATALOG)
  }

  export async function list(): Promise<AppSnapshot[]> {
    const current = await state()
    return Promise.all(catalog().map((entry) => toSnapshot(entry, current.apps[entry.id])))
  }

  export async function get(appId: string): Promise<AppSnapshot> {
    const entry = requireCatalogEntry(appId)
    const current = await state()
    return toSnapshot(entry, current.apps[appId])
  }

  export async function snapshot(appId: string): Promise<ManagedAppSnapshot> {
    const entry = requireCatalogEntry(appId)
    const current = await state()
    return managedSnapshotOf(entry, current.apps[appId])
  }

  export async function runtime(appId: string): Promise<RuntimeSnapshot> {
    return (await snapshot(appId)).runtime
  }

  export async function requireReady(appId: string): Promise<ManagedAppSnapshot> {
    const current = await snapshot(appId)
    const usageError = usageErrorOf(current)
    if (usageError) throw new UsageStateError(usageError)
    if (current.runtime.status !== "ready")
      throw new UsageStateError({
        appId,
        status: current.runtime.status,
        reason: current.runtime.status === "pending_config" ? "misconfigured" : "runtime_error",
        code: "MANAGED_APP_NOT_READY",
        message: `Managed app is not ready: ${appId} (${current.runtime.status})`,
      })
    return current
  }

  export async function usage(appId: string): Promise<UsageError | null> {
    return usageErrorOf(await snapshot(appId)) ?? null
  }

  export async function readyTools(): Promise<ReadyToolBinding[]> {
    const apps = await list()
    return apps.flatMap((app: AppSnapshot) => {
      if (app.runtimeStatus !== "ready") return []
      return app.toolContract.tools.map((tool: ToolDescriptor) => ({
        appId: app.id,
        namespace: app.toolContract.namespace,
        tool,
      }))
    })
  }

  export async function install(appId: string): Promise<AppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const now = Date.now()
      const existing = current.apps[appId] ?? defaultState(entry, now)
      if (existing.installState === "installed") return toSnapshot(entry, existing)
      const nextState: AppState = {
        ...existing,
        source: entry.source,
        installState: "installed",
        enableState: "disabled",
        error: undefined,
        installedAt: existing.installedAt ?? now,
        updatedAt: now,
      }
      const next = { ...current, apps: { ...current.apps, [appId]: nextState } }
      await persistAndPublish(next, appId)
      return toSnapshot(entry, nextState)
    })
  }

  export async function uninstall(appId: string): Promise<AppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const reset = defaultState(entry, Date.now())
      runtimeAttachments.delete(appId)
      const next = { ...current, apps: { ...current.apps, [appId]: reset } }
      await persistAndPublish(next, appId)
      return toSnapshot(entry, reset)
    })
  }

  export async function setConfigStatus(
    appId: string,
    configStatus: ConfigStatus,
    error?: Omit<ErrorStatus, "ts">,
  ): Promise<AppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = current.apps[appId] ?? defaultState(entry)
      if (existing.installState !== "installed") {
        throw new Error(`Cannot update config for non-installed app: ${appId}`)
      }
      const nextState: AppState = {
        ...existing,
        configStatus,
        error: error ? { ...error, ts: Date.now() } : existing.error,
        updatedAt: Date.now(),
      }
      const next = { ...current, apps: { ...current.apps, [appId]: nextState } }
      await persistAndPublish(next, appId)
      return toSnapshot(entry, nextState)
    })
  }

  export async function setConfigKeys(appId: string, keys: string[]): Promise<ManagedAppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = requireInstalledState(appId, entry, current)
      const now = Date.now()
      const nextState: AppState = {
        ...existing,
        config: { keys: Array.from(new Set(keys)).sort(), updatedAt: now },
        configStatus:
          entry.requiredConfig.length === 0 || entry.requiredConfig.every((k: string) => keys.includes(k))
            ? "configured"
            : "required",
        error: undefined,
        updatedAt: now,
      }
      const next = { ...current, apps: { ...current.apps, [appId]: nextState } }
      await persistAndPublish(next, appId)
      return managedSnapshotOf(entry, nextState)
    })
  }

  export async function enable(appId: string): Promise<AppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = current.apps[appId] ?? defaultState(entry)
      const authBinding = await authBindingOf(entry)
      if (existing.installState !== "installed") throw new Error(`Cannot enable app before install: ${appId}`)
      if (authBinding.status === "required" || authBinding.status === "invalid") {
        throw new UsageStateError({
          appId,
          status: "pending_auth",
          reason: "unauthenticated",
          code: authBinding.status === "invalid" ? "MANAGED_APP_INVALID_AUTH" : "MANAGED_APP_AUTH_REQUIRED",
          message:
            authBinding.status === "invalid"
              ? `Managed app ${appId} has invalid authentication binding`
              : `Managed app ${appId} requires exactly one authenticated account binding`,
        })
      }
      if (existing.configStatus !== "configured") {
        throw new Error(`Cannot enable app with config status ${existing.configStatus}: ${appId}`)
      }
      if (existing.error) throw new Error(`Cannot enable app in error state: ${appId}`)
      const nextState: AppState = { ...existing, enableState: "enabled", updatedAt: Date.now() }
      const next = { ...current, apps: { ...current.apps, [appId]: nextState } }
      await persistAndPublish(next, appId)
      return toSnapshot(entry, nextState)
    })
  }

  export async function disable(appId: string): Promise<AppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = current.apps[appId] ?? defaultState(entry)
      if (existing.installState !== "installed") throw new Error(`Cannot disable non-installed app: ${appId}`)
      runtimeAttachments.delete(appId)
      const nextState: AppState = { ...existing, enableState: "disabled", updatedAt: Date.now() }
      const next = { ...current, apps: { ...current.apps, [appId]: nextState } }
      await persistAndPublish(next, appId)
      return toSnapshot(entry, nextState)
    })
  }

  export async function markError(appId: string, error: Omit<ErrorStatus, "ts">): Promise<AppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = current.apps[appId] ?? defaultState(entry)
      if (existing.installState !== "installed") {
        throw new Error(`Cannot attach runtime error to non-installed app: ${appId}`)
      }
      const nextState: AppState = {
        ...existing,
        error: { ...error, ts: Date.now() },
        enableState: "disabled",
        updatedAt: Date.now(),
      }
      runtimeAttachments.delete(appId)
      const next = { ...current, apps: { ...current.apps, [appId]: nextState } }
      await persistAndPublish(next, appId)
      return toSnapshot(entry, nextState)
    })
  }

  export async function clearError(appId: string): Promise<AppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = current.apps[appId] ?? defaultState(entry)
      if (existing.installState !== "installed") {
        throw new Error(`Cannot clear runtime error for non-installed app: ${appId}`)
      }
      const nextState: AppState = { ...existing, error: undefined, updatedAt: Date.now() }
      const next = { ...current, apps: { ...current.apps, [appId]: nextState } }
      await persistAndPublish(next, appId)
      return toSnapshot(entry, nextState)
    })
  }

  export async function attachRuntime(
    appId: string,
    attachment: Omit<RuntimeAttachment, "attachedAt">,
  ): Promise<ManagedAppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = requireInstalledState(appId, entry, current)
      const authBinding = await authBindingOf(entry)
      if (runtimeStatusOf(existing, authBinding) !== "ready") {
        throw new Error(`Cannot attach runtime for non-ready app: ${appId}`)
      }
      runtimeAttachments.set(appId, { ...attachment, attachedAt: Date.now() })
      return managedSnapshotOf(entry, existing)
    })
  }

  export async function detachRuntime(
    appId: string,
    owner?: Pick<RuntimeAttachment, "owner" | "ownerId">,
  ): Promise<ManagedAppSnapshot> {
    return withMutex(async () => {
      const entry = requireCatalogEntry(appId)
      const current = await state()
      const existing = requireInstalledState(appId, entry, current)
      const attached = runtimeAttachments.get(appId)
      if (owner && attached && (attached.owner !== owner.owner || attached.ownerId !== owner.ownerId)) {
        throw new Error(`Managed app runtime owned by another attachment: ${appId}`)
      }
      runtimeAttachments.delete(appId)
      return managedSnapshotOf(entry, existing)
    })
  }
}
