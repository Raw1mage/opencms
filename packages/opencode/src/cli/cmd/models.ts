import type { Argv } from "yargs"
import { Instance } from "../../project/instance"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { EOL } from "os"
import { Account } from "../../account"
import { modelRegistry } from "../../plugin/antigravity/plugin/model-registry"

// Define specific models for Antigravity as fallback
const ANTIGRAVITY_MODELS = [
  "claude-opus-4-5-thinking",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-thinking",
  "gpt-oss-120b-medium",
  "gemini-3-flash",
  "gemini-3-pro-high",
  "gemini-3-pro-low"
];

// Define specific models for Gemini CLI as fallback
const GEMINI_CLI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3-pro-preview"
];

// Define specific models for OpenAI as fallback
const OPENAI_MODELS = [
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex"
];

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
        describe: "refresh the models cache from models.dev",
        type: "boolean",
      })
      .example("opencode models", "Show status dashboard")
      .example("opencode models antigravity", "Show status only for Antigravity")
      .example("opencode models add openai gpt-6-preview", "Add a new model to list")
  },
  handler: async (args) => {
    // Determine mode
    let mode: "list" | "add" | "remove" | "reset" = "list";
    let filterProvider: string | undefined = undefined;
    let targetProvider = args.provider;
    let targetModel = args.model;

    const action = args.action?.toLowerCase();

    if (action === "add" || action === "remove" || action === "reset") {
      mode = action;
    } else if (action) {
      // Treat as provider filter
      filterProvider = action;
    }

    if (args.refresh) {
      await ModelsDev.refresh()
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

    // Load registry
    await modelRegistry.load();

    // Handle modification actions
    if (mode !== "list") {
      if (!targetProvider && mode !== 'reset') {
        // targetProvider comes from 2nd arg.
      }

      if (!targetProvider) {
        UI.error(`Provider required for ${mode}. Usage: opencode models ${mode} <provider> [model]`);
        return;
      }

      if (mode === "add" && targetModel) {
        modelRegistry.add(targetProvider, targetModel);
        await modelRegistry.save();
        UI.println(UI.Style.TEXT_SUCCESS + `Added ${targetModel} to ${targetProvider}` + UI.Style.TEXT_NORMAL);
        return;
      }

      if (mode === "remove" && targetModel) {
        modelRegistry.remove(targetProvider, targetModel);
        await modelRegistry.save();
        UI.println(UI.Style.TEXT_SUCCESS + `Removed ${targetModel} from ${targetProvider}` + UI.Style.TEXT_NORMAL);
        return;
      }

      if (mode === "reset") {
        modelRegistry.reset(targetProvider);
        await modelRegistry.save();
        UI.println(UI.Style.TEXT_SUCCESS + `Reset ${targetProvider} to defaults` + UI.Style.TEXT_NORMAL);
        return;
      }

      UI.error("Missing arguments.");
      return;
    }

    // List Mode (Dashboard)
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const { globalAccountManager } = await import("../../plugin/antigravity/index");
        const families = await Account.listAll();
        const providers = await Provider.list();
        const now = Date.now();

        // Helper for time formatting
        const getWaitTime = (ts: number | undefined) => {
          if (!ts || ts <= now) return null;
          const waitSec = Math.ceil((ts - now) / 1000);
          if (waitSec > 3600) return `${(waitSec / 3600).toFixed(1)}h`;
          if (waitSec > 60) return `${(waitSec / 60).toFixed(1)}m`;
          return `${waitSec}s`;
        };

        const getAntigravityStatus = (acc: any, model: string) => {
          if (!acc || !acc.rateLimitResetTimes) return "✅ Ready";

          // Determine key to check
          let wait = null;

          // Check specific model key first (if any)
          if (acc.rateLimitResetTimes[model]) {
            wait = getWaitTime(acc.rateLimitResetTimes[model]);
          }

          // Fallback to family keys
          if (!wait) {
            if (model.includes("claude")) {
              wait = getWaitTime(acc.rateLimitResetTimes["claude"]);
            } else if (model.includes("gemini")) {
              wait = getWaitTime(acc.rateLimitResetTimes["gemini-antigravity"]);
            }
          }

          // Check global cooldown
          if (!wait && acc.coolingDownUntil && acc.coolingDownUntil > now) {
            wait = getWaitTime(acc.coolingDownUntil);
          }

          if (wait) {
            return `⏳ Limit (${wait})`;
          }
          return "✅ Ready";
        };

        // Order providers
        const order = ["antigravity", "gemini-cli", "anthropic", "openai", "opencode", "google API-KEY"];
        const sortedFamilies = Object.keys(families).sort((a, b) => {
          const idxA = order.indexOf(a);
          const idxB = order.indexOf(b);
          if (idxA === -1 && idxB === -1) return a.localeCompare(b);
          if (idxA === -1) return 1;
          if (idxB === -1) return -1;
          return idxA - idxB;
        });

        console.log(UI.Style.TEXT_NORMAL_BOLD + "\n📦 Model Health & Availability Status\n" + UI.Style.TEXT_NORMAL);

        const agSnapshot = globalAccountManager ? globalAccountManager.getAccountsSnapshot() : [];

        for (const familyName of sortedFamilies) {
          if (filterProvider && filterProvider !== familyName) continue;

          const familyData = families[familyName];
          const accountsArr = Object.entries(familyData.accounts);

          if (accountsArr.length === 0) continue;

          console.log(UI.Style.TEXT_HIGHLIGHT_BOLD + `📂 ${familyName.toUpperCase()}` + UI.Style.TEXT_NORMAL);

          for (const [id, info] of accountsArr) {
            const isActive = familyData.activeAccount === id;
            const activeMark = isActive ? UI.Style.TEXT_SUCCESS + "●" + UI.Style.TEXT_NORMAL : "○";
            const displayName = Account.getDisplayName(id, info, familyName);

            console.log(`  ${activeMark} 👤 ${displayName}`);

            // Determine available models using Registry
            let modelsToShow: string[] = [];

            // Try to get from registry first for ALL providers
            const customList = modelRegistry.get(familyName);

            if (customList.length > 0) {
              modelsToShow = [...customList];
            } else {
              // Fallback if not in registry
              if (familyName === "antigravity") {
                modelsToShow = ANTIGRAVITY_MODELS;
              } else if (familyName === "gemini-cli") {
                modelsToShow = GEMINI_CLI_MODELS;
              } else if (familyName === "openai") {
                modelsToShow = OPENAI_MODELS;
              } else {
                const p = providers[familyName];
                if (p) {
                  modelsToShow = Object.keys(p.models).slice(0, 6);
                } else {
                  modelsToShow = ["standard-model"];
                }
              }
            }

            // Find Antigravity account object for status checking
            let matchedAcc: any = undefined;
            if (familyName === "antigravity" && agSnapshot.length > 0) {
              matchedAcc = agSnapshot.find((a: any) => String(a.index) === id);
            } else if (agSnapshot.length > 0 && "email" in info && info.email) {
              matchedAcc = agSnapshot.find((a: any) => a.email === (info as any).email);
            }

            // Sort models
            modelsToShow.sort();

            for (const model of modelsToShow) {
              let status = "✅ Ready";

              if (matchedAcc) {
                if (familyName === "antigravity") {
                  status = getAntigravityStatus(matchedAcc, model);
                } else if (familyName === "gemini-cli") {
                  let wait = null;
                  if (matchedAcc.rateLimitResetTimes) {
                    wait = getWaitTime(matchedAcc.rateLimitResetTimes["gemini-cli"]);
                  }
                  if (!wait && matchedAcc.coolingDownUntil && matchedAcc.coolingDownUntil > now) {
                    wait = getWaitTime(matchedAcc.coolingDownUntil);
                  }
                  if (wait) status = `⏳ Limit (${wait})`;
                }
              }

              console.log(`      • ${model.padEnd(30)} : ${status}`);
            }
            console.log("");
          }
          console.log("");
        }

        console.log(UI.Style.TEXT_DIM + `Last updated: ${new Date().toLocaleTimeString()}` + UI.Style.TEXT_NORMAL);
        console.log(UI.Style.TEXT_DIM + `Hint: Use 'opencode models add/remove <provider> <model>' to customize this list.` + UI.Style.TEXT_NORMAL);
      },
    })
  },
})
