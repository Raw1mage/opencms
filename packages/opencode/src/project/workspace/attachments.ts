import type { WorkspaceAttachmentOwnership, WorkspaceAttachmentSummary } from "./types"

export type WorkspaceAttachmentType = "session" | "pty" | "preview" | "worker" | "draft" | "file_tab" | "comment"

export type WorkspaceAttachmentDescriptor = {
  type: WorkspaceAttachmentType
  ownership: WorkspaceAttachmentOwnership
  key: string
  active?: boolean
}

export function createEmptyWorkspaceAttachmentSummary(): WorkspaceAttachmentSummary {
  return {
    sessionIds: [],
    activeSessionId: undefined,
    ptyIds: [],
    previewIds: [],
    workerIds: [],
    draftKeys: [],
    fileTabKeys: [],
    commentKeys: [],
  }
}

export function summarizeWorkspaceAttachments(
  descriptors: WorkspaceAttachmentDescriptor[],
): WorkspaceAttachmentSummary {
  const summary = createEmptyWorkspaceAttachmentSummary()
  for (const descriptor of descriptors) {
    switch (descriptor.type) {
      case "session":
        if (!summary.sessionIds.includes(descriptor.key)) summary.sessionIds.push(descriptor.key)
        if (descriptor.active) summary.activeSessionId = descriptor.key
        break
      case "pty":
        if (!summary.ptyIds.includes(descriptor.key)) summary.ptyIds.push(descriptor.key)
        break
      case "preview":
        if (!summary.previewIds.includes(descriptor.key)) summary.previewIds.push(descriptor.key)
        break
      case "worker":
        if (!summary.workerIds.includes(descriptor.key)) summary.workerIds.push(descriptor.key)
        break
      case "draft":
        if (!summary.draftKeys.includes(descriptor.key)) summary.draftKeys.push(descriptor.key)
        break
      case "file_tab":
        if (!summary.fileTabKeys.includes(descriptor.key)) summary.fileTabKeys.push(descriptor.key)
        break
      case "comment":
        if (!summary.commentKeys.includes(descriptor.key)) summary.commentKeys.push(descriptor.key)
        break
    }
  }
  return summary
}
