import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { Provider } from "../../provider/provider"
import { Account } from "../../account"
import { UI } from "../ui"
import { Session } from "../../session"
import { SessionPrompt } from "../../session/prompt"
import { Global } from "../../global"
import { MessageV2 } from "../../session/message-v2"

type SmokeResult = {
  providerID: string
  modelID: string
  name?: string
  ok: boolean
  error?: string
  sessionID?: string
  time: number
}

export const ModelSmokeCommand = cmd({
  command: "model-smoke",
  describe: "simulate /models then send a prompt per model",
  builder: (yargs: Argv) =>
    yargs
      .option("message", {
        type: "string",
        default: "hi",
        describe: "message to send",
      })
      .option("provider", {
        type: "string",
        array: true,
        describe: "limit to provider or family (repeatable)",
      })
      .option("limit", {
        type: "number",
        describe: "limit total models to test",
      })
      .option("output", {
        type: "string",
        describe: "write results to a json file (defaults to logs/model-smoke-last.json)",
      })
      .option("timeout", {
        type: "number",
        describe: "timeout per model in milliseconds",
      })
      .option("skip", {
        type: "number",
        describe: "skip the first N models",
      }),
  handler: async (args) => {
    const message = (args.message ?? "hi").trim().length > 0 ? (args.message ?? "hi").trim() : "hi"
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : undefined
    const timeout = typeof args.timeout === "number" && args.timeout > 0 ? Math.floor(args.timeout) : 120000
    const skip = typeof args.skip === "number" && args.skip > 0 ? Math.floor(args.skip) : 0
    const filter = new Set(args.provider ?? [])
    const out = args.output ?? "logs/model-smoke-last.json"

    const family = (id: string) => {
      const parsed = Account.parseFamily(id)
      if (parsed) return parsed
      if (id === "opencode" || id.startsWith("opencode-")) return "opencode"
      return undefined
    }

    const allow = (id: string, fam?: string) => {
      if (filter.size === 0) return true
      if (filter.has(id)) return true
      if (fam && filter.has(fam)) return true
      return false
    }

    await bootstrap(process.cwd(), async () => {
      const providers = await Provider.list()
      const families = await Account.listAll()
      const active = new Set(Object.keys(families).filter((key) => !!families[key].activeAccount))
      const items: { providerID: string; modelID: string; name?: string }[] = []

      for (const [providerID, provider] of Object.entries(providers)) {
        if (provider.active === false) continue
        if (provider.cooldownReason?.includes("blocked")) continue
        const fam = family(providerID)
        if (!allow(providerID, fam)) continue
        const hasActive = fam ? active.has(fam) : false
        if (fam && hasActive && providerID === fam) continue
        if (fam && hasActive && provider.active !== true) continue

        for (const [modelID, info] of Object.entries(provider.models)) {
          if (Provider.isModelIgnored(providerID, modelID)) continue
          const input = info.capabilities?.input
          if (input && !input.text) continue
          const output = info.capabilities?.output
          if (output && !output.text) continue
          items.push({ providerID, modelID, name: info.name })
        }
      }

      const results: SmokeResult[] = []
      const state = { index: 0 }
      for (const item of items) {
        if (limit !== undefined && state.index >= limit) break
        state.index += 1
        if (skip && state.index <= skip) continue
        const label = `${item.providerID}/${item.modelID}`
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "~",
          UI.Style.TEXT_NORMAL,
          `smoke ${state.index}/${items.length}: ${label}`,
        )

        const create = await Session.create({
          title: `Smoke ${label}`,
          permission: [{ permission: "question", action: "deny", pattern: "*" }],
        }).catch((error) => ({ error }))

        if (!create || "error" in create) {
          const msg = create && "error" in create && create.error ? String(create.error) : "Failed to create session"
          results.push({ ...item, ok: false, error: msg, time: 0 })
          continue
        }

        const sessionID = "id" in create ? create.id : undefined
        if (!sessionID) {
          results.push({ ...item, ok: false, error: "Missing session ID", time: 0 })
          continue
        }

        const start = Date.now()
        const response = await Promise.race([
          SessionPrompt.prompt({
            sessionID,
            model: { providerID: item.providerID, modelID: item.modelID },
            parts: [{ type: "text", text: message }],
          })
            .then((res) => ({ res }))
            .catch((error) => ({ error })),
          sleep(timeout, { error: "Prompt timeout" }),
        ])

        if ("error" in response && response.error) {
          results.push({
            ...item,
            ok: false,
            error: String(response.error),
            sessionID,
            time: Date.now() - start,
          })
          continue
        }

        const msgRes = (response as { res: MessageV2.WithParts }).res
        const assistant = msgRes.info as MessageV2.Assistant
        const textParts = msgRes.parts.filter((p) => p.type === "text").map((p) => (p as MessageV2.TextPart).text)
        const fullText = textParts.join(" ").trim()
        const reasoningParts = msgRes.parts
          .filter((p) => p.type === "reasoning")
          .map((p) => (p as MessageV2.ReasoningPart).text)
        const fullReasoning = reasoningParts.join(" ").trim()

        let validationError: string | undefined

        if (assistant.error) {
          validationError = `Model returned error: ${JSON.stringify(assistant.error)}`
        } else if (fullText.length < 2 && fullReasoning.length < 2) {
          validationError = "Empty response (no text or reasoning content)"
        } else if (shouldIgnore(fullText)) {
          validationError = `Detected error keywords in response text: "${fullText.slice(0, 100)}..."`
        }

        if (validationError) {
          results.push({
            ...item,
            ok: false,
            error: validationError,
            sessionID,
            time: Date.now() - start,
          })
          continue
        }

        results.push({
          ...item,
          ok: true,
          sessionID,
          time: Date.now() - start,
        })
      }

      const json = JSON.stringify(
        {
          message,
          total: results.length,
          ok: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          results,
        },
        null,
        2,
      )
      await Bun.write(out, json)

      const ignored = await loadIgnored()
      const before = ignored.size
      for (const item of results.filter((r) => !r.ok)) {
        if (!shouldIgnore(item.error)) continue
        ignored.add(`${item.providerID}/${item.modelID}`)
      }
      if (ignored.size > before) {
        await saveIgnored(ignored)
      }

      const failed = results.filter((r) => !r.ok)
      if (failed.length === 0) {
        UI.println(UI.Style.TEXT_SUCCESS_BOLD + "✓", UI.Style.TEXT_NORMAL, "all models ok")
        process.exit(0)
      }

      UI.error(`failed models: ${failed.length}`)
      for (const item of failed) {
        UI.println(UI.Style.TEXT_DANGER_BOLD + "×", UI.Style.TEXT_NORMAL, `${item.providerID}/${item.modelID}`)
        if (item.error) UI.println(UI.Style.TEXT_DIM + item.error)
      }
      process.exit(1)
    })
  },
})

function sleep<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms)
  })
}

function shouldIgnore(error?: string): boolean {
  if (!error) return false
  const msg = error.toLowerCase()
  if (msg.includes("credential is only authorized for use with claude code")) return true
  if (msg.includes("not supported")) return true
  if (msg.includes("unsupported")) return true
  if (msg.includes("model not found")) return true
  if (msg.includes("quota exceeded")) return true
  if (msg.includes("timeout")) return true
  return false
}

async function loadIgnored(): Promise<Set<string>> {
  const file = Bun.file(`${Global.Path.data}/ignored-models.json`)
  const exists = await file.exists()
  if (!exists) return new Set<string>()
  const data = await file.json().catch(() => [])
  if (!Array.isArray(data)) return new Set<string>()
  return new Set<string>(data.filter((item) => typeof item === "string"))
}

async function saveIgnored(list: Set<string>) {
  const data = JSON.stringify([...list].sort(), null, 2)
  await Bun.write(`${Global.Path.data}/ignored-models.json`, data)
}
