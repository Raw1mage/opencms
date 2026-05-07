import z from "zod"
import { Storage } from "@/storage/storage"
import { debugCheckpoint } from "@/util/debug"
import { Instance } from "@/project/instance"
import { Token } from "@/util/token"
import { Tool } from "@/tool/tool"
import type { MessageV2 } from "./message-v2"
import { createHash } from "node:crypto"
import path from "node:path"
import fs from "node:fs/promises"

export namespace WorkingCache {
  export const ErrorCode = z.enum([
    "WORKING_CACHE_SCHEMA_INVALID",
    "WORKING_CACHE_EVIDENCE_MISSING",
    "WORKING_CACHE_SCOPE_UNRESOLVED",
    "WORKING_CACHE_EVIDENCE_STALE",
    "WORKING_CACHE_RENDER_OVER_BUDGET",
    "WORKING_CACHE_FRESHNESS_SIGNAL_MISSING",
    "WORKING_CACHE_DIGEST_BLOCK_MALFORMED",
    "WORKING_CACHE_LEDGER_DERIVATION_FAILED",
    "WORKING_CACHE_RECALL_INVALID_ARGS",
  ])
  export type ErrorCode = z.infer<typeof ErrorCode>

  export class WorkingCacheError extends Error {
    constructor(
      readonly code: ErrorCode,
      message: string,
      readonly details?: Record<string, unknown>,
    ) {
      super(message)
      this.name = "WorkingCacheError"
    }
  }

  const IsoDateTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Expected ISO date-time string",
  })

  export const Scope = z
    .object({
      kind: z.enum(["session", "repo", "domain"]),
      sessionID: z.string().optional(),
      repoRoot: z.string().optional(),
      domain: z.string().optional(),
      planPath: z.string().optional(),
    })
    .strict()

  export type Scope = z.infer<typeof Scope>

  export const Fact = z
    .object({
      text: z.string().min(1),
      confidence: z.enum(["low", "medium", "high"]).optional(),
      evidenceRefs: z.array(z.string()).min(1),
    })
    .strict()

  export type Fact = z.infer<typeof Fact>

  export const EvidenceRef = z
    .object({
      id: z.string().min(1),
      path: z.string().min(1),
      lineStart: z.number().int().positive().optional(),
      lineEnd: z.number().int().positive().optional(),
      kind: z.enum(["file", "event", "spec", "tool-result", "subagent-result"]),
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
      mtimeMs: z.number().optional(),
      capturedAt: z
        .string()
        .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Expected ISO date-time string" })
        .optional(),
    })
    .strict()

  export type EvidenceRef = z.infer<typeof EvidenceRef>

  export const InvalidationTrigger = z
    .object({
      type: z.enum(["path-change", "hash-mismatch", "max-age-ms", "spec-state-change", "manual"]),
      value: z.unknown(),
    })
    .strict()

  export type InvalidationTrigger = z.infer<typeof InvalidationTrigger>

  export const Entry = z
    .object({
      id: z.string().min(1),
      version: z.number().int().min(1),
      scope: Scope,
      operation: z.enum(["explore", "read", "modify", "validate", "handoff", "summary"]).optional(),
      derivedFrom: z.array(z.string()).default([]),
      supersedes: z.array(z.string()).default([]),
      purpose: z.string().min(1),
      summary: z.string().optional(),
      filesSearched: z.array(z.string()).default([]),
      filesRead: z.array(z.string()).default([]),
      facts: z.array(Fact).min(1),
      evidence: z.array(EvidenceRef).min(1),
      invalidation: z.array(InvalidationTrigger).default([]),
      unresolvedQuestions: z.array(z.string()).default([]),
      expiration: z
        .object({
          policy: z.enum(["deferred", "manual", "ttl", "superseded-only"]).optional(),
          expiresAt: IsoDateTime.optional(),
          reason: z.string().optional(),
        })
        .strict()
        .optional(),
      createdAt: IsoDateTime,
      updatedAt: IsoDateTime,
    })
    .strict()

  export type Entry = z.infer<typeof Entry>

  export type EntryInput = z.input<typeof Entry>

  type EntryIndex = {
    version: 1
    updatedAt: string
    entries: string[]
  }

  type Store = Pick<typeof Storage, "read" | "write">

  export interface SelectionResult {
    entries: Entry[]
    omitted: { entryID: string; reason: ErrorCode | "WORKING_CACHE_SCOPE_UNRESOLVED" }[]
  }

  let store: Store = Storage

  export function setStoreForTesting(next?: Store) {
    store = next ?? Storage
  }

  function entryKey(entryID: string): string[] {
    return ["working_cache", "entry", entryID]
  }

  function scopeKey(scope: Scope): string {
    switch (scope.kind) {
      case "session":
        return `session:${scope.sessionID}`
      case "repo":
        return `repo:${scope.repoRoot}`
      case "domain":
        return `domain:${scope.repoRoot}:${scope.domain}`
    }
  }

  function indexKey(scope: Scope): string[] {
    return ["working_cache", "index", scopeKey(scope)]
  }

  function reject(
    code: ErrorCode,
    entryID: string | undefined,
    message: string,
    details?: Record<string, unknown>,
  ): never {
    debugCheckpoint("working-cache.write", "reject", {
      code,
      entryID,
      reason: message,
    })
    throw new WorkingCacheError(code, message, details)
  }

  export function validate(input: EntryInput): Entry {
    const parsed = Entry.safeParse(input)
    if (!parsed.success) {
      reject(
        "WORKING_CACHE_SCHEMA_INVALID",
        input && typeof input === "object" ? (input as any).id : undefined,
        "Cache entry failed schema validation",
        {
          issues: parsed.error.issues,
        },
      )
    }

    const entry = parsed.data

    if (entry.scope.kind === "session" && !entry.scope.sessionID) {
      reject("WORKING_CACHE_SCOPE_UNRESOLVED", entry.id, "Session-scoped cache entry requires scope.sessionID")
    }
    if (entry.scope.kind === "repo" && !entry.scope.repoRoot) {
      reject("WORKING_CACHE_SCOPE_UNRESOLVED", entry.id, "Repo-scoped cache entry requires scope.repoRoot")
    }
    if (entry.scope.kind === "domain" && (!entry.scope.repoRoot || !entry.scope.domain)) {
      reject(
        "WORKING_CACHE_SCOPE_UNRESOLVED",
        entry.id,
        "Domain-scoped cache entry requires scope.repoRoot and scope.domain",
      )
    }

    const evidenceIDs = new Set(entry.evidence.map((evidence) => evidence.id))
    if (evidenceIDs.size === 0) {
      reject("WORKING_CACHE_EVIDENCE_MISSING", entry.id, "Cache entry has no usable evidence references")
    }

    const hasMaxAgeTrigger = entry.invalidation.some(
      (trigger) => trigger.type === "max-age-ms" && typeof trigger.value === "number",
    )

    for (const evidence of entry.evidence) {
      if (evidence.kind === "tool-result" || evidence.kind === "subagent-result") {
        // Non-replayable evidence: must carry a freshness signal because the
        // original payload can drift without any re-readable file path.
        const hasCapturedAt = typeof evidence.capturedAt === "string" && !Number.isNaN(Date.parse(evidence.capturedAt))
        if (!evidence.sha256 && !(hasCapturedAt && hasMaxAgeTrigger)) {
          reject(
            "WORKING_CACHE_FRESHNESS_SIGNAL_MISSING",
            entry.id,
            "tool-result / subagent-result evidence requires sha256 or (capturedAt + max-age-ms invalidation)",
            { evidenceID: evidence.id, kind: evidence.kind },
          )
        }
      } else if (!evidence.sha256 && typeof evidence.mtimeMs !== "number") {
        reject("WORKING_CACHE_EVIDENCE_MISSING", entry.id, "Evidence ref requires sha256 or mtimeMs", {
          evidenceID: evidence.id,
        })
      }
      if (
        typeof evidence.lineStart === "number" &&
        typeof evidence.lineEnd === "number" &&
        evidence.lineEnd < evidence.lineStart
      ) {
        reject(
          "WORKING_CACHE_SCHEMA_INVALID",
          entry.id,
          "Evidence lineEnd must be greater than or equal to lineStart",
          {
            evidenceID: evidence.id,
          },
        )
      }
    }

    for (const fact of entry.facts) {
      for (const ref of fact.evidenceRefs) {
        if (!evidenceIDs.has(ref)) {
          reject("WORKING_CACHE_EVIDENCE_MISSING", entry.id, "Fact references missing evidence", {
            evidenceRef: ref,
          })
        }
      }
    }

    return entry
  }

  async function loadIndex(scope: Scope): Promise<EntryIndex> {
    try {
      const existing = await store.read<EntryIndex>(indexKey(scope))
      return {
        version: 1,
        updatedAt: existing.updatedAt,
        entries: Array.from(new Set(existing.entries)),
      }
    } catch (err) {
      if (!(err instanceof Storage.NotFoundError)) throw err
      return {
        version: 1,
        updatedAt: new Date(0).toISOString(),
        entries: [],
      }
    }
  }

  export async function list(scope: Scope): Promise<Entry[]> {
    const index = await loadIndex(validateScope(scope))
    const entries: Entry[] = []
    for (const entryID of index.entries) {
      const raw = await store.read<EntryInput>(entryKey(entryID))
      entries.push(validate(raw))
    }
    return entries
  }

  function validateScope(scope: Scope): Scope {
    const parsed = Scope.safeParse(scope)
    if (!parsed.success) {
      reject("WORKING_CACHE_SCOPE_UNRESOLVED", undefined, "Working Cache scope failed schema validation", {
        issues: parsed.error.issues,
      })
    }
    const candidate = parsed.data
    if (candidate.kind === "session" && !candidate.sessionID) {
      reject("WORKING_CACHE_SCOPE_UNRESOLVED", undefined, "Session-scoped cache lookup requires scope.sessionID")
    }
    if (candidate.kind === "repo" && !candidate.repoRoot) {
      reject("WORKING_CACHE_SCOPE_UNRESOLVED", undefined, "Repo-scoped cache lookup requires scope.repoRoot")
    }
    if (candidate.kind === "domain" && (!candidate.repoRoot || !candidate.domain)) {
      reject(
        "WORKING_CACHE_SCOPE_UNRESOLVED",
        undefined,
        "Domain-scoped cache lookup requires scope.repoRoot and scope.domain",
      )
    }
    return candidate
  }

  function resolveEvidencePath(entry: Entry, evidence: EvidenceRef): string | undefined {
    if (path.isAbsolute(evidence.path)) return evidence.path
    if (entry.scope.repoRoot) return path.join(entry.scope.repoRoot, evidence.path)
    try {
      return path.join(Instance.worktree, evidence.path)
    } catch {
      return undefined
    }
  }

  /**
   * Tool-result / subagent-result evidence kinds carry no replayable file path,
   * so freshness depends on (a) an explicit `capturedAt` timestamp combined with
   * a `max-age-ms` invalidation trigger on the entry, or (b) a `sha256` of the
   * captured payload that can be compared against the present-day stored
   * payload by a future caller. Without at least one of those, the evidence is
   * unverifiable — fail closed.
   *
   * Plan reference: working-cache plan revision DD-12 / INV-6, replaces the
   * previous unconditional `return true` fail-open path.
   */
  function nonReplayableEvidenceIsFresh(entry: Entry, evidence: EvidenceRef): boolean {
    if (evidence.sha256) return true
    if (typeof evidence.capturedAt !== "string") return false
    const capturedAtMs = Date.parse(evidence.capturedAt)
    if (Number.isNaN(capturedAtMs)) return false
    const maxAge = entry.invalidation.find((trigger) => trigger.type === "max-age-ms")
    if (!maxAge || typeof maxAge.value !== "number") return false
    return Date.now() - capturedAtMs <= maxAge.value
  }

  async function evidenceIsFresh(entry: Entry, evidence: EvidenceRef): Promise<boolean> {
    if (evidence.kind === "tool-result" || evidence.kind === "subagent-result") {
      return nonReplayableEvidenceIsFresh(entry, evidence)
    }
    const filePath = resolveEvidencePath(entry, evidence)
    if (!filePath) return false
    const stat = await fs.stat(filePath).catch(() => undefined)
    if (!stat) return false
    if (typeof evidence.mtimeMs === "number" && Math.trunc(stat.mtimeMs) !== Math.trunc(evidence.mtimeMs)) return false
    if (evidence.sha256) {
      const text = await fs.readFile(filePath).catch(() => undefined)
      if (!text) return false
      const actual = createHash("sha256").update(text).digest("hex")
      if (actual !== evidence.sha256) return false
    }
    return true
  }

  async function entryIsFresh(entry: Entry): Promise<boolean> {
    if (entry.expiration?.expiresAt && Date.parse(entry.expiration.expiresAt) <= Date.now()) return false
    for (const trigger of entry.invalidation) {
      if (trigger.type === "manual") return false
      if (trigger.type === "max-age-ms" && typeof trigger.value === "number") {
        if (Date.now() - Date.parse(entry.updatedAt) > trigger.value) return false
      }
    }
    for (const evidence of entry.evidence) {
      if (!(await evidenceIsFresh(entry, evidence))) return false
    }
    return true
  }

  function preferLatestModifyingEntries(entries: Entry[]): Entry[] {
    const superseded = new Set<string>()
    for (const entry of entries) {
      for (const id of entry.supersedes) superseded.add(id)
    }
    return entries
      .filter((entry) => !superseded.has(entry.id))
      .toSorted((a, b) => {
        const opA = a.operation === "modify" ? 1 : 0
        const opB = b.operation === "modify" ? 1 : 0
        if (opA !== opB) return opB - opA
        return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
      })
  }

  export async function selectValid(scope: Scope, limit = 5): Promise<SelectionResult> {
    const entries = await list(scope).catch((err) => {
      if (err instanceof Storage.NotFoundError) return [] as Entry[]
      throw err
    })
    const valid: Entry[] = []
    const omitted: SelectionResult["omitted"] = []
    for (const entry of entries) {
      const fresh = await entryIsFresh(entry)
      if (!fresh) {
        omitted.push({ entryID: entry.id, reason: "WORKING_CACHE_EVIDENCE_STALE" })
        debugCheckpoint("working-cache.read", "omit", {
          entryID: entry.id,
          reason: "stale",
        })
        continue
      }
      valid.push(entry)
    }
    return {
      entries: preferLatestModifyingEntries(valid).slice(0, limit),
      omitted,
    }
  }


  export async function record(input: EntryInput): Promise<Entry> {
    debugCheckpoint("working-cache.write", "start", {
      entryID: input && typeof input === "object" ? (input as any).id : undefined,
      scopeKind: input && typeof input === "object" ? (input as any).scope?.kind : undefined,
      factCount:
        input && typeof input === "object" && Array.isArray((input as any).facts)
          ? (input as any).facts.length
          : undefined,
      evidenceCount:
        input && typeof input === "object" && Array.isArray((input as any).evidence)
          ? (input as any).evidence.length
          : undefined,
    })

    const entry = validate(input)
    await store.write(entryKey(entry.id), entry)

    const index = await loadIndex(entry.scope)
    if (!index.entries.includes(entry.id)) index.entries.push(entry.id)
    index.updatedAt = new Date().toISOString()
    await store.write(indexKey(entry.scope), index)

    return entry
  }

  // ─────────────────────────────────────────────────────────────────────────
  // L2 raw ledger — derived view over Session.messages ToolPart records.
  // Plan reference: working-cache plan revision DD-7, INV-2, INV-16.
  //
  // L2 stores no payload. `deriveLedger` walks the existing message stream and
  // emits pointer records. `recall_toolcall_raw` follows the pointer back into
  // Session.messages on demand (see DD-21 `include_body` flag), so the source
  // of truth remains the message storage; L2 is index-only.
  // ─────────────────────────────────────────────────────────────────────────

  export const LedgerEntry = z
    .object({
      toolCallID: z.string().min(1),
      toolName: z.string().min(1),
      kind: z.enum(["exploration", "modify", "other"]),
      argsSummary: z.string(),
      filePath: z.string().optional(),
      outputHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
      mtimeMs: z.number().optional(),
      turn: z.number().int().min(0),
      messageRef: z.string().min(1),
      capturedAt: z.string(),
      ageTurns: z.number().int().min(0).optional(),
    })
    .strict()

  export type LedgerEntry = z.infer<typeof LedgerEntry>

  /**
   * Best-effort args summary for a ledger pointer. Extracts the most useful
   * primitive fields (filePath, pattern, command, path, query) without
   * leaking the full input payload.
   */
  function summariseArgs(toolName: string, input: Record<string, unknown> | undefined): string {
    if (!input || typeof input !== "object") return ""
    const candidate = (key: string) => {
      const value = input[key]
      return typeof value === "string" ? value : undefined
    }
    const picks = ["filePath", "path", "pattern", "query", "command", "url"]
      .map((key) => candidate(key))
      .filter((value): value is string => typeof value === "string" && value.length > 0)
    if (picks.length === 0) return `${toolName} call`
    return picks.slice(0, 2).join(" | ")
  }

  /**
   * Pull a `filePath` (or single canonical path-like field) out of a tool
   * input shape. Stays conservative — only fields commonly used as the single
   * file under inspection.
   */
  function extractFilePath(input: Record<string, unknown> | undefined): string | undefined {
    if (!input || typeof input !== "object") return undefined
    for (const key of ["filePath", "path", "file"]) {
      const value = input[key]
      if (typeof value === "string" && value.length > 0) return value
    }
    return undefined
  }

  /**
   * Derive an L2 ledger view over a session's existing `MessageV2.WithParts[]`
   * stream. Pure function — no storage writes, no payload duplication.
   *
   * Each completed `ToolPart` produces one `LedgerEntry` with a stable
   * `messageRef` pointer back into message storage.
   */
  export function deriveLedger(messages: MessageV2.WithParts[]): LedgerEntry[] {
    const entries: LedgerEntry[] = []
    const totalTurns = messages.length
    messages.forEach((message, turnIndex) => {
      const messageID = message.info?.id
      if (!messageID) return
      for (const part of message.parts ?? []) {
        if (part.type !== "tool") continue
        if (part.state?.status !== "completed") continue
        const state = part.state
        const toolName = part.tool
        const callID = part.callID
        if (!toolName || !callID) continue
        const input = state.input as Record<string, unknown> | undefined
        const output = typeof state.output === "string" ? state.output : ""
        const outputHash = output.length > 0 ? createHash("sha256").update(output).digest("hex") : undefined
        const filePath = extractFilePath(input)
        const startMs = state.time?.start
        const capturedAt = typeof startMs === "number" ? new Date(startMs).toISOString() : new Date().toISOString()
        entries.push({
          toolCallID: callID,
          toolName,
          kind: Tool.kind(toolName),
          argsSummary: summariseArgs(toolName, input),
          filePath,
          outputHash,
          mtimeMs: undefined,
          turn: turnIndex,
          messageRef: messageID,
          capturedAt,
          ageTurns: Math.max(0, totalTurns - 1 - turnIndex),
        })
      }
    })
    return entries
  }

  /**
   * Manifest shape returned by both the post-compaction provider (Phase B
   * awareness) and the on-demand `system-manager:recall_toolcall_index` tool.
   *
   * Plan reference: DD-5 (catch-up phasing) / DD-22 (three exposure surfaces).
   */
  export interface Manifest {
    l2: {
      total: number
      byKind: Record<string, number>
      byFileCount: number
    }
    l1: {
      total: number
      topics: string[]
    }
    retrieval: {
      raw: string
      digest: string
      index: string
    }
  }

  /**
   * Compose the awareness manifest from a derived ledger + the currently valid
   * L1 entries. Counts and topic labels only — no fact bodies, no hashes, no
   * path enumeration. INV-9 invariant.
   */
  export function buildManifest(ledger: LedgerEntry[], digestEntries: Entry[]): Manifest {
    const byKind: Record<string, number> = {}
    const filePaths = new Set<string>()
    for (const entry of ledger) {
      byKind[entry.toolName] = (byKind[entry.toolName] ?? 0) + 1
      if (entry.filePath) filePaths.add(entry.filePath)
    }
    const topics = digestEntries.map((entry) => entry.purpose).slice(0, 16)
    return {
      l2: {
        total: ledger.length,
        byKind,
        byFileCount: filePaths.size,
      },
      l1: {
        total: digestEntries.length,
        topics,
      },
      retrieval: {
        raw: "system-manager:recall_toolcall_raw",
        digest: "system-manager:recall_toolcall_digest",
        index: "system-manager:recall_toolcall_index",
      },
    }
  }

  /**
   * Render a manifest as the compact text block injected at post-compaction.
   * Token budget: ≤120 tokens (~480 chars). Keeps counts + small topic preview;
   * never emits hashes or path enumerations. Per plan revision DD-22, the
   * manifest is awareness-level only — drill-in is via the recall_toolcall_*
   * tool family.
   */
  export function renderManifest(manifest: Manifest): string {
    const kindsCompact = Object.entries(manifest.l2.byKind)
      .slice(0, 5)
      .map(([toolName, count]) => `${toolName}=${count}`)
      .join(",")
    const topicPreview = manifest.l1.topics
      .slice(0, 4)
      .map((topic) => (topic.length > 36 ? `${topic.slice(0, 35)}…` : topic))
      .join("; ")
    const lines = [
      `Working Cache: L2=${manifest.l2.total} toolcalls (${manifest.l2.byFileCount} files${kindsCompact ? `; ${kindsCompact}` : ""}); L1=${manifest.l1.total} digests${topicPreview ? ` (${topicPreview}${manifest.l1.topics.length > 4 ? "…" : ""})` : ""}.`,
      `Refresh: \`${manifest.retrieval.index}\` | Pull raw: \`${manifest.retrieval.raw}\` (optional include_body) | Pull digest: \`${manifest.retrieval.digest}\`.`,
      "Modifying actions still need fresh evidence verification.",
    ]
    return lines.join("\n")
  }

  /**
   * Filter the derived ledger by recall_toolcall_raw query parameters.
   * Returns matching entries (newest first) or empty array on miss.
   */
  export function selectLedger(
    ledger: LedgerEntry[],
    query: {
      kind?: Tool.Kind
      path?: string
      hash?: string
      turnRangeStart?: number
      turnRangeEnd?: number
    },
  ): LedgerEntry[] {
    const filtered = ledger.filter((entry) => {
      if (query.kind && entry.kind !== query.kind) return false
      if (query.path && entry.filePath !== query.path) return false
      if (query.hash && entry.outputHash !== query.hash) return false
      if (typeof query.turnRangeStart === "number" && entry.turn < query.turnRangeStart) return false
      if (typeof query.turnRangeEnd === "number" && entry.turn > query.turnRangeEnd) return false
      return true
    })
    return filtered.toSorted((a, b) => b.turn - a.turn)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Exploration-sequence depth counter (DD-7 / DD-8)
  //
  // Tracks consecutive exploration-class toolcalls per session. The L1
  // postscript fires when depth crosses the configured threshold; modify or
  // other-class toolcalls reset the counter. Lives in-memory; restart resets
  // — acceptable because the cache itself is the durable artefact.
  // ─────────────────────────────────────────────────────────────────────────

  const explorationDepth = new Map<string, number>()
  const DEFAULT_DEPTH_THRESHOLD = 3

  export function tickExplorationDepth(sessionID: string, toolKind: Tool.Kind): number {
    if (toolKind === "exploration") {
      const next = (explorationDepth.get(sessionID) ?? 0) + 1
      explorationDepth.set(sessionID, next)
      return next
    }
    if (toolKind === "modify") {
      explorationDepth.set(sessionID, 0)
      return 0
    }
    // "other" leaves the counter untouched so neutral tools like todowrite
    // don't break a real exploration sequence.
    return explorationDepth.get(sessionID) ?? 0
  }

  export function getExplorationDepth(sessionID: string): number {
    return explorationDepth.get(sessionID) ?? 0
  }

  export function resetExplorationDepth(sessionID: string): void {
    explorationDepth.delete(sessionID)
  }

  /**
   * Returns the postscript text to append to a tool result when exploration
   * depth has crossed the threshold. Caller appends — this function decides
   * whether to emit. Returns empty string when no postscript should fire.
   */
  export function explorationPostscript(
    depth: number,
    threshold: number = DEFAULT_DEPTH_THRESHOLD,
  ): string {
    if (depth < threshold) return ""
    return [
      "",
      "[working-cache] Exploration sequence reached depth " + String(depth) + ".",
      "If you formed a reusable claim from this exploration, emit a `cache-digest`",
      "fenced block in your next response. Required fields: purpose, facts",
      "(each with evidenceRefs), evidence (with id/path/kind plus sha256 or mtimeMs;",
      "tool-result kind also requires sha256 OR capturedAt + max-age-ms).",
      "Skip emission entirely if no reusable fact crystallised — empty/forced",
      "blocks waste tokens.",
    ].join("\n")
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Fenced cache-digest block parser
  //
  // Plan reference: working-cache plan revision DD-8, DD-9. The L1 emission
  // surface is a JSON-bodied fenced block in assistant messages; turn-end hook
  // calls `parseDigestBlocks(text, sessionID)` to extract candidate entries.
  // Malformed blocks raise WORKING_CACHE_DIGEST_BLOCK_MALFORMED so the next
  // turn surfaces an explicit error rather than a silent drop.
  // ─────────────────────────────────────────────────────────────────────────

  const FENCED_BLOCK_PATTERN = /```cache-digest\s*\n([\s\S]*?)\n```/g

  export interface ParsedDigestBlock {
    raw: string
    entry: Entry | null
    error?: { code: ErrorCode; message: string; details?: Record<string, unknown> }
  }

  /**
   * Auto-generate fields the AI may legitimately omit. Sessions, timestamps,
   * version, and operation default sensibly so the LLM only has to author the
   * substantive parts (purpose / facts / evidence).
   */
  function defaultEntryFields(sessionID: string, draft: Record<string, unknown>): Record<string, unknown> {
    const now = new Date().toISOString()
    return {
      version: 1,
      scope: { kind: "session", sessionID },
      operation: "summary",
      createdAt: now,
      updatedAt: now,
      derivedFrom: [],
      supersedes: [],
      filesSearched: [],
      filesRead: [],
      invalidation: [],
      unresolvedQuestions: [],
      ...draft,
      // Re-apply id last so a draft-provided id wins; missing id triggers a generated one.
      id:
        typeof draft.id === "string" && draft.id.length > 0
          ? draft.id
          : `wc_${createHash("sha256")
              .update(`${sessionID}:${now}:${Math.random()}`)
              .digest("hex")
              .slice(0, 16)}`,
    }
  }

  /**
   * Parse all `cache-digest` fenced blocks out of an assistant message text.
   * Each block must be a single JSON object matching `EntryInput`. Required
   * fields the AI must author: `purpose`, `facts`, `evidence`. The rest is
   * defaulted from session context.
   *
   * Pure function. Does NOT persist; pass results to `record()` to write.
   */
  export function parseDigestBlocks(text: string, sessionID: string): ParsedDigestBlock[] {
    const results: ParsedDigestBlock[] = []
    if (typeof text !== "string" || text.length === 0) return results
    let match: RegExpExecArray | null
    FENCED_BLOCK_PATTERN.lastIndex = 0
    while ((match = FENCED_BLOCK_PATTERN.exec(text)) !== null) {
      const body = match[1].trim()
      if (body.length === 0) {
        results.push({
          raw: match[0],
          entry: null,
          error: {
            code: "WORKING_CACHE_DIGEST_BLOCK_MALFORMED",
            message: "cache-digest block body is empty",
          },
        })
        continue
      }
      let draft: Record<string, unknown>
      try {
        const parsed = JSON.parse(body)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("cache-digest block must be a JSON object")
        }
        draft = parsed as Record<string, unknown>
      } catch (err) {
        results.push({
          raw: match[0],
          entry: null,
          error: {
            code: "WORKING_CACHE_DIGEST_BLOCK_MALFORMED",
            message: err instanceof Error ? err.message : String(err),
            details: { excerpt: body.slice(0, 200) },
          },
        })
        continue
      }
      const candidate = defaultEntryFields(sessionID, draft)
      try {
        const entry = validate(candidate as EntryInput)
        results.push({ raw: match[0], entry })
      } catch (err) {
        if (err instanceof WorkingCacheError) {
          results.push({
            raw: match[0],
            entry: null,
            error: { code: err.code, message: err.message, details: err.details },
          })
          continue
        }
        throw err
      }
    }
    return results
  }

  /**
   * Filter L1 digest entries for recall_toolcall_digest queries.
   * Returns matching valid entries plus omitted-with-reason for stale ones.
   */
  export async function selectDigest(
    scope: Scope,
    query: { topic?: string; entryID?: string; evidencePath?: string },
  ): Promise<SelectionResult> {
    const entries = await list(scope).catch((err) => {
      if (err instanceof Storage.NotFoundError) return [] as Entry[]
      throw err
    })
    const matched = entries.filter((entry) => {
      if (query.entryID && entry.id !== query.entryID) return false
      if (query.topic) {
        const haystack = `${entry.purpose} ${entry.summary ?? ""}`.toLowerCase()
        if (!haystack.includes(query.topic.toLowerCase())) return false
      }
      if (query.evidencePath) {
        const matches = entry.evidence.some((ref) => ref.path === query.evidencePath)
        if (!matches) return false
      }
      return true
    })
    const valid: Entry[] = []
    const omitted: SelectionResult["omitted"] = []
    for (const entry of matched) {
      if (await entryIsFresh(entry)) {
        valid.push(entry)
      } else {
        omitted.push({ entryID: entry.id, reason: "WORKING_CACHE_EVIDENCE_STALE" })
      }
    }
    return {
      entries: preferLatestModifyingEntries(valid),
      omitted,
    }
  }
}
