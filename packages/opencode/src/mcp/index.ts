export * from "./app-registry"
export { McpAppStore } from "./app-store"
export { McpAppManifest } from "./manifest"
import { McpAppManifest } from "./manifest"

import { dynamicTool, type Tool, jsonSchema, type JSONSchema7 } from "ai"
import { ManagedAppRegistry } from "./app-registry"
import { McpAppStore } from "./app-store"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"

/**
 * /specs/docxmcp-http-transport DD-12: parse a unix:// URL of the form
 *   unix:///abs/path/to/sock:/http-path
 * into { socketPath, httpPath }. Returns null if the URL is not a unix scheme.
 */
function parseUnixSocketUrl(raw: string): { socketPath: string; httpPath: string } | null {
  if (!raw.startsWith("unix://")) return null
  const rest = raw.slice("unix://".length)
  // The socket path is filesystem-absolute and ends at the first ":/" we see.
  const idx = rest.indexOf(":/")
  if (idx < 0) {
    return { socketPath: rest, httpPath: "/" }
  }
  return { socketPath: rest.slice(0, idx), httpPath: rest.slice(idx + 1) }
}
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod/v4"
import { Instance } from "../project/instance"
import { Installation } from "../installation"
import { withTimeout } from "@/util/timeout"
import { McpOAuthProvider } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "@/bus"
import { TuiEvent, publishToastTraced } from "@/cli/cmd/tui/event"
import open from "open"
import { Env } from "@/env"
import { Global } from "@/global"
import fs from "fs/promises"
import path from "path"
import { IncomingDispatcher } from "../incoming/dispatcher"

export namespace MCP {
  const log = Log.create({ service: "mcp" })
  const DEFAULT_TIMEOUT = 30_000

  export const Resource = z
    .object({
      name: z.string(),
      uri: z.string(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
      client: z.string(),
    })
    .meta({ ref: "McpResource" })
  export type Resource = z.infer<typeof Resource>

  export const ToolsChanged = BusEvent.define(
    "mcp.tools.changed",
    z.object({
      server: z.string(),
    }),
  )

  export const BrowserOpenFailed = BusEvent.define(
    "mcp.browser.open.failed",
    z.object({
      mcpName: z.string(),
      url: z.string(),
    }),
  )

  export const Failed = NamedError.create(
    "MCPFailed",
    z.object({
      name: z.string(),
    }),
  )

  type MCPClient = Client

  export const Status = z
    .discriminatedUnion("status", [
      z
        .object({
          status: z.literal("connected"),
        })
        .meta({
          ref: "MCPStatusConnected",
        }),
      z
        .object({
          status: z.literal("disabled"),
        })
        .meta({
          ref: "MCPStatusDisabled",
        }),
      z
        .object({
          status: z.literal("failed"),
          error: z.string(),
        })
        .meta({
          ref: "MCPStatusFailed",
        }),
      z
        .object({
          status: z.literal("needs_auth"),
        })
        .meta({
          ref: "MCPStatusNeedsAuth",
        }),
      z
        .object({
          status: z.literal("needs_client_registration"),
          error: z.string(),
        })
        .meta({
          ref: "MCPStatusNeedsClientRegistration",
        }),
    ])
    .meta({
      ref: "MCPStatus",
    })
  export type Status = z.infer<typeof Status>

  // Register notification handlers for MCP client
  function registerNotificationHandlers(client: MCPClient, serverName: string) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      log.info("tools list changed notification received", { server: serverName })
      Bus.publish(ToolsChanged, { server: serverName })
    })
  }

  // /specs/repo-incoming-attachments DD-3: every mcp tool call goes through
  // IncomingDispatcher so incoming/** paths get staged into mcp-staging/
  // (the only host dir the container is allowed to see) and published-out
  // bundles land back in <repo>/incoming/<stem>/. The container never
  // touches the user repo directly.
  function appIdFromServerName(serverName: string): string {
    return serverName.startsWith("mcpapp-") ? serverName.slice("mcpapp-".length) : serverName
  }

  // /specs/docxmcp-http-transport DD-3: token wire format is
  // `^tok_[A-Z2-7]{32}$`. The mcp server enforces this strictly, but
  // when a dispatcher (IncomingDispatcher.before) sits between the
  // model and the mcp server, the model should be allowed to pass a
  // project-relative path that the dispatcher uploads + rewrites to a
  // token. Relax the pattern in the schema we expose to the AI SDK so
  // dynamicTool's pre-execute validation does not reject path inputs.
  const TOKEN_PATTERN = "^tok_[A-Z2-7]{32}$"
  function relaxTokenFieldsForDispatcher(schema: JSONSchema7): void {
    const props = schema.properties as Record<string, JSONSchema7> | undefined
    if (!props) return
    for (const [key, value] of Object.entries(props)) {
      if (!value || typeof value !== "object") continue
      if (value.type === "string" && value.pattern === TOKEN_PATTERN) {
        delete value.pattern
        const note =
          " May also be passed as a project-relative path (e.g. `incoming/foo.docx`); opencode will upload the file and substitute a token automatically."
        value.description = (value.description ?? "") + note
      }
    }
  }

  function expandEnvironment(environment: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!environment) return undefined
    const home = Env.get("HOME") ?? process.env.HOME ?? ""
    return Object.fromEntries(
      Object.entries(environment).map(([key, value]) => [
        key,
        value.replaceAll("${HOME}", home).replaceAll("$HOME", home),
      ]),
    )
  }

  // Convert MCP tool definition to AI SDK Tool type
  async function convertMcpTool(
    mcpTool: MCPToolDef,
    client: MCPClient,
    timeout?: number,
    serverName?: string,
  ): Promise<Tool> {
    const inputSchema = mcpTool.inputSchema

    // Spread first, then override type to ensure it's always "object"
    const schema: JSONSchema7 = {
      ...(inputSchema as JSONSchema7),
      type: "object",
      properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
      additionalProperties: false,
    }

    // /specs/docxmcp-http-transport: server-side token fields advertise
    // a strict `^tok_[A-Z2-7]{32}$` pattern. The AI SDK's dynamicTool
    // validates args against this schema BEFORE invoking execute(), so
    // the IncomingDispatcher can never run path→token substitution. We
    // relax the pattern here so the model can pass either a token or a
    // project-relative path; the dispatcher uploads paths and rewrites
    // them to tokens before they reach the mcp server.
    relaxTokenFieldsForDispatcher(schema)

    const appId = serverName ? appIdFromServerName(serverName) : "unknown"

    return dynamicTool({
      description: mcpTool.description ?? "",
      inputSchema: jsonSchema(schema),
      execute: async (args: unknown) => {
        const argsObj = (args || {}) as Record<string, unknown>
        // sessionID is not available through the AI SDK dynamicTool seam.
        // History entries written by the dispatcher carry null sessionId
        // for mcp-driven events; that's acceptable for traceability.
        const dispatch = await IncomingDispatcher.before({
          toolName: mcpTool.name,
          args: argsObj,
          appId,
          sessionID: null,
        }).catch((err) => {
          log.warn("incoming.dispatcher.before threw, passing args through unchanged", {
            tool: mcpTool.name,
            error: err instanceof Error ? err.message : String(err),
          })
          return null
        })

        let rawResult: unknown
        if (dispatch?.ctx.skipMcpCall) {
          // DD-17 cache hit: synthesize a result indicating the bundle is
          // already published. The shape mirrors a normal mcp tools/call
          // CallToolResultSchema response.
          rawResult = {
            content: [
              {
                type: "text",
                text: `[incoming.dispatcher cache-hit] bundle already published at ${dispatch.ctx.cacheHit?.repoBundlePath}`,
              },
            ],
            isError: false,
            structuredContent: {
              bundlePath: dispatch.ctx.cacheHit?.repoBundlePath,
              fromCache: true,
              sha256: dispatch.ctx.cacheHit?.sha,
            },
          }
        } else {
          rawResult = await client.callTool(
            {
              name: mcpTool.name,
              arguments: dispatch ? dispatch.rewrittenArgs : argsObj,
            },
            CallToolResultSchema,
            {
              resetTimeoutOnProgress: true,
              timeout,
            },
          )
        }

        if (!dispatch) return rawResult
        return IncomingDispatcher.after({ result: rawResult, ctx: dispatch.ctx }).catch((err) => {
          log.warn("incoming.dispatcher.after threw, returning raw mcp result", {
            tool: mcpTool.name,
            error: err instanceof Error ? err.message : String(err),
          })
          return rawResult
        })
      },
    })
  }

  // NOTE: managedAppExecutors, convertManagedAppTool, and related helper
  // functions have been removed (mcp-separation Step 6c). Gmail and Calendar
  // now run as standalone stdio MCP servers via mcp-apps.json, using the same
  // convertMcpTool() path as all other MCP servers.

  // Store transports for OAuth servers to allow finishing auth
  type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
  const pendingOAuthTransports = new Map<string, TransportWithAuth>()

  type ToolsCacheEntry = {
    value: Record<string, Tool>
    expiresAt: number
    dirty: boolean
  }

  function parseToolsCacheMs() {
    const raw = process.env.OPENCODE_MCP_TOOLS_CACHE_MS
    if (!raw) return 30_000
    const value = Number(raw)
    if (!Number.isFinite(value)) return 30_000
    return Math.max(1_000, Math.min(10 * 60_000, Math.floor(value)))
  }

  function invalidateToolsCache(cache: ToolsCacheEntry) {
    cache.dirty = true
    cache.expiresAt = 0
    cache.value = {}
  }

  // Prompt cache types
  type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]

  type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
  type McpEntry = NonNullable<Config.Info["mcp"]>[string]
  function isMcpConfigured(entry: McpEntry): entry is Config.Mcp {
    return typeof entry === "object" && entry !== null && "type" in entry
  }

  async function createState() {
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const clients: Record<string, MCPClient> = {}
    const status: Record<string, Status> = {}
    const skipAutoConnect = process.env.OPENCODE_SKIP_MCP_AUTO === "1"

    // Phase 1: Register all servers as disabled immediately (fast)
    const pendingAutoConnect: Array<{ key: string; mcp: Config.Mcp }> = []
    for (const [key, mcp] of Object.entries(config)) {
      if (!isMcpConfigured(mcp)) {
        log.error("Ignoring MCP config entry without type", { key })
        continue
      }
      status[key] = { status: "disabled" }
      if (!skipAutoConnect && mcp.enabled !== false) {
        pendingAutoConnect.push({ key, mcp: mcp as Config.Mcp })
      }
    }

    const toolsCache: ToolsCacheEntry = {
      value: {},
      expiresAt: 0,
      dirty: true,
    }

    const unsubscribeToolsChanged = Bus.subscribe(ToolsChanged, () => {
      invalidateToolsCache(toolsCache)
    })
    const unsubscribeManagedAppsUpdated = Bus.subscribe(ManagedAppRegistry.Event.Updated, () => {
      invalidateToolsCache(toolsCache)
    })

    // NOTE: Google OAuth token startup sweep removed (mcp-separation).
    // Gmail/Calendar now run as standalone servers; token injected via env.

    // Phase 2: Auto-connect enabled servers in background (progressive)
    if (pendingAutoConnect.length > 0) {
      Promise.resolve().then(async () => {
        for (const { key, mcp } of pendingAutoConnect) {
          try {
            const result = await create(key, mcp)
            if (result) {
              status[key] = result.status
              if (result.mcpClient) {
                clients[key] = result.mcpClient
              }
              invalidateToolsCache(toolsCache)
              Bus.publish(ToolsChanged, { server: key })
            }
          } catch (e) {
            log.error("background auto-connect failed", { key, error: e })
            status[key] = { status: "failed", error: e instanceof Error ? e.message : String(e) }
          }
        }
      })
    }

    return {
      status,
      clients,
      toolsCache,
      unsubscribeToolsChanged,
      unsubscribeManagedAppsUpdated,
    }
  }

  async function cleanupState(state: Awaited<ReturnType<typeof createState>>) {
    await Promise.all(
      Object.values(state.clients).map((client) =>
        client.close().catch((error) => {
          log.error("Failed to close MCP client", {
            error,
          })
        }),
      ),
    )
    state.unsubscribeToolsChanged?.()
    state.unsubscribeManagedAppsUpdated?.()
    pendingOAuthTransports.clear()
  }

  let stateGetter: (() => Promise<Awaited<ReturnType<typeof createState>>>) | undefined
  let fallbackState: Promise<Awaited<ReturnType<typeof createState>>> | undefined

  function state() {
    if (typeof Instance.state === "function") {
      stateGetter ||= Instance.state(createState, cleanupState)
      return stateGetter()
    }

    fallbackState ||= createState()
    return fallbackState
  }

  // Helper function to fetch prompts for a specific client
  async function fetchPromptsForClient(clientName: string, client: Client) {
    const prompts = await client.listPrompts().catch((e) => {
      log.error("failed to get prompts", { clientName, error: e.message })
      return undefined
    })

    if (!prompts) {
      return
    }

    const commands: Record<string, PromptInfo & { client: string }> = {}

    for (const prompt of prompts.prompts) {
      const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
      const sanitizedPromptName = prompt.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      const key = sanitizedClientName + ":" + sanitizedPromptName

      commands[key] = { ...prompt, client: clientName }
    }
    return commands
  }

  async function fetchResourcesForClient(clientName: string, client: Client) {
    const resources = await client.listResources().catch((e) => {
      log.error("failed to get prompts", { clientName, error: e.message })
      return undefined
    })

    if (!resources) {
      return
    }

    const commands: Record<string, ResourceInfo & { client: string }> = {}

    for (const resource of resources.resources) {
      const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
      const sanitizedResourceName = resource.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      const key = sanitizedClientName + ":" + sanitizedResourceName

      commands[key] = { ...resource, client: clientName }
    }
    return commands
  }

  export async function add(name: string, mcp: Config.Mcp) {
    const s = await state()
    const result = await create(name, mcp)
    if (!result) {
      const status = {
        status: "failed" as const,
        error: "unknown error",
      }
      s.status[name] = status
      invalidateToolsCache(s.toolsCache)
      return {
        status,
      }
    }
    if (!result.mcpClient) {
      s.status[name] = result.status
      invalidateToolsCache(s.toolsCache)
      return {
        status: s.status,
      }
    }
    // Close existing client if present to prevent memory leaks
    const existingClient = s.clients[name]
    if (existingClient) {
      await existingClient.close().catch((error) => {
        log.error("Failed to close existing MCP client", { name, error })
      })
    }
    s.clients[name] = result.mcpClient
    s.status[name] = result.status
    invalidateToolsCache(s.toolsCache)

    return {
      status: s.status,
    }
  }

  async function create(key: string, mcp: Config.Mcp) {
    if (mcp.enabled === false) {
      log.info("mcp server disabled", { key })
      return {
        mcpClient: undefined,
        status: { status: "disabled" as const },
      }
    }

    log.info("found", { key, type: mcp.type })
    let mcpClient: MCPClient | undefined
    let status: Status | undefined = undefined

    if (mcp.type === "remote") {
      // OAuth is enabled by default for remote servers unless explicitly disabled with oauth: false
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
          },
          {
            onRedirect: async (url) => {
              log.info("oauth redirect requested", { key, url: url.toString() })
              // Store the URL - actual browser opening is handled by startAuth
            },
          },
        )
      }

      // /specs/docxmcp-http-transport DD-12: support unix:// URLs by
      // routing through a custom fetch that uses Bun's unix-socket option.
      // URL form: unix:///abs/path/to/sock:/http-path
      // We split on ":/" to separate the socket path from the HTTP path.
      const unixSocketPath = parseUnixSocketUrl(mcp.url)
      const httpUrl = unixSocketPath
        ? new URL(unixSocketPath.httpPath || "/", "http://docxmcp.local")
        : new URL(mcp.url)
      const customFetch = unixSocketPath
        ? (((url, init) => fetch(url as any, { ...(init ?? {}), unix: unixSocketPath.socketPath } as any)) as FetchLike)
        : undefined

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(httpUrl, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
            fetch: customFetch,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(httpUrl, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      let lastError: Error | undefined
      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      for (const { name, transport } of transports) {
        try {
          const client = new Client({
            name: "opencode",
            version: Installation.VERSION,
          })
          await withTimeout(client.connect(transport), connectTimeout)
          registerNotificationHandlers(client, key)
          mcpClient = client
          log.info("connected", { key, transport: name })
          status = { status: "connected" }
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))

          // Handle OAuth-specific errors
          if (error instanceof UnauthorizedError) {
            log.info("mcp server requires authentication", { key, transport: name })

            // Check if this is a "needs registration" error
            if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
              status = {
                status: "needs_client_registration" as const,
                error: "Server does not support dynamic client registration. Please provide clientId in config.",
              }
              // Show toast for needs_client_registration
              publishToastTraced(
                {
                  title: "MCP Authentication Required",
                  message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                  variant: "warning",
                  duration: 8000,
                },
                { source: "mcp.needs_client_registration" },
              ).catch((e) => log.debug("failed to show toast", { error: e }))
            } else {
              // Store transport for later finishAuth call
              pendingOAuthTransports.set(key, transport)
              status = { status: "needs_auth" as const }
              // Show toast for needs_auth
              publishToastTraced(
                {
                  title: "MCP Authentication Required",
                  message: `Server "${key}" requires authentication. Run: opencode mcp auth ${key}`,
                  variant: "warning",
                  duration: 8000,
                },
                { source: "mcp.needs_auth" },
              ).catch((e) => log.debug("failed to show toast", { error: e }))
            }
            break
          }

          log.debug("transport connection failed", {
            key,
            transport: name,
            url: mcp.url,
            error: lastError.message,
          })
          status = {
            status: "failed" as const,
            error: lastError.message,
          }
        }
      }
    }

    if (mcp.type === "local") {
      const [cmd, ...args] = mcp.command
      // Bun standalone binaries read bunfig.toml from cwd ancestors at runtime.
      // Internal MCP binaries (compiled with bun build --compile) must not inherit
      // the project-level bunfig.toml (which has @opentui/solid/preload for the TUI).
      // Use /tmp as cwd for these to avoid the preload-not-found crash.
      // Bun compiled binaries read bunfig.toml from cwd ancestors.
      // Use /tmp as cwd for any binary outside the project tree to avoid
      // picking up the project-level preload config.
      const isExternalBinary = cmd.startsWith("/usr/local/lib/opencode/mcp/") || cmd.startsWith("/opt/opencode-apps/")
      const cwd = isExternalBinary ? "/tmp" : Instance.directory

      const expandedEnvironment = expandEnvironment(mcp.environment)

      // Ensure memory storage directory exists when MEMORY_FILE_PATH is configured.
      if (key.startsWith("memory")) {
        const memoryFilePath = expandedEnvironment?.MEMORY_FILE_PATH
        if (memoryFilePath) {
          await fs.mkdir(path.dirname(memoryFilePath), { recursive: true }).catch((error) => {
            log.warn("failed to prepare memory directory", {
              key,
              memoryFilePath,
              error: error instanceof Error ? error.message : String(error),
            })
          })
        }
      }

      // Auto-inject CWD for filesystem MCP if not already present
      const finalArgs = [...args]
      if (key === "filesystem") {
        const hasParent = finalArgs.some((arg) => cwd.startsWith(arg))
        if (!hasParent && !finalArgs.includes(cwd)) {
          log.info("auto-injecting cwd into filesystem mcp", { key, cwd })
          finalArgs.push(cwd)
        }
      }

      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args: finalArgs,
        cwd,
        env: {
          ...Env.all(),
          OPENCODE_PID: process.env.OPENCODE_PID ?? String(process.pid),
          ...(cmd === "opencode" ? { BUN_BE_BUN: "1" } : {}),
          ...expandedEnvironment,
        },
      })
      transport.stderr?.on("data", (chunk: Buffer) => {
        log.info(`mcp stderr: ${chunk.toString()}`, { key })
      })

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      try {
        const client = new Client({
          name: "opencode",
          version: Installation.VERSION,
        })
        await withTimeout(client.connect(transport), connectTimeout)
        registerNotificationHandlers(client, key)
        mcpClient = client
        status = {
          status: "connected",
        }
      } catch (error) {
        log.error("local mcp startup failed", {
          key,
          command: mcp.command,
          cwd,
          error: error instanceof Error ? error.message : String(error),
        })
        status = {
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    if (!status) {
      status = {
        status: "failed" as const,
        error: "Unknown error",
      }
    }

    if (!mcpClient) {
      return {
        mcpClient: undefined,
        status,
      }
    }

    const result: Awaited<ReturnType<MCPClient["listTools"]>> | undefined = await withTimeout(
      mcpClient.listTools(),
      mcp.timeout ?? DEFAULT_TIMEOUT,
    ).catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return undefined
    })
    if (!result) {
      await mcpClient.close().catch((error) => {
        log.error("Failed to close MCP client", {
          error,
        })
      })
      status = {
        status: "failed",
        error: "Failed to get tools",
      }
      return {
        mcpClient: undefined,
        status: {
          status: "failed" as const,
          error: "Failed to get tools",
        },
      }
    }

    log.info("create() successfully created client", { key, toolCount: result.tools.length })
    return {
      mcpClient,
      status,
    }
  }

  export async function status() {
    const s = await state()
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const result: Record<string, Status> = {}

    // Include all configured MCPs from config, not just connected ones
    for (const [key, mcp] of Object.entries(config)) {
      if (!isMcpConfigured(mcp)) continue
      result[key] = s.status[key] ?? { status: "disabled" }
    }

    return result
  }

  const RETIRED_SERVER_APP_IDS = new Set(["beta-tool", "refacting-merger", "gcp-grounding"])

  /** Metadata for built-in MCP servers — shown in app market cards */
  const SERVER_META: Record<string, { description: string; icon: string }> = {
    fetch: {
      description: "HTTP fetch tool for retrieving web content, APIs, and remote resources.",
      icon: "🌐",
    },
    filesystem: {
      description: "File system operations — read, write, search, and manage files within the workspace.",
      icon: "📁",
    },
    memory: {
      description: "Persistent key-value memory store for retaining context across sessions.",
      icon: "🧠",
    },
    "sequential-thinking": {
      description: "Step-by-step reasoning tool for complex multi-step problem solving.",
      icon: "🔗",
    },
    "system-manager": {
      description: "System administration tools — process management, environment inspection, and runtime control.",
      icon: "⚙️",
    },
    drawmiat: {
      description: "IDEF0 / Grafcet (IEC 60848) diagram renderer — generates SVG from structured JSON.",
      icon: "📐",
    },
  }

  export interface ServerApp {
    id: string
    name: string
    description: string
    icon: string
    kind: "mcp-server" | "managed-app"
    type?: "local" | "remote"
    status: string
    error?: string
    tools: Array<{ id: string; name: string; description: string }>
    enabled: boolean
  }

  /** Return all MCP servers as app-market-compatible cards */
  export async function serverApps(): Promise<ServerApp[]> {
    const s = await state()
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const clientsSnapshot = await clients()
    const result: ServerApp[] = []

    for (const [key, mcp] of Object.entries(config)) {
      if (!isMcpConfigured(mcp)) continue
      if (RETIRED_SERVER_APP_IDS.has(key)) continue
      const serverStatus = s.status[key] ?? { status: "disabled" as const }
      const meta = SERVER_META[key] ?? { description: `MCP server: ${key}`, icon: "📦" }
      const isConnected = serverStatus.status === "connected"

      // Get tools for connected servers
      const toolList: ServerApp["tools"] = []
      if (isConnected && clientsSnapshot[key]) {
        try {
          const toolsResult = await clientsSnapshot[key].listTools()
          for (const t of toolsResult.tools) {
            toolList.push({ id: t.name, name: t.name, description: t.description ?? "" })
          }
        } catch {
          // tools unavailable
        }
      }

      result.push({
        id: key,
        name: key,
        description: meta.description,
        icon: meta.icon,
        kind: "mcp-server",
        type: mcp.type,
        status: serverStatus.status,
        error: "error" in serverStatus ? serverStatus.error : undefined,
        tools: toolList,
        enabled: serverStatus.status !== "disabled",
      })
    }

    return result
  }

  export async function clients() {
    return state().then((state) => state.clients)
  }

  export async function connect(name: string) {
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const mcp = config[name]
    if (!mcp) {
      log.error("MCP config not found", { name })
      return
    }

    if (!isMcpConfigured(mcp)) {
      log.error("Ignoring MCP connect request for config without type", { name })
      return
    }

    const result = await create(name, { ...mcp, enabled: true })

    if (!result) {
      const s = await state()
      s.status[name] = {
        status: "failed",
        error: "Unknown error during connection",
      }
      invalidateToolsCache(s.toolsCache)
      return
    }

    const s = await state()
    s.status[name] = result.status
    if (result.mcpClient) {
      // Close existing client if present to prevent memory leaks
      const existingClient = s.clients[name]
      if (existingClient) {
        await existingClient.close().catch((error) => {
          log.error("Failed to close existing MCP client", { name, error })
        })
      }
      s.clients[name] = result.mcpClient
    }
    invalidateToolsCache(s.toolsCache)
  }

  export async function disconnect(name: string) {
    const s = await state()
    const client = s.clients[name]
    if (client) {
      await client.close().catch((error) => {
        log.error("Failed to close MCP client", { name, error })
      })
      delete s.clients[name]
    }
    s.status[name] = { status: "disabled" }
    invalidateToolsCache(s.toolsCache)
  }

  // ── mcp-apps.json integration (Layer 2) ────────────────────────────

  /**
   * Per-gauth-path "this refresh_token has been proven dead by upstream"
   * short-circuit. Map<gauthPath, refreshToken>. Once a 4xx (revoked /
   * invalid_grant) hits, we cache the dead token and skip future timer-
   * driven refresh attempts. Auto-recovers when gauth.json is re-written
   * with a fresh refresh_token (re-auth flow).
   */
  const deadGoogleRefreshTokens = new Map<string, string>()

  /**
   * Resolve auth token for an MCP App based on its manifest auth config.
   * Reads from gauth.json (Google OAuth) or accounts.json (other providers).
   * Returns env vars to inject into the App's spawn environment.
   */
  /**
   * Refresh Google OAuth token using refresh_token from gauth.json.
   * Returns new access_token or null if refresh failed.
   */
  async function refreshGoogleToken(gauthPath: string): Promise<string | null> {
    try {
      const content = await fs.readFile(gauthPath, "utf-8")
      const tokens = JSON.parse(content) as { refresh_token?: string }
      if (!tokens.refresh_token) {
        log.warn("no refresh_token in gauth.json, cannot auto-refresh", { path: gauthPath })
        return null
      }

      // Per-token "this refresh_token is already dead" short-circuit.
      // Without it the 45min background timer keeps hitting Google's
      // oauth2 endpoint with a known-revoked refresh_token (~32 calls/day).
      // Auto-recovers when user re-auths (gauth.json gets a new
      // refresh_token, mismatches the cached dead value).
      if (deadGoogleRefreshTokens.get(gauthPath) === tokens.refresh_token) {
        return null
      }

      const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID
      const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET
      if (!clientId || !clientSecret) {
        log.warn("GOOGLE_CALENDAR_CLIENT_ID/SECRET not set, cannot auto-refresh", { path: gauthPath })
        return null
      }

      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: tokens.refresh_token,
          grant_type: "refresh_token",
        }),
      })

      if (!res.ok) {
        const body = await res.text()
        // 4xx = permanent revoke / invalid_grant. Cache the dead token so
        // future timer ticks short-circuit. 5xx is transient — retry on
        // next tick.
        if (res.status >= 400 && res.status < 500) {
          deadGoogleRefreshTokens.set(gauthPath, tokens.refresh_token)
          log.warn("google token refresh suspended: refresh_token revoked, awaiting re-auth", {
            path: gauthPath,
            status: res.status,
          })
        } else {
          log.warn("google token refresh failed", { status: res.status, body })
        }
        return null
      }

      const data = (await res.json()) as { access_token: string; expires_in: number }
      const updated = {
        ...JSON.parse(await fs.readFile(gauthPath, "utf-8")),
        access_token: data.access_token,
        expires_at: Date.now() + data.expires_in * 1000,
        updated_at: Date.now(),
      }
      await fs.writeFile(gauthPath, JSON.stringify(updated, null, 2))
      log.info("google token auto-refreshed", {
        path: gauthPath,
        expiresAt: new Date(updated.expires_at).toISOString(),
      })
      return data.access_token
    } catch (err) {
      log.warn("google token refresh error", {
        path: gauthPath,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  async function resolveAuthEnv(manifest: {
    auth?: { type: string; provider?: string; tokenEnv?: string; refreshTokenEnv?: string }
  }): Promise<Record<string, string>> {
    if (!manifest.auth || manifest.auth.type === "none") return {}

    const auth = manifest.auth as { type: string; provider?: string; tokenEnv?: string; refreshTokenEnv?: string }
    if (!auth.tokenEnv) return {}

    // Google OAuth: read from gauth.json (legacy) or accounts.json
    if (auth.provider === "google") {
      // Try multiple paths: Global.Path.config may not be initialized yet during
      // early daemon startup. Fall back to standard XDG path.
      const xdgFallback = path.join(
        process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config"),
        "opencode",
        "gauth.json",
      )
      let globalConfigPath: string | undefined
      try {
        globalConfigPath = path.join(Global.Path.config, "gauth.json")
      } catch {}
      const candidates = globalConfigPath ? [globalConfigPath, xdgFallback] : [xdgFallback]
      for (const gauthPath of candidates) {
        try {
          const content = await fs.readFile(gauthPath, "utf-8")
          const tokens = JSON.parse(content) as { access_token?: string; refresh_token?: string; expires_at?: number }
          if (tokens.access_token) {
            let accessToken = tokens.access_token

            // Auto-refresh if expired (or expiring within 5 min)
            const expiryBuffer = 5 * 60 * 1000
            if (tokens.expires_at && Date.now() > tokens.expires_at - expiryBuffer) {
              log.info("google oauth token expired or expiring soon, auto-refreshing", { path: gauthPath })
              const refreshed = await refreshGoogleToken(gauthPath)
              if (refreshed) {
                accessToken = refreshed
              } else {
                log.warn("auto-refresh failed, injecting stale token", { path: gauthPath })
              }
            }

            const env: Record<string, string> = { [auth.tokenEnv]: accessToken }
            if (auth.refreshTokenEnv && tokens.refresh_token) {
              env[auth.refreshTokenEnv] = tokens.refresh_token
            }
            log.info("injecting google oauth token", { tokenEnv: auth.tokenEnv, path: gauthPath })
            return env
          }
        } catch {
          continue
        }
      }
      log.warn("no gauth.json found for token injection", { candidates })
    }

    // TODO: other providers — read from accounts.json by auth.provider key

    return {}
  }

  // ── Background Google token refresh ────────────────────────────────
  let gauthRefreshTimer: ReturnType<typeof setInterval> | undefined

  function startGauthRefreshTimer() {
    if (gauthRefreshTimer) return
    const REFRESH_INTERVAL = 45 * 60 * 1000 // 45 minutes (tokens last ~60 min)

    gauthRefreshTimer = setInterval(async () => {
      try {
        const gauthPath = path.join(Global.Path.config, "gauth.json")
        const content = await fs.readFile(gauthPath, "utf-8")
        const tokens = JSON.parse(content) as { access_token?: string; expires_at?: number }
        if (!tokens.access_token) return

        const expiryBuffer = 10 * 60 * 1000
        if (tokens.expires_at && Date.now() > tokens.expires_at - expiryBuffer) {
          log.info("background gauth refresh: token expiring soon, refreshing")
          await refreshGoogleToken(gauthPath)
        }
      } catch {
        // gauth.json doesn't exist — no Google OAuth apps, skip
      }
    }, REFRESH_INTERVAL)

    // Don't keep daemon alive just for this timer
    if (gauthRefreshTimer.unref) gauthRefreshTimer.unref()
    log.info("background gauth refresh timer started", { intervalMs: REFRESH_INTERVAL })
  }

  let mcpAppsInitialized = false

  /**
   * Connect all enabled Apps from mcp-apps.json on first tools() call.
   * Uses the existing MCP.add() path so they appear as regular MCP servers
   * in the tool pool — no separate tool collection logic needed.
   */
  async function connectMcpApps(): Promise<void> {
    if (mcpAppsInitialized) return
    mcpAppsInitialized = true
    log.info("connectMcpApps: starting")

    try {
      const config = await McpAppStore.loadConfig()
      const enabledApps = Object.entries(config.apps).filter(([, entry]) => entry.enabled)

      if (enabledApps.length === 0) return

      log.info("loading mcp-apps.json apps", { count: enabledApps.length })

      await Promise.allSettled(
        enabledApps.map(async ([id, entry]) => {
          // Skip if already connected (e.g. via opencode.json.mcp)
          const s = await state()
          if (s.status[`mcpapp-${id}`]?.status === "connected") return

          try {
            // /specs/docxmcp-http-transport DD-8: HTTP transport branch.
            // Entries that declare transport=streamable-http use `url`
            // (which may be unix:// for Unix domain socket) instead of
            // a docker command. We funnel those through the existing
            // remote-mcp connection path in add().
            if (entry.transport === "streamable-http" || entry.transport === "sse") {
              if (!entry.url) {
                log.warn("mcp-apps.json http-transport entry missing url", { id })
                return
              }
              const result = await add(`mcpapp-${id}`, {
                type: "remote",
                url: entry.url,
                enabled: true,
              })
              const statusMap = result?.status as Record<string, Status> | undefined
              const addedStatus = statusMap?.[`mcpapp-${id}`]
              if (addedStatus?.status === "failed") {
                const errorMsg = "error" in addedStatus ? addedStatus.error : "unknown"
                log.warn("mcp-apps.json http app failed to start", { id, url: entry.url, error: errorMsg })
              } else {
                log.info("mcp-apps.json http app connected", { id, url: entry.url, transport: entry.transport })
              }
              return
            }

            // entry.command is already resolved to absolute path at registration time
            // by the sudo wrapper or addApp(). No re-resolution needed here.
            if (!entry.command || entry.command.length === 0) {
              log.warn("mcp-apps.json app has no command", { id, path: entry.path })
              return
            }

            // Load manifest for env/auth, then resolve auth tokens + user config
            let env: Record<string, string> = {}
            try {
              const manifest = await McpAppManifest.load(entry.path)
              env = { ...manifest.env }
              log.info("manifest loaded for auth", { id, authType: manifest.auth?.type })
              const authEnv = await resolveAuthEnv(manifest)
              Object.assign(env, authEnv)
              log.info("auth env resolved", { id, envKeys: Object.keys(env) })
            } catch (manifestErr) {
              log.warn("failed to load manifest for auth resolution", {
                id,
                path: entry.path,
                error: manifestErr instanceof Error ? manifestErr.message : String(manifestErr),
              })
            }

            // Inject output directory for tools that save files (e.g. gmail HTML).
            // Uses .opencode/mcp-output/ under the project root so fileview can access it.
            // Gitignored. Not /tmp (security risk with multi-user).
            const projectRoot = Instance.project?.worktree ?? process.cwd()
            env.OPENCODE_OUTPUT_DIR = path.join(projectRoot, ".opencode", "mcp-output")

            // Inject user config values as env vars (key uppercased)
            if (entry.config) {
              for (const [key, value] of Object.entries(entry.config)) {
                const envKey = key.toUpperCase()
                env[envKey] = String(value)
              }
              log.info("user config injected as env", { id, keys: Object.keys(entry.config) })
            }

            const result = await add(`mcpapp-${id}`, {
              type: "local",
              command: entry.command,
              environment: env,
              enabled: true,
            })

            // Check if connection actually succeeded
            const statusMap = result?.status as Record<string, Status> | undefined
            const addedStatus = statusMap?.[`mcpapp-${id}`]
            if (addedStatus?.status === "failed") {
              const errorMsg = "error" in addedStatus ? addedStatus.error : "unknown"
              log.warn("mcp-apps.json app failed to start", { id, error: errorMsg })
            } else {
              log.info("mcp-apps.json app connected", { id, command: entry.command, tools: "via tools/list" })
            }
          } catch (err) {
            log.warn("mcp-apps.json app failed to connect", {
              id,
              path: entry.path,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }),
      )
    } catch (err) {
      log.warn("failed to load mcp-apps.json", {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Start background token refresh for Google OAuth apps
    startGauthRefreshTimer()
  }

  export async function tools() {
    // Ensure mcp-apps.json apps are connected on first call
    await connectMcpApps()
    const s = await state()
    const now = Date.now()
    if (!s.toolsCache.dirty && s.toolsCache.expiresAt > now) {
      return s.toolsCache.value
    }

    const result: Record<string, Tool> = {}
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const clientsSnapshot = await clients()
    const defaultTimeout = cfg.experimental?.mcp_timeout
    const cacheMs = parseToolsCacheMs()

    const connectedClients = Object.entries(clientsSnapshot).filter(
      ([clientName]) => s.status[clientName]?.status === "connected",
    )

    const toolsResults = await Promise.all(
      connectedClients.map(async ([clientName, client]) => {
        const toolsResult = await client.listTools().catch((e) => {
          log.error("failed to get tools", { clientName, error: e.message })
          const failedStatus = {
            status: "failed" as const,
            error: e instanceof Error ? e.message : String(e),
          }
          s.status[clientName] = failedStatus
          delete s.clients[clientName]
          invalidateToolsCache(s.toolsCache)
          return undefined
        })
        return { clientName, client, toolsResult }
      }),
    )

    for (const { clientName, client, toolsResult } of toolsResults) {
      if (!toolsResult) continue
      const mcpConfig = config[clientName]
      const entry = isMcpConfigured(mcpConfig) ? mcpConfig : undefined
      const timeout = entry?.timeout ?? defaultTimeout
      for (const mcpTool of toolsResult.tools) {
        const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
        const sanitizedToolName = mcpTool.name.replace(/[^a-zA-Z0-9_-]/g, "_")
        result[sanitizedClientName + "_" + sanitizedToolName] = await convertMcpTool(
          mcpTool,
          client,
          timeout,
          clientName,
        )
      }
    }

    // NOTE: Managed app tools (Gmail/Calendar) are no longer collected here
    // via managedAppExecutors. They now run as standalone stdio MCP servers
    // and their tools appear via the standard convertMcpTool() path above
    // (registered through mcp-apps.json → connectMcpApps()).

    s.toolsCache.value = result
    s.toolsCache.expiresAt = now + cacheMs
    s.toolsCache.dirty = false
    return result
  }

  export async function prompts() {
    const s = await state()
    const clientsSnapshot = await clients()

    const prompts = Object.fromEntries<PromptInfo & { client: string }>(
      (
        await Promise.all(
          Object.entries(clientsSnapshot).map(async ([clientName, client]) => {
            if (s.status[clientName]?.status !== "connected") {
              return []
            }

            return Object.entries((await fetchPromptsForClient(clientName, client)) ?? {})
          }),
        )
      ).flat(),
    )

    return prompts
  }

  export async function resources() {
    const s = await state()
    const clientsSnapshot = await clients()

    const result = Object.fromEntries<ResourceInfo & { client: string }>(
      (
        await Promise.all(
          Object.entries(clientsSnapshot).map(async ([clientName, client]) => {
            if (s.status[clientName]?.status !== "connected") {
              return []
            }

            return Object.entries((await fetchResourcesForClient(clientName, client)) ?? {})
          }),
        )
      ).flat(),
    )

    return result
  }

  export async function getPrompt(clientName: string, name: string, args?: Record<string, string>) {
    const clientsSnapshot = await clients()
    const client = clientsSnapshot[clientName]

    if (!client) {
      log.warn("client not found for prompt", {
        clientName,
      })
      return undefined
    }

    const result = await client
      .getPrompt({
        name: name,
        arguments: args,
      })
      .catch((e) => {
        log.error("failed to get prompt from MCP server", {
          clientName,
          promptName: name,
          error: e.message,
        })
        return undefined
      })

    return result
  }

  export async function readResource(clientName: string, resourceUri: string) {
    const clientsSnapshot = await clients()
    const client = clientsSnapshot[clientName]

    if (!client) {
      log.warn("client not found for prompt", {
        clientName: clientName,
      })
      return undefined
    }

    const result = await client
      .readResource({
        uri: resourceUri,
      })
      .catch((e) => {
        log.error("failed to get prompt from MCP server", {
          clientName: clientName,
          resourceUri: resourceUri,
          error: e.message,
        })
        return undefined
      })

    return result
  }

  /**
   * Start OAuth authentication flow for an MCP server.
   * Returns the authorization URL that should be opened in a browser.
   */
  export async function startAuth(mcpName: string): Promise<{ authorizationUrl: string }> {
    const cfg = await Config.get()
    const mcpConfig = cfg.mcp?.[mcpName]

    if (!mcpConfig) {
      throw new Error(`MCP server not found: ${mcpName}`)
    }

    if (!isMcpConfigured(mcpConfig)) {
      throw new Error(`MCP server ${mcpName} is disabled or missing configuration`)
    }

    if (mcpConfig.type !== "remote") {
      throw new Error(`MCP server ${mcpName} is not a remote server`)
    }

    if (mcpConfig.oauth === false) {
      throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
    }

    // Start the callback server
    await McpOAuthCallback.ensureRunning()

    // Generate and store a cryptographically secure state parameter BEFORE creating the provider
    // The SDK will call provider.state() to read this value
    const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    await McpAuth.updateOAuthState(mcpName, oauthState)

    // Create a new auth provider for this flow
    // OAuth config is optional - if not provided, we'll use auto-discovery
    const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined
    let capturedUrl: URL | undefined
    const authProvider = new McpOAuthProvider(
      mcpName,
      mcpConfig.url,
      {
        clientId: oauthConfig?.clientId,
        clientSecret: oauthConfig?.clientSecret,
        scope: oauthConfig?.scope,
      },
      {
        onRedirect: async (url) => {
          capturedUrl = url
        },
      },
    )

    // Create transport with auth provider
    const transport = new StreamableHTTPClientTransport(new URL(mcpConfig.url), {
      authProvider,
    })

    // Try to connect - this will trigger the OAuth flow
    try {
      const client = new Client({
        name: "opencode",
        version: Installation.VERSION,
      })
      await client.connect(transport)
      // If we get here, we're already authenticated
      return { authorizationUrl: "" }
    } catch (error) {
      if (error instanceof UnauthorizedError && capturedUrl) {
        // Store transport for finishAuth
        pendingOAuthTransports.set(mcpName, transport)
        return { authorizationUrl: capturedUrl.toString() }
      }
      throw error
    }
  }

  /**
   * Complete OAuth authentication after user authorizes in browser.
   * Opens the browser and waits for callback.
   */
  export async function authenticate(mcpName: string): Promise<Status> {
    const { authorizationUrl } = await startAuth(mcpName)

    if (!authorizationUrl) {
      // Already authenticated
      const s = await state()
      return s.status[mcpName] ?? { status: "connected" }
    }

    // Get the state that was already generated and stored in startAuth()
    const oauthState = await McpAuth.getOAuthState(mcpName)
    if (!oauthState) {
      throw new Error("OAuth state not found - this should not happen")
    }

    // The SDK has already added the state parameter to the authorization URL
    // We just need to open the browser
    log.info("opening browser for oauth", { mcpName, url: authorizationUrl, state: oauthState })

    // Register the callback BEFORE opening the browser to avoid race condition
    // when the IdP has an active SSO session and redirects immediately
    const callbackPromise = McpOAuthCallback.waitForCallback(oauthState)

    try {
      const subprocess = await open(authorizationUrl)
      // The open package spawns a detached process and returns immediately.
      // We need to listen for errors which fire asynchronously:
      // - "error" event: command not found (ENOENT)
      // - "exit" with non-zero code: command exists but failed (e.g., no display)
      await new Promise<void>((resolve, reject) => {
        // Give the process a moment to fail if it's going to
        const timeout = setTimeout(() => resolve(), 500)
        subprocess.on("error", (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        subprocess.on("exit", (code) => {
          if (code !== null && code !== 0) {
            clearTimeout(timeout)
            reject(new Error(`Browser open failed with exit code ${code}`))
          }
        })
      })
    } catch (error) {
      // Browser opening failed (e.g., in remote/headless sessions like SSH, devcontainers)
      // Emit event so CLI can display the URL for manual opening
      log.warn("failed to open browser, user must open URL manually", { mcpName, error })
      Bus.publish(BrowserOpenFailed, { mcpName, url: authorizationUrl })
    }

    // Wait for callback using the already-registered promise
    const code = await callbackPromise

    // Validate and clear the state
    const storedState = await McpAuth.getOAuthState(mcpName)
    if (storedState !== oauthState) {
      await McpAuth.clearOAuthState(mcpName)
      throw new Error("OAuth state mismatch - potential CSRF attack")
    }

    await McpAuth.clearOAuthState(mcpName)

    // Finish auth
    return finishAuth(mcpName, code)
  }

  /**
   * Complete OAuth authentication with the authorization code.
   */
  export async function finishAuth(mcpName: string, authorizationCode: string): Promise<Status> {
    const transport = pendingOAuthTransports.get(mcpName)

    if (!transport) {
      throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)
    }

    try {
      // Call finishAuth on the transport
      await transport.finishAuth(authorizationCode)

      // Clear the code verifier after successful auth
      await McpAuth.clearCodeVerifier(mcpName)

      // Now try to reconnect
      const cfg = await Config.get()
      const mcpConfig = cfg.mcp?.[mcpName]

      if (!mcpConfig) {
        throw new Error(`MCP server not found: ${mcpName}`)
      }

      if (!isMcpConfigured(mcpConfig)) {
        throw new Error(`MCP server ${mcpName} is disabled or missing configuration`)
      }

      // Re-add the MCP server to establish connection
      pendingOAuthTransports.delete(mcpName)
      const result = await add(mcpName, mcpConfig)

      const statusRecord = result.status as Record<string, Status>
      return statusRecord[mcpName] ?? { status: "failed", error: "Unknown error after auth" }
    } catch (error) {
      log.error("failed to finish oauth", { mcpName, error })
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Remove OAuth credentials for an MCP server.
   */
  export async function removeAuth(mcpName: string): Promise<void> {
    const oauthState = await McpAuth.getOAuthState(mcpName)
    await McpAuth.remove(mcpName)
    if (oauthState) McpOAuthCallback.cancelPending(oauthState)
    pendingOAuthTransports.delete(mcpName)
    await McpAuth.clearOAuthState(mcpName)
    log.info("removed oauth credentials", { mcpName })
  }

  /**
   * Check if an MCP server supports OAuth (remote servers support OAuth by default unless explicitly disabled).
   */
  export async function supportsOAuth(mcpName: string): Promise<boolean> {
    const cfg = await Config.get()
    const mcpConfig = cfg.mcp?.[mcpName]
    if (!mcpConfig) return false
    if (!isMcpConfigured(mcpConfig)) return false
    return mcpConfig.type === "remote" && mcpConfig.oauth !== false
  }

  /**
   * Check if an MCP server has stored OAuth tokens.
   */
  export async function hasStoredTokens(mcpName: string): Promise<boolean> {
    const entry = await McpAuth.get(mcpName)
    return !!entry?.tokens
  }

  export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

  /**
   * Get the authentication status for an MCP server.
   */
  export async function getAuthStatus(mcpName: string): Promise<AuthStatus> {
    const hasTokens = await hasStoredTokens(mcpName)
    if (!hasTokens) return "not_authenticated"
    const expired = await McpAuth.isTokenExpired(mcpName)
    return expired ? "expired" : "authenticated"
  }
}
