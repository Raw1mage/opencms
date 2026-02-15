export const ModelLimits: Record<string, number | undefined> = {
  "gemini-3-pro": 250,
  "gemini-2.5-flash-lite": undefined,
  "gemini-3-flash": 10000,
  "gemini-2.5-pro": 1000,
  "gemini-2.5-flash": 10000,
}

export function getModelRPDLimit(modelId: string): number | undefined {
  // Check for exact match first
  if (ModelLimits[modelId]) return ModelLimits[modelId]

  // Check for partial match (longest key first to handle subsets like flash-lite vs flash)
  const keys = Object.keys(ModelLimits).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    if (modelId.includes(key)) {
      return ModelLimits[key]
    }
  }

  return undefined
}
