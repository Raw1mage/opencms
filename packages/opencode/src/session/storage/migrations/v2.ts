// v2 — session-scoped oversized attachment blob storage.

import type { Database } from "bun:sqlite"

export const VERSION = 2 as const

const DDL_ATTACHMENTS = `
CREATE TABLE attachments (
  ref_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT,
  part_id TEXT,
  mime TEXT NOT NULL,
  filename TEXT,
  byte_size INTEGER NOT NULL,
  est_tokens INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY (session_id, ref_id)
)
`

const INDEXES = [
  "CREATE INDEX idx_attachments_session ON attachments(session_id, ref_id)",
  "CREATE INDEX idx_attachments_message ON attachments(message_id) WHERE message_id IS NOT NULL",
] as const

export function applyV2(db: Database): void {
  db.exec(DDL_ATTACHMENTS)
  for (const stmt of INDEXES) db.exec(stmt)
}

export function rollbackV2(db: Database): void {
  db.exec("DROP INDEX IF EXISTS idx_attachments_message")
  db.exec("DROP INDEX IF EXISTS idx_attachments_session")
  db.exec("DROP TABLE IF EXISTS attachments")
}
