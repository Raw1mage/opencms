type ProviderModels = Record<string, { models: Record<string, unknown> }>

const SMALL_MODEL_PRIORITY = [
  "claude-haiku-4-5",
  "claude-haiku-4.5",
  "3-5-haiku",
  "3.5-haiku",
  "gemini-3-flash",
  "gemini-2.5-flash",
  "gpt-5-nano",
  "gpt-5-mini",
]

type SmallModelDeps<T> = {
  providerId: string
  smallModelConfig?: string
  parseModel: (value: string) => { providerId: string; modelID: string }
  isModelAvailable: (providerId: string, modelID: string) => Promise<boolean>
  listProviders: () => Promise<ProviderModels>
  getModel: (providerId: string, modelID: string) => Promise<T | undefined>
  debug: (message: string, extra?: Record<string, unknown>) => void
}

export async function resolveSmallModel<T>(deps: SmallModelDeps<T>): Promise<T | undefined> {
  const { providerId, smallModelConfig, parseModel, isModelAvailable, listProviders, getModel, debug } = deps

  if (smallModelConfig) {
    const parsed = parseModel(smallModelConfig)
    if (await isModelAvailable(parsed.providerId, parsed.modelID)) {
      return getModel(parsed.providerId, parsed.modelID)
    }
  }

  const candidates: Array<{ providerId: string; modelID: string; priorityIndex: number }> = []
  const providers = await listProviders()

  for (const [pid, provider] of Object.entries(providers)) {
    if (!provider?.models) continue

    for (const modelID of Object.keys(provider.models)) {
      const priorityIndex = SMALL_MODEL_PRIORITY.findIndex((p) => modelID.includes(p))
      if (priorityIndex === -1) continue
      if (!(await isModelAvailable(pid, modelID))) continue
      candidates.push({ providerId: pid, modelID, priorityIndex })
    }
  }

  candidates.sort((a, b) => {
    if (a.priorityIndex !== b.priorityIndex) return a.priorityIndex - b.priorityIndex
    if (a.providerId === providerId && b.providerId !== providerId) return -1
    if (b.providerId === providerId && a.providerId !== providerId) return 1
    return 0
  })

  if (candidates.length > 0) {
    const best = candidates[0]
    debug("getSmallModel selected", {
      requested: providerId,
      selected: best.providerId,
      modelID: best.modelID,
      candidateCount: candidates.length,
      allCandidates: candidates.map((c) => `${c.providerId}:${c.modelID}`).slice(0, 5),
    })
    return getModel(best.providerId, best.modelID)
  }

  const opencodeProvider = providers["opencode"]
  if (opencodeProvider?.models?.["gpt-5-nano"] && (await isModelAvailable("opencode", "gpt-5-nano"))) {
    return getModel("opencode", "gpt-5-nano")
  }

  const originalProvider = providers[providerId]
  if (originalProvider) {
    for (const item of SMALL_MODEL_PRIORITY) {
      for (const model of Object.keys(originalProvider.models)) {
        if (model.includes(item)) {
          return getModel(providerId, model)
        }
      }
    }
  }

  return undefined
}
