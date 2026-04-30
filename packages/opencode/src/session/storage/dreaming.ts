import { Database } from "bun:sqlite"
import fsp from "fs/promises"
import path from "path"

import { Bus } from "@/bus"
import { Tweaks } from "@/config/tweaks"
import { Log } from "@/util/log"

import type { MessageV2 } from "../message-v2"
import { SessionStorageEvent } from "./events"
import { runIntegrityCheckUncached } from "./integrity"
import { LegacyStore } from "./legacy"
import { ensureSchema } from "./migration-runner"
import { SessionStorageMetrics } from "./metrics"
import { ConnectionPool } from "./pool"
import { drainLegacyDebris } from "./router"

const log = Log.create({ service: "session.storage" })

const DEFAULT_TICK_MS = 5_000

type MigrationStage = "read" | "tmp_write" | "integrity_check" | "row_count" | "rename" | "legacy_delete"

export interface DreamingWorkerOptions {
  tickMs?: number
  idleThresholdMs?: number
  connectionIdleMs?: number
  now?: () => number
  hooks?: DreamingWorker.TestHooks
}

interface LegacyCandidate {
  sessionID: string
  touchedMs: number
}

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
`

const SQL_INSERT_PART = `
INSERT INTO parts (id, message_id, sequence, type, payload_json)
VALUES ($id, $message_id, $sequence, $type, $payload_json)
`

function sessionRoot(): string {
  return path.dirname(ConnectionPool.resolveDbPath("ses_dreaming_probe"))
}

function legacySessionDir(sessionID: string): string {
  return path.join(sessionRoot(), sessionID)
}

function legacyMessagesDir(sessionID: string): string {
  return path.join(legacySessionDir(sessionID), "messages")
}

function tmpDbPath(sessionID: string): string {
  return ConnectionPool.resolveDbPath(sessionID) + ".tmp"
}

function tmpSidecars(sessionID: string): string[] {
  const tmp = tmpDbPath(sessionID)
  return [tmp, tmp + "-wal", tmp + "-shm"]
}

async function exists(p: string): Promise<boolean> {
  return await fsp
    .stat(p)
    .then(() => true)
    .catch(() => false)
}

async function rmTmp(sessionID: string): Promise<void> {
  for (const p of tmpSidecars(sessionID)) await fsp.rm(p, { force: true }).catch(() => {})
}

function encodeMessageInfo(info: MessageV2.Info): MessageRow {
  if (info.role === "user") {
    const { id, sessionID: _sid, role: _role, time, agent, model, ...rest } = info
    void _sid
    void _role
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
      agent,
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

  const {
    id,
    sessionID: _sid,
    role: _role,
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
  void _role
  const total =
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
    agent,
    finish: finish ?? null,
    tokens_input: tokens.input,
    tokens_output: tokens.output,
    tokens_total: total,
    tokens_cache_read: tokens.cache.read,
    tokens_cache_write: tokens.cache.write,
    tokens_reasoning: tokens.reasoning,
    cost,
    summary: summary ? 1 : 0,
    error_json: error ? JSON.stringify(error) : null,
    info_extra_json: JSON.stringify(rest),
  }
}

// Pruning thresholds. Anything above this gets sanitized so a rogue tool
// output (e.g., apply_patch capturing a 300MB ELF binary as diff text)
// can't blow SQLite's 1GB cell limit and block the entire dream queue.
//
// Philosophy (user-confirmed 2026-04-30): conversation logic — user/
// assistant text, reasoning, tool inputs, short tool outputs — is the
// real value. Long tool outputs and binary diffs are transient by-
// products that have no retrospective worth, even for the AI itself.
const PRUNE_PART_BYTES = 256 * 1024 // trigger threshold
const PRUNE_OUTPUT_HEAD = 1024
const PRUNE_OUTPUT_TAIL = 1024

interface PruneStats {
  partsPruned: number
  bytesSaved: number
}

function pruneLargeStringField(holder: Record<string, any>, key: string, label: string): boolean {
  const value = holder[key]
  if (typeof value !== "string" || value.length <= PRUNE_OUTPUT_HEAD * 2) return false
  holder[key] = `[dream-pruned: dropped ${value.length.toLocaleString()} bytes of ${label}]`
  return true
}

function pruneToolMetadata(metadata: Record<string, any>): boolean {
  let changed = false
  changed = pruneLargeStringField(metadata, "diff", "diff") || changed
  if (Array.isArray(metadata.files)) {
    for (const file of metadata.files) {
      if (!file || typeof file !== "object") continue
      const entry = file as Record<string, any>
      let entryChanged = false
      entryChanged = pruneLargeStringField(entry, "diff", "file diff") || entryChanged
      entryChanged = pruneLargeStringField(entry, "before", "file before snapshot") || entryChanged
      entryChanged = pruneLargeStringField(entry, "after", "file after snapshot") || entryChanged
      if (entryChanged) entry.dreamPruned = true
      changed = entryChanged || changed
    }
  }
  if (changed) metadata.dreamPruned = true
  return changed
}

function prunePart(part: MessageV2.Part, stats: PruneStats): MessageV2.Part {
  const original = JSON.stringify(part)
  if (original.length <= PRUNE_PART_BYTES) return part
  const before = original.length
  // Tool parts: drop oversized diff payloads entirely; truncate
  // state.output to head + tail. Keep input + title — the decision
  // trail and display string. Older apply_patch tool parts may carry
  // the diff under state.metadata.diff rather than top-level metadata.diff.
  if (part.type === "tool") {
    const cloned = JSON.parse(original) as typeof part & {
      metadata?: Record<string, unknown> & { dreamPruned?: boolean; diff?: unknown }
      state: typeof part.state & {
        output?: unknown
        metadata?: Record<string, unknown> & { dreamPruned?: boolean; diff?: unknown }
      }
    }
    const m = (cloned.metadata ?? {}) as Record<string, any>
    pruneToolMetadata(m)
    const state = cloned.state as {
      output?: unknown
      metadata?: Record<string, any> & { dreamPruned?: boolean; diff?: unknown }
    }
    if (state.metadata) pruneToolMetadata(state.metadata)
    if (typeof state.output === "string" && state.output.length > PRUNE_OUTPUT_HEAD + PRUNE_OUTPUT_TAIL + 64) {
      const s = state.output
      state.output =
        s.slice(0, PRUNE_OUTPUT_HEAD) +
        `\n... [dream-pruned: ${(s.length - PRUNE_OUTPUT_HEAD - PRUNE_OUTPUT_TAIL).toLocaleString()} bytes truncated] ...\n` +
        s.slice(-PRUNE_OUTPUT_TAIL)
    }
    m.dreamPruned = true
    cloned.metadata = m
    const after = JSON.stringify(cloned).length
    if (after < before) {
      stats.partsPruned++
      stats.bytesSaved += before - after
      return cloned as MessageV2.Part
    }
  }
  // Text part with bloated metadata (e.g., raw provider response body).
  // Strip non-record metadata values per the AI SDK contract; cap any
  // remaining string fields hard.
  if (part.type === "text" || part.type === "reasoning") {
    const cloned = JSON.parse(original) as typeof part & {
      metadata?: Record<string, any> & { dreamPruned?: boolean }
    }
    if (cloned.metadata) {
      const m = cloned.metadata as Record<string, any>
      for (const [k, v] of Object.entries(m)) {
        if (typeof v === "string" && v.length > PRUNE_OUTPUT_HEAD * 2) {
          m[k] = `[dream-pruned: ${v.length.toLocaleString()} bytes]`
        }
      }
      m.dreamPruned = true
    }
    const after = JSON.stringify(cloned).length
    if (after < before) {
      stats.partsPruned++
      stats.bytesSaved += before - after
      return cloned as MessageV2.Part
    }
  }
  return part
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

async function publishFailed(sessionID: string, stage: MigrationStage, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  const outcome =
    stage === "row_count" ? "row_count_mismatch" : stage === "integrity_check" ? "integrity_failed" : "failed"
  SessionStorageMetrics.increment("migrations_total", { outcome })
  log.error("migration.aborted", { sessionID, stage, error: message })
  await Bus.publish(SessionStorageEvent.MigrationFailed, {
    sessionID,
    stage,
    error: message,
    timestamp: Date.now(),
  }).catch(() => {})
}

async function readLegacySnapshot(sessionID: string): Promise<MessageV2.WithParts[]> {
  const messages: MessageV2.WithParts[] = []
  for await (const message of LegacyStore.stream(sessionID)) messages.push(message)
  return messages
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

async function ensureTmpMaterialized(db: Database, tmp: string): Promise<void> {
  if (await exists(tmp)) return
  db.exec(`VACUUM INTO ${quoteSqlString(tmp)}`)
  if (!(await exists(tmp))) throw new Error(`SQLite did not materialize tmp database at ${tmp}`)
}

async function writeSnapshot(input: {
  sessionID: string
  messages: MessageV2.WithParts[]
  hooks?: DreamingWorker.TestHooks
}): Promise<void> {
  const tmp = tmpDbPath(input.sessionID)
  await rmTmp(input.sessionID)
  await fsp.mkdir(path.dirname(tmp), { recursive: true })
  const db = new Database(tmp, { create: true })
  try {
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA synchronous = NORMAL")
    db.exec("PRAGMA foreign_keys = ON")
    await ensureSchema(db, input.sessionID, tmp)

    const pruneStats: PruneStats = { partsPruned: 0, bytesSaved: 0 }
    const transaction = db.transaction(() => {
      const insertMessage = db.query(SQL_INSERT_MESSAGE)
      const insertPart = db.query(SQL_INSERT_PART)
      for (const message of input.messages) {
        const row = encodeMessageInfo(message.info)
        insertMessage.run({
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
        for (let i = 0; i < message.parts.length; i++) {
          const pruned = prunePart(message.parts[i], pruneStats)
          const part = encodePart(pruned, i)
          insertPart.run({
            $id: part.id,
            $message_id: part.message_id,
            $sequence: part.sequence,
            $type: part.type,
            $payload_json: part.payload_json,
          })
        }
      }
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        "migrated_from_legacy",
        new Date().toISOString(),
      )
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        "legacy_message_count",
        String(input.messages.length),
      )
      if (pruneStats.partsPruned > 0) {
        db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
          "dream_pruned_parts",
          String(pruneStats.partsPruned),
        )
        db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
          "dream_pruned_bytes",
          String(pruneStats.bytesSaved),
        )
      }
    })
    transaction()
    if (pruneStats.partsPruned > 0) {
      log.info("dreaming.pruned", {
        sessionID: input.sessionID,
        partsPruned: pruneStats.partsPruned,
        bytesSaved: pruneStats.bytesSaved,
      })
    }
    await input.hooks?.afterTmpWrite?.(input.sessionID, tmp)
    await ensureTmpMaterialized(db, tmp)
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } finally {
    db.close()
  }
  const handle = await fsp.open(tmp, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function verifyTmp(input: {
  sessionID: string
  legacyCount: number
  hooks?: DreamingWorker.TestHooks
}): Promise<number> {
  const tmp = tmpDbPath(input.sessionID)
  await input.hooks?.beforeIntegrityCheck?.(input.sessionID, tmp)
  const db = new Database(tmp, { readonly: true, create: false })
  try {
    const verdict = await runIntegrityCheckUncached(db, input.sessionID, tmp)
    if (verdict !== "ok") throw new Error(verdict)
    let sqliteCount = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM messages").get()?.c ?? 0
    if (input.hooks?.overrideSqliteRowCount) sqliteCount = input.hooks.overrideSqliteRowCount(sqliteCount)
    if (sqliteCount !== input.legacyCount) {
      throw new Error(`SQLite row count ${sqliteCount} does not match legacy message count ${input.legacyCount}`)
    }
    return sqliteCount
  } finally {
    db.close()
  }
}

export class DreamingWorker {
  private timer: ReturnType<typeof setInterval> | undefined
  private lastMessageWriteMs: number
  private running = false
  private readonly tickMs: number
  private readonly idleThresholdMs: number
  private readonly now: () => number
  private readonly hooks: DreamingWorker.TestHooks | undefined
  // Per-process telemetry — surfaces via /dream_status. Reset on daemon
  // restart; not persisted to disk (the canonical state is the .db /
  // legacy-dir filesystem layout itself).
  private lastTickAt: number | undefined
  private lastMigratedSessionID: string | undefined
  private currentMigrationSessionID: string | undefined
  private migrationsThisProcess = 0
  private lastError: string | undefined
  // Sessions whose migration failed in a way that's pointless to retry
  // automatically (e.g. SQLite "string or blob too big" — a single part
  // exceeds the 1 GB cell limit). Without a blocklist the worker would
  // pick the same broken session at every tick and never advance to
  // the rest of the queue. The list is per-process; daemon restart
  // re-tries everything (and a code-side fix for oversized parts will
  // need to land separately before they can ever migrate).
  private blockedSessionIDs = new Set<string>()
  private blockedSessionReasons = new Map<string, string>()

  constructor(options: DreamingWorkerOptions = {}) {
    const storageTweaks = Tweaks.sessionStorageSync()
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS
    this.idleThresholdMs = options.idleThresholdMs ?? storageTweaks.idleThresholdMs
    this.now = options.now ?? Date.now
    this.hooks = options.hooks
    this.lastMessageWriteMs = this.now()
    ConnectionPool.configure({ idleMs: options.connectionIdleMs ?? storageTweaks.connectionIdleMs })
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch((err) =>
        log.error("dreaming.tick_failed", { error: err instanceof Error ? err.message : String(err) }),
      )
    }, this.tickMs)
    if (typeof (this.timer as unknown as { unref?: () => void }).unref === "function") {
      ;(this.timer as unknown as { unref(): void }).unref()
    }
  }

  isRunning(): boolean {
    return this.timer !== undefined
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  noteMessageWrite(): void {
    this.lastMessageWriteMs = this.now()
  }

  async tick(): Promise<{ migrated?: string; skipped: boolean }> {
    if (this.running) return { skipped: true }
    this.lastTickAt = this.now()
    const idleForMs = this.now() - this.lastMessageWriteMs
    if (idleForMs < this.idleThresholdMs) {
      log.info("dreaming.skipped_active_writes", { active_writer_count: 1 })
      return { skipped: true }
    }

    this.running = true
    try {
      await DreamingWorker.cleanupStartup()
      await drainLegacyDebris()
      const candidates = await DreamingWorker.scanLegacySessions()
      SessionStorageMetrics.gauge("legacy_sessions_pending_count", candidates.length)
      // Pick the first candidate that isn't on the blocklist. If every
      // remaining candidate is blocked, this tick is a no-op until the
      // daemon restarts (which clears the in-memory list) or a code fix
      // ships for the underlying limit.
      const picked = candidates.find((c) => !this.blockedSessionIDs.has(c.sessionID))?.sessionID
      log.info("dreaming.tick", {
        idle_for_ms: idleForMs,
        pending_count: candidates.length,
        blocked_count: this.blockedSessionIDs.size,
        picked_session_id: picked,
      })
      if (!picked) return { skipped: true }
      this.currentMigrationSessionID = picked
      try {
        await this.migrateSession(picked)
        this.lastMigratedSessionID = picked
        this.migrationsThisProcess++
        this.lastError = undefined
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        this.lastError = errMsg
        // Auto-blocklist on size-class errors that won't change without
        // a code fix. The session stays on disk; user can investigate.
        if (
          errMsg.includes("string or blob too big") ||
          errMsg.includes("too large") ||
          errMsg.includes("size limit")
        ) {
          this.blockedSessionIDs.add(picked)
          this.blockedSessionReasons.set(picked, errMsg)
          log.warn("dreaming.blocklisted_session", { sessionID: picked, reason: errMsg })
        }
        throw err
      } finally {
        this.currentMigrationSessionID = undefined
      }
      return { migrated: picked, skipped: false }
    } finally {
      this.running = false
    }
  }

  /**
   * Snapshot of per-process telemetry. Surfaces via /dream_status. The
   * canonical "how many done" answer is the count of `<sid>.db` files
   * on disk — `migrationsThisProcess` is just what THIS process has
   * advanced since boot.
   */
  getStatus() {
    return {
      running: this.timer !== undefined,
      tickInFlight: this.running,
      tickMs: this.tickMs,
      idleThresholdMs: this.idleThresholdMs,
      lastTickAt: this.lastTickAt,
      lastMessageWriteMs: this.lastMessageWriteMs,
      lastMigratedSessionID: this.lastMigratedSessionID,
      currentMigrationSessionID: this.currentMigrationSessionID,
      migrationsThisProcess: this.migrationsThisProcess,
      lastError: this.lastError,
      blocked: Array.from(this.blockedSessionIDs).map((sid) => ({
        sessionID: sid,
        reason: this.blockedSessionReasons.get(sid) ?? "unknown",
      })),
    }
  }

  async migrateSession(sessionID: string): Promise<void> {
    return DreamingWorker.migrateSession(sessionID, { hooks: this.hooks })
  }

  static async cleanupStartup(): Promise<{ deletedTmp: string[] }> {
    const root = sessionRoot()
    const deletedTmp: string[] = []
    if (!(await exists(root))) return { deletedTmp }
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".db.tmp")) continue
      const sessionID = entry.name.slice(0, -".db.tmp".length)
      if (await exists(legacyMessagesDir(sessionID))) {
        await rmTmp(sessionID)
        deletedTmp.push(sessionID)
      }
    }
    return { deletedTmp }
  }

  static async scanLegacySessions(): Promise<LegacyCandidate[]> {
    const root = sessionRoot()
    if (!(await exists(root))) return []
    const out: LegacyCandidate[] = []
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sessionID = entry.name
      const messagesDir = legacyMessagesDir(sessionID)
      if (!(await exists(messagesDir))) continue
      if (await exists(ConnectionPool.resolveDbPath(sessionID))) continue
      const stat = await fsp.stat(messagesDir)
      out.push({ sessionID, touchedMs: stat.mtimeMs })
    }
    out.sort((a, b) => a.touchedMs - b.touchedMs || a.sessionID.localeCompare(b.sessionID))
    return out
  }

  /**
   * Count of migrated sessions (sibling `<sid>.db` files in the storage
   * root). Cheap directory listing — no DB opens.
   */
  static async countMigrated(): Promise<number> {
    const root = sessionRoot()
    if (!(await exists(root))) return 0
    let count = 0
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".db") && !entry.name.endsWith(".db.tmp")) count++
    }
    return count
  }

  static async migrateSession(sessionID: string, options: { hooks?: DreamingWorker.TestHooks } = {}): Promise<void> {
    const start = Date.now()
    let snapshot: MessageV2.WithParts[]
    try {
      snapshot = await readLegacySnapshot(sessionID)
    } catch (err) {
      await publishFailed(sessionID, "read", err)
      throw err
    }
    await Bus.publish(SessionStorageEvent.MigrationStarted, {
      sessionID,
      legacyMessageCount: snapshot.length,
      timestamp: Date.now(),
    }).catch(() => {})
    log.info("migration.started", { sessionID, legacy_message_count: snapshot.length })

    try {
      await writeSnapshot({ sessionID, messages: snapshot, hooks: options.hooks })
      SessionStorageMetrics.observeMs("migrate_stage_ms", Date.now() - start, { stage: "tmp_write" })
      log.info("migration.stage", { sessionID, stage: "tmp_write", duration_ms: Date.now() - start })
    } catch (err) {
      await rmTmp(sessionID)
      await publishFailed(sessionID, "tmp_write", err)
      throw err
    }

    let sqliteRowCount: number
    try {
      sqliteRowCount = await verifyTmp({ sessionID, legacyCount: snapshot.length, hooks: options.hooks })
      SessionStorageMetrics.observeMs("migrate_stage_ms", Date.now() - start, { stage: "integrity_check" })
      log.info("migration.stage", { sessionID, stage: "integrity_check", duration_ms: Date.now() - start })
    } catch (err) {
      await rmTmp(sessionID)
      const stage = String(err instanceof Error ? err.message : err).includes("row count")
        ? "row_count"
        : "integrity_check"
      await publishFailed(sessionID, stage, err)
      throw err
    }

    try {
      await options.hooks?.beforeRename?.(sessionID, tmpDbPath(sessionID))
      await fsp.rename(tmpDbPath(sessionID), ConnectionPool.resolveDbPath(sessionID))
      for (const p of [tmpDbPath(sessionID) + "-wal", tmpDbPath(sessionID) + "-shm"])
        await fsp.rm(p, { force: true }).catch(() => {})
      await options.hooks?.afterRename?.(sessionID, ConnectionPool.resolveDbPath(sessionID))
      SessionStorageMetrics.observeMs("migrate_stage_ms", Date.now() - start, { stage: "rename" })
      log.info("migration.stage", { sessionID, stage: "rename", duration_ms: Date.now() - start })
    } catch (err) {
      await publishFailed(sessionID, "rename", err)
      throw err
    }

    try {
      await fsp.rm(legacySessionDir(sessionID), { recursive: true, force: true })
      SessionStorageMetrics.observeMs("migrate_stage_ms", Date.now() - start, { stage: "legacy_delete" })
      log.info("migration.stage", { sessionID, stage: "legacy_delete", duration_ms: Date.now() - start })
    } catch (err) {
      await publishFailed(sessionID, "legacy_delete", err)
      throw err
    }

    const durationMs = Date.now() - start
    SessionStorageMetrics.increment("migrations_total", { outcome: "success" })
    SessionStorageMetrics.observeMs("migrate_duration_ms", durationMs, { outcome: "success" })
    log.info("migration.completed", { sessionID, duration_ms: durationMs, sqlite_row_count: sqliteRowCount })
    await Bus.publish(SessionStorageEvent.Migrated, {
      sessionID,
      legacyMessageCount: snapshot.length,
      sqliteRowCount,
      durationMs,
      timestamp: Date.now(),
    }).catch(() => {})
  }
}

export namespace DreamingWorker {
  export interface TestHooks {
    afterTmpWrite?: (sessionID: string, tmpDbPath: string) => Promise<void> | void
    beforeIntegrityCheck?: (sessionID: string, tmpDbPath: string) => Promise<void> | void
    overrideSqliteRowCount?: (actual: number) => number
    beforeRename?: (sessionID: string, tmpDbPath: string) => Promise<void> | void
    afterRename?: (sessionID: string, dbPath: string) => Promise<void> | void
  }

  export function noteMessageWrite(worker: DreamingWorker | undefined): void {
    worker?.noteMessageWrite()
  }

  export function sessionRootForTesting(): string {
    return sessionRoot()
  }
}
