import z from "zod"
import { Tool } from "./tool"
import { Log } from "@/util/log"
import { RebindEpoch } from "@/session/rebind-epoch"
import { CapabilityLayer } from "@/session/capability-layer"
import { RuntimeEventService } from "@/system/runtime-event-service"

const log = Log.create({ service: "refresh-capability-tool" })

/** Per-turn cap on tool calls (DD-6). Reset per messageID. */
const PER_TURN_LIMIT = 3

type TurnCounterKey = string // `${sessionID}::${messageID}`
const perTurnCounter = new Map<TurnCounterKey, number>()

function turnKey(sessionID: string, messageID: string): TurnCounterKey {
  return `${sessionID}::${messageID}`
}

function incrementAndCheck(sessionID: string, messageID: string): { count: number; allowed: boolean } {
  const key = turnKey(sessionID, messageID)
  const current = perTurnCounter.get(key) ?? 0
  const next = current + 1
  perTurnCounter.set(key, next)
  return { count: next, allowed: next <= PER_TURN_LIMIT }
}

async function appendAnomaly(sessionID: string, payload: Record<string, unknown>) {
  try {
    await RuntimeEventService.append({
      sessionID,
      level: "warn",
      domain: "anomaly",
      eventType: "tool.refresh_loop_suspected",
      anomalyFlags: ["refresh_loop_suspected"],
      payload: payload as any,
    })
  } catch (err) {
    log.warn("[refresh-capability-tool] failed to append anomaly", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

type RefreshToolMetadata = {
  rateLimited?: boolean
  turnCount?: number
  perTurnLimit?: number
  rateLimitReason?: string
  status?: "refreshed" | "partial" | "failed"
  previousEpoch?: number
  currentEpoch?: number
  pinnedSkills?: string[]
  missingSkills?: string[]
  failures?: Array<{ layer: string; error: string }>
}

const RefreshCapabilityLayerParams = z
  .object({
    reason: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "Required — explain in one sentence why this refresh is needed. Captured in the session.rebind event payload for audit.",
      ),
  })
  .describe("Arguments for refresh_capability_layer.")

export const RefreshCapabilityLayerTool = Tool.define<typeof RefreshCapabilityLayerParams, RefreshToolMetadata>(
  "refresh_capability_layer",
  {
    description: `Force a refresh of the current session's capability layer (AGENTS.md, driver prompt, pinned skills, enablement registry).

Use this when you detect the capability layer is stale — for example:
- You recognize a skill name that SHOULD be pinned but is not visible in your context
- A user instruction in AGENTS.md suggests a capability that your current system prompt does not reflect
- You suspect the AGENTS.md / SKILL.md file was updated since your session started

This tool bumps the session's rebind epoch, which invalidates the capability-layer cache so the next round (or the same round after this call) re-reads fresh content from disk.

Limits:
- Maximum ${PER_TURN_LIMIT} invocations per assistant turn (to prevent accidental refresh loops).
- If the per-turn limit is hit, the tool returns a rate-limited error without bumping the epoch.`,
    parameters: RefreshCapabilityLayerParams,
    async execute(params, ctx) {
    const { sessionID, messageID } = ctx
    const gate = incrementAndCheck(sessionID, messageID)
    if (!gate.allowed) {
      log.warn("[refresh-capability-tool] per-turn limit hit", {
        sessionID,
        messageID,
        turnCount: gate.count,
        perTurnLimit: PER_TURN_LIMIT,
      })
      await appendAnomaly(sessionID, {
        turnCount: gate.count,
        perTurnLimit: PER_TURN_LIMIT,
      })
      return {
        title: "refresh_capability_layer — rate limited",
        metadata: { rateLimited: true, turnCount: gate.count, perTurnLimit: PER_TURN_LIMIT } as RefreshToolMetadata,
        output:
          `refresh limit exceeded (${PER_TURN_LIMIT} per turn) — the capability layer is already at the latest epoch; proceed with the task.`,
      }
    }

    const bump = await RebindEpoch.bumpEpoch({
      sessionID,
      trigger: "tool_call",
      reason: params.reason,
    })
    if (bump.status === "rate_limited") {
      log.warn("[refresh-capability-tool] session rebind rate limit hit", {
        sessionID,
        rateLimitReason: bump.rateLimitReason,
      })
      return {
        title: "refresh_capability_layer — session rate limited",
        metadata: { rateLimited: true, rateLimitReason: bump.rateLimitReason ?? undefined } as RefreshToolMetadata,
        output: `session rebind rate-limited (${bump.rateLimitReason ?? "rate limit"}) — try again shortly`,
      }
    }

    const reinject = await CapabilityLayer.reinject(sessionID, bump.currentEpoch)
    log.info("[refresh-capability-tool] invoked", {
      sessionID,
      reason: params.reason,
      turnCount: gate.count,
      previousEpoch: bump.previousEpoch,
      currentEpoch: bump.currentEpoch,
      pinnedSkills: reinject.pinnedSkills,
      missingSkills: reinject.missingSkills,
      failures: reinject.failures,
    })
    const status =
      reinject.failures.length === 0 ? "refreshed" : reinject.pinnedSkills.length > 0 ? "partial" : "failed"
    const summaryLines = [
      `status: ${status}`,
      `epoch: ${bump.previousEpoch} -> ${bump.currentEpoch}`,
      `pinned: ${reinject.pinnedSkills.length > 0 ? reinject.pinnedSkills.join(", ") : "(none)"}`,
    ]
    if (reinject.missingSkills.length > 0) summaryLines.push(`missing: ${reinject.missingSkills.join(", ")}`)
    if (reinject.failures.length > 0)
      summaryLines.push(`failures: ${reinject.failures.map((f) => `${f.layer}:${f.error}`).join(", ")}`)
    return {
      title: `refresh_capability_layer — epoch ${bump.currentEpoch}`,
      metadata: {
        status,
        previousEpoch: bump.previousEpoch,
        currentEpoch: bump.currentEpoch,
        turnCount: gate.count,
        pinnedSkills: reinject.pinnedSkills,
        missingSkills: reinject.missingSkills,
        failures: reinject.failures,
      } as RefreshToolMetadata,
      output: summaryLines.join("\n"),
    }
  },
  },
)

export const REFRESH_CAPABILITY_LAYER_PER_TURN_LIMIT = PER_TURN_LIMIT

/** For tests: drop all per-turn counters. */
export function __resetRefreshCapabilityLayerCounters() {
  perTurnCounter.clear()
}
