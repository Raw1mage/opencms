import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { WorkspaceAggregateSchema, WorkspaceAttachmentOwnershipSchema } from "./types"

export const WorkspaceAttachmentTypeSchema = z.enum([
  "session",
  "pty",
  "preview",
  "worker",
  "draft",
  "file_tab",
  "comment",
])

export const WorkspaceAttachmentEventSchema = z.object({
  type: WorkspaceAttachmentTypeSchema,
  ownership: WorkspaceAttachmentOwnershipSchema,
  key: z.string(),
  active: z.boolean().optional(),
})

export const WorkspaceEvent = {
  Created: BusEvent.define(
    "workspace.created",
    z.object({
      workspace: WorkspaceAggregateSchema,
    }),
  ),
  Updated: BusEvent.define(
    "workspace.updated",
    z.object({
      workspace: WorkspaceAggregateSchema,
      previous: WorkspaceAggregateSchema.optional(),
    }),
  ),
  LifecycleChanged: BusEvent.define(
    "workspace.lifecycle.changed",
    z.object({
      workspace: WorkspaceAggregateSchema,
      previous: WorkspaceAggregateSchema,
      previousState: WorkspaceAggregateSchema.shape.lifecycleState,
      nextState: WorkspaceAggregateSchema.shape.lifecycleState,
    }),
  ),
  AttachmentAdded: BusEvent.define(
    "workspace.attachment.added",
    z.object({
      workspace: WorkspaceAggregateSchema,
      attachment: WorkspaceAttachmentEventSchema,
    }),
  ),
  AttachmentRemoved: BusEvent.define(
    "workspace.attachment.removed",
    z.object({
      workspace: WorkspaceAggregateSchema,
      attachment: WorkspaceAttachmentEventSchema,
    }),
  ),
}
