import { Slug } from "@opencode-ai/util/slug"
import path from "path"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Decimal } from "decimal.js"
import z from "zod"
import { type ProviderMetadata } from "ai"
import { Config } from "../config/config"
import { Flag } from "../flag/flag"
import { Identifier } from "../id/id"
import { Installation } from "../installation"

import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import { debugCheckpoint } from "../util/debug"
import { MessageV2 } from "./message-v2"
import { readMessageInfo, removeMessageInfo, removePartFile } from "./storage/legacy"
import { DreamingWorker } from "./storage/dreaming"
import { Router as StorageRouter } from "./storage/router"
import { Instance } from "../project/instance"
import { Project } from "../project/project"
import { SessionPrompt } from "./prompt"
import { Tweaks } from "../config/tweaks"
import { fn } from "@/util/fn"
import { Command } from "../command"
import { Snapshot } from "@/snapshot"

import type { Provider } from "@/provider/provider"
import { PermissionNext } from "@/permission/next"
import { Global } from "@/global"
import type { LanguageModelV2Usage } from "@ai-sdk/provider"
import { iife } from "@/util/iife"

export namespace Session {
  const log = Log.create({ service: "session" })
  const defaultDreamingWorker = new DreamingWorker()

  /**
   * Start the per-process DreamingWorker tick timer. Called at daemon
   * boot; idempotent (the worker's start() guards re-entry). Tests do
   * NOT call this — the worker stays dormant unless explicitly started,
   * so test imports never spawn a real interval that would drift across
   * the suite.
   */
  export function startDreamingWorker() {
    defaultDreamingWorker.start()
    log.info("dreaming.worker.started")
  }

  export function stopDreamingWorker() {
    defaultDreamingWorker.stop()
    log.info("dreaming.worker.stopped")
  }

  export async function dreamingStatus() {
    const candidates = await DreamingWorker.scanLegacySessions().catch(() => [] as Array<{ sessionID: string }>)
    const migrated = await DreamingWorker.countMigrated().catch(() => 0)
    const inner = defaultDreamingWorker.getStatus()
    return {
      ...inner,
      pending: candidates.length,
      migrated,
      // First few pending session IDs for quick eyeballing.
      pendingPreview: candidates.slice(0, 5).map((c) => c.sessionID),
    }
  }

  export const Stats = z.object({
    requestsTotal: z.number(),
    totalTokens: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    lastUpdated: z.number(),
  })
  export type Stats = z.output<typeof Stats>

  const parentTitlePrefix = "New session - "
  const childTitlePrefix = "Child session - "

  function createDefaultTitle(isChild = false) {
    return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
  }

  export function isDefaultTitle(title: string) {
    return new RegExp(
      `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
    ).test(title)
  }

  function getForkedTitle(title: string): string {
    const match = title.match(/^(.+) \(fork #(\d+)\)$/)
    if (match) {
      const base = match[1]
      const num = parseInt(match[2], 10)
      return `${base} (fork #${num + 1})`
    }
    return `${title} (fork #1)`
  }

  function emptyStats(now = Date.now()): Stats {
    return {
      requestsTotal: 0,
      totalTokens: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      lastUpdated: now,
    }
  }

  function assistantUsage(msg?: MessageV2.Info) {
    if (!msg || msg.role !== "assistant") {
      return {
        requests: 0,
        totalTokens: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }
    }
    const safe = (value: number) => (Number.isFinite(value) ? value : 0)
    const input = safe(msg.tokens.input)
    const output = safe(msg.tokens.output)
    const reasoning = safe(msg.tokens.reasoning)
    const cacheRead = safe(msg.tokens.cache.read)
    const cacheWrite = safe(msg.tokens.cache.write)
    const total = input + output + reasoning + cacheRead + cacheWrite
    return {
      requests: total > 0 ? 1 : 0,
      totalTokens: total,
      tokens: {
        input,
        output,
        reasoning,
        cache: {
          read: cacheRead,
          write: cacheWrite,
        },
      },
    }
  }

  function applyMessageUsageDelta(session: Info, prev?: MessageV2.Info, next?: MessageV2.Info) {
    const before = assistantUsage(prev)
    const after = assistantUsage(next)
    const deltaRequests = after.requests - before.requests
    const deltaTotalTokens = after.totalTokens - before.totalTokens
    const deltaInput = after.tokens.input - before.tokens.input
    const deltaOutput = after.tokens.output - before.tokens.output
    const deltaReasoning = after.tokens.reasoning - before.tokens.reasoning
    const deltaCacheRead = after.tokens.cache.read - before.tokens.cache.read
    const deltaCacheWrite = after.tokens.cache.write - before.tokens.cache.write

    if (
      deltaRequests === 0 &&
      deltaTotalTokens === 0 &&
      deltaInput === 0 &&
      deltaOutput === 0 &&
      deltaReasoning === 0 &&
      deltaCacheRead === 0 &&
      deltaCacheWrite === 0
    ) {
      return false
    }

    const current = session.stats ?? emptyStats()
    session.stats = {
      requestsTotal: Math.max(0, current.requestsTotal + deltaRequests),
      totalTokens: Math.max(0, current.totalTokens + deltaTotalTokens),
      tokens: {
        input: Math.max(0, current.tokens.input + deltaInput),
        output: Math.max(0, current.tokens.output + deltaOutput),
        reasoning: Math.max(0, current.tokens.reasoning + deltaReasoning),
        cache: {
          read: Math.max(0, current.tokens.cache.read + deltaCacheRead),
          write: Math.max(0, current.tokens.cache.write + deltaCacheWrite),
        },
      },
      lastUpdated: Date.now(),
    }
    return true
  }

  function hasMessageUsageDelta(prev?: MessageV2.Info, next?: MessageV2.Info) {
    const before = assistantUsage(prev)
    const after = assistantUsage(next)
    return (
      before.requests !== after.requests ||
      before.totalTokens !== after.totalTokens ||
      before.tokens.input !== after.tokens.input ||
      before.tokens.output !== after.tokens.output ||
      before.tokens.reasoning !== after.tokens.reasoning ||
      before.tokens.cache.read !== after.tokens.cache.read ||
      before.tokens.cache.write !== after.tokens.cache.write
    )
  }

  export const AutonomousPolicy = z.object({
    enabled: z.boolean(),
    maxContinuousRounds: z.number().optional(),
    stopOnTestsFail: z.boolean().optional(),
    requireApprovalFor: z.array(z.string()).optional(),
  })
  export type AutonomousPolicy = z.output<typeof AutonomousPolicy>

  export const WorkflowState = z.enum(["idle", "running", "waiting_user", "blocked", "completed"])
  export type WorkflowState = z.output<typeof WorkflowState>

  export const WorkflowSupervisor = z.object({
    leaseOwner: z.string().optional(),
    leaseExpiresAt: z.number().optional(),
    retryAt: z.number().optional(),
    consecutiveResumeFailures: z.number().optional(),
    lastResumeCategory: z.string().optional(),
    lastResumeError: z.string().optional(),
  })
  export type WorkflowSupervisor = z.output<typeof WorkflowSupervisor>

  export const WorkflowInfo = z.object({
    autonomous: AutonomousPolicy,
    state: WorkflowState,
    stopReason: z.string().optional(),
    updatedAt: z.number(),
    lastRunAt: z.number().optional(),
    supervisor: WorkflowSupervisor.optional(),
  })
  export type WorkflowInfo = z.output<typeof WorkflowInfo>

  export const ExecutionIdentity = z.object({
    providerId: z.string(),
    modelID: z.string(),
    accountId: z.string().optional(),
    revision: z.number().int().nonnegative(),
    updatedAt: z.number(),
    /**
     * compaction-redesign DD-11: epoch ms when codex provider rejected
     * `previous_response_id`. State-driven replacement for the legacy
     * `pendingRebindCompaction` Set. `deriveObservedCondition` returns
     * `"continuation-invalidated"` when this timestamp is newer than the
     * most recent Anchor's `time.created`. Implicit cooldown via
     * anchor-recency comparison; no flag-clear step.
     */
    continuationInvalidatedAt: z.number().optional(),
    /**
     * attachment-lifecycle v4 DD-20: image filenames currently queued for
     * inline rendering in the next preface trailing tier (BP4 zone). Drained
     * after each assistant `finish="stop"` so the active set never grows
     * across turns. Re-populated by `addOnUpload` (post-user-message) or
     * `addOnReread` (voucher tool). Empty/undefined = no images inlined.
     */
    activeImageRefs: z.array(z.string()).optional(),
  })
  export type ExecutionIdentity = z.output<typeof ExecutionIdentity>

  export const Info = z
    .object({
      id: Identifier.schema("session"),
      slug: z.string(),
      projectID: z.string(),
      directory: z.string(),
      parentID: Identifier.schema("session").optional(),
      summary: z
        .object({
          additions: z.number(),
          deletions: z.number(),
          files: z.number(),
          diffs: Snapshot.FileDiff.array().optional(),
        })
        .optional(),
      share: z
        .object({
          url: z.string(),
        })
        .optional(),
      title: z.string(),
      version: z.string(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        compacting: z.number().optional(),
        archived: z.number().optional(),
      }),
      permission: PermissionNext.Ruleset.optional(),
      revert: z
        .object({
          messageID: z.string(),
          partID: z.string().optional(),
          snapshot: z.string().optional(),
          diff: z.string().optional(),
        })
        .optional(),
      stats: Stats.optional(),
      execution: ExecutionIdentity.optional(),
      workflow: WorkflowInfo.optional(),
      // responsive-orchestrator R2: wake-only notice queue. Subscriber
      // (pending-notice-appender) appends here; prompt assemble drains
      // by rendering each notice into a one-line system-prompt addendum
      // then atomically removing consumed entries.
      pendingSubagentNotices: MessageV2.PendingSubagentNotice.array().optional(),
    })
    .meta({
      ref: "Session",
    })
  export type Info = z.output<typeof Info>

  export function defaultWorkflow(now = Date.now()): WorkflowInfo {
    return {
      autonomous: {
        enabled: false,
        stopOnTestsFail: true,
        requireApprovalFor: ["push", "destructive", "architecture_change"],
      },
      state: "waiting_user",
      updatedAt: now,
      supervisor: {},
    }
  }

  function sameExecutionIdentity(
    left?: Pick<ExecutionIdentity, "providerId" | "modelID" | "accountId">,
    right?: Pick<ExecutionIdentity, "providerId" | "modelID" | "accountId">,
  ) {
    return (
      left?.providerId === right?.providerId && left?.modelID === right?.modelID && left?.accountId === right?.accountId
    )
  }

  export function nextExecutionIdentity(input: {
    current?: ExecutionIdentity
    model: { providerId: string; modelID: string; accountId?: string }
    now?: number
  }): ExecutionIdentity {
    const now = input.now ?? Date.now()
    const unchanged = sameExecutionIdentity(input.current, input.model)
    return {
      providerId: input.model.providerId,
      modelID: input.model.modelID,
      accountId: input.model.accountId,
      revision: unchanged ? (input.current?.revision ?? 0) : (input.current?.revision ?? 0) + 1,
      updatedAt: now,
    }
  }

  export function mergeAutonomousPolicy(
    current: AutonomousPolicy | undefined,
    patch: Partial<AutonomousPolicy>,
  ): AutonomousPolicy {
    const base = current ?? defaultWorkflow().autonomous
    return {
      enabled: patch.enabled ?? base.enabled,
      maxContinuousRounds: patch.maxContinuousRounds ?? base.maxContinuousRounds,
      stopOnTestsFail: patch.stopOnTestsFail ?? base.stopOnTestsFail,
      requireApprovalFor: patch.requireApprovalFor ?? base.requireApprovalFor,
    }
  }

  export const ProjectInfo = z
    .object({
      id: z.string(),
      name: z.string().optional(),
      worktree: z.string(),
    })
    .meta({
      ref: "ProjectSummary",
    })
  export type ProjectInfo = z.output<typeof ProjectInfo>

  export const GlobalInfo = Info.extend({
    project: ProjectInfo.nullable(),
  }).meta({
    ref: "GlobalSession",
  })
  export type GlobalInfo = z.output<typeof GlobalInfo>

  export const ShareInfo = z
    .object({
      secret: z.string(),
      url: z.string(),
    })
    .meta({
      ref: "SessionShare",
    })
  export type ShareInfo = z.output<typeof ShareInfo>

  export const Event = {
    Created: BusEvent.define(
      "session.created",
      z.object({
        info: Info,
      }),
    ),
    Updated: BusEvent.define(
      "session.updated",
      z.object({
        info: Info,
      }),
    ),
    Deleted: BusEvent.define(
      "session.deleted",
      z.object({
        info: Info,
      }),
    ),
    Diff: BusEvent.define(
      "session.diff",
      z.object({
        sessionID: z.string(),
        diff: Snapshot.FileDiff.array(),
      }),
    ),
    Error: BusEvent.define(
      "session.error",
      z.object({
        sessionID: z.string().optional(),
        error: MessageV2.Assistant.shape.error,
      }),
    ),
    WorkflowUpdated: BusEvent.define(
      "session.workflow.updated",
      z.object({
        sessionID: Identifier.schema("session"),
        workflow: WorkflowInfo,
      }),
    ),
  }

  export const create = fn(
    z
      .object({
        parentID: Identifier.schema("session").optional(),
        title: z.string().optional(),
        permission: Info.shape.permission,
      })
      .optional(),
    async (input) => {
      return createNext({
        parentID: input?.parentID,
        directory: Instance.directory,
        title: input?.title,
        permission: input?.permission,
      })
    },
  )

  export const fork = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
    }),
    async (input) => {
      const original = await get(input.sessionID)
      if (!original) throw new Error("session not found")
      const title = getForkedTitle(original.title)
      const session = await createNext({
        directory: Instance.directory,
        title,
      })
      const msgs = await messages({ sessionID: input.sessionID })
      const idMap = new Map<string, string>()

      for (const msg of msgs) {
        if (input.messageID && msg.info.id >= input.messageID) break
        const newID = Identifier.ascending("message")
        idMap.set(msg.info.id, newID)

        const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
        const cloned = await updateMessage({
          ...msg.info,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        })

        for (const part of msg.parts) {
          await updatePart({
            ...part,
            id: Identifier.ascending("part"),
            messageID: cloned.id,
            sessionID: session.id,
          })
        }
      }
      return session
    },
  )

  export const touch = fn(Identifier.schema("session"), async (sessionID) => {
    await update(sessionID, (draft) => {
      draft.time.updated = Date.now()
    })
  })

  export async function createNext(input: {
    id?: string
    title?: string
    parentID?: string
    directory: string
    permission?: PermissionNext.Ruleset
  }) {
    const result: Info = {
      id: Identifier.descending("session", input.id),
      slug: Slug.create(),
      version: Installation.VERSION,
      projectID: Instance.project.id,
      directory: input.directory,
      parentID: input.parentID,
      title: input.title ?? createDefaultTitle(!!input.parentID),
      permission: input.permission,
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
      stats: emptyStats(),
      workflow: defaultWorkflow(),
    }
    log.info("created", result)
    await Storage.write(["session", Instance.project.id, result.id], result)
    Bus.publish(Event.Created, {
      info: result,
    })
    const cfg = await Config.get()
    if (!result.parentID && (Flag.OPENCODE_AUTO_SHARE || cfg.share === "auto"))
      share(result.id)
        .then((share) => {
          update(result.id, (draft) => {
            draft.share = share
          })
        })
        .catch(() => {
          // Silently ignore sharing errors during session creation
        })
    Bus.publish(Event.Updated, {
      info: result,
    })
    return result
  }

  export const get = fn(Identifier.schema("session"), async (id) => {
    const read = await Storage.read<Info>(["session", Instance.project.id, id])
    // Version guard: detect sessions created by a different daemon version
    if (read.version && read.version !== Installation.VERSION) {
      ;(read as any)._staleVersion = true
      Log.Default.warn("session version mismatch", {
        sessionID: id,
        sessionVersion: read.version,
        daemonVersion: Installation.VERSION,
      })
      debugCheckpoint("session", "version_drift", {
        sessionID: id,
        sessionVersion: read.version,
        daemonVersion: Installation.VERSION,
      })
    }
    return read as Info
  })

  export const getShare = fn(Identifier.schema("session"), async (id) => {
    return Storage.read<ShareInfo>(["share", id])
  })

  export const share = fn(Identifier.schema("session"), async (id) => {
    const cfg = await Config.get()
    if (cfg.share === "disabled") {
      throw new Error("Sharing is disabled in configuration")
    }
    const { ShareNext } = await import("@/share/share-next")
    const share = await ShareNext.create(id)
    await update(
      id,
      (draft) => {
        draft.share = {
          url: share.url,
        }
      },
      { touch: false },
    )
    return share
  })

  export const unshare = fn(Identifier.schema("session"), async (id) => {
    // Use ShareNext to remove the share (same as share function uses ShareNext to create)
    const { ShareNext } = await import("@/share/share-next")
    await ShareNext.remove(id)
    await update(
      id,
      (draft) => {
        draft.share = undefined
      },
      { touch: false },
    )
  })

  export async function update(id: string, editor: (session: Info) => void, options?: { touch?: boolean }) {
    const project = Instance.project
    const result = await Storage.update<Info>(["session", project.id, id], (draft) => {
      editor(draft)
      if (options?.touch !== false) {
        draft.time.updated = Date.now()
      }
    })
    Bus.publish(Event.Updated, {
      info: result,
    })
    if (result.workflow) {
      Bus.publish(Event.WorkflowUpdated, {
        sessionID: result.id,
        workflow: result.workflow,
      })
    }
    return result
  }

  export async function setWorkflowState(input: {
    sessionID: string
    state: WorkflowState
    stopReason?: string
    lastRunAt?: number
  }) {
    return update(
      input.sessionID,
      (draft) => {
        const current = draft.workflow ?? defaultWorkflow(draft.time.updated)
        draft.workflow = {
          ...current,
          state: input.state,
          stopReason: input.stopReason,
          lastRunAt: input.lastRunAt ?? current.lastRunAt,
          updatedAt: Date.now(),
        }
      },
      { touch: false },
    )
  }

  export async function updateAutonomous(input: { sessionID: string; policy: Partial<AutonomousPolicy> }) {
    return update(
      input.sessionID,
      (draft) => {
        const current = draft.workflow ?? defaultWorkflow(draft.time.updated)
        draft.workflow = {
          ...current,
          autonomous: mergeAutonomousPolicy(current.autonomous, input.policy),
          updatedAt: Date.now(),
        }
      },
      { touch: false },
    )
  }

  export async function updateWorkflowSupervisor(input: {
    sessionID: string
    patch: Partial<WorkflowSupervisor>
    clear?: Array<keyof WorkflowSupervisor>
  }) {
    return update(
      input.sessionID,
      (draft) => {
        const current = draft.workflow ?? defaultWorkflow(draft.time.updated)
        const supervisor = {
          ...(current.supervisor ?? {}),
          ...input.patch,
        }
        for (const key of input.clear ?? []) delete supervisor[key]
        draft.workflow = {
          ...current,
          supervisor,
          updatedAt: Date.now(),
        }
      },
      { touch: false },
    )
  }

  export async function pinExecutionIdentity(input: {
    sessionID: string
    model: { providerId: string; modelID: string; accountId?: string }
  }) {
    // Skip update (and the Bus event it publishes) when identity is unchanged.
    // pinExecutionIdentity is called up to 5× per processor loop iteration;
    // unconditional updates caused a Bus event storm → frontend SSE cascade →
    // expensive snapshot scans → event-loop saturation → slow LLM streaming.
    const current = await get(input.sessionID)
    if (current && sameExecutionIdentity(current.execution, input.model)) {
      return current
    }
    return update(
      input.sessionID,
      (draft) => {
        draft.execution = nextExecutionIdentity({
          current: draft.execution,
          model: input.model,
        })
      },
      { touch: false },
    )
  }

  /**
   * attachment-lifecycle v4 (DD-20): set the activeImageRefs queue on the
   * session's execution identity. Called by the user-message commit hook
   * (addOnUpload) and the post-completion drain hook
   * (drainAfterAssistant). No-op when no execution identity exists yet.
   */
  export async function setActiveImageRefs(sessionID: string, refs: string[]) {
    return update(
      sessionID,
      (draft) => {
        if (draft.execution) {
          draft.execution = { ...draft.execution, activeImageRefs: refs }
        }
      },
      { touch: false },
    )
  }

  /**
   * compaction-redesign DD-11: record the moment codex rejected
   * `previous_response_id`. State-driven equivalent of legacy
   * `markRebindCompaction`. The runloop's `deriveObservedCondition`
   * compares this timestamp against the most recent Anchor's
   * `time.created` to decide whether to fire `run({observed:
   * "continuation-invalidated"})`.
   */
  export async function markContinuationInvalidated(sessionID: string) {
    return update(
      sessionID,
      (draft) => {
        if (draft.execution) {
          draft.execution = {
            ...draft.execution,
            continuationInvalidatedAt: Date.now(),
          }
        }
      },
      { touch: false },
    )
  }

  export const diff = fn(Identifier.schema("session"), async (sessionID) => {
    const diffs = await Storage.read<Snapshot.FileDiff[]>(["session_diff", sessionID])
    return diffs ?? []
  })

  export const messages = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      limit: z.number().optional(),
      // Cursor for older-history pagination. When set, return up to `limit`
      // messages strictly older than the referenced message. MessageV2.stream
      // is newest-first so we skip until we see this id, drop it, then
      // collect the next `limit` entries. Without `before`, returns the
      // last `limit` messages chronologically.
      before: z.string().optional(),
    }),
    async (input) => {
      const result = [] as MessageV2.WithParts[]
      let seenCursor = input.before === undefined
      for await (const msg of MessageV2.stream(input.sessionID)) {
        if (!seenCursor) {
          if (msg.info?.id === input.before) {
            seenCursor = true
          }
          continue
        }
        if (input.limit && result.length >= input.limit) break
        result.push(msg)
      }
      result.reverse()
      return result
    },
  )

  export async function* list() {
    const project = Instance.project
    for (const item of await Storage.list(["session", project.id])) {
      const session = await Storage.read<Info>(item).catch(() => undefined)
      if (!session) continue
      yield session
    }
  }

  export async function* listGlobal(input?: {
    directory?: string
    roots?: boolean
    start?: number
    cursor?: number
    search?: string
    limit?: number
    archived?: boolean
    providerFamily?: "claude"
  }) {
    const term = input?.search?.toLowerCase()
    const limit = input?.limit ?? 100
    const sessions: GlobalInfo[] = []

    const projects = await Project.list().catch(() => [] as Project.Info[])
    const projectByID = new Map<string, ProjectInfo>()
    for (const project of projects) {
      projectByID.set(project.id, {
        id: project.id,
        name: project.name ?? undefined,
        worktree: project.worktree,
      })
    }

    // Build a set of projectIDs that map to the requested directory.
    // This handles repo moves: old sessions may have a stale directory string
    // but their projectID still maps to the same worktree via the project record.
    const matchingProjectIDs = new Set<string>()
    if (input?.directory !== undefined) {
      for (const [pid, proj] of projectByID) {
        if (proj.worktree === input.directory) {
          matchingProjectIDs.add(pid)
        }
      }
    }

    const items = await Storage.list(["session"])
    const sessionContents = await Promise.all(
      items.map(async (item) => {
        const session = await Storage.read<Info>(item).catch(() => undefined)
        if (!session) return null

        if (input?.directory !== undefined) {
          const dirMatch = session.directory === input.directory
          const projMatch = matchingProjectIDs.has(session.projectID)
          if (!dirMatch && !projMatch) return null
          if (!dirMatch && projMatch) {
            log.warn("session directory mismatch (repo moved?)", {
              sessionID: session.id,
              stored: session.directory,
              current: input.directory,
              projectID: session.projectID,
            })
          }
        }
        if (input?.roots && session.parentID) return null
        if (input?.start !== undefined && session.time.updated < input.start) return null
        if (input?.cursor !== undefined && session.time.updated >= input.cursor) return null
        if (!input?.archived && session.time.archived !== undefined) return null
        if (term !== undefined && !session.title.toLowerCase().includes(term)) return null
        if (input?.providerFamily === "claude" && !isClaudeSession(session)) return null

        return {
          ...session,
          project: projectByID.get(session.projectID) ?? null,
        }
      }),
    )

    for (const s of sessionContents) {
      if (s) sessions.push(s)
    }

    sessions.sort((a, b) => b.time.updated - a.time.updated || b.id.localeCompare(a.id))
    for (const session of sessions.slice(0, limit)) {
      yield session
    }
  }

  export function isClaudeSession(session: Pick<Info, "execution">) {
    const execution = session.execution
    if (!execution) return false
    return (
      execution.providerId === "claude-cli" ||
      execution.providerId === "anthropic" ||
      execution.modelID.startsWith("claude-") ||
      execution.modelID.includes("/claude-")
    )
  }

  export const children = fn(Identifier.schema("session"), async (parentID) => {
    const project = Instance.project
    const items = await Storage.list(["session", project.id])
    const sessions = await Promise.all(
      items.map(async (item) => {
        const session = await Storage.read<Info>(item).catch(() => undefined)
        if (session?.parentID === parentID) return session
        return null
      }),
    )
    return sessions.filter((s): s is Info => !!s)
  })

  export const remove = fn(Identifier.schema("session"), async (sessionID) => {
    try {
      // Resolve the session's actual projectID from storage rather than assuming
      // Instance.project.  listGlobal() returns cross-project sessions, so the
      // caller may be deleting a session that belongs to a different project.
      let session: Info | undefined
      let ownerProjectID = Instance.project.id
      try {
        session = await get(sessionID)
      } catch {
        // Session not in current project — scan all projects
        for (const item of await Storage.list(["session"])) {
          const sid = item.at(-1)
          if (sid !== sessionID) continue
          const projectID = item.length >= 3 ? item[1] : undefined
          if (projectID) ownerProjectID = projectID
          session = await Storage.read<Info>(item).catch(() => undefined)
          break
        }
      }
      if (!session) {
        log.warn("session not found for removal", { sessionID })
        return
      }
      for (const child of await children(sessionID)) {
        await remove(child.id)
      }
      await unshare(sessionID).catch(() => {})
      await StorageRouter.deleteSession(sessionID)
      await Storage.remove(["session", ownerProjectID, sessionID])
      Bus.publish(Event.Deleted, {
        info: session,
      })
    } catch (e) {
      log.error(e)
    }
  })

  export const updateMessage = fn(MessageV2.Info, async (msg) => {
    const previous = await readMessageInfo(msg.sessionID, msg.id)
    await StorageRouter.upsertMessage(msg)
    DreamingWorker.noteMessageWrite(defaultDreamingWorker)
    if (hasMessageUsageDelta(previous, msg)) {
      await update(
        msg.sessionID,
        (draft) => {
          applyMessageUsageDelta(draft, previous, msg)
        },
        { touch: false },
      ).catch(() => {})
    }
    Bus.publish(MessageV2.Event.Updated, {
      info: msg,
    })
    return msg
  })

  export const removeMessage = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      const previous = await readMessageInfo(input.sessionID, input.messageID)
      await removeMessageInfo(input.sessionID, input.messageID)
      if (hasMessageUsageDelta(previous, undefined)) {
        await update(
          input.sessionID,
          (draft) => {
            applyMessageUsageDelta(draft, previous, undefined)
          },
          { touch: false },
        ).catch(() => {})
      }
      Bus.publish(MessageV2.Event.Removed, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    },
  )

  export const removePart = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
      partID: Identifier.schema("part"),
    }),
    async (input) => {
      await removePartFile(input.messageID, input.partID)
      Bus.publish(MessageV2.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    },
  )

  const UpdatePartInput = z.union([
    MessageV2.Part,
    z.object({
      part: MessageV2.TextPart,
      delta: z.string(),
    }),
    z.object({
      part: MessageV2.ReasoningPart,
      delta: z.string(),
    }),
  ])

  // Instrumentation: track cumulative part sizes for delta effectiveness measurement
  const _deltaMetrics = { updates: 0, totalPartBytes: 0, totalDeltaBytes: 0 }

  // --- Streaming part persistence guards (hotfix 2026-04-23) ------------------
  //
  // Root cause: every text/reasoning delta used to call Storage.write() which
  // JSON.stringify-s the entire growing part and overwrites the on-disk file.
  // A 3.7 MB part × 13,600 deltas = ~50 GB of cumulative stringify + disk
  // writes on a single reasoning-loop runaway, which starved the event loop
  // and made the daemon look hung.
  //
  // A. Debounce: during streaming we coalesce delta writes into one flush
  //    every `partPersistence.debounceMs`. Non-delta updates (text-end,
  //    tool transitions, completion) flush immediately so at-rest state
  //    is always consistent once streaming ends.
  // C. Hard cap: if the growing part text exceeds `partPersistence.maxPartBytes`
  //    we truncate it with a marker, seal the part so further deltas are
  //    ignored, flush, and abort the session with reason="runaway-guard".
  type _PendingPartWrite = {
    key: string[]
    content: any
    timer: ReturnType<typeof setTimeout>
  }
  const _pendingPartWrites = new Map<string, _PendingPartWrite>()
  const _sealedParts = new Set<string>()

  async function _flushPartWrite(keyStr: string): Promise<void> {
    const entry = _pendingPartWrites.get(keyStr)
    if (!entry) return
    clearTimeout(entry.timer)
    _pendingPartWrites.delete(keyStr)
    await StorageRouter.upsertPart(entry.content as MessageV2.Part)
  }

  function _schedulePartWrite(keyStr: string, key: string[], content: any, debounceMs: number) {
    const existing = _pendingPartWrites.get(keyStr)
    if (existing) {
      existing.key = key
      existing.content = content
      return
    }
    const timer = setTimeout(() => {
      const e = _pendingPartWrites.get(keyStr)
      if (!e) return
      _pendingPartWrites.delete(keyStr)
      Storage.write(e.key, e.content).catch((err) =>
        log.warn("debounced part write failed", {
          keyStr,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }, debounceMs)
    _pendingPartWrites.set(keyStr, { key, content, timer })
  }

  export const updatePart = fn(UpdatePartInput, async (input) => {
    const part = "delta" in input ? input.part : input
    const delta = "delta" in input ? input.delta : undefined
    const storeKey = ["part", part.messageID, part.id]
    const keyStr = `${part.messageID}/${part.id}`

    // Runaway guard: once a part is sealed, drop further streaming deltas
    // so the upstream caller's accumulating buffer stops growing in memory
    // too. Non-delta updates (e.g. text-end) still flow through so the
    // upstream finalisation path terminates cleanly.
    if (_sealedParts.has(keyStr) && delta) return part

    const tweak = Tweaks.partPersistenceSync()
    let runawayTripped = false
    if (delta && "text" in part && typeof part.text === "string" && part.text.length > tweak.maxPartBytes) {
      const truncated =
        part.text.slice(0, tweak.maxPartBytes) +
        `\n\n[…truncated by runaway-guard: part exceeded ${tweak.maxPartBytes} bytes]`
      ;(part as any).text = truncated
      _sealedParts.add(keyStr)
      runawayTripped = true
    }

    // Persistence: debounce streaming deltas; flush+write synchronously
    // for non-delta updates or when the runaway guard just tripped.
    if (delta && "text" in part && typeof part.text === "string" && !runawayTripped) {
      _schedulePartWrite(keyStr, storeKey, part, tweak.debounceMs)
    } else {
      await _flushPartWrite(keyStr)
      await StorageRouter.upsertPart(part)
    }

    // [DELTA-PART] instrumentation: measure full-part vs delta cost per chunk
    if ("text" in part && typeof part.text === "string") {
      _deltaMetrics.updates++
      _deltaMetrics.totalPartBytes += part.text.length
      _deltaMetrics.totalDeltaBytes += delta?.length ?? part.text.length
      if (_deltaMetrics.updates % 50 === 0) {
        const ratio =
          _deltaMetrics.totalPartBytes > 0
            ? ((_deltaMetrics.totalDeltaBytes / _deltaMetrics.totalPartBytes) * 100).toFixed(1)
            : "N/A"
        console.error(
          `[DELTA-PART] updates=${_deltaMetrics.updates} totalPartChars=${_deltaMetrics.totalPartBytes} totalDeltaChars=${_deltaMetrics.totalDeltaBytes} ratio=${ratio}% partId=${part.id}`,
        )
      }
    }

    // Delta-aware transport: when streaming text/reasoning deltas, strip
    // part.text from the event to avoid O(n²) amplification over Bus → SSE.
    // Consumers accumulate text from deltas; textLength enables desync detection.
    // Non-delta updates (tool parts, completion) carry the full part as before.
    //
    // IMPORTANT: The first delta for a new part must carry full text so consumers
    // can insert the part with its initial content. We detect "first" by checking
    // if part.text === delta (text accumulated so far equals just this chunk).
    if (delta && "text" in part && typeof part.text === "string" && part.text !== delta) {
      const textLength = part.text.length
      const { text: _stripped, ...lightPart } = part as Record<string, unknown>
      Bus.publish(MessageV2.Event.PartUpdated, {
        part: lightPart as typeof part,
        delta,
        textLength,
      })
      log.info("[PART-FLOW-A] published part.updated (delta-stripped)", {
        sessionID: part.sessionID,
        partId: part.id,
        partType: part.type,
        tool: (part as { tool?: string }).tool,
        textLength,
      })
    } else {
      Bus.publish(MessageV2.Event.PartUpdated, {
        part,
        delta,
      })
      log.info("[PART-FLOW-A] published part.updated", {
        sessionID: part.sessionID,
        partId: part.id,
        partType: part.type,
        tool: (part as { tool?: string }).tool,
        toolStateStatus: (part as { state?: { status?: string } }).state?.status,
      })
    }

    if (runawayTripped) {
      console.error(
        `[RUNAWAY-GUARD] sealed part sessionID=${part.sessionID} partId=${part.id} capBytes=${tweak.maxPartBytes} cancelSession=${tweak.cancelOnCapTrip}`,
      )
      if (tweak.cancelOnCapTrip) {
        try {
          SessionPrompt.cancel(part.sessionID, "runaway-guard")
        } catch (err) {
          log.warn("runaway-guard cancel failed", {
            sessionID: part.sessionID,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    return part
  })

  export const getUsage = fn(
    z.object({
      model: z.custom<Provider.Model>(),
      usage: z.custom<LanguageModelV2Usage>(),
      metadata: z.custom<ProviderMetadata>().optional(),
    }),
    (input) => {
      const safe = (value: number) => {
        if (!Number.isFinite(value)) return 0
        return value
      }
      const inputTokens = safe(input.usage.inputTokens ?? 0)
      const outputTokens = safe(input.usage.outputTokens ?? 0)
      const reasoningTokens = safe(input.usage.reasoningTokens ?? 0)

      const cacheReadInputTokens = safe(input.usage.cachedInputTokens ?? 0)
      const cacheWriteInputTokens = safe(
        (input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
          // @ts-expect-error
          input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
          // @ts-expect-error
          input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
          0) as number,
      )

      // OpenRouter provides inputTokens as the total count of input tokens (including cached).
      // AFAIK other providers (OpenRouter/OpenAI/Gemini etc.) do it the same way e.g. vercel/ai#8794 (comment)
      // Anthropic does it differently though - inputTokens doesn't include cached tokens.
      // It looks like OpenCode's cost calculation assumes all providers return inputTokens the same way Anthropic does (I'm guessing getUsage logic was originally implemented with anthropic), so it's causing incorrect cost calculation for OpenRouter and others.
      const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
      const adjustedInputTokens = safe(
        excludesCachedTokens ? inputTokens : inputTokens - cacheReadInputTokens - cacheWriteInputTokens,
      )

      const total = iife(() => {
        // Anthropic doesn't provide total_tokens, also ai sdk will vastly undercount if we
        // don't compute from components
        if (
          input.model.api.npm === "@ai-sdk/anthropic" ||
          input.model.api.npm === "@ai-sdk/amazon-bedrock" ||
          input.model.api.npm === "@ai-sdk/google-vertex/anthropic"
        ) {
          return adjustedInputTokens + outputTokens + cacheReadInputTokens + cacheWriteInputTokens
        }
        return input.usage.totalTokens
      })

      const tokens = {
        total,
        input: adjustedInputTokens,
        output: outputTokens,
        reasoning: reasoningTokens,
        cache: {
          write: cacheWriteInputTokens,
          read: cacheReadInputTokens,
        },
      }

      const costInfo =
        input.model.cost?.experimentalOver200K && tokens.input + tokens.cache.read > 200_000
          ? input.model.cost.experimentalOver200K
          : input.model.cost
      const reasoningRate = costInfo?.reasoning ?? costInfo?.output ?? 0
      return {
        cost: safe(
          new Decimal(0)
            .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
            .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
            .add(new Decimal(tokens.reasoning).mul(reasoningRate).div(1_000_000))
            .toNumber(),
        ),
        tokens,
      }
    },
  )

  export class BusyError extends Error {
    constructor(public readonly sessionID: string) {
      super(`Session ${sessionID} is busy`)
    }
  }

  export const initialize = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      modelID: z.string(),
      providerID: z.string(),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      await SessionPrompt.command({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: input.providerID + "/" + input.modelID,
        command: Command.Default.INIT,
        arguments: "",
      })
    },
  )
}
