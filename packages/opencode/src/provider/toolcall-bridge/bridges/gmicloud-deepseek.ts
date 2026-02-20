import { rewriteOpenAIChatToolCallPayload } from "../openai-chat-rewriter"
import { extractTextProtocolToolCalls } from "../protocol/text-protocol"
import type { ToolCallBridge } from "../types"

export const gmiCloudDeepSeekBridge: ToolCallBridge = {
  id: "gmicloud-deepseek-text-protocol",
  priority: 100,
  match(ctx) {
    const providerIdLower = ctx.providerId.toLowerCase()
    const modelIdLower = ctx.modelId.toLowerCase()
    const isGmiCloudEndpoint = /https?:\/\/api\.gmi-serving\.com\/v1/i.test(ctx.inputUrl)
    const isExplicitGmiCloudAccount = providerIdLower === "gmicloud" || providerIdLower.startsWith("gmicloud-")
    const isExplicitDeepSeekR1_0528 =
      modelIdLower === "deepseek-ai/deepseek-r1-0528" || modelIdLower === "deepseek-ai/deepseek-r1"

    return (
      (isExplicitGmiCloudAccount || ctx.providerFamily === "gmicloud" || isGmiCloudEndpoint) &&
      (isExplicitDeepSeekR1_0528 || modelIdLower.includes("deepseek")) &&
      ctx.inputUrl.includes("/chat/completions")
    )
  },
  rewrite(raw, ctx) {
    return rewriteOpenAIChatToolCallPayload(raw, {
      stream: ctx.stream,
      extractor: extractTextProtocolToolCalls,
      toolCallIdPrefix: "gmi-tool",
    })
  },
}
