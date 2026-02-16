import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { promises as fs } from "fs"
import { exec } from "child_process"
import { promisify } from "util"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { validateForkResult, validateForkSource } from "./system-manager-session"

const execAsync = promisify(exec)

const HOME = process.env.HOME ?? os.homedir()
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? path.join(HOME, ".config")
const XDG_STATE_HOME = process.env.XDG_STATE_HOME ?? path.join(HOME, ".local", "state")
const XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? path.join(HOME, ".local", "share")
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..")

const ACCOUNTS_PATH = path.join(XDG_CONFIG_HOME, "opencode", "accounts.json")
const ANTIGRAVITY_ACCOUNTS_PATH = path.join(XDG_CONFIG_HOME, "opencode", "antigravity-accounts.json")
const CONFIG_PATH = path.join(XDG_CONFIG_HOME, "opencode", "opencode.json")
const MODEL_STATE_PATH = path.join(XDG_STATE_HOME, "opencode", "model.json")
const KV_PATH = path.join(XDG_STATE_HOME, "opencode", "kv.json")
const ROTATION_STATE_PATH = path.join(XDG_STATE_HOME, "opencode", "rotation-state.json")
const USAGE_STATS_PATH = path.join(XDG_CONFIG_HOME, "opencode", "usage-stats.json")
const STORAGE_BASE = path.join(XDG_DATA_HOME, "opencode", "storage")
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

const THEME_DIR = path.join(REPO_ROOT, "packages", "opencode", "src", "cli", "cmd", "tui", "context", "theme")
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
    const hourlyUsed = usage?.rate_limit?.primary_window?.used_percent ?? 0
    const weeklyUsed = usage?.rate_limit?.secondary_window?.used_percent ?? 0
    return {
      "5H": `${Math.round(Math.max(0, 100 - hourlyUsed))}%`,
      WK: `${Math.round(Math.max(0, 100 - weeklyUsed))}%`,
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
        name: "switch_account",
        description: "Switch active account for a family.",
        inputSchema: {
          type: "object",
          properties: { family: { type: "string" }, accountId: { type: "string" } },
          required: ["family", "accountId"],
        },
      },
      {
        name: "switch_model",
        description: "Switch the global default model by updating recent models list.",
        inputSchema: {
          type: "object",
          properties: {
            providerId: { type: "string" },
            modelID: { type: "string" },
          },
          required: ["providerId", "modelID"],
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
        name: "manage_session",
        description: "Manage opencode sessions (rename, fork, summarize, undo, redo, create, list).",
        inputSchema: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["rename", "fork", "summarize", "undo", "redo", "create", "list"] },
            sessionID: { type: "string" },
            title: { type: "string", description: "New title for rename" },
            messageID: { type: "string", description: "Message ID to fork from" },
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

      let antigravityDetailed: any = null
      try {
        antigravityDetailed = JSON.parse(await fs.readFile(ANTIGRAVITY_ACCOUNTS_PATH, "utf-8"))
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

              // Enrich with antigravity detailed data if available
              let detailedInfo = undefined
              if (fname === "antigravity" && antigravityDetailed) {
                const match = antigravityDetailed.accounts.find((da: any) => da.refreshToken === a.refreshToken)
                if (match) {
                  detailedInfo = {
                    coolingDownUntil: match.coolingDownUntil,
                    cooldownReason: match.cooldownReason,
                    rateLimitResetTimes: match.rateLimitResetTimes,
                  }
                }
              }

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

    if (name === "switch_account") {
      const { family, accountId } = args as { family: string; accountId: string }
      const raw = await fs.readFile(ACCOUNTS_PATH, "utf-8")
      const accounts = JSON.parse(raw)
      if (!accounts.families[family]) throw new Error(`Family ${family} not found`)
      accounts.families[family].activeAccount = accountId
      await fs.writeFile(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2))
      return { content: [{ type: "text", text: `Switched ${family} to ${accountId}` }] }
    }

    if (name === "switch_model") {
      const { providerId, modelID } = args as { providerId: string; modelID: string }
      let data: any = { recent: [], favorite: [], hidden: [], hiddenProviders: [], variant: {} }
      try {
        const raw = await fs.readFile(MODEL_STATE_PATH, "utf-8")
        data = JSON.parse(raw)
      } catch (e) {}

      // Update recent: Move to front or add if new
      const index = data.recent.findIndex((m: any) => m.providerId === providerId && m.modelID === modelID)
      if (index !== -1) {
        data.recent.splice(index, 1)
      }
      data.recent.unshift({ providerId, modelID })

      // Limit recent to 10
      data.recent = data.recent.slice(0, 10)

      await fs.writeFile(MODEL_STATE_PATH, JSON.stringify(data, null, 2))
      return { content: [{ type: "text", text: `Switched global model to ${providerId}:${modelID}` }] }
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
      const cmdPath = path.join(REPO_ROOT, ".opencode", "command", `${cmdName}.md`)
      try {
        const content = await fs.readFile(cmdPath, "utf-8")
        return { content: [{ type: "text", text: content }] }
      } catch (e) {
        return { content: [{ type: "text", text: `Command ${cmdName} not found` }], isError: true }
      }
    }

    if (name === "update_models") {
      await execAsync(`bun run ${JSON.stringify(path.join(REPO_ROOT, "bin", "opencode.ts"))} models --refresh`)
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
      const { operation, sessionID, title, messageID } = args as {
        operation: string
        sessionID?: string
        title?: string
        messageID?: string
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
        let kv: any = {}
        try {
          kv = JSON.parse(await fs.readFile(KV_PATH, "utf-8"))
        } catch (e) {}
        kv.ui_trigger = "session.new"
        await fs.writeFile(KV_PATH, JSON.stringify(kv, null, 2))
        return { content: [{ type: "text", text: "Creating new session..." }] }
      }

      if (!sessionID) throw new Error("sessionID is required for this operation")
      const sessionInfoPath = `${STORAGE_BASE}/session/${sessionID}/info.json`

      if (operation === "rename") {
        if (!title) throw new Error("Title is required for rename")
        const session = JSON.parse(await fs.readFile(sessionInfoPath, "utf-8"))
        session.title = title
        await fs.writeFile(sessionInfoPath, JSON.stringify(session, null, 2))
        return { content: [{ type: "text", text: `Renamed session ${sessionID} to "${title}"` }] }
      }

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
      const messageDir = `${STORAGE_BASE}/message/${sessionID}`

      const session = JSON.parse(await fs.readFile(sessionInfoPath, "utf-8"))
      const messageFiles = await fs.readdir(messageDir)
      const messages = await Promise.all(
        messageFiles.sort().map(async (file: string) => {
          const msg = JSON.parse(await fs.readFile(`${messageDir}/${file}`, "utf-8"))
          const partDir = `${STORAGE_BASE}/part/${msg.id}`
          let parts = []
          try {
            const partFiles = await fs.readdir(partDir)
            parts = await Promise.all(
              partFiles
                .sort()
                .map(async (pfile: string) => JSON.parse(await fs.readFile(`${partDir}/${pfile}`, "utf-8"))),
            )
          } catch (e) {}
          return { ...msg, parts }
        }),
      )

      let md = `# Session: ${session.title || sessionID}\n\n`
      for (const m of messages) {
        md += `## ${m.role === "user" ? "User" : "Assistant"}\n\n`
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

    throw new Error(`Tool ${name} not implemented`)
  } catch (error: any) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
