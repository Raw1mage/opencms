// Router — storage seam.
//
// Spec: /specs/session-storage-db, DD-1 (Router is the retained seam after
// the legacy teardown; it delegates straight to SqliteStore).
//
// Post-teardown there is exactly one backend: SqliteStore. The Router keeps
// the Backend export surface so callers don't need to change shape (DD-9),
// but every method is now a thin pass-through. Legacy format detection,
// dual-track dispatch, and debris scheduling were removed in Phase 4.
//
// DD-13: any error from SqliteStore propagates. The Router never catches
// and re-routes — there is no second backend to fall back to.

import { SqliteStore } from "./sqlite"
import type { MessageV2 } from "../message-v2"
import type { SessionStorage } from "./index"

export type Format = "legacy" | "sqlite"

export const Router: SessionStorage.Backend = {
  stream(sessionID: string): AsyncIterable<MessageV2.WithParts> {
    return SqliteStore.stream(sessionID)
  },

  async get(input: { sessionID: string; messageID: string }): Promise<MessageV2.WithParts> {
    return SqliteStore.get(input)
  },

  async parts(messageID: string, sessionID?: string): Promise<MessageV2.Part[]> {
    // sessionID stays optional on the Backend interface (DD-9), but SqliteStore
    // requires it and throws when missing. No legacy fall-through (Phase 4).
    return SqliteStore.parts(messageID, sessionID)
  },

  async upsertMessage(info: MessageV2.Info): Promise<void> {
    return SqliteStore.upsertMessage(info)
  },

  async upsertPart(part: MessageV2.Part): Promise<void> {
    return SqliteStore.upsertPart(part)
  },

  async upsertAttachmentBlob(blob: SessionStorage.AttachmentBlob): Promise<void> {
    return SqliteStore.upsertAttachmentBlob(blob)
  },

  async getAttachmentBlob(input: { sessionID: string; refID: string }): Promise<SessionStorage.AttachmentBlob> {
    return SqliteStore.getAttachmentBlob(input)
  },

  async listAttachmentBlobs(sessionID: string): Promise<SessionStorage.AttachmentBlobMetadata[]> {
    return SqliteStore.listAttachmentBlobs(sessionID)
  },

  async removeAttachmentBlob(input: { sessionID: string; refID: string }): Promise<void> {
    return SqliteStore.removeAttachmentBlob(input)
  },

  async removeMessage(input: { sessionID: string; messageID: string }): Promise<void> {
    return SqliteStore.removeMessage(input)
  },

  async removePart(input: { sessionID: string; messageID: string; partID: string }): Promise<void> {
    return SqliteStore.removePart(input)
  },

  async deleteSession(sessionID: string): Promise<void> {
    return SqliteStore.deleteSession(sessionID)
  },
}
