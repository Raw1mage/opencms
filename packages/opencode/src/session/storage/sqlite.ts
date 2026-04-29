// SqliteStore — SQLite-backed implementation of SessionStorage.Backend.
//
// Spec: /specs/session-storage-db, tasks 2.5 / 2.6 / 2.7 / 2.8
// Cross-refs: DD-3 (WAL pragmas), DD-6 (tokens_total column), DD-9
// (signature compatibility), DD-10 (pool), DD-13 (no silent fallback),
// DR-1 (per-message commit), INV-3 (integrity-once), INV-6 (per-msg
// atomicity), INV-8 (forward-only schema).
//
// Behavior contract:
//   - acquire(sid) goes through ConnectionPool. Cold open runs the
//     onColdOpen hook which (a) runs MigrationRunner — bootstraps to
//     schema v1 if user_version=0, advances if behind — and (b) runs
//     IntegrityChecker. Order matters: migration first (so meta table
//     exists), integrity_check second. Both throw on failure; the open
//     fails fast and the pool entry is not retained.
//   - Per-message commit: upsertMessage + (any) upsertPart within the
//     same logical message must be each their own SQLite transaction.
//     Daemon kill between transactions = at most one in-flight message
//     lost; never half-formed.
//   - Encode/decode: promoted columns mirror data-schema.json. Fields
//     without a column round-trip via info_extra_json / payload_json.
//   - Reader handles (mode "ro") are not pooled — caller closes.
//
// Not in scope here:
//   - Bus event publication for read/write_failed (caller's policy)
//   - Router dispatch (task 3.1)

import { Database } from "bun:sqlite"

import type { MessageV2 } from "../message-v2"
import type { SessionStorage } from "./index"
import { ConnectionPool } from "./pool"
import { runIntegrityCheck } from "./integrity"
import { ensureSchema, TARGET_VERSION } from "./migration-runner"

// Cold-open ordering — migration first (creates meta on fresh DBs),
// then integrity. Both throw on failure; the caller's pool entry is
// not retained when onColdOpen rejects (Pool's documented behavior).
async function onColdOpen(db: Database, dbPath: string, sessionID: string): Promise<void> {
  await ensureSchema(db, sessionID, dbPath)
  void TARGET_VERSION
  await runIntegrityCheck(db, sessionID, dbPath)
}

async function acquireRW(sessionID: string): Promise<Database> {
  return ConnectionPool.acquire({
    sessionID,
    mode: "rw",
    onColdOpen: async (db, dbPath) => onColdOpen(db, dbPath, sessionID),
  })
}

// ── Encode helpers ──────────────────────────────────────────────────────

interface MessageRow {
  id: string
  role: "user" | "assistant"
  parent_id: string | null
  time_created: number
  time_completed: number | null
  model_id: string | null
  provider_id: string | null
  account_id: string | null
  mode: string | null
  agent: string | null
  finish: string | null
  tokens_input: number
  tokens_output: number
  tokens_total: number
  tokens_cache_read: number
  tokens_cache_write: number
  tokens_reasoning: number
  cost: number
  summary: number
  error_json: string | null
  info_extra_json: string
}

interface PartRow {
  id: string
  message_id: string
  sequence: number
  type: string
  payload_json: string
}

/**
 * Encode a MessageV2.Info to a row tuple. Promoted columns are extracted
 * by name; the residue (everything not promoted) round-trips via
 * info_extra_json. This is lossless: decode rebuilds the exact original
 * shape because info_extra_json carries every non-promoted field.
 */
function encodeMessageInfo(info: MessageV2.Info): MessageRow {
  if (info.role === "user") {
    const {
      id,
      sessionID: _sid,
      role: _r,
      time,
      agent,
      model,
      ...rest
    } = info
    void _sid
    void _r
    return {
      id,
      role: "user",
      parent_id: null,
      time_created: time.created,
      time_completed: null,
      model_id: model?.modelID ?? null,
      provider_id: model?.providerId ?? null,
      account_id: model?.accountId ?? null,
      mode: null,
      agent: agent,
      finish: null,
      tokens_input: 0,
      tokens_output: 0,
      tokens_total: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      tokens_reasoning: 0,
      cost: 0,
      summary: 0,
      error_json: null,
      info_extra_json: JSON.stringify(rest),
    }
  }

  // assistant
  const {
    id,
    sessionID: _sid,
    role: _r,
    time,
    parentID,
    modelID,
    providerId,
    accountId,
    mode,
    agent,
    finish,
    tokens,
    cost,
    summary,
    error,
    ...rest
  } = info
  void _sid
  void _r
  const totalDerived =
    typeof tokens.total === "number"
      ? tokens.total
      : tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
  return {
    id,
    role: "assistant",
    parent_id: parentID ?? null,
    time_created: time.created,
    time_completed: time.completed ?? null,
    model_id: modelID ?? null,
    provider_id: providerId ?? null,
    account_id: accountId ?? null,
    mode: mode ?? null,
    agent: agent,
    finish: finish ?? null,
    tokens_input: tokens.input,
    tokens_output: tokens.output,
    tokens_total: totalDerived,
    tokens_cache_read: tokens.cache.read,
    tokens_cache_write: tokens.cache.write,
    tokens_reasoning: tokens.reasoning,
    cost,
    summary: summary ? 1 : 0,
    error_json: error ? JSON.stringify(error) : null,
    info_extra_json: JSON.stringify(rest),
  }
}

/**
 * Decode a row back to MessageV2.Info. Reverse of encodeMessageInfo.
 */
function decodeMessageInfo(row: MessageRow, sessionID: string): MessageV2.Info {
  const extra = row.info_extra_json ? JSON.parse(row.info_extra_json) : {}
  if (row.role === "user") {
    return {
      ...extra,
      id: row.id,
      sessionID,
      role: "user",
      time: { created: row.time_created },
      agent: row.agent ?? extra.agent ?? "",
      model: row.model_id || row.provider_id
        ? {
            modelID: row.model_id ?? "",
            providerId: row.provider_id ?? "",
            ...(row.account_id ? { accountId: row.account_id } : {}),
          }
        : extra.model,
    } as MessageV2.User
  }
  return {
    ...extra,
    id: row.id,
    sessionID,
    role: "assistant",
    time: {
      created: row.time_created,
      ...(row.time_completed != null ? { completed: row.time_completed } : {}),
    },
    parentID: row.parent_id ?? "",
    modelID: row.model_id ?? "",
    providerId: row.provider_id ?? "",
    ...(row.account_id ? { accountId: row.account_id } : {}),
    mode: row.mode ?? "",
    agent: row.agent ?? "",
    ...(row.finish ? { finish: row.finish } : {}),
    tokens: {
      total: row.tokens_total,
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    cost: row.cost,
    ...(row.summary === 1 ? { summary: true } : {}),
    ...(row.error_json ? { error: JSON.parse(row.error_json) } : {}),
  } as MessageV2.Assistant
}

function encodePart(part: MessageV2.Part, sequence: number): PartRow {
  return {
    id: part.id,
    message_id: part.messageID,
    sequence,
    type: part.type,
    payload_json: JSON.stringify(part),
  }
}

function decodePart(row: PartRow): MessageV2.Part {
  return JSON.parse(row.payload_json) as MessageV2.Part
}

// ── Backend implementation ──────────────────────────────────────────────

const SQL_INSERT_MESSAGE = `
INSERT INTO messages (
  id, role, parent_id, time_created, time_completed,
  model_id, provider_id, account_id, mode, agent, finish,
  tokens_input, tokens_output, tokens_total, tokens_cache_read, tokens_cache_write, tokens_reasoning,
  cost, summary, error_json, info_extra_json
) VALUES (
  $id, $role, $parent_id, $time_created, $time_completed,
  $model_id, $provider_id, $account_id, $mode, $agent, $finish,
  $tokens_input, $tokens_output, $tokens_total, $tokens_cache_read, $tokens_cache_write, $tokens_reasoning,
  $cost, $summary, $error_json, $info_extra_json
)
ON CONFLICT(id) DO UPDATE SET
  role = excluded.role,
  parent_id = excluded.parent_id,
  time_created = excluded.time_created,
  time_completed = excluded.time_completed,
  model_id = excluded.model_id,
  provider_id = excluded.provider_id,
  account_id = excluded.account_id,
  mode = excluded.mode,
  agent = excluded.agent,
  finish = excluded.finish,
  tokens_input = excluded.tokens_input,
  tokens_output = excluded.tokens_output,
  tokens_total = excluded.tokens_total,
  tokens_cache_read = excluded.tokens_cache_read,
  tokens_cache_write = excluded.tokens_cache_write,
  tokens_reasoning = excluded.tokens_reasoning,
  cost = excluded.cost,
  summary = excluded.summary,
  error_json = excluded.error_json,
  info_extra_json = excluded.info_extra_json
`

// Stream order MUST match LegacyStore — newest first (id DESC).
// Downstream filterCompacted assumes DESC input and reverses to produce
// ASC output; prompt.ts then walks backward to find latest user. If we
// give ASC here, filterCompacted's reverse turns it into DESC, and the
// walk lands on the OLDEST user — which silently breaks every multi-turn
// session. (Diagnosed 2026-04-29 from cross-turn parent_id corruption.)
const SQL_LIST_MESSAGES = `SELECT * FROM messages ORDER BY id DESC`
const SQL_GET_MESSAGE = `SELECT * FROM messages WHERE id = $id`
const SQL_LIST_PARTS = `SELECT * FROM parts WHERE message_id = $message_id ORDER BY sequence ASC, id ASC`
const SQL_DELETE_MESSAGE = `DELETE FROM messages WHERE id = $id`
const SQL_DELETE_ALL_PARTS = `DELETE FROM parts`
const SQL_DELETE_ALL_MESSAGES = `DELETE FROM messages`
const SQL_PART_EXISTING_SEQ = `SELECT sequence FROM parts WHERE id = $id`
const SQL_PART_NEXT_SEQ = `SELECT COALESCE(MAX(sequence) + 1, 0) AS next FROM parts WHERE message_id = $message_id`
const SQL_INSERT_PART = `
INSERT INTO parts (id, message_id, sequence, type, payload_json)
VALUES ($id, $message_id, $sequence, $type, $payload_json)
ON CONFLICT(id) DO UPDATE SET
  type = excluded.type,
  payload_json = excluded.payload_json
`

export const SqliteStore: SessionStorage.Backend = {
  async *stream(sessionID: string): AsyncIterable<MessageV2.WithParts> {
    const db = await acquireRW(sessionID)
    const rows = db.query<MessageRow, []>(SQL_LIST_MESSAGES).all()
    for (const row of rows) {
      const info = decodeMessageInfo(row, sessionID)
      const partRows = db
        .query<PartRow, { $message_id: string }>(SQL_LIST_PARTS)
        .all({ $message_id: row.id })
      yield { info, parts: partRows.map(decodePart) }
    }
  },

  async get(input: { sessionID: string; messageID: string }): Promise<MessageV2.WithParts> {
    const db = await acquireRW(input.sessionID)
    const row = db
      .query<MessageRow, { $id: string }>(SQL_GET_MESSAGE)
      .get({ $id: input.messageID })
    if (!row) {
      throw new Error(`SqliteStore.get: message not found ${input.messageID} in ${input.sessionID}`)
    }
    const info = decodeMessageInfo(row, input.sessionID)
    const partRows = db
      .query<PartRow, { $message_id: string }>(SQL_LIST_PARTS)
      .all({ $message_id: row.id })
    return { info, parts: partRows.map(decodePart) }
  },

  async parts(messageID: string, sessionID?: string): Promise<MessageV2.Part[]> {
    if (!sessionID) {
      // SqliteStore needs to know which DB to open. Per Backend
      // interface, sessionID is optional — but for SQLite it is
      // required. Throw rather than silently scan all DBs (DD-13).
      throw new Error(
        `SqliteStore.parts requires sessionID. Got messageID=${messageID} only. ` +
          `Caller must thread sessionID through (Router does this automatically in task 3.1).`,
      )
    }
    const db = await acquireRW(sessionID)
    const rows = db
      .query<PartRow, { $message_id: string }>(SQL_LIST_PARTS)
      .all({ $message_id: messageID })
    return rows.map(decodePart)
  },

  async upsertMessage(info: MessageV2.Info): Promise<void> {
    const db = await acquireRW(info.sessionID)
    const row = encodeMessageInfo(info)
    db.transaction(() => {
      db.query(SQL_INSERT_MESSAGE).run({
        $id: row.id,
        $role: row.role,
        $parent_id: row.parent_id,
        $time_created: row.time_created,
        $time_completed: row.time_completed,
        $model_id: row.model_id,
        $provider_id: row.provider_id,
        $account_id: row.account_id,
        $mode: row.mode,
        $agent: row.agent,
        $finish: row.finish,
        $tokens_input: row.tokens_input,
        $tokens_output: row.tokens_output,
        $tokens_total: row.tokens_total,
        $tokens_cache_read: row.tokens_cache_read,
        $tokens_cache_write: row.tokens_cache_write,
        $tokens_reasoning: row.tokens_reasoning,
        $cost: row.cost,
        $summary: row.summary,
        $error_json: row.error_json,
        $info_extra_json: row.info_extra_json,
      })
    })()
  },

  async upsertPart(part: MessageV2.Part): Promise<void> {
    // PartBase carries sessionID — no resolution needed.
    const db = await acquireRW(part.sessionID)
    db.transaction(() => {
      let sequence: number
      const existing = db
        .query<{ sequence: number }, { $id: string }>(SQL_PART_EXISTING_SEQ)
        .get({ $id: part.id })
      if (existing) {
        sequence = existing.sequence
      } else {
        const next = db
          .query<{ next: number }, { $message_id: string }>(SQL_PART_NEXT_SEQ)
          .get({ $message_id: part.messageID })
        sequence = next?.next ?? 0
      }
      const row = encodePart(part, sequence)
      db.query(SQL_INSERT_PART).run({
        $id: row.id,
        $message_id: row.message_id,
        $sequence: row.sequence,
        $type: row.type,
        $payload_json: row.payload_json,
      })
    })()
  },

  async deleteSession(sessionID: string): Promise<void> {
    // Close the pool entry first so no concurrent writer holds the file
    // open; then delete the .db (and any sidecar -wal / -shm) on disk.
    // FK ON DELETE CASCADE on parts → only need to clear messages, but
    // we explicitly clear both in one transaction for symmetry (and so
    // an interrupted call leaves an empty-but-valid DB rather than a
    // half-truncated one).
    const dbPath = ConnectionPool.resolveDbPath(sessionID)
    const db = await acquireRW(sessionID)
    db.transaction(() => {
      db.exec(SQL_DELETE_ALL_PARTS)
      db.exec(SQL_DELETE_ALL_MESSAGES)
    })()
    ConnectionPool.close(sessionID)
    // File-level removal is the caller's job (Session.delete handles
    // the directory namespace). We do NOT unlink the .db here — that
    // is policy, not storage primitive. Caller can rm if it wants.
    void SQL_DELETE_MESSAGE
    void dbPath
  },
}

