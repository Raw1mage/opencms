export const ModelLimits: Record<string, number> = {
  "gemini-2.5-flash": 20,
  "gemini-2.5-pro": 1500,
  "gemini-2.0-flash": 1500,
  "gemini-2.0-flash-exp": 1500,
  "gemini-2.0-flash-lite": 1500,
  "gemini-2.0-pro-exp": 1500,
  "gemini-2.5-flash-lite": 20,
  "gemini-3-pro": 1500,
  "gemini-3-flash": 20,
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
