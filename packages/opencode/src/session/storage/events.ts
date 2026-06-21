// Bus event definitions for session-storage subsystem.
//
// Spec: /specs/session-storage-db/observability.md.
// Tasks: 2.3, 2.4, 5.4, 7.1.
//
// Events are subscribed by structured logger, admin panel sidebar, and
// (where applicable) Grafana exporters.

import z from "zod"
import { BusEvent } from "@/bus/bus-event"

export namespace SessionStorageEvent {
  export const Corrupted = BusEvent.define(
    "session.storage.corrupted",
    z.object({
      sessionID: z.string(),
      integrityCheckOutput: z.string(),
      dbPath: z.string(),
      timestamp: z.number(),
    }),
  )

  export const MigrationFailed = BusEvent.define(
    "session.storage.migration_failed",
    z.object({
      sessionID: z.string(),
      stage: z.enum(["read", "tmp_write", "integrity_check", "row_count", "rename", "legacy_delete"]),
      error: z.string(),
      timestamp: z.number(),
    }),
  )

  export const ReadFailed = BusEvent.define(
    "session.storage.read_failed",
    z.object({
      sessionID: z.string(),
      operation: z.string(),
      error: z.string(),
      timestamp: z.number(),
    }),
  )

  export const WriteFailed = BusEvent.define(
    "session.storage.write_failed",
    z.object({
      sessionID: z.string(),
      operation: z.string(),
      error: z.string(),
      timestamp: z.number(),
    }),
  )
}
