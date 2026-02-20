import { rewriteOpenAIChatToolCallPayload } from "./toolcall-bridge/openai-chat-rewriter"
import { extractTextProtocolToolCalls } from "./toolcall-bridge/protocol/text-protocol"

export const extractGmiCloudTextProtocolToolCalls = extractTextProtocolToolCalls

export function rewriteGmiCloudToolCallPayload(raw: string, stream: boolean): string | null {
  return rewriteOpenAIChatToolCallPayload(raw, {
    stream,
    extractor: extractTextProtocolToolCalls,
    toolCallIdPrefix: "gmi-tool",
  })
}
