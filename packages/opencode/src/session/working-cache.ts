import z from "zod"
import { Storage } from "@/storage/storage"
import { debugCheckpoint } from "@/util/debug"
import { Instance } from "@/project/instance"
import { Token } from "@/util/token"
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

    for (const evidence of entry.evidence) {
      if (!evidence.sha256 && typeof evidence.mtimeMs !== "number") {
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

  async function evidenceIsFresh(entry: Entry, evidence: EvidenceRef): Promise<boolean> {
    if (evidence.kind === "tool-result" || evidence.kind === "subagent-result") return true
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

  export function renderForRecovery(entries: Entry[], maxTokens = 2000): string {
    const blocks = entries.map((entry) => {
      const lines: string[] = []
      lines.push(`- ${entry.purpose} (${entry.operation ?? "summary"}; entry ${entry.id})`)
      if (entry.summary) lines.push(`  Summary: ${entry.summary}`)
      for (const fact of entry.facts) lines.push(`  Fact: ${fact.text} [evidence: ${fact.evidenceRefs.join(", ")}]`)
      const lineage = [
        ...entry.derivedFrom.map((id) => `derivedFrom:${id}`),
        ...entry.supersedes.map((id) => `supersedes:${id}`),
      ]
      if (lineage.length > 0) lines.push(`  Lineage: ${lineage.join(", ")}`)
      if (entry.unresolvedQuestions.length > 0) lines.push(`  Unresolved: ${entry.unresolvedQuestions.join("; ")}`)
      return lines.join("\n")
    })
    const rendered = blocks.join("\n")
    if (Token.estimate(rendered) <= maxTokens) return rendered
    let kept: string[] = []
    for (const block of blocks) {
      const next = [...kept, block].join("\n")
      if (Token.estimate(next) > maxTokens) break
      kept.push(block)
    }
    if (kept.length === 0) {
      reject("WORKING_CACHE_RENDER_OVER_BUDGET", undefined, "Working Cache recovery render exceeds budget")
    }
    return kept.join("\n")
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
}
