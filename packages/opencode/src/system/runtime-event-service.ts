import z from "zod"
import { Storage } from "@/storage/storage"
import { Identifier } from "@/id/id"

export namespace RuntimeEventService {
  export const Level = z.enum(["info", "warn", "error"])
  export const Domain = z.enum(["runner", "workflow", "subagent", "mission", "anomaly", "telemetry"])

  export const Event = z.object({
    id: z.string(),
    ts: z.number(),
    level: Level,
    domain: Domain,
    eventType: z.string(),
    sessionID: Identifier.schema("session"),
    todoID: z.string().optional(),
    anomalyFlags: z.array(z.string()).default([]),
    payload: z.record(z.string(), z.any()).default({}),
  })
  export type Event = z.infer<typeof Event>

  function key(sessionID: string) {
    return ["session_runtime_event", sessionID]
  }

  export async function append(
    input: Omit<Event, "id" | "ts"> & {
      id?: string
      ts?: number
    },
  ) {
    const event = Event.parse({
      ...input,
      id: input.id ?? `rte_${Identifier.create("tool", false).slice(5)}`,
      ts: input.ts ?? Date.now(),
    })
    const existing = ((await Storage.read<Event[]>(key(event.sessionID)).catch(() => [] as Event[])) ?? []) as Event[]
    existing.push(event)
    await Storage.write(key(event.sessionID), existing)
    return event
  }

  export async function list(sessionID: string, input?: { limit?: number }) {
    const events = ((await Storage.read<Event[]>(key(sessionID)).catch(() => [] as Event[])) ?? []) as Event[]
    const sorted = [...events].sort((a, b) => a.ts - b.ts)
    if (!input?.limit) return sorted
    return sorted.slice(-input.limit)
  }

  export async function clear(sessionID: string) {
    await Storage.remove(key(sessionID)).catch(() => undefined)
  }
}

export namespace TelemetryProjector {
  const PromptSummary = z.object({
    promptId: z.string(),
    sessionID: z.string(),
    providerId: z.string(),
    modelId: z.string(),
    accountId: z.string().optional(),
    blocks: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        chars: z.number(),
        tokens: z.number(),
        injected: z.boolean(),
        policy: z.string(),
      }),
    ),
    finalSystemTokens: z.number(),
    finalSystemChars: z.number(),
    finalSystemMessages: z.number(),
    messageCount: z.number(),
    timestamp: z.number(),
  })

  const RoundSummary = z.object({
    sessionID: z.string(),
    roundIndex: z.number().optional(),
    requestId: z.string().optional(),
    providerId: z.string(),
    modelId: z.string(),
    accountId: z.string().optional(),
    finishReason: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    totalTokens: z.number(),
    cost: z.number(),
    contextLimit: z.number(),
    inputLimit: z.number().optional(),
    reservedTokens: z.number(),
    usableTokens: z.number(),
    observedTokens: z.number(),
    needsCompaction: z.boolean(),
    compactionResult: z.string().optional(),
    compactionDraftTokens: z.number().optional(),
    compactionCount: z.number().optional(),
    timestamp: z.number(),
  })

  const CompactionSummary = z.object({
    sessionID: z.string(),
    roundIndex: z.number().optional(),
    requestId: z.string().optional(),
    providerId: z.string(),
    modelId: z.string(),
    accountId: z.string().optional(),
    compactionAttemptId: z.string(),
    compactionCount: z.number().optional(),
    compactionResult: z.string(),
    compactionDraftTokens: z.number().optional(),
    timestamp: z.number(),
  })

  export const Aggregate = z.object({
    source: z.literal("projector"),
    promptSummary: PromptSummary.nullable(),
    roundSummary: RoundSummary.nullable(),
    compactionSummary: CompactionSummary.nullable(),
    sessionSummary: z.object({
      sessionID: z.string(),
      cumulativeTokens: z.number(),
      cumulativeCacheReadTokens: z.number().optional(),
      cumulativeInputTokens: z.number().optional(),
      totalRequests: z.number(),
      cumulativeCost: z.number(),
      latestRoundIndex: z.number().optional(),
      latestCompactionAt: z.number().optional(),
      latestUpdatedAt: z.number().optional(),
    }),
    freshness: z.object({
      lastEventAt: z.number().optional(),
      lastEventType: z.string().optional(),
      bootstrapNeeded: z.boolean(),
      catchUpNeeded: z.boolean(),
      degraded: z.boolean(),
    }),
  })
  export type Aggregate = z.infer<typeof Aggregate>

  export async function project(sessionID: string): Promise<Aggregate> {
    const events = await RuntimeEventService.list(sessionID)
    const promptEvents = events.filter((event) => event.eventType === "llm.prompt.telemetry")
    const roundEvents = events.filter((event) => event.eventType === "session.round.telemetry")
    const compactionEvents = events.filter((event) => event.eventType === "session.compaction.telemetry")

    const latestPrompt = promptEvents.at(-1)?.payload
    const latestRound = roundEvents.at(-1)?.payload
    const latestCompaction = compactionEvents.at(-1)?.payload
    const totalRequests = roundEvents.length
    const sumField = (field: string) =>
      roundEvents.reduce((sum, event) => {
        const v = (event.payload as Record<string, unknown>)[field]
        return sum + (typeof v === "number" ? v : 0)
      }, 0)
    const cumulativeTokens = sumField("totalTokens")
    const cumulativeCacheReadTokens = sumField("cacheReadTokens")
    const cumulativeInputTokens = sumField("inputTokens")
    const cumulativeCost = sumField("cost")
    const lastEvent = events.at(-1)

    return Aggregate.parse({
      source: "projector",
      promptSummary: latestPrompt ?? null,
      roundSummary: latestRound ?? null,
      compactionSummary: latestCompaction ?? null,
      sessionSummary: {
        sessionID,
        cumulativeTokens,
        cumulativeCacheReadTokens,
        cumulativeInputTokens,
        totalRequests,
        cumulativeCost,
        latestRoundIndex:
          latestRound && typeof (latestRound as Record<string, unknown>).roundIndex === "number"
            ? ((latestRound as Record<string, unknown>).roundIndex as number)
            : undefined,
        latestCompactionAt:
          latestCompaction && typeof (latestCompaction as Record<string, unknown>).timestamp === "number"
            ? ((latestCompaction as Record<string, unknown>).timestamp as number)
            : undefined,
        latestUpdatedAt: lastEvent?.ts,
      },
      freshness: {
        lastEventAt: lastEvent?.ts,
        lastEventType: lastEvent?.eventType,
        bootstrapNeeded: events.length === 0,
        catchUpNeeded: false,
        degraded: false,
      },
    })
  }
}
