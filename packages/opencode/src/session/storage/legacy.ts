// LegacyStore — directory-of-small-files backend.
//
// Encapsulates the historical layout where each session is a directory tree:
//   <storage-root>/session/<sid>/messages/<mid>/info.json
//   <storage-root>/session/<sid>/messages/<mid>/parts/<pid>.json
//
// Storage path conventions used throughout this module:
//   ["message", sessionID]              → directory listing of messages
//   ["message", sessionID, messageID]   → one message info file
//   ["part", messageID]                 → directory listing of parts
//   ["part", messageID, partID]         → one part file
//   ["attachment", sessionID, refID]     → session-scoped oversized blob envelope
//
// Cross-cutting concerns (Bus event publishing, debounce, runaway guard,
// usage delta tracking, transport optimization) intentionally remain in
// Session.updateMessage / Session.updatePart. This module is a thin facade
// over the Storage namespace so a SQLite-backed sibling can plug in via the
// same Backend contract (DD-9 signature compatibility).
//
// Spec reference: /specs/session-storage-db, task 1.2.

import { Storage } from "@/storage/storage"
import type { MessageV2 } from "../message-v2"
import type { SessionStorage } from "./index"

type LegacyAttachmentEnvelope = SessionStorage.AttachmentBlobMetadata & { contentBase64: string }

function encodeAttachmentBlob(blob: SessionStorage.AttachmentBlob): LegacyAttachmentEnvelope {
  const { content, ...metadata } = blob
  return {
    ...metadata,
    contentBase64: Buffer.from(content).toString("base64"),
  }
}

function decodeAttachmentBlob(envelope: LegacyAttachmentEnvelope): SessionStorage.AttachmentBlob {
  const { contentBase64, ...metadata } = envelope
  return {
    ...metadata,
    content: Uint8Array.from(Buffer.from(contentBase64, "base64")),
  }
}

export const LegacyStore: SessionStorage.Backend = {
  async *stream(sessionID: string): AsyncIterable<MessageV2.WithParts> {
    const list = await Array.fromAsync(await Storage.list(["message", sessionID]))
    for (let i = list.length - 1; i >= 0; i--) {
      yield await this.get({ sessionID, messageID: list[i][2] })
    }
  },

  async get(input: { sessionID: string; messageID: string }): Promise<MessageV2.WithParts> {
    return {
      info: await Storage.read<MessageV2.Info>(["message", input.sessionID, input.messageID]),
      parts: await this.parts(input.messageID),
    }
  },

  async parts(messageID: string, _sessionID?: string): Promise<MessageV2.Part[]> {
    const result = [] as MessageV2.Part[]
    for (const item of await Storage.list(["part", messageID])) {
      // TOCTOU: a part listed by Storage.list can be deleted before we
      // read it (debounce flush, part-cap trip, snapshot prune, sibling
      // worker write). Treat ENOENT as "skip" rather than letting
      // NotFoundError propagate as an unhandled rejection.
      try {
        const read = await Storage.read<MessageV2.Part>(item)
        result.push(read)
      } catch (e) {
        if (e instanceof Storage.NotFoundError) continue
        throw e
      }
    }
    result.sort((a, b) => (a.id > b.id ? 1 : -1))
    return result
  },

  async upsertMessage(info: MessageV2.Info): Promise<void> {
    await Storage.write(["message", info.sessionID, info.id], info)
  },

  async upsertPart(part: MessageV2.Part): Promise<void> {
    await Storage.write(["part", part.messageID, part.id], part)
  },

  async upsertAttachmentBlob(blob: SessionStorage.AttachmentBlob): Promise<void> {
    await Storage.write(["attachment", blob.sessionID, blob.refID], encodeAttachmentBlob(blob))
  },

  async getAttachmentBlob(input: { sessionID: string; refID: string }): Promise<SessionStorage.AttachmentBlob> {
    const envelope = await Storage.read<LegacyAttachmentEnvelope>(["attachment", input.sessionID, input.refID])
    return decodeAttachmentBlob(envelope)
  },

  async listAttachmentBlobs(sessionID: string): Promise<SessionStorage.AttachmentBlobMetadata[]> {
    const result: SessionStorage.AttachmentBlobMetadata[] = []
    for (const item of await Storage.list(["attachment", sessionID])) {
      const envelope = await Storage.read<LegacyAttachmentEnvelope>(item)
      const { contentBase64: _contentBase64, ...metadata } = envelope
      void _contentBase64
      result.push(metadata)
    }
    result.sort((a, b) => (a.refID > b.refID ? 1 : -1))
    return result
  },

  async removeAttachmentBlob(input: { sessionID: string; refID: string }): Promise<void> {
    await Storage.remove(["attachment", input.sessionID, input.refID])
  },

  async deleteSession(sessionID: string): Promise<void> {
    // Best-effort recursive remove. Caller (Session.delete) owns Bus
    // event publication and any associated cleanup.
    for (const item of await Storage.list(["message", sessionID])) {
      const messageID = item[2]
      for (const partItem of await Storage.list(["part", messageID])) {
        await Storage.remove(partItem).catch(() => {})
      }
      await Storage.remove(["message", sessionID, messageID]).catch(() => {})
    }
    for (const item of await Storage.list(["attachment", sessionID])) {
      await Storage.remove(item).catch(() => {})
    }
  },
}

/**
 * Read a message info file directly. Used by callers that need the previous
 * value before an update (e.g. usage-delta tracking in Session.updateMessage)
 * without going through the full `get` (which also loads parts).
 */
export async function readMessageInfo(
  sessionID: string,
  messageID: string,
): Promise<MessageV2.Info | undefined> {
  return await Storage.read<MessageV2.Info>(["message", sessionID, messageID]).catch(() => undefined)
}

/**
 * Remove a single message info file. Parts are not touched here — callers
 * that need part cleanup should iterate `parts(messageID)` first or call
 * `removePartFile` per id. (Mirrors current Session.removeMessage which only
 * removes the info file.)
 */
export async function removeMessageInfo(sessionID: string, messageID: string): Promise<void> {
  await Storage.remove(["message", sessionID, messageID])
}

/**
 * Remove a single part file.
 */
export async function removePartFile(messageID: string, partID: string): Promise<void> {
  await Storage.remove(["part", messageID, partID])
}

/**
 * Write a part file directly. This is the underlying fs-write that
 * Session.updatePart's debounce path eventually calls. Exposed so the
 * debounced flush in Session can keep its current shape while the
 * underlying byte path moves through this module.
 */
export async function writePartFile(part: MessageV2.Part): Promise<void> {
  await Storage.write(["part", part.messageID, part.id], part)
}

/**
 * Read a single part file by its (messageID, partID). Used by share-render
 * paths that already know the part id and don't want to load the entire
 * part list of a message just to find one entry.
 */
export async function readPartFile<T = MessageV2.Part>(
  messageID: string,
  partID: string,
): Promise<T> {
  return await Storage.read<T>(["part", messageID, partID])
}
