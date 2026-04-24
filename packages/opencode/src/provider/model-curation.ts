type ModelShape = {
  id: string
  name: string
  family?: string
  release_date: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  limit: {
    context: number
    output: number
    input?: number
  }
  options: Record<string, any>
  cost?: Record<string, any>
  modalities?: Record<string, any>
  interleaved?: true | { field: "reasoning_content" | "reasoning_details" }
  experimental?: boolean
  status?: "alpha" | "beta" | "deprecated"
  headers?: Record<string, string>
  provider?: {
    npm?: string
    api?: string
  }
  variants?: Record<string, Record<string, any>>
  [key: string]: any
}

type ProviderCorrection<T extends ModelShape> = {
  remove: string[]
  add: Record<string, T>
}

const OPENAI_CORRECTION: ProviderCorrection<ModelShape> = {
  // models.dev currently over-reports the OpenAI/Codex surface relative to the
  // verified Codex extension selector. Remove the known-bad extras, but keep
  // the mechanism patch-based so future upstream changes can be corrected
  // incrementally instead of maintaining a hard allowlist at the output edge.
  remove: [
    "codex-mini-latest",
    "gpt-3.5-turbo",
    "gpt-4",
    "gpt-4-turbo",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4o-2024-05-13",
    "gpt-4o-2024-08-06",
    "gpt-4o-2024-11-20",
    "gpt-4o-mini",
    "gpt-5",
    "gpt-5-chat-latest",
    "gpt-5-codex",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5-pro",
    "gpt-5.1",
    "gpt-5.1-chat-latest",
    "gpt-5.1-codex",
    "gpt-5.2-chat-latest",
    "gpt-5.2-pro",
    "gpt-5.3-codex-spark",
    "gpt-5.4-pro",
    "o1",
    "o1-mini",
    "o1-preview",
    "o1-pro",
    "o3",
    "o3-deep-research",
    "o3-mini",
    "o3-pro",
    "o4-mini",
    "o4-mini-deep-research",
    "text-embedding-3-large",
    "text-embedding-3-small",
    "text-embedding-ada-002",
  ],
  add: {
    "gpt-5.1-codex-max": {
      id: "gpt-5.1-codex-max",
      name: "GPT-5.1 Codex Max",
      family: "gpt-5.1-codex",
      release_date: "2025-08-05",
      last_updated: "2025-08-05",
      attachment: false,
      reasoning: true,
      temperature: false,
      tool_call: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 400000, output: 128000 },
      cost: { input: 15, output: 120 },
      options: {},
    },
    "gpt-5.1-codex-mini": {
      id: "gpt-5.1-codex-mini",
      name: "GPT-5.1 Codex Mini",
      family: "gpt-5.1-codex",
      release_date: "2025-08-05",
      last_updated: "2025-08-05",
      attachment: false,
      reasoning: false,
      temperature: false,
      tool_call: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 400000, output: 128000 },
      cost: { input: 1.5, output: 6 },
      options: {},
    },
    "gpt-5.2": {
      id: "gpt-5.2",
      name: "GPT-5.2",
      family: "gpt-5.2",
      release_date: "2025-09-16",
      last_updated: "2025-09-16",
      attachment: false,
      reasoning: true,
      temperature: false,
      tool_call: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 400000, output: 128000 },
      cost: { input: 1.25, output: 10 },
      options: {},
    },
    "gpt-5.2-codex": {
      id: "gpt-5.2-codex",
      name: "GPT-5.2 Codex",
      family: "gpt-5.2-codex",
      release_date: "2025-09-16",
      last_updated: "2025-09-16",
      attachment: false,
      reasoning: true,
      temperature: false,
      tool_call: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 400000, output: 128000 },
      cost: { input: 1.5, output: 6 },
      options: {},
    },
    "gpt-5.3-codex": {
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      family: "gpt-5.3-codex",
      release_date: "2026-01-30",
      last_updated: "2026-01-30",
      attachment: false,
      reasoning: true,
      temperature: false,
      tool_call: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 400000, output: 128000 },
      cost: { input: 1.5, output: 6 },
      options: {},
    },
    "gpt-5.4": {
      id: "gpt-5.4",
      name: "GPT-5.4",
      family: "gpt-5.4",
      release_date: "2026-03-06",
      last_updated: "2026-03-06",
      attachment: false,
      reasoning: true,
      temperature: false,
      tool_call: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 400000, output: 128000 },
      cost: { input: 1.25, output: 10 },
      options: {},
    },
    "gpt-5.5": {
      id: "gpt-5.5",
      name: "GPT-5.5",
      family: "gpt-5.5",
      release_date: "2026-04-24",
      last_updated: "2026-04-24",
      attachment: false,
      reasoning: true,
      temperature: false,
      tool_call: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 400000, output: 128000 },
      cost: { input: 1.25, output: 10 },
      options: {},
    },
  },
}

const PROVIDER_CORRECTIONS: Record<string, ProviderCorrection<ModelShape>> = {
  openai: OPENAI_CORRECTION,
}

function correctionKey(providerId: string) {
  if (providerId === "openai" || providerId.startsWith("openai-")) return "openai"
  return providerId
}

export function applyProviderModelCorrections<T>(providerId: string, models: Record<string, T>) {
  return applyProviderModelCorrectionsWithAdditions(providerId, models)
}

export function applyProviderModelCorrectionsWithAdditions<T>(
  providerId: string,
  models: Record<string, T>,
  additions?: Record<string, T>,
) {
  const correction = PROVIDER_CORRECTIONS[correctionKey(providerId)]
  if (!correction) return structuredClone(models)

  const next = structuredClone(models)
  for (const modelId of correction.remove) {
    delete next[modelId]
  }
  if (additions) {
    for (const [modelId, model] of Object.entries(additions)) {
      if (!next[modelId]) next[modelId] = structuredClone(model) as T
    }
  }
  return next
}

export const OPENAI_FALLBACK_MODELS = Object.keys(OPENAI_CORRECTION.add)
export const OPENAI_RAW_MODEL_ADDITIONS = OPENAI_CORRECTION.add
