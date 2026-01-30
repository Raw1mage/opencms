import type { Argv } from "yargs"
import { Instance } from "../../project/instance"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { EOL } from "os"
import { Account } from "../../account"

// Define specific models for Antigravity as requested
const ANTIGRAVITY_MODELS = [
  "gemini-3-pro-high",
  "gemini-3-pro-low",
  "gemini-3-flash",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-thinking",
  "claude-opus-4-5-thinking",
  "gpt-oss-120b-medium"
];

// Define specific models for Gemini CLI
const GEMINI_CLI_MODELS = [
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-2.0-flash-exp",
  "gemini-2.0-pro-exp",
  "gemini-2.0-flash-thinking-exp"
];

export const ModelsCommand = cmd({
  command: "models [provider]",
  describe: "list all available models with health status",
  builder: (yargs: Argv) => {
    return yargs
      .positional("provider", {
        describe: "provider ID to filter models by",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "use more verbose model output (includes metadata like costs)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the models cache from models.dev",
        type: "boolean",
      })
  },
  handler: async (args) => {
    if (args.refresh) {
      await ModelsDev.refresh()
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

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
          if (args.provider && args.provider !== familyName) continue;

          const familyData = families[familyName];
          const accountsArr = Object.entries(familyData.accounts);

          if (accountsArr.length === 0) continue;

          console.log(UI.Style.TEXT_HIGHLIGHT_BOLD + `📂 ${familyName.toUpperCase()}` + UI.Style.TEXT_NORMAL);

          for (const [id, info] of accountsArr) {
            const isActive = familyData.activeAccount === id;
            const activeMark = isActive ? UI.Style.TEXT_SUCCESS + "●" + UI.Style.TEXT_NORMAL : "○";
            const displayName = Account.getDisplayName(id, info, familyName);

            console.log(`  ${activeMark} 👤 ${displayName}`);

            // Determine available models for this account/provider
            let modelsToShow: string[] = [];

            if (familyName === "antigravity") {
              modelsToShow = ANTIGRAVITY_MODELS;
            } else if (familyName === "gemini-cli") {
              modelsToShow = GEMINI_CLI_MODELS;
            } else {
              // Fallback: list generic models for this provider if available in Provider list
              const p = providers[familyName];
              if (p) {
                modelsToShow = Object.keys(p.models).slice(0, 6); // Limit to top 6 to keep it clean
              } else {
                modelsToShow = ["standard-model"];
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

              // Specialized status check for Antigravity accounts (or mixed ones)
              if (matchedAcc) {
                if (familyName === "antigravity") {
                  status = getAntigravityStatus(matchedAcc, model);
                } else if (familyName === "gemini-cli") {
                  // Check gemini-cli quota key
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
            console.log(""); // Empty line between accounts
          }
          console.log(""); // Empty line between providers
        }

        console.log(UI.Style.TEXT_DIM + `Last updated: ${new Date().toLocaleTimeString()}` + UI.Style.TEXT_NORMAL);
        console.log(UI.Style.TEXT_DIM + `Note: Status reflects local client state.` + UI.Style.TEXT_NORMAL);
      },
    })
  },
})
