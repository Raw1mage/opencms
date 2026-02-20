import { gmiCloudDeepSeekBridge } from "./bridges/gmicloud-deepseek"
import type { ToolCallBridge, ToolCallBridgeContext, ToolCallBridgeRewriteResult } from "./types"

const BRIDGES: ToolCallBridge[] = [gmiCloudDeepSeekBridge].sort((a, b) => b.priority - a.priority)

export namespace ToolCallBridgeManager {
  export function resolve(ctx: ToolCallBridgeContext): ToolCallBridge | undefined {
    return BRIDGES.find((bridge) => bridge.match(ctx))
  }

  export function rewrite(raw: string, ctx: ToolCallBridgeContext): ToolCallBridgeRewriteResult | null {
    const bridge = resolve(ctx)
    if (!bridge) return null
    const payload = bridge.rewrite(raw, ctx)
    if (!payload || payload === raw) return null
    return {
      bridgeId: bridge.id,
      payload,
    }
  }
}
