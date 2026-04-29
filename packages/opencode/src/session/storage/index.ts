// Session storage subsystem.
//
// Owns per-session persistence. Per spec /specs/session-storage-db, this
// subsystem replaces the directory-of-small-files layout with one SQLite
// file per session, while a dual-track router keeps legacy directories
// readable until DreamingWorker migrates them.
//
// This file is the public seam. Concrete backends (LegacyStore, SqliteStore)
// and the Router live in sibling files added in later phases.

import type { MessageV2 } from "../message-v2"

export namespace SessionStorage {
  /**
   * Storage backend contract. Both LegacyStore (filesystem walk) and
   * SqliteStore (SQL queries) implement this. Router dispatches per call.
   *
   * Signatures intentionally mirror the existing call surface in
   * message-v2.ts (stream/parts/get) and session/index.ts (updateMessage/
   * updatePart) so callers don't need to change shape — DD-9.
   */
  export interface Backend {
    /**
     * Yield messages for a session in ascending id order. Implementations
     * must lazily load parts (callers iterate, not materialize-all).
     */
    stream(sessionID: string): AsyncIterable<MessageV2.WithParts>

    /** Read one message + all its parts. */
    get(input: { sessionID: string; messageID: string }): Promise<MessageV2.WithParts>

    /**
     * Read parts for one message in render order.
     *
     * `sessionID` is optional for back-compat with the legacy filesystem
     * surface (where messageID alone identifies the on-disk path). The
     * SqliteStore requires it because parts live inside the per-session
     * DB; calling SqliteStore.parts without sessionID throws. The Router
     * (task 3.1) always supplies it.
     */
    parts(messageID: string, sessionID?: string): Promise<MessageV2.Part[]>

    /** Insert or update a message info row. */
    upsertMessage(info: MessageV2.Info): Promise<void>

    /** Insert or update a part row. */
    upsertPart(part: MessageV2.Part): Promise<void>

    /** Remove an entire session and all its data. */
    deleteSession(sessionID: string): Promise<void>
  }

  /**
   * Format detection hint used by the Router. Concrete detection logic
   * lands in router.ts (task 3.1).
   */
  export type Format = "legacy" | "sqlite"
}
