// v1 — initial SQLite schema for session storage.
//
// Spec: /specs/session-storage-db/data-schema.json (v1).
// Task: 2.1.
//
// Tables: messages, parts, meta.
// Pragmas applied at every connection open by the SqliteStore (DD-3).
// Column choice mirrors data-schema.json verbatim — promoting tokens_*,
// summary, finish, etc. to columns is what makes filterCompacted's
// "no JSON.stringify" path possible (DD-6).

import type { Database } from "bun:sqlite"

export const VERSION = 1 as const

const DDL_MESSAGES = `
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  parent_id TEXT,
  time_created INTEGER NOT NULL,
  time_completed INTEGER,
  model_id TEXT,
  provider_id TEXT,
  account_id TEXT,
  mode TEXT,
  agent TEXT,
  finish TEXT,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_total INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  summary INTEGER NOT NULL DEFAULT 0,
  error_json TEXT,
  info_extra_json TEXT NOT NULL DEFAULT '{}'
)
`

const DDL_PARTS = `
CREATE TABLE parts (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
)
`

const DDL_META = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
)
`

const INDEXES = [
  "CREATE INDEX idx_messages_parent ON messages(parent_id)",
  "CREATE INDEX idx_messages_role_id ON messages(role, id)",
  "CREATE INDEX idx_messages_summary ON messages(summary) WHERE summary = 1",
  "CREATE INDEX idx_parts_message ON parts(message_id, sequence)",
  "CREATE INDEX idx_parts_type ON parts(type)",
] as const

/**
 * Apply v1 schema to a fresh database. Caller wraps in a transaction.
 * Idempotent only against truly-empty databases — running twice will
 * fail at CREATE TABLE because the tables already exist. The
 * MigrationRunner's user_version check is the gate against double-apply.
 */
export function applyV1(db: Database): void {
  db.exec(DDL_MESSAGES)
  db.exec(DDL_PARTS)
  db.exec(DDL_META)
  for (const stmt of INDEXES) db.exec(stmt)
}

/**
 * Rollback v1 schema. For the initial version this is "drop everything";
 * its real value is exercising the rollback contract via unit tests so the
 * pattern is in place when v2+ migrations land (R-5 / DR-5).
 */
export function rollbackV1(db: Database): void {
  db.exec("DROP INDEX IF EXISTS idx_parts_type")
  db.exec("DROP INDEX IF EXISTS idx_parts_message")
  db.exec("DROP INDEX IF EXISTS idx_messages_summary")
  db.exec("DROP INDEX IF EXISTS idx_messages_role_id")
  db.exec("DROP INDEX IF EXISTS idx_messages_parent")
  db.exec("DROP TABLE IF EXISTS meta")
  db.exec("DROP TABLE IF EXISTS parts")
  db.exec("DROP TABLE IF EXISTS messages")
}
