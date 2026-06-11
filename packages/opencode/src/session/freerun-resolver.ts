/**
 * freerun-resolver — single dispatch point for "is this session freerun?"
 *
 * compaction_enrichment-ai-first DD-9/DD-10: the freerun decision used to be
 * re-implemented at four call sites (llm.ts effectiveMode, prompt.ts
 * auto-arm, compaction.ts compaction-bypass, tool/bash.ts privileged-command
 * block), each reading provider config independently. DD-9 adds a second
 * trigger — small context window (≤128K) auto-routes to freerun — which MUST
 * apply to all four sites simultaneously or the safety posture and the
 * compaction bypass desynchronize. Hence: one resolver, four consumers.
 *
 * Decision (DD-9):
 *   1. per-session override "off"  → NOT freerun (explicit decision gate)
 *   2. per-session override "on"   → freerun
 *   3. provider config mode="freerun" → freerun
 *   4. model contextLimit ≤ 128K   → freerun (small windows have no prompt-
 *      cache dividend; stateless per-iteration rebuild beats accumulate+
 *      compact, and the whole anchor/enrichment machinery is bypassed)
 *   5. otherwise                   → NOT freerun
 */

import { Log } from "../util/log"

const log = Log.create({ service: "session.freerun-resolver" })

export namespace FreerunResolver {
  /** DD-9: windows at or below this are auto-routed to freerun. */
  export const SMALL_WINDOW_TOKENS = 128_000

  export type ProviderMode = "full" | "lite" | "freerun"
  export type Override = "on" | "off"

  /**
   * Pure decision core — unit-testable, no I/O. All call sites must reach
   * their verdict through this function (DD-10).
   */
  export function decide(input: { providerMode?: ProviderMode; contextLimit?: number; override?: Override }): boolean {
    if (input.override === "off") return false
    if (input.override === "on") return true
    if (input.providerMode === "freerun") return true
    if (input.contextLimit !== undefined && input.contextLimit > 0 && input.contextLimit <= SMALL_WINDOW_TOKENS) {
      return true
    }
    return false
  }

  /**
   * Session-scoped resolver. Loads the session (override + execution
   * identity), provider config (mode tag), and the model's context limit,
   * then delegates to `decide`. Lazy imports avoid circular module concerns
   * (this file is consumed from tool/bash.ts and session/llm.ts alike).
   *
   * `modelHint` lets call sites that already hold a resolved model skip the
   * Provider.getModel lookup (llm.ts, compaction.ts).
   */
  export async function isFreerunSession(
    sessionID: string,
    modelHint?: { providerId?: string; modelID?: string; limit?: { context?: number } },
  ): Promise<boolean> {
    try {
      const { Session } = await import("./index")
      const { Config } = await import("../config/config")
      const session = await Session.get(sessionID).catch(() => null)
      if (!session) return false
      const override = session.workflow?.freerunOverride
      const providerId = modelHint?.providerId ?? session.execution?.providerId
      if (!providerId) return decide({ override })
      const cfg = await Config.get()
      const providerCfg = (cfg.provider as Record<string, { lite?: boolean; mode?: ProviderMode }> | undefined)?.[
        providerId
      ]
      let contextLimit = modelHint?.limit?.context
      if (contextLimit === undefined) {
        const modelID = modelHint?.modelID ?? session.execution?.modelID
        if (modelID) {
          const { Provider } = await import("../provider/provider")
          contextLimit = await Provider.getModel(providerId, modelID)
            .then((m) => m?.limit?.context)
            .catch(() => undefined)
        }
      }
      const verdict = decide({ providerMode: providerCfg?.mode, contextLimit, override })
      if (verdict && providerCfg?.mode !== "freerun") {
        log.info("small-window auto-route to freerun (DD-9)", {
          sessionID,
          providerId,
          contextLimit,
          override: override ?? "(none)",
        })
      }
      return verdict
    } catch (err) {
      // Fail toward turn-based mode: freerun strips capabilities and bypasses
      // compaction — wrongly entering it is worse than wrongly staying out.
      log.warn("freerun resolution failed; defaulting to turn-based", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }
}
