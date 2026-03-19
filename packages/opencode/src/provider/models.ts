import { Global } from "../global"
import { Log } from "../util/log"
import path from "path"
import z from "zod"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { lazy } from "@/util/lazy"
import { OPENAI_RAW_MODEL_ADDITIONS, applyProviderModelCorrectionsWithAdditions } from "./model-curation"

// Try to import bundled snapshot (generated at build time)
// Falls back to undefined in dev mode when snapshot doesn't exist

export namespace ModelsDev {
  const log = Log.create({ service: "models.dev" })
  const filepath = path.join(Global.Path.cache, "models.json")

  export const Model = z.object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    release_date: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    temperature: z.boolean(),
    tool_call: z.boolean(),
    interleaved: z
      .union([
        z.literal(true),
        z
          .object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          })
          .strict(),
      ])
      .optional(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        reasoning: z.number().optional(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
        context_over_200k: z
          .object({
            input: z.number(),
            output: z.number(),
            reasoning: z.number().optional(),
            cache_read: z.number().optional(),
            cache_write: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    limit: z.object({
      context: z.number(),
      input: z.number().optional(),
      output: z.number(),
    }),
    modalities: z
      .object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      })
      .optional(),
    experimental: z.boolean().optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    options: z.record(z.string(), z.any()),
    headers: z.record(z.string(), z.string()).optional(),
    provider: z
      .object({
        npm: z.string().optional(),
        api: z.string().optional(),
      })
      .optional(),
    variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  })
  export type Model = z.infer<typeof Model>

  export const Provider = z.object({
    api: z.string().optional(),
    name: z.string(),
    env: z.array(z.string()),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), Model),
  })

  export type Provider = z.infer<typeof Provider>

  function url() {
    return Flag.OPENCODE_MODELS_URL || "https://models.dev"
  }

  export const Data = lazy(async () => {
    const file = Bun.file(Flag.OPENCODE_MODELS_PATH ?? filepath)
    const result = await file.json().catch(() => {})
    if (result) return result
    const snapshot = await import("./models-snapshot")
      .then((m) => m.snapshot as Record<string, unknown>)
      .catch(() => undefined)
    if (snapshot) return snapshot
    if (Flag.OPENCODE_DISABLE_MODELS_FETCH) return {}
    const json = await fetch(`${url()}/api.json`).then((x) => x.text())
    return JSON.parse(json)
  })

  function normalizeProviders(data: Record<string, Provider>): Record<string, Provider> {
    const normalized = { ...data }
    const googleProvider = normalized["google"]
    if (googleProvider) {
      if (!normalized["google-api"]) {
        normalized["google-api"] = {
          ...googleProvider,
          id: "google-api",
        }
      }
      delete normalized["google"]
    }
    return normalized
  }

  function applyProviderCurations(data: Record<string, Provider>): Record<string, Provider> {
    const curated = structuredClone(data)
    // models.dev is NOT an official source for github-copilot models.
    // Bundled defaults in provider.ts are the single source of truth.
    delete curated["github-copilot"]
    delete curated["github-copilot-enterprise"]
    for (const [providerId, provider] of Object.entries(curated)) {
      const additions =
        providerId === "openai" ? (OPENAI_RAW_MODEL_ADDITIONS as typeof provider.models) : undefined
      provider.models = applyProviderModelCorrectionsWithAdditions(providerId, provider.models, additions)
    }
    return curated
  }

  export async function get() {
    const result = await Data()
    const data = applyProviderCurations(result as Record<string, Provider>)

    if (!data["gmicloud"]) {
      data["gmicloud"] = {
        id: "gmicloud",
        name: "GMI Cloud",
        env: ["GMI_API_KEY"],
        api: "https://api.gmi-serving.com/v1",
        npm: "@ai-sdk/openai-compatible",
        models: {
          "deepseek-ai/DeepSeek-R1": {
            id: "deepseek-ai/DeepSeek-R1",
            name: "DeepSeek R1",
            family: "deepseek",
            release_date: "2025-01-01",
            attachment: false,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 64000, output: 8000 },
            options: {},
          },
        },
      }
    }

    // Merge snapshot models into result so that locally-added models
    // are always available even when a cached models.json takes priority.
    const snapshotData = await import("./models-snapshot")
      .then((m) => m.snapshot as unknown as Record<string, Provider>)
      .catch(() => undefined)
    if (snapshotData) {
      for (const [providerKey, snapshotProvider] of Object.entries(snapshotData)) {
        // Skip copilot — bundled defaults in provider.ts are the SSOT
        if (providerKey === "github-copilot" || providerKey === "github-copilot-enterprise") continue
        const existing = data[providerKey]
        if (existing && snapshotProvider.models) {
          for (const [modelId, model] of Object.entries(snapshotProvider.models)) {
            if (!existing.models[modelId]) {
              existing.models[modelId] = model
            }
          }
        }
      }
    }

    return normalizeProviders(data)
  }

  export async function refresh() {
    const file = Bun.file(filepath)
    const result = await fetch(`${url()}/api.json`, {
      headers: {
        "User-Agent": Installation.USER_AGENT,
      },
      signal: AbortSignal.timeout(10 * 1000),
    }).catch((e) => {
      log.error("Failed to fetch models.dev", {
        error: e,
      })
    })
    if (result && result.ok) {
      const next = applyProviderCurations(JSON.parse(await result.text()) as Record<string, Provider>)
      await Bun.write(file, JSON.stringify(next))
      ModelsDev.Data.reset()
    }
  }
}

if (!Flag.OPENCODE_DISABLE_MODELS_FETCH) {
  ModelsDev.refresh()
  setInterval(
    async () => {
      await ModelsDev.refresh()
    },
    60 * 1000 * 60,
  ).unref()
}
