import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { MCP } from "../mcp"
import { ModelsDev } from "../provider/models"
import { Provider } from "../provider/provider"
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

  // Note: `handler` is intentionally excluded from the Zod schema because
  // z.function() cannot be represented in JSON Schema (used for OpenAPI generation).
  // The handler field is defined only in the TypeScript type below.
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
      source: z.string().optional(),
    })
    .meta({
      ref: "Command",
    })

  /** Runtime context passed to command handlers. Most existing handlers ignore
   *  these fields (the param is optional for backward compat), but session-scoped
   *  commands like `/reload` (session-rebind-capability-refresh) rely on
   *  `ctx.sessionID` to bump the correct session's rebind epoch. */
  export type HandlerContext = {
    sessionID: string
  }

  // for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
  export type Info = Omit<z.infer<typeof Info>, "template" | "handler"> & {
    template: Promise<string> | string
    handler?: (ctx?: HandlerContext) => Promise<{ output: string; title?: string }>
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
    UPDATE_MODELS: "update_models",
    PLAN: "plan",
    RELOAD: "reload",
  } as const

  /** Exported for unit tests. Executes the /reload command's bump + reinject. */
  export async function reloadHandler(
    ctx?: HandlerContext,
  ): Promise<{ output: string; title?: string }> {
    const { RebindEpoch } = await import("../session/rebind-epoch")
    const { CapabilityLayer } = await import("../session/capability-layer")
    if (!ctx?.sessionID) {
      return { output: "no active session to reload", title: "Reload — No Session" }
    }
    const outcome = await RebindEpoch.bumpEpoch({
      sessionID: ctx.sessionID,
      trigger: "slash_reload",
      reason: "user invoked /reload",
    })
    if (outcome.status === "rate_limited") {
      return {
        output: `Reload rate limit hit (${outcome.rateLimitReason ?? "rate limit"}) — try again shortly`,
        title: "Reload — Rate Limited",
      }
    }
    const reinject = await CapabilityLayer.reinject(ctx.sessionID, outcome.currentEpoch)
    if (reinject.failures.length > 0) {
      const details = reinject.failures.map((f) => `${f.layer}:${f.error}`).join(", ")
      return {
        output: `Capability layer partial refresh (${outcome.previousEpoch} → ${outcome.currentEpoch}). Failures: ${details}`,
        title: "Reload — Partial",
      }
    }
    const pinned = reinject.pinnedSkills.length > 0 ? reinject.pinnedSkills.join(", ") : "(none)"
    const missing =
      reinject.missingSkills.length > 0
        ? `; missing: ${reinject.missingSkills.join(", ")}`
        : ""
    return {
      output: `Capability layer refreshed (${outcome.previousEpoch} → ${outcome.currentEpoch}). Pinned: ${pinned}${missing}`,
      title: "Reload",
    }
  }

  async function createState() {
    const cfg = await Config.get()

    const result: Record<string, Info> = {
      [Default.INIT]: {
        name: Default.INIT,
        description: "create/update AGENTS.md",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", Instance.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      },
      [Default.REVIEW]: {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", Instance.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      },
      [Default.UPDATE_MODELS]: {
        name: Default.UPDATE_MODELS,
        description: "fetch latest model definitions from models.dev",
        source: "command",
        template: "",
        hints: [],
        handler: async () => {
          await ModelsDev.refresh()
          Provider.reset()
          await Bus.publish(TuiEvent.ProviderRefresh, {})
          const data = await ModelsDev.get()
          const providerCount = Object.keys(data).length
          const modelCount = Object.values(data).reduce((acc, p) => acc + Object.keys(p.models).length, 0)
          return {
            output: `✓ Models updated — ${providerCount} providers / ${modelCount} models`,
            title: "Models Updated",
          }
        },
      },
      [Default.PLAN]: {
        name: Default.PLAN,
        description: "enter planner-first discussion mode",
        source: "command",
        template:
          "The user requested plan mode. Load planner + miatdiagram skills, then use `bun run scripts/plan-init.ts` to set up the spec directory.",
        hints: [],
      },
      [Default.RELOAD]: {
        name: Default.RELOAD,
        description: "refresh capability layer (AGENTS.md + driver + skills + enablement) for this session",
        source: "command",
        template: "",
        hints: [],
        handler: reloadHandler,
      },
    }

    for (const [name, command] of Object.entries(cfg.command ?? {})) {
      if (result[name] && result[name].handler) continue
      result[name] = {
        name,
        agent: command.agent,
        model: command.model,
        description: command.description,
        source: "command",
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
  }

  let stateGetter: (() => Promise<Awaited<ReturnType<typeof createState>>>) | undefined
  let fallbackState: Promise<Awaited<ReturnType<typeof createState>>> | undefined

  function state() {
    if (typeof Instance.state === "function") {
      stateGetter ||= Instance.state(createState)
      return stateGetter()
    }

    fallbackState ||= createState()
    return fallbackState
  }

  export async function get(name: string) {
    return state().then((x) => x[name])
  }

  export async function list() {
    return state().then((x) => Object.values(x))
  }
}
