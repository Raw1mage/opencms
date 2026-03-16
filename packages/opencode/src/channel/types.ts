import { z } from "zod"

/**
 * Channel types — independent execution contexts for concurrent agent conversations.
 *
 * IDEF0 reference: A2 (Manage Channel Lifecycle)
 * Design decision: DD-14 (per-file JSON), DD-17 (auto-bootstrap default)
 */

// --- Lane policy ---

export const LanePolicySchema = z.object({
  main: z.number().int().positive(),
  cron: z.number().int().positive(),
  subagent: z.number().int().positive(),
  nested: z.number().int().positive(),
})
export type LanePolicy = z.infer<typeof LanePolicySchema>

export const DEFAULT_LANE_POLICY: LanePolicy = {
  main: 1,
  cron: 1,
  subagent: 2,
  nested: 1,
}

// --- Channel info ---

export const ChannelInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  lanePolicy: LanePolicySchema,
  killSwitchScope: z.enum(["channel", "global"]),
  sessionFilter: z
    .object({
      prefix: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  state: z.object({
    activeSessionCount: z.number().int().nonnegative(),
    lastActivityAtMs: z.number().optional(),
  }),
})
export type ChannelInfo = z.infer<typeof ChannelInfoSchema>

// --- Create / Patch ---

export type ChannelCreate = {
  name: string
  description?: string
  lanePolicy?: Partial<LanePolicy>
  killSwitchScope?: "channel" | "global"
  sessionFilter?: { prefix?: string; tags?: string[] }
}

export type ChannelPatch = Partial<Omit<ChannelCreate, "name">> & {
  name?: string
  enabled?: boolean
}

// --- Default channel ---

export const DEFAULT_CHANNEL_ID = "default"

export function createDefaultChannel(nowMs: number = Date.now()): ChannelInfo {
  return {
    id: DEFAULT_CHANNEL_ID,
    name: "Default",
    description: "Auto-created default channel for non-channel-scoped sessions",
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    lanePolicy: { ...DEFAULT_LANE_POLICY },
    killSwitchScope: "global",
    state: {
      activeSessionCount: 0,
    },
  }
}
