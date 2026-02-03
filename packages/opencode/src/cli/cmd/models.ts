import type { Argv } from "yargs"
import { Instance } from "../../project/instance"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { EOL } from "os"
import { Account } from "../../account"
import { modelRegistry } from "../../plugin/antigravity/plugin/model-registry"
import { AccountManager } from "../../plugin/antigravity/plugin/accounts" // Import explicitly

// Define specific models for Antigravity as fallback
const ANTIGRAVITY_MODELS = [
  "claude-opus-4-5-thinking",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-thinking",
  "gpt-oss-120b-medium",
  "gemini-3-flash",
  "gemini-3-pro-high",
  "gemini-3-pro-low",
]

// Define specific models for Gemini CLI as fallback
const GEMINI_CLI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
]

// Define specific models for OpenAI as fallback
const OPENAI_MODELS = ["gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex"]

// Internal ID to Display Name
const DISPLAY_ALIASES: Record<string, string> = {
  "google API-KEY": "google-api",
}

// Input Name to Internal ID
const INPUT_ALIASES: Record<string, string> = {
  "google-api": "google API-KEY",
}

export const ModelsCommand = cmd({
  command: "models [action] [provider] [model]",
  describe: "Manage and monitor models. Actions: list (default), add, remove, reset.",
  builder: (yargs: Argv) => {
    return yargs
      .positional("action", {
        describe: "Action to perform (add, remove, reset) or Provider ID to filter by",
        type: "string",
      })
      .positional("provider", {
        describe: "Provider ID (for add/remove actions)",
        type: "string",
      })
      .positional("model", {
        describe: "Model ID (for add/remove actions)",
        type: "string",
      })
      .option("verbose", {
        describe: "use more verbose model output",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the models cache from models.dev AND Google API",
        type: "boolean",
      })
      .example("opencode models", "Show status dashboard")
      .example("opencode models antigravity", "Show status only for Antigravity")
      .example("opencode models add google-api gemini-1.5-pro", "Add model using simplified alias")
  },
  handler: async (args) => {
    // Determine mode
    let mode: "list" | "add" | "remove" | "reset" = "list"
    let filterProvider: string | undefined = undefined

    // Resolve aliases for inputs
    let targetProvider = args.provider
    if (targetProvider && INPUT_ALIASES[targetProvider]) {
      targetProvider = INPUT_ALIASES[targetProvider]
    }

    let targetModel = args.model

    const action = args.action?.toLowerCase()

    if (action === "add" || action === "remove" || action === "reset") {
      mode = action
    } else if (action) {
      // Treat as provider filter (also check alias)
      filterProvider = INPUT_ALIASES[action] || action
    }

    if (args.refresh) {
      await ModelsDev.refresh()
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

    // Load registry
    await modelRegistry.load()

    if (args.refresh) {
      UI.println("Refreshing model lists...")

      // 1. Refresh generic cache
      await ModelsDev.refresh()
      UI.println("  • Models.dev cache refreshed")

      // 2. Discover Google API models
      try {
        const families = await Account.listAll()
        // Look for google API-KEY accounts
        const googleFamily = families["google API-KEY"]
        if (googleFamily && googleFamily.accounts) {
          const accounts = Object.values(googleFamily.accounts)
          // Find first account with apiKey
          const acc = accounts.find((a: any) => a.apiKey)
          if (acc && (acc as any).apiKey) {
            const apiKey = (acc as any).apiKey
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`)
            if (response.ok) {
              const data = await response.json()
              if (data.models && Array.isArray(data.models)) {
                let count = 0
                for (const m of data.models) {
                  let name = m.name
                  if (name.startsWith("models/")) name = name.substring(7)
                  if (name.includes("gemini") || name.includes("palm")) {
                    modelRegistry.add("google API-KEY", name)
                    count++
                  }
                }
                await modelRegistry.save()
                UI.println(`  • Discovered ${count} Google models via API`)
              }
            } else {
              UI.println(`  • Failed to list Google models: ${response.status}`)
            }
          }
        }
      } catch (e) {
        UI.println(`  • Error refreshing Google models: ${e}`)
      }

      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Refresh complete." + UI.Style.TEXT_NORMAL)
    }

    // Handle modification actions
    if (mode !== "list") {
      if (!targetProvider) {
        UI.error(`Provider required for ${mode}. Usage: opencode models ${mode} <provider> [model]`)
        return
      }

      const displayProvider = DISPLAY_ALIASES[targetProvider] || targetProvider

      if (mode === "add" && targetModel) {
        modelRegistry.add(targetProvider, targetModel)
        await modelRegistry.save()
        UI.println(UI.Style.TEXT_SUCCESS + `Added ${targetModel} to ${displayProvider}` + UI.Style.TEXT_NORMAL)
        return
      }

      if (mode === "remove" && targetModel) {
        modelRegistry.remove(targetProvider, targetModel)
        await modelRegistry.save()
        UI.println(UI.Style.TEXT_SUCCESS + `Removed ${targetModel} from ${displayProvider}` + UI.Style.TEXT_NORMAL)
        return
      }

      if (mode === "reset") {
        modelRegistry.reset(targetProvider)
        await modelRegistry.save()
        UI.println(UI.Style.TEXT_SUCCESS + `Reset ${displayProvider} to defaults` + UI.Style.TEXT_NORMAL)
        return
      }

      UI.error("Missing arguments.")
      return
    }

    // List Mode (Dashboard)
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const families = await Account.listAll()
        const providers = await Provider.list()
        const now = Date.now()

        // Initialize Antigravity Account Manager explicitly to ensure data availability
        const agManager = await AccountManager.loadFromDisk()
        const agSnapshot = agManager.getAccountsSnapshot()

        // Helper for time formatting
        const getWaitTime = (ts: number | undefined) => {
          if (!ts || ts <= now) return null
          const waitSec = Math.ceil((ts - now) / 1000)
          if (waitSec > 3600) return `${(waitSec / 3600).toFixed(1)}h`
          if (waitSec > 60) return `${(waitSec / 60).toFixed(1)}m`
          return `${waitSec}s`
        }

        const getAntigravityStatus = (acc: any, model: string) => {
          if (!acc || !acc.rateLimitResetTimes) return "✅ Ready"

          // Determine key to check
          let wait = null

          // Check specific model key first (if any)
          if (acc.rateLimitResetTimes[model]) {
            wait = getWaitTime(acc.rateLimitResetTimes[model])
          }

          // Fallback to family keys
          if (!wait) {
            if (model.includes("claude")) {
              wait = getWaitTime(acc.rateLimitResetTimes["claude"])
            } else if (model.includes("gemini")) {
              wait = getWaitTime(acc.rateLimitResetTimes["gemini-antigravity"])
            }
          }

          // Check global cooldown
          if (!wait && acc.coolingDownUntil && acc.coolingDownUntil > now) {
            wait = getWaitTime(acc.coolingDownUntil)
          }

          if (wait) {
            return `⏳ Limit (${wait})`
          }
          return "✅ Ready"
        }

        // Order providers
        const order = ["antigravity", "gemini-cli", "anthropic", "openai", "opencode", "google API-KEY"]
        const sortedFamilies = Object.keys(families).sort((a, b) => {
          // Map a to sort key if needed, mostly 'google API-KEY' is in sort list
          const idxA = order.indexOf(a)
          const idxB = order.indexOf(b)
          if (idxA === -1 && idxB === -1) return a.localeCompare(b)
          if (idxA === -1) return 1
          if (idxB === -1) return -1
          return idxA - idxB
        })

        console.log(UI.Style.TEXT_NORMAL_BOLD + "\n📦 Model Health & Availability Status\n" + UI.Style.TEXT_NORMAL)

        for (const familyName of sortedFamilies) {
          if (filterProvider && filterProvider !== familyName) continue

          const familyData = families[familyName]
          const accountsArr = Object.entries(familyData.accounts)

          if (accountsArr.length === 0) continue

          // Apply alias for display
          const displayFamilyName = DISPLAY_ALIASES[familyName] || familyName

          console.log(UI.Style.TEXT_HIGHLIGHT_BOLD + `📂 ${displayFamilyName.toUpperCase()}` + UI.Style.TEXT_NORMAL)

          for (const [id, info] of accountsArr) {
            const isActive = familyData.activeAccount === id
            const activeMark = isActive ? UI.Style.TEXT_SUCCESS + "●" + UI.Style.TEXT_NORMAL : "○"

            // 1. Find matched account FIRST to get metadata
            let matchedAcc: any = undefined
            let displayNameOverride: string | null = null

            if (familyName === "antigravity" && agSnapshot.length > 0) {
              // ID format: antigravity-subscription-{N} where N is 1-based index
              // Snapshot index is 0-based
              const match = id.match(/antigravity-subscription-(\d+)/)
              if (match) {
                const index = parseInt(match[1]) - 1
                matchedAcc = agSnapshot.find((a: any) => a.index === index)
              } else {
                // Fallback: try direct index match if ID happens to be just number
                matchedAcc = agSnapshot.find((a: any) => String(a.index) === id)
              }

              if (matchedAcc && matchedAcc.email) {
                displayNameOverride = matchedAcc.email
              }
            } else if (agSnapshot.length > 0 && "email" in info && (info as any).email) {
              matchedAcc = agSnapshot.find((a: any) => a.email === (info as any).email)
            }

            // 2. Determine Display Name
            let displayName = displayNameOverride || Account.getDisplayName(id, info, familyName)

            console.log(`  ${activeMark} 👤 ${displayName}`)

            // Determine available models using Registry
            let modelsToShow: string[] = []

            // Try to get from registry first for ALL providers
            const customList = modelRegistry.get(familyName)

            if (customList.length > 0) {
              modelsToShow = [...customList]
            } else {
              // Fallback if not in registry
              if (familyName === "antigravity") {
                modelsToShow = ANTIGRAVITY_MODELS
              } else if (familyName === "gemini-cli") {
                modelsToShow = GEMINI_CLI_MODELS
              } else if (familyName === "openai") {
                modelsToShow = OPENAI_MODELS
              } else {
                const p = providers[familyName]
                if (p) {
                  modelsToShow = Object.keys(p.models).slice(0, 6)
                } else {
                  modelsToShow = ["standard-model"]
                }
              }
            }

            // Sort models
            modelsToShow.sort()

            for (const model of modelsToShow) {
              let status = "✅ Ready"

              if (matchedAcc) {
                if (familyName === "antigravity") {
                  status = getAntigravityStatus(matchedAcc, model)
                } else if (familyName === "gemini-cli") {
                  let wait = null
                  if (matchedAcc.rateLimitResetTimes) {
                    wait = getWaitTime(matchedAcc.rateLimitResetTimes["gemini-cli"])
                  }
                  if (!wait && matchedAcc.coolingDownUntil && matchedAcc.coolingDownUntil > now) {
                    wait = getWaitTime(matchedAcc.coolingDownUntil)
                  }
                  if (wait) status = `⏳ Limit (${wait})`
                }
              }

              console.log(`      • ${model.padEnd(30)} : ${status}`)
            }
            console.log("")
          }
          console.log("")
        }

        console.log(UI.Style.TEXT_DIM + `Last updated: ${new Date().toLocaleTimeString()}` + UI.Style.TEXT_NORMAL)

        if (!args.refresh) {
          console.log(
            UI.Style.TEXT_DIM +
              `Hint: Use 'opencode models --refresh' to discover new Google models.` +
              UI.Style.TEXT_NORMAL,
          )
        }
      },
    })
  },
})
