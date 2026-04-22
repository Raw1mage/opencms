import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { promises as fs, existsSync } from "fs"
import { exec } from "child_process"
import { promisify } from "util"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { validateForkResult, validateForkSource } from "./system-manager-session"
import { patchSessionExecutionViaApi, patchSessionViaApi } from "./system-manager-http"

const execAsync = promisify(exec)

const HOME = process.env.HOME ?? os.homedir()
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? path.join(HOME, ".config")
const XDG_STATE_HOME = process.env.XDG_STATE_HOME ?? path.join(HOME, ".local", "state")
const XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? path.join(HOME, ".local", "share")
const OPENCODE_DATA_HOME = process.env.OPENCODE_DATA_HOME ?? path.join(XDG_DATA_HOME, "opencode")

const ACCOUNTS_PATH = path.join(XDG_CONFIG_HOME, "opencode", "accounts.json")
const CONFIG_PATH = path.join(XDG_CONFIG_HOME, "opencode", "opencode.json")
const MODEL_STATE_PATH = path.join(XDG_STATE_HOME, "opencode", "model.json")
const KV_PATH = path.join(XDG_STATE_HOME, "opencode", "kv.json")
const ROTATION_STATE_PATH = path.join(XDG_STATE_HOME, "opencode", "rotation-state.json")
const USAGE_STATS_PATH = path.join(XDG_CONFIG_HOME, "opencode", "usage-stats.json")
const STORAGE_BASE = path.join(OPENCODE_DATA_HOME, "storage")
const OPENCODE_SERVER_CFG = process.env.OPENCODE_SERVER_CFG ?? "/etc/opencode/opencode.cfg"
const CODEX_ISSUER = "https://auth.openai.com"
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

// Resolve the daemon unix socket path (same logic as server/daemon.ts)
function getDaemonSocketPath(): string {
  const xdg = process.env.XDG_RUNTIME_DIR
  const runtimeDir = xdg
    ? path.join(xdg, "opencode")
    : path.join(HOME, ".local", "state", "opencode", "run")
  return path.join(runtimeDir, "daemon.sock")
}

// Prefer unix socket (works in both TUI and web mode), fallback to TCP HTTP
async function getServerApiBaseUrl() {
  const explicit = process.env.OPENCODE_SERVER_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, "")

  // Check if daemon socket exists — prefer IPC over TCP
  const sock = getDaemonSocketPath()
  if (existsSync(sock)) {
    return `http://localhost/api/v2`  // URL is nominal; actual transport is unix socket
  }

  const raw = await fs.readFile(OPENCODE_SERVER_CFG, "utf-8").catch(() => "")
  const portLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("OPENCODE_PORT="))
  const port =
    portLine
      ?.slice("OPENCODE_PORT=".length)
      .trim()
      .replace(/^['\"]|['\"]$/g, "") || "1080"
  return `http://127.0.0.1:${port}/api/v2`
}

// Wrap fetch to use unix socket when available
async function serverFetch(url: string, init?: RequestInit): Promise<Response> {
  const sock = getDaemonSocketPath()
  if (existsSync(sock)) {
    return fetch(url, { ...init, unix: sock } as any)
  }
  return fetch(url, init)
}

async function readServerRuntimeConfig() {
  const raw = await fs.readFile(OPENCODE_SERVER_CFG, "utf-8").catch(() => "")
  const map = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const index = trimmed.indexOf("=")
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    const value = trimmed
      .slice(index + 1)
      .trim()
      .replace(/^['\"]|['\"]$/g, "")
    map.set(key, value)
  }
  return map
}

async function getServerRequestHeaders(method: string) {
  const headers = new Headers()
  const config = await readServerRuntimeConfig()
  const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || config.get("OPENCODE_SERVER_USERNAME")?.trim() || ""
  const password = process.env.OPENCODE_SERVER_PASSWORD?.trim() || ""
  const htpasswd = config.get("OPENCODE_SERVER_HTPASSWD")?.trim() || ""

  if (username && password) {
    headers.set("Authorization", `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`)
    return headers
  }

  if (method !== "GET" && htpasswd) {
    return headers
  }

  return headers
}

async function readNestedSessionMessages(sessionID: string) {
  const messagesDir = path.join(STORAGE_BASE, "session", sessionID, "messages")
  if (!(await pathExists(messagesDir))) {
    throw new Error(`Canonical transcript storage missing for session ${sessionID}: ${messagesDir}`)
  }

  const entries = await fs.readdir(messagesDir, { withFileTypes: true })
  const messages: Array<{ info: any; parts: any[] }> = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const messageDir = path.join(messagesDir, entry.name)
    const infoPath = path.join(messageDir, "info.json")
    const partsDir = path.join(messageDir, "parts")
    if (!(await pathExists(infoPath))) {
      throw new Error(`Canonical transcript message missing info.json: ${infoPath}`)
    }
    if (!(await pathExists(partsDir))) {
      throw new Error(`Canonical transcript message missing parts directory: ${partsDir}`)
    }

    const info = JSON.parse(await fs.readFile(infoPath, "utf-8"))
    const partFiles = (await fs.readdir(partsDir)).filter((name) => name.endsWith(".json")).sort()
    const parts = await Promise.all(
      partFiles.map(async (name) => JSON.parse(await fs.readFile(path.join(partsDir, name), "utf-8"))),
    )
    messages.push({ info, parts })
  }

  messages.sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0))
  return messages
}

function getQuotaDayStart(): number {
  const now = new Date()
  const resetHourUTC = 8 // 16:00 Taipei is 08:00 UTC
  const todayReset = new Date(now)
  todayReset.setUTCHours(resetHourUTC, 0, 0, 0)

  if (now.getTime() < todayReset.getTime()) {
    const yesterdayReset = new Date(todayReset)
    yesterdayReset.setUTCDate(yesterdayReset.getUTCDate() - 1)
    return yesterdayReset.getTime()
  }
  return todayReset.getTime()
}

const IS_PRODUCTION = !existsSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..", "bin", "opencode.ts"),
)

const THEME_DIR = (() => {
  const xdgTheme = path.join(XDG_CONFIG_HOME, "opencode", "theme")
  // For dev mode, if repo root can be found, use it as fallback
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(scriptDir, "../../../..")
  const repoTheme = path.join(repoRoot, "packages", "opencode", "src", "cli", "cmd", "tui", "context", "theme")
  return existsSync(xdgTheme) ? xdgTheme : repoTheme
})()
const DEFAULT_THEMES = [
  "aura",
  "ayu",
  "catppuccin",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "cobalt2",
  "cursor",
  "dracula",
  "everforest",
  "flexoki",
  "github",
  "gruvbox",
  "kanagawa",
  "material",
  "matrix",
  "mercury",
  "monokai",
  "nightowl",
  "nord",
  "one-dark",
  "osaka-jade",
  "opencode",
  "orng",
  "lucent-orng",
  "palenight",
  "rosepine",
  "solarized",
  "synthwave84",
  "tokyonight",
  "vesper",
  "vercel",
  "zenburn",
  "carbonfox",
]

async function refreshCodexAccessToken(refreshToken: string) {
  const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) throw new Error(`Codex token refresh failed: ${response.status}`)
  return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>
}

async function getCodexUsage(info: any, accountId: string, familyId: string) {
  let access = info.accessToken
  let expires = info.expiresAt
  let refresh = info.refreshToken
  let chatgptAccountId = info.accountId

  if (!access || !expires || expires < Date.now()) {
    try {
      const tokens = await refreshCodexAccessToken(refresh)
      access = tokens.access_token
      refresh = tokens.refresh_token ?? refresh
      expires = Date.now() + (tokens.expires_in ?? 3600) * 1000

      const raw = await fs.readFile(ACCOUNTS_PATH, "utf-8")
      const accounts = JSON.parse(raw)
      accounts.families[familyId].accounts[accountId] = {
        ...accounts.families[familyId].accounts[accountId],
        accessToken: access,
        refreshToken: refresh,
        expiresAt: expires,
      }
      await fs.writeFile(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2))
    } catch (e) {
      return { error: "Auth refresh failed" }
    }
  }

  try {
    const headers = new Headers({ Authorization: `Bearer ${access}`, Accept: "application/json" })
    if (chatgptAccountId) headers.set("ChatGPT-Account-Id", chatgptAccountId)

    const response = await fetch(CODEX_USAGE_URL, { headers })
    if (!response.ok) return { error: `HTTP ${response.status}` }

    const usage: any = await response.json()
    const primary = usage?.rate_limit?.primary_window
    const secondary = usage?.rate_limit?.secondary_window

    const primaryUsed = typeof primary?.used_percent === "number" ? primary.used_percent : undefined
    const secondaryUsed = typeof secondary?.used_percent === "number" ? secondary.used_percent : undefined
    const primaryWindowSeconds =
      typeof primary?.limit_window_seconds === "number" ? primary.limit_window_seconds : undefined

    const isWeeklyOnly =
      secondary == null && typeof primaryWindowSeconds === "number" && primaryWindowSeconds >= 6 * 24 * 60 * 60
    const hourlyRemaining =
      secondaryUsed !== undefined
        ? Math.round(Math.max(0, 100 - (primaryUsed ?? 0)))
        : isWeeklyOnly
          ? undefined
          : primaryUsed !== undefined
            ? Math.round(Math.max(0, 100 - primaryUsed))
            : undefined
    const weeklyRemaining =
      secondaryUsed !== undefined
        ? Math.round(Math.max(0, 100 - secondaryUsed))
        : isWeeklyOnly
          ? Math.round(Math.max(0, 100 - (primaryUsed ?? 0)))
          : undefined

    return {
      "5H": hourlyRemaining === undefined ? "--" : `${hourlyRemaining}%`,
      WK: weeklyRemaining === undefined ? "--" : `${weeklyRemaining}%`,
    }
  } catch (e) {
    return { error: "Fetch usage failed" }
  }
}

const server = new Server({ name: "opencode-system-manager", version: "1.1.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_system_status",
        description: "Get providers, active accounts, and real-time usage (including OpenAI 5H/WK).",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "switch_session",
        description:
          "Switch the active/visible session by sessionID. Treat natural-language requests like 'open that session' or 'switch to session X' as session-based navigation. If the target session is ambiguous, ask with question first. Do not silently guess a session.",
        inputSchema: {
          type: "object",
          properties: { sessionID: { type: "string" } },
          required: ["sessionID"],
        },
      },
      {
        name: "switch_model",
        description:
          "Switch the model for a session's execution context. This is always session-based; there is no global model switch here. Natural-language requests like 'switch to 5.2' should resolve against the current session context first. If multiple models match, ask with question. Do not silently fallback or guess.",
        inputSchema: {
          type: "object",
          properties: {
            sessionID: { type: "string" },
            providerId: { type: "string" },
            modelID: { type: "string" },
            accountId: { type: "string" },
          },
          required: ["sessionID", "modelID"],
        },
      },
      {
        name: "switch_account",
        description:
          "Switch the account for a session's execution context. This is always session-based; there is no global active-account switch here. If the session already has a provider/model, the agent may reuse that execution context when unambiguous. If the target account or provider is ambiguous, ask with question instead of guessing.",
        inputSchema: {
          type: "object",
          properties: {
            sessionID: { type: "string" },
            family: { type: "string" },
            accountId: { type: "string" },
            modelID: { type: "string" },
          },
          required: ["sessionID", "family", "accountId"],
        },
      },
      {
        name: "switch_provider",
        description:
          "Switch the provider for a session's execution context. This is always session-based. Provider and model are coupled operationally, so the target model should be explicit or unambiguous. If the user only says 'switch provider' without a clear model choice, ask with question. Do not invent a cross-provider fallback.",
        inputSchema: {
          type: "object",
          properties: {
            sessionID: { type: "string" },
            providerId: { type: "string" },
            modelID: { type: "string" },
            accountId: { type: "string" },
          },
          required: ["sessionID", "providerId", "modelID"],
        },
      },
      {
        name: "rename_session",
        description:
          "Rename a session. This is a session-based metadata update for requests like 'rename this session to X'. If the new title is missing or unclear, ask with question rather than inventing one.",
        inputSchema: {
          type: "object",
          properties: {
            sessionID: { type: "string" },
            title: { type: "string" },
          },
          required: ["sessionID", "title"],
        },
      },
      {
        name: "get_favorites",
        description: "Get favorite and recent models.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "switch_theme",
        description: "Switch the TUI theme by updating opencode.json.",
        inputSchema: {
          type: "object",
          properties: {
            theme: { type: "string", enum: DEFAULT_THEMES },
          },
          required: ["theme"],
        },
      },
      {
        name: "toggle_mcp",
        description: "Enable or disable an MCP server in opencode.json.",
        inputSchema: {
          type: "object",
          properties: {
            mcpName: { type: "string" },
            enabled: { type: "boolean" },
          },
          required: ["mcpName", "enabled"],
        },
      },
      {
        name: "copy_to_clipboard",
        description: "Copy text to system clipboard.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      },
      {
        name: "execute_command",
        description: "Retrieve a command template from .opencode/command/.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Command name (e.g., 'issues', 'commit')" },
          },
          required: ["name"],
        },
      },
      {
        name: "update_models",
        description: "Refresh model lists from providers.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "switch_agent",
        description: "Switch the default agent by updating opencode.json.",
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string" },
          },
          required: ["agent"],
        },
      },
      {
        name: "open_in_editor",
        description: "Open a file in the default system editor.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
      {
        name: "open_fileview",
        description: "Open a file in the web UI file viewer tab. Use this to display rich content (HTML, markdown, SVG) to the user without reading it yourself. The file will open in a new tab in the file viewer panel.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to the file to display" },
            title: { type: "string", description: "Optional display title for the tab" },
          },
          required: ["path"],
        },
      },
      {
        name: "manage_session",
        description:
          "Manage opencode sessions for non-switching operations (fork, summarize, undo, redo, create, list, search). Use switch_session / rename_session / switch_model / switch_account / switch_provider for session-based control actions. If a user asks in natural language to switch session/provider/account/model or rename a session, prefer those dedicated tools over manage_session.\n\nFor operation='create' you may pass sessionID as a handover source: the new session will inherit the source's directory and model, and (unless handoverAutoPrompt=false) will be auto-seeded with a prompt telling the new session to read the source's eventlog / checkpoint / SharedContext and continue. Pass handover for extra free-form context appended after the canned instruction.",
        inputSchema: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: ["fork", "summarize", "undo", "redo", "create", "list", "search"],
            },
            sessionID: {
              type: "string",
              description:
                "Target session ID. For operation='create' this is the handover SOURCE session (optional) whose directory + execution model the new session inherits.",
            },
            messageID: { type: "string", description: "Message ID to fork from" },
            query: { type: "string", description: "Search keyword for session titles (used with 'search' operation)" },
            limit: { type: "number", description: "Max results for search (default 10)" },
            title: { type: "string", description: "Title for the new session (operation='create')" },
            handover: {
              type: "string",
              description:
                "Free-form extra context appended after the canned handover instruction when operation='create' and sessionID is supplied.",
            },
            handoverAutoPrompt: {
              type: "boolean",
              description:
                "When operation='create' and sessionID is supplied, auto-fire a seed prompt on the new session. Default true.",
            },
            directory: {
              type: "string",
              description:
                "Override working directory for operation='create'. If omitted, inherits from sessionID's directory or falls back to the caller's project.",
            },
          },
          required: ["operation"],
        },
      },
      {
        name: "app_control",
        description: "Control the application (exit, help, models, connect, admin).",
        inputSchema: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["exit", "help", "models", "connect", "admin"] },
          },
          required: ["operation"],
        },
      },
      {
        name: "set_ui_config",
        description: "Set TUI configuration (sidebar, thinking, details, timestamps).",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", enum: ["sidebar", "thinking_visibility", "tool_details_visibility", "timestamps"] },
            value: { type: "string", description: "Value to set (e.g., 'hide', 'show', 'true', 'false')" },
          },
          required: ["key", "value"],
        },
      },
      {
        name: "export_transcript",
        description: "Export session transcript to a Markdown file and open it.",
        inputSchema: {
          type: "object",
          properties: {
            sessionID: { type: "string" },
            savePath: { type: "string", description: "Optional: Path to save the file to (defaults to /tmp)" },
          },
          required: ["sessionID"],
        },
      },
      {
        name: "set_log_level",
        description:
          "Dynamically set the Bus log level for all subscribers. Takes effect within 5 seconds. Levels: 0=off (all subscribers silent), 1=quiet (debug.log only, no toast), 2=normal (debug.log + toast + card, default), 3=verbose (same as normal, reserved for future expansion). Use 'get' action to read the current level without changing it.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["set", "get"], description: "set: change level, get: read current level" },
            level: { type: "string", enum: ["0", "1", "2", "3"], description: "Log level: 0=off, 1=quiet, 2=normal, 3=verbose (required for 'set' action)" },
          },
          required: ["action"],
        },
      },
      // ── MCP App Store tools (Layer 3: Conversational Provisioning) ───
      {
        name: "install_mcp_app",
        description:
          "Install an MCP App from a GitHub URL or local path. Clones the repo (if GitHub), reads/infers mcp.json manifest, installs dependencies, probes via stdio tools/list, and registers in mcp-apps.json. The App becomes available in the session tool pool.",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: "GitHub URL (https://github.com/owner/repo) or absolute local path to an MCP server directory",
            },
            id: {
              type: "string",
              description: "App identifier (optional — inferred from repo name or mcp.json if omitted)",
            },
          },
          required: ["source"],
        },
      },
      {
        name: "list_mcp_apps",
        description:
          "List all installed MCP Apps from mcp-apps.json (both system-level and user-level) with their manifest metadata, status, and tier.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "remove_mcp_app",
        description:
          "Unregister an MCP App from mcp-apps.json. Only removes the registry entry — does NOT delete App files from disk. Use ONLY when the user explicitly asks to remove an App. Never call this proactively.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "App identifier to remove" },
          },
          required: ["id"],
        },
      },
      {
        name: "restart_self",
        description:
          "[META TOOL — RESTARTS OPENCODE ITSELF, NOT THE USER'S PROJECT] " +
          "Request a controlled rebuild+restart of the opencode AI runtime you " +
          "are currently running on (the bun daemon under ~/projects/opencode, " +
          "the opencode web frontend, or the C gateway). " +
          "ONLY use this when you have just modified the opencode source repo " +
          "itself and need those changes live. " +
          "DO NOT use this to restart any of the following, even if the user's " +
          "project is ALSO a web application: " +
          "Flask/Django/Node/etc servers under /home/pkcs12/projects/<anything> " +
          "other than /home/pkcs12/projects/opencode; the user's docker compose " +
          "stacks; systemd services owned by the user's project; nginx; " +
          "anything launched by the user's own webctl / make / start scripts. " +
          "If the user's project needs its own server restarted, read its " +
          "README or ask the user — this tool cannot do it. Running this tool " +
          "on the wrong assumption WILL kill the AI runtime the user is " +
          "talking to, forcing a reconnect cycle for every client. " +
          "On legitimate use (opencode source just changed): webctl.sh " +
          "smart-detects which layers are dirty and only rebuilds those; if " +
          "nothing changed the call is a no-op. On failure the system stays on " +
          "the previous version (daemon is not killed). Do NOT attempt to run " +
          "`webctl.sh` directly via execute_command — that path is denied; " +
          "this tool is the only sanctioned path.",
        inputSchema: {
          type: "object",
          properties: {
            targets: {
              type: "array",
              items: { type: "string", enum: ["daemon", "frontend", "gateway"] },
              description:
                "Optional layer hint. Omit to let webctl auto-detect. Include 'gateway' ONLY when the C gateway binary changed (daemon/opencode-gateway.c) — this adds --force-gateway and causes a systemd respawn of the gateway itself, briefly disconnecting all users.",
            },
            reason: {
              type: "string",
              description: "Short human-readable reason (stored in gateway log and restart event log). Example: 'applied auth middleware rewrite'.",
              maxLength: 500,
            },
          },
        },
      },
    ],
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    if (name === "get_system_status") {
      const accounts = JSON.parse(await fs.readFile(ACCOUNTS_PATH, "utf-8"))
      const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))

      let rotationState: any = { rateLimits: {}, accountHealth: {} }
      try {
        if (await pathExists(ROTATION_STATE_PATH)) {
          rotationState = JSON.parse(await fs.readFile(ROTATION_STATE_PATH, "utf-8"))
        }
      } catch (e) {}

      let usageStats: any = {}
      try {
        if (await pathExists(USAGE_STATS_PATH)) {
          usageStats = JSON.parse(await fs.readFile(USAGE_STATS_PATH, "utf-8"))
        }
      } catch (e) {}

      let currentModel = null
      try {
        const modelState = JSON.parse(await fs.readFile(MODEL_STATE_PATH, "utf-8"))
        currentModel = modelState.recent?.[0]
      } catch (e) {}

      const families = await Promise.all(
        Object.entries(accounts.families).map(async ([fname, data]: [string, any]) => {
          const accountList = await Promise.all(
            Object.entries(data.accounts).map(async ([id, a]: [string, any]) => {
              let usage = undefined
              if (fname === "openai" && a.type === "subscription") {
                usage = await getCodexUsage(a, id, fname)
              }

              let detailedInfo = undefined

              // Cross-reference with rotation state for cooldowns across ALL providers
              const rotationKey = `${fname}:${id}`
              const cooldowns = rotationState.rateLimits[rotationKey] || {}

              // Gather real-time usage (RPM/RPD) from usage-stats
              const modelUsage: Record<string, any> = {}
              for (const [key, stats] of Object.entries(usageStats)) {
                if (key.startsWith(`${fname}:${id}:`)) {
                  const modelId = key.split(":").slice(2).join(":")
                  modelUsage[modelId] = stats
                }
              }

              return {
                name: a.name,
                email: a.email,
                id: id,
                usage: usage,
                detailed: detailedInfo,
                cooldowns: cooldowns,
                model_usage: modelUsage,
                reset: a.rateLimitResetTimes,
              }
            }),
          )

          return {
            family: fname,
            // REFACTOR: Renamed from 'active' to 'selectedAccount' to prevent AI confusion.
            // 'active' implies the provider is enabled/visible, but here it only means
            // "which account is currently selected". The provider might still be hidden.
            selectedAccount: data.activeAccount,
            accounts: accountList,
          }
        }),
      )

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                families,
                current_model: currentModel,
                config_provider: config.provider,
                theme: config.theme,
                agent: config.default_agent,
                next_reset_1600_taipei: new Date(getQuotaDayStart() + 86400000).toISOString(),
              },
              null,
              2,
            ),
          },
        ],
      }
    }

    if (name === "switch_session") {
      const { sessionID } = args as { sessionID: string }
      const session = JSON.parse(await fs.readFile(path.join(STORAGE_BASE, "session", sessionID, "info.json"), "utf-8"))
      const dir = session.directory ?? ""
      const dirBase64 = Buffer.from(dir).toString("base64")
      const baseUrl = await getServerApiBaseUrl()
      const headers = await getServerRequestHeaders("POST")
      headers.set("Content-Type", "application/json")
      const response = await serverFetch(`${baseUrl}/tui/select-session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionID }),
      })
      if (!response.ok) throw new Error(`Failed to switch session ${sessionID}: HTTP ${response.status}`)
      return {
        content: [
          {
            type: "text",
            text: `Switched to session ${sessionID}\nTitle: ${session.title ?? "(untitled)"}\nURL: /${dirBase64}/session/${sessionID}`,
          },
        ],
      }
    }

    if (name === "switch_account") {
      const { sessionID, family, accountId, modelID } = args as {
        sessionID: string
        family: string
        accountId: string
        modelID?: string
      }
      const session = JSON.parse(await fs.readFile(path.join(STORAGE_BASE, "session", sessionID, "info.json"), "utf-8"))
      const currentExecution = session.execution ?? {}
      const nextModelID = modelID ?? currentExecution.modelID
      if (!nextModelID) throw new Error("modelID is required when session has no existing execution model")
      const baseUrl = await getServerApiBaseUrl()
      const headers = await getServerRequestHeaders("PATCH")
      await patchSessionExecutionViaApi({
        fetchImpl: serverFetch as any,
        baseUrl,
        headers,
        sessionID,
        providerId: family,
        modelID: nextModelID,
        accountId,
      })
      return {
        content: [{ type: "text", text: `Switched session ${sessionID} account to ${accountId} under ${family}` }],
      }
    }

    if (name === "switch_model") {
      const { sessionID, providerId, modelID, accountId } = args as {
        sessionID: string
        providerId?: string
        modelID: string
        accountId?: string
      }
      const session = JSON.parse(await fs.readFile(path.join(STORAGE_BASE, "session", sessionID, "info.json"), "utf-8"))
      const currentExecution = session.execution ?? {}
      const nextProviderId = providerId ?? currentExecution.providerId
      if (!nextProviderId) throw new Error("providerId is required when session has no existing execution provider")
      const baseUrl = await getServerApiBaseUrl()
      const headers = await getServerRequestHeaders("PATCH")
      await patchSessionExecutionViaApi({
        fetchImpl: serverFetch as any,
        baseUrl,
        headers,
        sessionID,
        providerId: nextProviderId,
        modelID,
        accountId: accountId ?? currentExecution.accountId,
      })
      return {
        content: [{ type: "text", text: `Switched session ${sessionID} model to ${nextProviderId}:${modelID}` }],
      }
    }

    if (name === "switch_provider") {
      const { sessionID, providerId, modelID, accountId } = args as {
        sessionID: string
        providerId: string
        modelID: string
        accountId?: string
      }
      const baseUrl = await getServerApiBaseUrl()
      const headers = await getServerRequestHeaders("PATCH")
      await patchSessionExecutionViaApi({
        fetchImpl: serverFetch as any,
        baseUrl,
        headers,
        sessionID,
        providerId,
        modelID,
        accountId,
      })
      return {
        content: [{ type: "text", text: `Switched session ${sessionID} provider to ${providerId} (${modelID})` }],
      }
    }

    if (name === "rename_session") {
      const { sessionID, title } = args as { sessionID: string; title: string }
      const baseUrl = await getServerApiBaseUrl()
      const headers = await getServerRequestHeaders("PATCH")
      await patchSessionViaApi({
        fetchImpl: serverFetch as any,
        baseUrl,
        headers,
        sessionID,
        body: { title },
        errorPrefix: `Failed to rename session ${sessionID}`,
      })
      return { content: [{ type: "text", text: `Renamed session ${sessionID} to "${title}"` }] }
    }

    if (name === "get_favorites") {
      const modelState = JSON.parse(await fs.readFile(MODEL_STATE_PATH, "utf-8"))
      return { content: [{ type: "text", text: JSON.stringify(modelState, null, 2) }] }
    }

    if (name === "switch_theme") {
      const { theme } = args as { theme: string }
      const raw = await fs.readFile(CONFIG_PATH, "utf-8")
      const config = JSON.parse(raw)
      config.theme = theme
      await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2))
      return { content: [{ type: "text", text: `Switched theme to ${theme}` }] }
    }

    if (name === "toggle_mcp") {
      const { mcpName, enabled } = args as { mcpName: string; enabled: boolean }
      const raw = await fs.readFile(CONFIG_PATH, "utf-8")
      const config = JSON.parse(raw)
      if (!config.mcp) config.mcp = {}
      if (!config.mcp[mcpName]) {
        return { content: [{ type: "text", text: `MCP server ${mcpName} not found in config` }], isError: true }
      }
      config.mcp[mcpName].enabled = enabled
      await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2))
      return { content: [{ type: "text", text: `${enabled ? "Enabled" : "Disabled"} MCP server ${mcpName}` }] }
    }

    if (name === "copy_to_clipboard") {
      const { text } = args as { text: string }
      const child = exec("xclip -selection clipboard", (error: any) => {
        if (error) console.error(`xclip error: ${error}`)
      })
      child.stdin?.write(text)
      child.stdin?.end()
      return { content: [{ type: "text", text: "Copied to clipboard" }] }
    }

    if (name === "execute_command") {
      const { name: cmdName } = args as { name: string }
      const xdgCmdPath = path.join(XDG_CONFIG_HOME, "opencode", "command", `${cmdName}.md`)
      const scriptDir = path.dirname(fileURLToPath(import.meta.url))
      const repoRoot = path.resolve(scriptDir, "../../../..")
      const repoCmdPath = path.join(repoRoot, ".opencode", "command", `${cmdName}.md`)

      const cmdPath = (await pathExists(xdgCmdPath)) ? xdgCmdPath : repoCmdPath
      try {
        const content = await fs.readFile(cmdPath, "utf-8")
        return { content: [{ type: "text", text: content }] }
      } catch (e) {
        return { content: [{ type: "text", text: `Command ${cmdName} not found` }], isError: true }
      }
    }

    if (name === "update_models") {
      const scriptDir = path.dirname(fileURLToPath(import.meta.url))
      const repoRoot = path.resolve(scriptDir, "../../../..")
      const opencodeBin = !IS_PRODUCTION ? path.join(repoRoot, "bin", "opencode.ts") : "opencode" // Use system command in production

      if (!IS_PRODUCTION) {
        await execAsync(`bun run ${JSON.stringify(opencodeBin)} models --refresh`)
      } else {
        await execAsync(`${opencodeBin} models --refresh`)
      }
      return { content: [{ type: "text", text: "Models list refreshed" }] }
    }

    if (name === "switch_agent") {
      const { agent } = args as { agent: string }
      const raw = await fs.readFile(CONFIG_PATH, "utf-8")
      const config = JSON.parse(raw)
      config.default_agent = agent
      await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2))
      return { content: [{ type: "text", text: `Switched default agent to ${agent}` }] }
    }

    if (name === "open_in_editor") {
      const { path: targetPath } = args as { path: string }
      await execAsync(`xdg-open ${JSON.stringify(targetPath)}`)
      return { content: [{ type: "text", text: `Opened ${targetPath} in editor` }] }
    }

    if (name === "open_fileview") {
      const { path: targetPath, title } = args as { path: string; title?: string }
      // Write to KV store — frontend watches for fileview_open changes
      let kv: any = {}
      try {
        kv = JSON.parse(await fs.readFile(KV_PATH, "utf-8"))
      } catch (e) {}
      kv.fileview_open = { path: targetPath, title: title ?? targetPath, ts: Date.now() }
      await fs.writeFile(KV_PATH, JSON.stringify(kv, null, 2))
      return { content: [{ type: "text", text: `File viewer opened: ${title ?? targetPath}` }] }
    }

    if (name === "set_ui_config") {
      const { key, value } = args as { key: string; value: string }
      let kv: any = {}
      try {
        kv = JSON.parse(await fs.readFile(KV_PATH, "utf-8"))
      } catch (e) {}

      let finalValue: any = value
      if (value === "true") finalValue = true
      if (value === "false") finalValue = false

      kv[key] = finalValue
      await fs.writeFile(KV_PATH, JSON.stringify(kv, null, 2))
      return { content: [{ type: "text", text: `Set UI config ${key} to ${value}` }] }
    }

    if (name === "manage_session") {
      const {
        operation,
        sessionID,
        title,
        messageID,
        query,
        limit: searchLimit,
        handover,
        handoverAutoPrompt,
        directory: directoryOverride,
      } = args as {
        operation: string
        sessionID?: string
        title?: string
        messageID?: string
        query?: string
        limit?: number
        handover?: string
        handoverAutoPrompt?: boolean
        directory?: string
      }

      if (operation === "search") {
        if (!query) throw new Error("query is required for search operation")
        const sessionDir = path.join(STORAGE_BASE, "session")
        const entries = await fs.readdir(sessionDir).catch(() => [] as string[])
        const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)
        const maxResults = searchLimit ?? 10

        const matches: Array<{ id: string; title: string; directory: string; updated: number; url: string }> = []
        for (const entry of entries) {
          if (!entry.startsWith("ses_")) continue
          try {
            const info = JSON.parse(await fs.readFile(path.join(sessionDir, entry, "info.json"), "utf-8"))
            const sessionTitle = (info.title ?? "").toLowerCase()
            if (!keywords.every((kw: string) => sessionTitle.includes(kw))) continue
            const dir = info.directory ?? ""
            const dirBase64 = Buffer.from(dir).toString("base64")
            matches.push({
              id: info.id,
              title: info.title ?? "(untitled)",
              directory: dir,
              updated: info.time?.updated ?? info.time?.created ?? 0,
              url: `/${dirBase64}/session/${info.id}`,
            })
          } catch {
            continue
          }
        }

        matches.sort((a, b) => b.updated - a.updated)
        const results = matches.slice(0, maxResults)

        if (results.length === 0) {
          return { content: [{ type: "text", text: `No sessions found matching "${query}".` }] }
        }

        const lines = results.map((s, i) => {
          const date = new Date(s.updated).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })
          return `${i + 1}. **${s.title}**\n   ID: ${s.id}\n   Updated: ${date}\n   URL: ${s.url}`
        })
        return {
          content: [
            { type: "text", text: `Found ${matches.length} session(s) matching "${query}":\n\n${lines.join("\n\n")}` },
          ],
        }
      }

      if (operation === "list") {
        let kv: any = {}
        try {
          kv = JSON.parse(await fs.readFile(KV_PATH, "utf-8"))
        } catch (e) {}
        kv.ui_trigger = "session.list"
        await fs.writeFile(KV_PATH, JSON.stringify(kv, null, 2))
        return { content: [{ type: "text", text: "Opening session list UI..." }] }
      }

      if (operation === "create") {
        // Resolve source session (if any) to inherit directory + execution.
        let sourceInfo: any | undefined
        if (sessionID) {
          try {
            sourceInfo = JSON.parse(
              await fs.readFile(path.join(STORAGE_BASE, "session", sessionID, "info.json"), "utf-8"),
            )
          } catch (err) {
            throw new Error(
              `Handover source session ${sessionID} not found: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }

        // Pick target directory.
        // Priority: explicit directory arg > source session's directory > server default.
        // The key fix (2026-04-23): the previous implementation sent no
        // directory at all, so the server fell back to $HOME and the new
        // session was indexed under the wrong project — invisible in the
        // web session list of whatever project the user was viewing.
        const targetDirectory = directoryOverride ?? sourceInfo?.directory ?? undefined

        const baseUrl = await getServerApiBaseUrl()
        const headers = await getServerRequestHeaders("POST")
        headers.set("content-type", "application/json")
        if (targetDirectory) headers.set("x-opencode-directory", targetDirectory)

        const rawCreate = await serverFetch(`${baseUrl}/session`, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: title ?? (sessionID ? `Handover from ${sessionID}` : "New Session") }),
        }).catch((err) => {
          throw new Error(`POST /session failed: ${err instanceof Error ? err.message : String(err)}`)
        })

        if (!rawCreate?.ok) {
          const text = rawCreate ? await rawCreate.text().catch(() => "") : ""
          throw new Error(`POST /session returned HTTP ${rawCreate?.status ?? "n/a"}: ${text.slice(0, 400)}`)
        }

        const created = (await rawCreate.json().catch(() => undefined)) as any
        const createdID = created?.id
        if (!createdID) throw new Error("POST /session returned no session id")

        const dir = created.directory ?? targetDirectory ?? ""
        const dirBase64 = Buffer.from(dir).toString("base64")
        const url = `/${dirBase64}/session/${createdID}`

        // Handover auto-seed: if a source session was supplied, fire a
        // canned prompt telling the new session to catch up from the
        // source's transcript + runtime state, then append any free-form
        // `handover` text the caller added. The model is inherited from
        // source's `execution` record so we don't have to guess.
        let autoPromptResult: "fired" | "skipped" | "failed:no-model" | "failed:http" | undefined
        const wantsAutoPrompt = Boolean(sessionID) && handoverAutoPrompt !== false
        if (wantsAutoPrompt) {
          const exec = sourceInfo?.execution
          const model = exec?.providerId && exec?.modelID
            ? { providerId: exec.providerId, modelID: exec.modelID, accountId: exec.accountId }
            : undefined
          if (!model) {
            autoPromptResult = "failed:no-model"
          } else {
            const extra = handover?.trim() ? `\n\n${handover.trim()}` : ""
            const seedText =
              `請先讀取 session ${sessionID} 的 eventlog、checkpoint 與 SharedContext，` +
              `熟悉該會話目前的進度、已做過的決定、pending todo，再接手繼續工作。${extra}`
            const promptHeaders = await getServerRequestHeaders("POST")
            promptHeaders.set("content-type", "application/json")
            if (targetDirectory) promptHeaders.set("x-opencode-directory", targetDirectory)
            const rawPrompt = await serverFetch(
              `${baseUrl}/session/${encodeURIComponent(createdID)}/prompt_async`,
              {
                method: "POST",
                headers: promptHeaders,
                body: JSON.stringify({
                  model,
                  parts: [{ type: "text", text: seedText }],
                }),
              },
            ).catch(() => undefined)
            autoPromptResult = rawPrompt?.ok ? "fired" : "failed:http"
          }
        } else if (sessionID) {
          autoPromptResult = "skipped"
        }

        // Keep the TUI hint in place so TUI users still get a list refresh.
        // Web frontend already listens to the session.created bus event
        // emitted by Session.create and will pick up the new row on its own.
        try {
          let kv: any = {}
          try {
            kv = JSON.parse(await fs.readFile(KV_PATH, "utf-8"))
          } catch {}
          kv.ui_trigger = "session.list.refresh"
          await fs.writeFile(KV_PATH, JSON.stringify(kv, null, 2))
        } catch {}

        // Lead with a clickable markdown link so web chat renders it as a
        // single blue button the user can tap to jump over. Auto-navigation
        // via bus event is a separate feature; until that lands, this is
        // the one-click handover path.
        const displayTitle = created.title ?? "(untitled)"
        const lines = [
          `👉 **[Open new session: ${displayTitle}](${url})**`,
          "",
          `Session ID: \`${createdID}\``,
          `Directory: ${dir || "(server default)"}`,
        ]
        if (sessionID) lines.push(`Handover source: \`${sessionID}\``)
        if (autoPromptResult) lines.push(`Auto-seed prompt: ${autoPromptResult}`)
        if (autoPromptResult === "failed:no-model") {
          lines.push(
            "Note: source session has no recorded execution model; open the new session and send the first message manually.",
          )
        }
        return { content: [{ type: "text", text: lines.join("\n") }] }
      }

      if (!sessionID) throw new Error("sessionID is required for this operation")
      const sessionInfoPath = `${STORAGE_BASE}/session/${sessionID}/info.json`

      if (operation === "undo") {
        const messageDir = `${STORAGE_BASE}/message/${sessionID}`
        const files = (await fs.readdir(messageDir)).sort()
        let lastUserMsgID = null
        let lastUserContent = ""
        for (let i = files.length - 1; i >= 0; i--) {
          const msg = JSON.parse(await fs.readFile(`${messageDir}/${files[i]}`, "utf-8"))
          if (msg.role === "user") {
            lastUserMsgID = msg.id
            // Try to get text content from parts
            try {
              const partDir = `${STORAGE_BASE}/part/${msg.id}`
              const pFiles = await fs.readdir(partDir)
              const parts = await Promise.all(
                pFiles.sort().map(async (f: string) => JSON.parse(await fs.readFile(`${partDir}/${f}`, "utf-8"))),
              )
              lastUserContent = parts
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("\n")
            } catch (e) {}
            break
          }
        }
        if (lastUserMsgID) {
          const session = JSON.parse(await fs.readFile(sessionInfoPath, "utf-8"))
          session.revert = { messageID: lastUserMsgID, diff: "" }
          await fs.writeFile(sessionInfoPath, JSON.stringify(session, null, 2))
          return {
            content: [
              {
                type: "text",
                text: `Successfully undid last message in session ${sessionID}.\nContext restored to message: ${lastUserMsgID}\nContent: ${lastUserContent}`,
              },
            ],
          }
        }
        return { content: [{ type: "text", text: "No user message found to undo" }], isError: true }
      }

      if (operation === "redo") {
        const session = JSON.parse(await fs.readFile(sessionInfoPath, "utf-8"))
        session.revert = null
        await fs.writeFile(sessionInfoPath, JSON.stringify(session, null, 2))
        return { content: [{ type: "text", text: `Redid message in ${sessionID}` }] }
      }

      if (operation === "summarize") {
        return {
          content: [
            {
              type: "text",
              text: `Summarization for session ${sessionID} requested. (Implementation pending SDK integration)`,
            },
          ],
        }
      }

      if (operation === "fork") {
        const newID = "ses_" + Math.random().toString(36).substring(2, 15)
        const newDir = path.join(STORAGE_BASE, "session", newID)
        await fs.mkdir(newDir, { recursive: true })

        const session = JSON.parse(await fs.readFile(sessionInfoPath, "utf-8"))
        session.id = newID
        session.parentID = undefined
        session.title = `Fork of ${session.title || sessionID}`
        session.time = {
          created: Date.now(),
          updated: Date.now(),
        }

        const sourceMessagesDir = path.join(STORAGE_BASE, "session", sessionID, "messages")
        const legacyMessagesDir = path.join(STORAGE_BASE, "message", sessionID)
        const targetMessagesDir = path.join(newDir, "messages")

        const sourceValidation = await validateForkSource(STORAGE_BASE, sessionID)
        if (sourceValidation.fatal.length > 0) {
          await fs.rm(newDir, { recursive: true, force: true }).catch(() => {})
          throw new Error(sourceValidation.fatal.join("; "))
        }

        const hasSourceMessages = await pathExists(sourceMessagesDir)

        await fs.writeFile(path.join(newDir, "info.json"), JSON.stringify(session, null, 2))
        const sessionIndexDir = path.join(STORAGE_BASE, "index", "session")
        await fs.mkdir(sessionIndexDir, { recursive: true }).catch(() => {})
        await fs.writeFile(
          path.join(sessionIndexDir, `${newID}.json`),
          JSON.stringify({ projectID: session.projectID, parentID: session.parentID }, null, 2),
        )
        if (hasSourceMessages) {
          await fs.cp(sourceMessagesDir, targetMessagesDir, { recursive: true })
        } else {
          await fs.mkdir(path.join(STORAGE_BASE, "message"), { recursive: true }).catch(() => {})
          await fs.cp(legacyMessagesDir, path.join(STORAGE_BASE, "message", newID), { recursive: true })
        }

        const forkValidation = await validateForkResult(STORAGE_BASE, newID)
        if (forkValidation.fatal.length > 0) {
          await fs.rm(newDir, { recursive: true, force: true }).catch(() => {})
          throw new Error(`Forked session validation failed: ${forkValidation.fatal.join("; ")}`)
        }

        let kv: any = {}
        try {
          kv = JSON.parse(await fs.readFile(KV_PATH, "utf-8"))
        } catch (e) {}
        kv.ui_trigger = "session.list.refresh"
        await fs.writeFile(KV_PATH, JSON.stringify(kv, null, 2))

        const warnings = [...sourceValidation.warnings, ...forkValidation.warnings]
        const warningText = warnings.length > 0 ? `\nWarnings: ${warnings.join(" | ")}` : ""
        return {
          content: [{ type: "text", text: `Forked session ${sessionID} to new session ${newID}${warningText}` }],
        }
      }
    }

    if (name === "app_control") {
      const { operation } = args as { operation: string }
      let kv: any = {}
      try {
        kv = JSON.parse(await fs.readFile(KV_PATH, "utf-8"))
      } catch (e) {}

      switch (operation) {
        case "exit":
          // TUI doesn't have an exit listener yet, but we could add one.
          // For now, let's just use a signal if possible.
          return {
            content: [{ type: "text", text: "Exit requested. Please close the terminal manually or press Ctrl+C." }],
          }
        case "help":
          kv.ui_trigger = "help.show"
          break
        case "models":
          kv.ui_trigger = "model.list"
          break
        case "connect":
          kv.ui_trigger = "provider.list"
          break
        case "admin":
          kv.ui_trigger = "admin.panel"
          break
      }

      await fs.writeFile(KV_PATH, JSON.stringify(kv, null, 2))
      return { content: [{ type: "text", text: `Triggered ${operation} UI...` }] }
    }

    if (name === "export_transcript") {
      const { sessionID, savePath } = args as { sessionID: string; savePath?: string }
      const sessionInfoPath = `${STORAGE_BASE}/session/${sessionID}/info.json`

      const session = JSON.parse(await fs.readFile(sessionInfoPath, "utf-8"))
      const messages = await readNestedSessionMessages(sessionID)

      let md = `# Session: ${session.title || sessionID}\n\n`
      for (const m of messages) {
        md += `## ${m.info.role === "user" ? "User" : "Assistant"}\n\n`
        for (const p of m.parts) {
          if (p.type === "text") md += `${p.text}\n\n`
          if (p.type === "tool") {
            md += `> **Tool: ${p.tool}**\n`
            md += `> \`\`\`json\n> ${JSON.stringify(p.state.input, null, 2).replace(/\n/g, "\n> ")}\n> \`\`\`\n\n`
          }
        }
      }

      const finalPath = savePath ?? `/tmp/opencode_export_${sessionID}.md`
      await fs.writeFile(finalPath, md)
      if (!savePath) {
        await execAsync(`xdg-open ${JSON.stringify(finalPath)}`)
        return { content: [{ type: "text", text: `Transcript exported and opened: ${finalPath}` }] }
      } else {
        return { content: [{ type: "text", text: `Transcript saved to: ${finalPath}` }] }
      }
    }

    if (name === "set_log_level") {
      const LEVEL_NAMES: Record<number, string> = { 0: "off", 1: "quiet", 2: "normal", 3: "verbose" }
      const action = (args as any)?.action ?? "get"
      const apiBase = await getServerApiBaseUrl()
      const headers = await getServerRequestHeaders("GET")

      if (action === "get") {
        try {
          headers.set("Accept", "application/json")
          const res = await serverFetch(`${apiBase}/global/log-level`, { headers })
          if (res.ok) {
            const data = (await res.json()) as { level: number; name: string }
            return {
              content: [{
                type: "text",
                text: `Current log level: ${data.level} (${data.name})\n\nAvailable levels:\n  0 = off (all subscribers silent)\n  1 = quiet (debug.log writes, no toast)\n  2 = normal (debug.log + toast + card)\n  3 = verbose (reserved for future expansion)`,
              }],
            }
          }
          return { content: [{ type: "text", text: `Error: server returned ${res.status}` }], isError: true }
        } catch (e: any) {
          return { content: [{ type: "text", text: `Error: cannot reach server — ${e.message}` }], isError: true }
        }
      }

      // action === "set"
      const level = Number((args as any)?.level)
      if (isNaN(level) || level < 0 || level > 3) {
        return { content: [{ type: "text", text: "Error: level must be 0, 1, 2, or 3" }], isError: true }
      }
      try {
        headers.set("Content-Type", "application/json")
        const res = await serverFetch(`${apiBase}/global/log-level`, {
          method: "POST",
          headers,
          body: JSON.stringify({ level }),
        })
        if (res.ok) {
          const data = (await res.json()) as { level: number; name: string }
          return {
            content: [{
              type: "text",
              text: `Log level set to ${data.level} (${data.name}). Effective immediately.\n\nLevels:\n  0 = off\n  1 = quiet\n  2 = normal\n  3 = verbose`,
            }],
          }
        }
        return { content: [{ type: "text", text: `Error: server returned ${res.status}` }], isError: true }
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: cannot reach server — ${e.message}` }], isError: true }
      }
    }

    // ── MCP App Store handlers (Layer 3) ─────────────────────────────

    if (name === "install_mcp_app") {
      const { source, id: providedId } = args as { source: string; id?: string }

      const isGithub = source.startsWith("https://github.com/") || source.startsWith("git@")
      const inferredId = providedId ?? (isGithub ? source.split("/").pop()?.replace(/\.git$/, "") : source.split("/").pop()) ?? "unknown"

      try {
        const baseUrl = await getServerApiBaseUrl()
        const res = await serverFetch(`${baseUrl}/mcp/store/apps`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isGithub
              ? { githubUrl: source, id: inferredId }
              : { path: source, id: inferredId }
          ),
        })

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
          return { content: [{ type: "text", text: `Installation failed: ${err.error ?? res.statusText}` }], isError: true }
        }

        const result = await res.json() as { id: string; manifest: { name: string; description?: string; command: string[] }; status: string }
        const lines = [
          `MCP App installed successfully:`,
          `  ID: ${result.id}`,
          `  Name: ${result.manifest.name}`,
          result.manifest.description ? `  Description: ${result.manifest.description}` : null,
          `  Command: ${result.manifest.command.join(" ")}`,
          `  Status: ${result.status}`,
        ].filter(Boolean)
        return { content: [{ type: "text", text: lines.join("\n") }] }
      } catch (e: any) {
        return { content: [{ type: "text", text: `Install error: ${e.message}` }], isError: true }
      }
    }

    if (name === "list_mcp_apps") {
      try {
        const baseUrl = await getServerApiBaseUrl()
        const res = await serverFetch(`${baseUrl}/mcp/store/apps`)
        if (!res.ok) {
          return { content: [{ type: "text", text: `Failed to list apps: HTTP ${res.status}` }], isError: true }
        }
        const apps = await res.json() as Array<{
          id: string
          entry: { path: string; enabled: boolean; source: { type: string } }
          manifest: { name: string; description?: string; icon?: string } | null
          tier: string
        }>

        if (apps.length === 0) {
          return { content: [{ type: "text", text: "No MCP Apps installed." }] }
        }

        const lines = apps.map((app) => {
          const status = app.entry.enabled ? "enabled" : "disabled"
          const name = app.manifest?.name ?? app.id
          const icon = app.manifest?.icon ?? "📦"
          return `${icon} ${name} (${app.id}) — ${status} [${app.tier}] ${app.entry.path}`
        })
        return { content: [{ type: "text", text: `Installed MCP Apps:\n${lines.join("\n")}` }] }
      } catch (e: any) {
        return { content: [{ type: "text", text: `List error: ${e.message}` }], isError: true }
      }
    }

    if (name === "remove_mcp_app") {
      const { id } = args as { id: string }
      try {
        const baseUrl = await getServerApiBaseUrl()
        const res = await serverFetch(`${baseUrl}/mcp/store/apps/${encodeURIComponent(id)}`, {
          method: "DELETE",
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
          return { content: [{ type: "text", text: `Remove failed: ${err.error ?? res.statusText}` }], isError: true }
        }
        return { content: [{ type: "text", text: `MCP App '${id}' removed successfully.` }] }
      } catch (e: any) {
        return { content: [{ type: "text", text: `Remove error: ${e.message}` }], isError: true }
      }
    }

    if (name === "restart_self") {
      // Thin shim over POST /api/v2/global/web/restart.  The daemon endpoint
      // handles the actual rebuild+restart orchestration via webctl.sh.
      // This tool exists so AI has a sanctioned path (vs. running webctl.sh
      // directly, which execute_command will deny).
      const { targets, reason } = args as {
        targets?: Array<"daemon" | "frontend" | "gateway">
        reason?: string
      }
      const baseUrl = await getServerApiBaseUrl()
      const body: Record<string, unknown> = {}
      if (targets && targets.length > 0) body.targets = targets
      if (reason) body.reason = reason
      const res = await serverFetch(`${baseUrl}/global/web/restart`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        const msg =
          typeof payload.message === "string"
            ? payload.message
            : typeof payload.code === "string"
              ? payload.code
              : `HTTP ${res.status}`
        const logPath = typeof payload.errorLogPath === "string" ? `\nError log: ${payload.errorLogPath}` : ""
        const hint = typeof payload.hint === "string" ? `\nHint: ${payload.hint}` : ""
        return {
          content: [
            {
              type: "text",
              text: `restart_self failed (${res.status}): ${msg}${hint}${logPath}`,
            },
          ],
          isError: true,
        }
      }
      const mode = typeof payload.runtimeMode === "string" ? payload.runtimeMode : "unknown"
      const txid = typeof payload.txid === "string" ? payload.txid : "(no txid)"
      return {
        content: [
          {
            type: "text",
            text: `restart_self scheduled (mode=${mode}, txid=${txid}). The daemon will self-terminate after webctl finishes; the gateway will respawn a fresh daemon on the next request. Expect a brief window of 503/reconnect.`,
          },
        ],
      }
    }

    throw new Error(`Tool ${name} not implemented`)
  } catch (error: any) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
