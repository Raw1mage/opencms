export type ParsedToolCall = {
  name: string
  input: string
}

export type ParsedToolCallContent = {
  cleanedText: string
  toolCalls: ParsedToolCall[]
}

export type ToolCallBridgeContext = {
  providerId: string
  providerFamily: string
  modelId: string
  inputUrl: string
  stream: boolean
}

export type ToolCallBridge = {
  id: string
  priority: number
  match: (ctx: ToolCallBridgeContext) => boolean
  rewrite: (raw: string, ctx: ToolCallBridgeContext) => string | null
}

export type ToolCallBridgeRewriteResult = {
  bridgeId: string
  payload: string
}
