import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Installation } from "../installation"
import { Identifier } from "../id/id"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { MCP } from "../mcp"
import { Account } from "../account"
import { renderModelCheckReport } from "../cli/cmd/model-check-report"

import { Bus } from "@/bus"
import { TuiEvent } from "../cli/cmd/tui/event"

export namespace Command {
  export const Event = {
    Executed: BusEvent.define(
      "command.executed",
      z.object({
        name: z.string(),
        sessionID: Identifier.schema("session"),
        arguments: z.string(),
        messageID: Identifier.schema("message"),
      }),
    ),
  }

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      mcp: z.boolean().optional(),
      // workaround for zod not supporting async functions natively so we use getters
      // https://zod.dev/v4/changelog?id=zfunction
      template: z.promise(z.string()).or(z.string()),
      subtask: z.boolean().optional(),
      hints: z.array(z.string()),
      handler: z.function().optional(),
    })
    .meta({
      ref: "Command",
    })

  // for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
  export type Info = Omit<z.infer<typeof Info>, "template" | "handler"> & {
    template: Promise<string> | string
    handler?: () => Promise<{ output: string; title?: string }>
  }

  export function hints(template: string): string[] {
    const result: string[] = []
    const numbered = template.match(/\$\d+/g)
    if (numbered) {
      for (const match of [...new Set(numbered)].sort()) result.push(match)
    }
    if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
    return result
  }


  export const Default = {
    INIT: "init",
    REVIEW: "review",
    MODEL_CHECK: "model-check",
    ACCOUNTS: "accounts",
  } as const

  const state = Instance.state(async () => {
    const cfg = await Config.get()

    const result: Record<string, Info> = {
      [Default.INIT]: {
        name: Default.INIT,
        description: "create/update AGENTS.md",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", Instance.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      },
      [Default.REVIEW]: {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        get template() {
          return PROMPT_REVIEW.replace("${path}", Instance.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      },
      [Default.MODEL_CHECK]: {
        name: Default.MODEL_CHECK,
        description: "perceive available models and account status",
        get template() {
          return `Perceiving available models and account status...`
        },
        subtask: false,
        hints: [],
        async handler() {
          // Direct execution of model-check in perception mode
          const { ProviderHealth } = await import("../provider/health")

          // Suppress console errors during health check
          const originalConsoleError = console.error
          let report: any
          try {
            console.error = () => { }
            report = await ProviderHealth.checkAll({ timeout: 10000, parallel: true, mode: "perception" })
          } finally {
            console.error = originalConsoleError
          }

          return {
            output: renderModelCheckReport(report),
            title: "Model Health Report",
          }
        },
      },
      [Default.ACCOUNTS]: {
        name: Default.ACCOUNTS,
        description: "manage accounts",
        get template() {
          return `Opening account manager...`
        },
        subtask: false,
        hints: [],
        async handler() {
          const families = await Account.listAll();
          const lines: string[] = ["# Account Status", ""];

          const order = ["opencode", "anthropic", "openai", "antigravity", "gemini-cli", "google API-KEY", "copilot", "others"];
          const sortedFamilies = Object.keys(families).sort((a, b) => {
            const idxA = order.indexOf(a);
            const idxB = order.indexOf(b);
            if (idxA === -1 && idxB === -1) return a.localeCompare(b);
            if (idxA === -1) return 1;
            if (idxB === -1) return -1;
            return idxA - idxB;
          });

          for (const familyName of sortedFamilies) {
            const familyData = families[familyName];
            const accountsArr = Object.entries(familyData.accounts);
            if (accountsArr.length === 0) continue;

            lines.push(`### 📂 ${familyName.toUpperCase()}`);
            for (const [id, info] of accountsArr) {
              const isActive = familyData.activeAccount === id;
              const status = isActive ? "✅ **active**" : "   ";
              const displayName = Account.getDisplayName(id, info, familyName);
              lines.push(`- ${status} \`${displayName}\`  *(id: ${id})*`);
            }
            lines.push("");
          }

          await Bus.publish(TuiEvent.CommandExecute, { command: "account.manage" })
          return {
            output: lines.join("\n"),
            title: "Account Status"
          }
        },
      },
    }

    for (const [name, command] of Object.entries(cfg.command ?? {})) {
      if (result[name] && result[name].handler) continue
      result[name] = {
        name,
        agent: command.agent,
        model: command.model,
        description: command.description,
        get template() {
          return command.template
        },
        subtask: command.subtask,
        hints: hints(command.template),
      }
    }
    for (const [name, prompt] of Object.entries(await MCP.prompts())) {
      if (result[name] && result[name].handler) continue
      result[name] = {
        name,
        mcp: true,
        description: prompt.description,
        get template() {
          // since a getter can't be async we need to manually return a promise here
          return new Promise<string>(async (resolve, reject) => {
            const template = await MCP.getPrompt(
              prompt.client,
              prompt.name,
              prompt.arguments
                ? // substitute each argument with $1, $2, etc.
                Object.fromEntries(prompt.arguments?.map((argument, i) => [argument.name, `$${i + 1}`]))
                : {},
            ).catch(reject)
            resolve(
              template?.messages
                .map((message) => (message.content.type === "text" ? message.content.text : ""))
                .join("\n") || "",
            )
          })
        },
        hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
      }
    }

    return result
  })

  export async function get(name: string) {
    return state().then((x) => x[name])
  }

  export async function list() {
    return state().then((x) => Object.values(x))
  }
}
