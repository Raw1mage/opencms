import z from "zod"

// --- Lane policy (moved from channel/types.ts) ---

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

export const KillSwitchScopeSchema = z.enum(["workspace", "global"])
export type KillSwitchScope = z.infer<typeof KillSwitchScopeSchema>

export const WorkspaceKindSchema = z.enum(["root", "sandbox", "derived"])
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>

export const WorkspaceOriginSchema = z.enum(["local", "generated", "imported"])
export type WorkspaceOrigin = z.infer<typeof WorkspaceOriginSchema>

export const WorkspaceLifecycleStateSchema = z.enum(["active", "archived", "resetting", "deleting", "failed"])
export type WorkspaceLifecycleState = z.infer<typeof WorkspaceLifecycleStateSchema>

export const WorkspaceAttachmentOwnershipSchema = z.enum(["workspace", "session", "session_with_workspace_default"])
export type WorkspaceAttachmentOwnership = z.infer<typeof WorkspaceAttachmentOwnershipSchema>

export const WorkspaceLocatorSchema = z.object({
  directory: z.string(),
  projectId: z.string(),
  kind: WorkspaceKindSchema,
})
export type WorkspaceLocator = z.infer<typeof WorkspaceLocatorSchema>

export const WorkspaceIdentitySchema = WorkspaceLocatorSchema.extend({
  workspaceId: z.string(),
})
export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>

export const WorkspaceAttachmentSummarySchema = z.object({
  sessionIds: z.array(z.string()),
  activeSessionId: z.string().optional(),
  ptyIds: z.array(z.string()),
  previewIds: z.array(z.string()),
  workerIds: z.array(z.string()),
  draftKeys: z.array(z.string()),
  fileTabKeys: z.array(z.string()),
  commentKeys: z.array(z.string()),
})
export type WorkspaceAttachmentSummary = z.infer<typeof WorkspaceAttachmentSummarySchema>

export const WorkspaceAggregateSchema = WorkspaceIdentitySchema.extend({
  origin: WorkspaceOriginSchema,
  lifecycleState: WorkspaceLifecycleStateSchema,
  displayName: z.string().optional(),
  branch: z.string().optional(),
  attachments: WorkspaceAttachmentSummarySchema,
  lanePolicy: LanePolicySchema.optional(),
  killSwitchScope: KillSwitchScopeSchema.optional(),
})
export type WorkspaceAggregate = z.infer<typeof WorkspaceAggregateSchema>
