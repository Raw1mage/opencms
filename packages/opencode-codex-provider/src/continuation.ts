/**
 * File-backed continuation state for WebSocket delta.
 *
 * Persists lastResponseId + lastInputLength across daemon restarts.
 * Extracted from plugin/codex-websocket.ts.
 */
import { existsSync, readFileSync, writeFileSync } from "fs"
import type { ContinuationState } from "./types.js"

// ---------------------------------------------------------------------------
// § 1  In-memory cache + file persistence
// ---------------------------------------------------------------------------

interface PersistedStore {
  [sessionId: string]: ContinuationState
}

let _cache: PersistedStore | null = null
let _dirty = false
let _flushTimer: ReturnType<typeof setTimeout> | null = null
let _filePath: string | null = null

export function setContinuationFilePath(filePath: string) {
  _filePath = filePath
}

function load(): PersistedStore {
  if (_cache) return _cache
  if (_filePath) {
    try {
      if (existsSync(_filePath)) {
        _cache = JSON.parse(readFileSync(_filePath, "utf-8"))
        return _cache!
      }
    } catch {
      // Corrupted file — start fresh
    }
  }
  _cache = {}
  return _cache
}

function save() {
  _dirty = true
  if (_flushTimer) return
  _flushTimer = setTimeout(() => {
    _flushTimer = null
    if (!_dirty || !_cache || !_filePath) return
    _dirty = false
    try {
      writeFileSync(_filePath, JSON.stringify(_cache, null, 2))
    } catch {
      // Disk write failed — not critical, will retry on next save
    }
  }, 2000)
}

// ---------------------------------------------------------------------------
// § 2  Public API
// ---------------------------------------------------------------------------

export function getContinuation(sessionId: string): ContinuationState {
  const store = load()
  return store[sessionId] ?? {}
}

export function updateContinuation(sessionId: string, update: Partial<ContinuationState>) {
  const store = load()
  store[sessionId] = { ...store[sessionId], ...update }
  save()
}

export function clearContinuation(sessionId: string) {
  const store = load()
  delete store[sessionId]
  save()
}

/**
 * Invalidate continuation for a session.
 * Called when server rejects previous_response_id or after compaction.
 */
export function invalidateContinuation(sessionId: string) {
  const store = load()
  if (store[sessionId]) {
    delete store[sessionId].lastResponseId
    delete store[sessionId].lastInputLength
    save()
  }
}

/**
 * Invalidate the base session continuation and every per-account continuation
 * shard (`${sessionId}:${accountId}`). Compaction/rebind changes the local
 * context generation, so all Codex server-side response chains for that
 * session become unsafe, not only the currently active account shard.
 */
export function invalidateContinuationFamily(sessionId: string) {
  const store = load()
  let changed = false
  for (const key of Object.keys(store)) {
    if (key === sessionId || key.startsWith(`${sessionId}:`)) {
      delete store[key].lastResponseId
      delete store[key].lastInputLength
      changed = true
    }
  }
  if (changed) save()
}
