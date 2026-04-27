import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import { SharedContext } from "./shared-context"
import { Global } from "../global"
import path from "path"
import fs from "fs/promises"

// ── Memory ────────────────────────────────────────────────────────────────────
// Per-session memory artifact. Single Storage path: session_memory/<sessionID>.
// Replaces SharedContext.Space and the disk-file rebind-checkpoint as the
// canonical memory of "what happened in this session". See:
//
//   specs/compaction-redesign/spec.md           — R-1..R-9 behavioural contract
//   specs/compaction-redesign/data-schema.json  — type schema
//   specs/compaction-redesign/design.md         — DD-1..DD-10 design decisions
//
// Primary content: TurnSummary[] (AI's natural turn-end self-summary, captured
// at runloop exit per DD-2). Auxiliary content: fileIndex/actionLog (legacy
// SharedContext role retained as metadata, not as primary narrative).
//
// Render produces two independent forms (DD-5):
//   renderForLLM  → compact provider-agnostic text for next LLM call
//   renderForHuman → timeline form for UI / debug consumption
//
// Persistence uses a new path; reads fall back to legacy SharedContext +
// rebind-checkpoint disk file if the new path is empty (DD-3).

export namespace Memory {
  const log = Log.create({ service: "session.memory" })

  // ── Data Model (mirrors data-schema.json) ──────────────────

  export interface SessionMemory {
    sessionID: string
    version: number
    updatedAt: number
    turnSummaries: TurnSummary[]
    fileIndex: FileEntry[]
    actionLog: ActionEntry[]
    lastCompactedAt: { round: number; timestamp: number } | null
    rawTailBudget: number
  }

  export interface TurnSummary {
    turnIndex: number
    userMessageId: string
    assistantMessageId?: string
    endedAt: number
    text: string
    modelID: string
    providerId: string
    accountId?: string | null
    tokens?: { input?: number; output?: number }
  }

  export interface FileEntry {
    path: string
    operation: "read" | "edit" | "write" | "grep_match" | "glob_match"
    lines?: number | null
    summary?: string | null
    updatedAt: number
  }

  export interface ActionEntry {
    tool: string
    summary: string
    turn: number
    addedAt: number
  }

  const RAW_TAIL_BUDGET_DEFAULT = 5

  // ── Storage ─────────────────────────────────────────────────

  function storageKey(sessionID: string): string[] {
    return ["session_memory", sessionID]
  }

  function legacyCheckpointPath(sessionID: string): string {
    return path.join(Global.Path.state, `rebind-checkpoint-${sessionID}.json`)
  }

  function createEmpty(sid: string): SessionMemory {
    return {
      sessionID: sid,
      version: 0,
      updatedAt: Date.now(),
      turnSummaries: [],
      fileIndex: [],
      actionLog: [],
      lastCompactedAt: null,
      rawTailBudget: RAW_TAIL_BUDGET_DEFAULT,
    }
  }

  // ── Read with legacy fallback (DD-3) ────────────────────────

  /**
   * Read SessionMemory for a session.
   *
   * Strategy (DD-3):
   *   1. Try the new Storage key `session_memory/<sid>`.
   *   2. If empty, fall back: project legacy SharedContext.Space and the
   *      rebind-checkpoint disk file into the new shape, write it once
   *      (lazy migration), and return the projected memory.
   *   3. If both legacies are empty, return a fresh empty SessionMemory.
   *
   * Per AGENTS.md rule 1, every fallback transition surfaces a log line.
   */
  export async function read(sessionID: string): Promise<SessionMemory> {
    const fromNew = await Storage.read<SessionMemory>(storageKey(sessionID)).catch(() => undefined)
    if (fromNew) return normalizeShape(fromNew)

    const legacyShared = await SharedContext.get(sessionID).catch(() => undefined)
    const legacyCheckpoint = await readLegacyCheckpoint(sessionID)

    if (!legacyShared && !legacyCheckpoint) {
      return createEmpty(sessionID)
    }

    log.info("memory.legacy_fallback_read", {
      sessionID,
      legacySource:
        legacyShared && legacyCheckpoint ? "both" : legacyShared ? "shared-context" : "checkpoint",
    })

    const projected = projectLegacy(sessionID, legacyShared, legacyCheckpoint)
    // Lazy migration write so subsequent reads use the new path directly.
    await Storage.write(storageKey(sessionID), projected).catch((err) => {
      log.warn("memory.legacy_fallback_lazy_write_failed", {
        sessionID,
        error: String(err),
      })
    })
    return projected
  }

  /**
   * Normalize a SessionMemory shape that may be missing newer fields (forward
   * compatibility: a session_memory blob written by an earlier daemon version
   * may lack rawTailBudget or lastCompactedAt).
   */
  function normalizeShape(mem: Partial<SessionMemory> & { sessionID: string }): SessionMemory {
    return {
      sessionID: mem.sessionID,
      version: mem.version ?? 0,
      updatedAt: mem.updatedAt ?? Date.now(),
      turnSummaries: mem.turnSummaries ?? [],
      fileIndex: mem.fileIndex ?? [],
      actionLog: mem.actionLog ?? [],
      lastCompactedAt: mem.lastCompactedAt ?? null,
      rawTailBudget: mem.rawTailBudget ?? RAW_TAIL_BUDGET_DEFAULT,
    }
  }

  async function readLegacyCheckpoint(sessionID: string): Promise<
    | { snapshot: string; lastMessageId?: string; timestamp?: number }
    | undefined
  > {
    try {
      const raw = await fs.readFile(legacyCheckpointPath(sessionID), "utf8")
      const obj = JSON.parse(raw) as {
        snapshot?: string
        lastMessageId?: string
        timestamp?: number
      }
      if (typeof obj.snapshot === "string" && obj.snapshot.length > 0) {
        return {
          snapshot: obj.snapshot,
          lastMessageId: obj.lastMessageId,
          timestamp: obj.timestamp,
        }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * Project legacy artefacts into the new SessionMemory shape.
   *
   * - SharedContext.files / actions → fileIndex / actionLog (1:1 shape match).
   * - SharedContext.goal / discoveries / currentState → synthesized into a
   *   single legacy-bridge TurnSummary so the narrative content is preserved
   *   for the LLM. This is best-effort; the regex-extracted shape doesn't
   *   carry true narrative quality, but it is better than dropping it.
   * - rebind-checkpoint snapshot (if newer than SharedContext) → synthesized
   *   as a second legacy-bridge TurnSummary.
   * - lastCompactedAt is left null: legacy state didn't carry per-round
   *   compaction recency information aligned with the new Cooldown source.
   */
  function projectLegacy(
    sessionID: string,
    legacyShared: SharedContext.Space | undefined,
    legacyCheckpoint: { snapshot: string; lastMessageId?: string; timestamp?: number } | undefined,
  ): SessionMemory {
    const mem = createEmpty(sessionID)

    if (legacyShared) {
      mem.fileIndex = legacyShared.files.map((f) => ({
        path: f.path,
        operation: f.operation,
        lines: f.lines ?? null,
        summary: f.summary ?? null,
        updatedAt: f.updatedAt,
      }))
      mem.actionLog = legacyShared.actions.map((a) => ({
        tool: a.tool,
        summary: a.summary,
        turn: a.turn,
        addedAt: a.addedAt,
      }))
      const sharedNarrative = synthesizeLegacySharedNarrative(legacyShared)
      if (sharedNarrative) {
        mem.turnSummaries.push({
          turnIndex: 0,
          userMessageId: "<legacy-bridge-shared-context>",
          endedAt: legacyShared.updatedAt,
          text: sharedNarrative,
          modelID: "legacy",
          providerId: "legacy",
        })
      }
    }

    if (legacyCheckpoint) {
      mem.turnSummaries.push({
        turnIndex: mem.turnSummaries.length,
        userMessageId: legacyCheckpoint.lastMessageId ?? "<legacy-bridge-checkpoint>",
        endedAt: legacyCheckpoint.timestamp ?? Date.now(),
        text: legacyCheckpoint.snapshot,
        modelID: "legacy",
        providerId: "legacy",
      })
    }

    mem.version = 1
    mem.updatedAt = Date.now()
    return mem
  }

  function synthesizeLegacySharedNarrative(s: SharedContext.Space): string {
    const lines: string[] = []
    if (s.goal) lines.push(`Goal: ${s.goal}`)
    if (s.discoveries.length > 0) {
      lines.push("Discoveries:")
      for (const d of s.discoveries) lines.push(`- ${d}`)
    }
    if (s.currentState) lines.push(`Current state: ${s.currentState}`)
    return lines.join("\n")
  }

  // ── Write ───────────────────────────────────────────────────

  /**
   * Persist SessionMemory to Storage. Idempotent (per INV-5): write(read(x)) === x
   * at the byte level provided x went through normalizeShape.
   */
  export async function write(sessionID: string, mem: SessionMemory): Promise<void> {
    if (mem.sessionID !== sessionID) {
      throw new Error(
        `Memory.write: sessionID mismatch (arg=${sessionID}, mem.sessionID=${mem.sessionID})`,
      )
    }
    await Storage.write(storageKey(sessionID), mem)
  }

  // ── Append TurnSummary (called at runloop exit, DD-2) ───────

  /**
   * Append a new TurnSummary entry, bump version, and persist.
   *
   * Caller is the runloop exit handler at prompt.ts:1230 (the `exiting loop`
   * site). Per INV-6, the append must be durable before the next runloop
   * iteration (or daemon return) — implementation: Storage.write completes
   * before this function resolves. Caller may still treat the call as
   * fire-and-forget for UX latency, but we do not return early on partial
   * persistence.
   */
  export async function appendTurnSummary(
    sessionID: string,
    summary: TurnSummary,
  ): Promise<void> {
    const mem = await read(sessionID)
    mem.turnSummaries.push(summary)
    mem.version += 1
    mem.updatedAt = Date.now()
    await write(sessionID, mem)
  }

  // ── Mark compacted (Cooldown source-of-truth, DD-7) ─────────

  /**
   * Update Memory.lastCompactedAt. Called by SessionCompaction.run on success.
   * This is the canonical source for Cooldown.shouldThrottle (per DD-7); the
   * separate cooldownState Map is removed in phase 7.
   */
  export async function markCompacted(
    sessionID: string,
    at: { round: number; timestamp?: number },
  ): Promise<void> {
    const mem = await read(sessionID)
    mem.lastCompactedAt = {
      round: at.round,
      timestamp: at.timestamp ?? Date.now(),
    }
    mem.version += 1
    mem.updatedAt = Date.now()
    await write(sessionID, mem)
  }
}
