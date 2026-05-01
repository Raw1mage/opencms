import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import {
  APICallError,
  convertToModelMessages,
  LoadAPIKeyError,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from "ai"
import { Identifier } from "../id/id"
import { LSP } from "../lsp"
import { Snapshot } from "@/snapshot"
import { fn } from "@/util/fn"
import { Storage } from "@/storage/storage"
import { Router as StorageRouter } from "./storage/router"
import { ProviderError } from "@/provider/error"
import { ProviderTransform } from "@/provider/transform"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import { type SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { Token } from "../util/token"
import { Bus } from "@/bus"
import { debugCheckpoint } from "@/util/debug"

export namespace MessageV2 {
  export type ContinuationResetTrigger =
    | "identity_changed"
    | "provider_invalidation"
    | "restart_resume_mismatch"
    | "checkpoint_rebuild_untrusted"
    | "explicit_reset"

  export interface ContinuationExecutionIdentity {
    providerId: string
    modelID: string
    accountId?: string
  }

  export interface ContinuationResetDecisionInput {
    current?: ContinuationExecutionIdentity
    next?: ContinuationExecutionIdentity
    providerInvalidation?: boolean
    restartResumeMismatch?: boolean
    checkpointRebuildUntrusted?: boolean
    explicitReset?: boolean
  }

  export interface ContinuationResetDecision {
    flushRemoteRefs: boolean
    matchedTriggers: ContinuationResetTrigger[]
  }

  export interface ContinuationReplayDebug {
    textParts: number
    textItemIds: number
    reasoningParts: number
    reasoningItemIds: number
    toolParts: number
    toolItemIds: number
  }

  function redactSensitiveText(input: string | undefined) {
    if (!input) return undefined
    let value = input
    value = value.replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;]+/gi, "$1[REDACTED]")
    value = value.replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    value = value.replace(/(token\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    value = value.replace(/(secret\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    value = value.replace(/(cookie\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    return value.slice(0, 240)
  }

  export function buildInvalidationDebugSnapshot(input: {
    current: ContinuationExecutionIdentity
    next: ContinuationExecutionIdentity
    decision: ContinuationResetDecision
    replay: ContinuationReplayDebug
    compactionParts: number
    invalidationCode?: string
    invalidationMessage?: string
  }) {
    const matched = new Set(input.decision.matchedTriggers)
    const totalRemoteItemIds = input.replay.textItemIds + input.replay.reasoningItemIds + input.replay.toolItemIds
    return {
      executionIdentity: {
        current: input.current,
        next: input.next,
      },
      triggerEvaluation: {
        a1IdentityChanged: matched.has("identity_changed"),
        a2ProviderInvalidation: matched.has("provider_invalidation"),
        a3RestartResumeMismatch: matched.has("restart_resume_mismatch"),
        a4CheckpointRebuildUntrusted: matched.has("checkpoint_rebuild_untrusted"),
        a5ExplicitReset: matched.has("explicit_reset"),
        matchedTriggers: input.decision.matchedTriggers,
        flushRemoteRefs: input.decision.flushRemoteRefs,
      },
      checkpointTailBoundary: {
        checkpointPartCount: input.compactionParts,
        tailPartCount: Math.max(0, input.replay.textParts + input.replay.reasoningParts + input.replay.toolParts),
      },
      replayComposition: {
        mode: "checkpoint_plus_tail",
        replay: input.replay,
      },
      invalidation: {
        code: input.invalidationCode ?? (matched.has("provider_invalidation") ? "provider_invalidation" : undefined),
        messageExcerpt: redactSensitiveText(input.invalidationMessage),
      },
      flushResult: {
        remoteRefsCleared: input.decision.flushRemoteRefs,
        clearedRemoteRefCount: input.decision.flushRemoteRefs ? totalRemoteItemIds : 0,
      },
    }
  }

  export function evaluateContinuationReset(input: ContinuationResetDecisionInput): ContinuationResetDecision {
    const matchedTriggers: ContinuationResetTrigger[] = []
    if (
      input.current &&
      input.next &&
      (input.current.providerId !== input.next.providerId ||
        input.current.modelID !== input.next.modelID ||
        input.current.accountId !== input.next.accountId)
    ) {
      matchedTriggers.push("identity_changed")
    }
    if (input.providerInvalidation) matchedTriggers.push("provider_invalidation")
    if (input.restartResumeMismatch) matchedTriggers.push("restart_resume_mismatch")
    if (input.checkpointRebuildUntrusted) matchedTriggers.push("checkpoint_rebuild_untrusted")
    if (input.explicitReset) matchedTriggers.push("explicit_reset")
    return {
      flushRemoteRefs: matchedTriggers.length > 0,
      matchedTriggers,
    }
  }

  function hasRemoteItemId(metadata: unknown) {
    if (!metadata || typeof metadata !== "object") return false
    for (const value of Object.values(metadata)) {
      if (!value || typeof value !== "object") continue
      if ("itemId" in value && typeof value.itemId === "string" && value.itemId.length > 0) return true
    }
    return false
  }

  export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))
  export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))
  export const StructuredOutputError = NamedError.create(
    "StructuredOutputError",
    z.object({
      message: z.string(),
      retries: z.number(),
    }),
  )
  export const AuthError = NamedError.create(
    "ProviderAuthError",
    z.object({
      providerId: z.string(),
      message: z.string(),
    }),
  )
  export const APIError = NamedError.create(
    "APIError",
    z.object({
      message: z.string(),
      statusCode: z.number().optional(),
      isRetryable: z.boolean(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
      responseBody: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  )
  export type APIError = z.infer<typeof APIError.Schema>
  export const ContextOverflowError = NamedError.create(
    "ContextOverflowError",
    z.object({ message: z.string(), responseBody: z.string().optional() }),
  )

  export const OutputFormatText = z
    .object({
      type: z.literal("text"),
    })
    .meta({
      ref: "OutputFormatText",
    })

  export const OutputFormatJsonSchema = z
    .object({
      type: z.literal("json_schema"),
      schema: z.record(z.string(), z.any()).meta({ ref: "JSONSchema" }),
      retryCount: z.number().int().min(0).default(2),
    })
    .meta({
      ref: "OutputFormatJsonSchema",
    })

  export const Format = z.discriminatedUnion("type", [OutputFormatText, OutputFormatJsonSchema]).meta({
    ref: "OutputFormat",
  })
  export type OutputFormat = z.infer<typeof Format>

  const PartBase = z.object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
  })

  export const SnapshotPart = PartBase.extend({
    type: z.literal("snapshot"),
    snapshot: z.string(),
  }).meta({
    ref: "SnapshotPart",
  })
  export type SnapshotPart = z.infer<typeof SnapshotPart>

  export const PatchPart = PartBase.extend({
    type: z.literal("patch"),
    hash: z.string(),
    files: z.string().array(),
  }).meta({
    ref: "PatchPart",
  })
  export type PatchPart = z.infer<typeof PatchPart>

  export const TextPart = PartBase.extend({
    type: z.literal("text"),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    time: z
      .object({
        start: z.number(),
        end: z.number().optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "TextPart",
  })
  export type TextPart = z.infer<typeof TextPart>

  export const ReasoningPart = PartBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
    time: z.object({
      start: z.number(),
      end: z.number().optional(),
    }),
  }).meta({
    ref: "ReasoningPart",
  })
  export type ReasoningPart = z.infer<typeof ReasoningPart>

  const FilePartSourceBase = z.object({
    text: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .meta({
        ref: "FilePartSourceText",
      }),
  })

  export const FileSource = FilePartSourceBase.extend({
    type: z.literal("file"),
    path: z.string(),
  }).meta({
    ref: "FileSource",
  })

  export const SymbolSource = FilePartSourceBase.extend({
    type: z.literal("symbol"),
    path: z.string(),
    range: LSP.Range,
    name: z.string(),
    kind: z.number().int(),
  }).meta({
    ref: "SymbolSource",
  })

  export const ResourceSource = FilePartSourceBase.extend({
    type: z.literal("resource"),
    clientName: z.string(),
    uri: z.string(),
  }).meta({
    ref: "ResourceSource",
  })

  export const FilePartSource = z.discriminatedUnion("type", [FileSource, SymbolSource, ResourceSource]).meta({
    ref: "FilePartSource",
  })

  export const FilePart = PartBase.extend({
    type: z.literal("file"),
    mime: z.string(),
    filename: z.string().optional(),
    url: z.string(),
    source: FilePartSource.optional(),
  }).meta({
    ref: "FilePart",
  })
  export type FilePart = z.infer<typeof FilePart>

  export const AttachmentRefPart = PartBase.extend({
    type: z.literal("attachment_ref"),
    ref_id: z.string(),
    mime: z.string(),
    filename: z.string().optional(),
    est_tokens: z.number().int().nonnegative(),
    byte_size: z.number().int().nonnegative(),
    preview: z.string().optional(),
    dimensions: z
      .object({
        w: z.number().int().positive(),
        h: z.number().int().positive(),
      })
      .optional(),
  }).meta({
    ref: "AttachmentRefPart",
  })
  export type AttachmentRefPart = z.infer<typeof AttachmentRefPart>

  export const AgentPart = PartBase.extend({
    type: z.literal("agent"),
    name: z.string(),
    source: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .optional(),
  }).meta({
    ref: "AgentPart",
  })
  export type AgentPart = z.infer<typeof AgentPart>

  export const CompactionPart = PartBase.extend({
    type: z.enum(["compaction", "compaction-request"]),
    auto: z.boolean(),
  }).meta({
    ref: "CompactionPart",
  })
  export type CompactionPart = z.infer<typeof CompactionPart>

  export const SubtaskPart = PartBase.extend({
    type: z.literal("subtask"),
    prompt: z.string(),
    prompt_input: z
      .union([
        z.string(),
        z.object({
          type: z.enum(["analysis", "implementation", "review", "testing", "documentation"]),
          content: z.string(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
      ])
      .optional(),
    description: z.string(),
    agent: z.string(),
    model: z
      .object({
        providerId: z.string(),
        modelID: z.string(),
        accountId: z.string().optional(),
      })
      .optional(),
    command: z.string().optional(),
  }).meta({
    ref: "SubtaskPart",
  })
  export type SubtaskPart = z.infer<typeof SubtaskPart>

  export const RetryPart = PartBase.extend({
    type: z.literal("retry"),
    attempt: z.number(),
    error: APIError.Schema,
    time: z.object({
      created: z.number(),
    }),
  }).meta({
    ref: "RetryPart",
  })
  export type RetryPart = z.infer<typeof RetryPart>

  export const StepStartPart = PartBase.extend({
    type: z.literal("step-start"),
    snapshot: z.string().optional(),
  }).meta({
    ref: "StepStartPart",
  })
  export type StepStartPart = z.infer<typeof StepStartPart>

  export const StepFinishPart = PartBase.extend({
    type: z.literal("step-finish"),
    reason: z.string(),
    snapshot: z.string().optional(),
    cost: z.number(),
    tokens: z.object({
      total: z.number().optional(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
  }).meta({
    ref: "StepFinishPart",
  })
  export type StepFinishPart = z.infer<typeof StepFinishPart>

  export const ToolStatePending = z
    .object({
      status: z.literal("pending"),
      input: z.record(z.string(), z.any()),
      raw: z.string(),
    })
    .meta({
      ref: "ToolStatePending",
    })

  export type ToolStatePending = z.infer<typeof ToolStatePending>

  export const ToolStateRunning = z
    .object({
      status: z.literal("running"),
      input: z.record(z.string(), z.any()),
      title: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateRunning",
    })
  export type ToolStateRunning = z.infer<typeof ToolStateRunning>

  export const DirectRenderInfo = z.object({
    filePath: z.string(),
    title: z.string(),
    size: z.number(),
  })
  export type DirectRenderInfo = z.infer<typeof DirectRenderInfo>

  export const ToolStateCompleted = z
    .object({
      status: z.literal("completed"),
      input: z.record(z.string(), z.any()),
      output: z.string(),
      title: z.string(),
      metadata: z.record(z.string(), z.any()),
      time: z.object({
        start: z.number(),
        end: z.number(),
        compacted: z.number().optional(),
      }),
      attachments: FilePart.array().optional(),
      directRender: DirectRenderInfo.optional(),
    })
    .meta({
      ref: "ToolStateCompleted",
    })
  export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

  export const ToolStateError = z
    .object({
      status: z.literal("error"),
      input: z.record(z.string(), z.any()),
      error: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
        end: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateError",
    })
  export type ToolStateError = z.infer<typeof ToolStateError>

  export const ToolState = z
    .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
    .meta({
      ref: "ToolState",
    })

  export const ToolPart = PartBase.extend({
    type: z.literal("tool"),
    callID: z.string(),
    tool: z.string(),
    state: ToolState,
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "ToolPart",
  })
  export type ToolPart = z.infer<typeof ToolPart>

  const Base = z.object({
    id: z.string(),
    sessionID: z.string(),
  })

  export const User = Base.extend({
    role: z.literal("user"),
    time: z.object({
      created: z.number(),
    }),
    summary: z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        diffs: Snapshot.FileDiff.array(),
      })
      .optional(),
    agent: z.string(),
    model: z.object({
      providerId: z.string(),
      modelID: z.string(),
      accountId: z.string().optional(),
    }),
    format: Format.optional(),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    variant: z.string().optional(),
  }).meta({
    ref: "UserMessage",
  })
  export type User = z.infer<typeof User>

  export const Part = z
    .discriminatedUnion("type", [
      TextPart,
      SubtaskPart,
      ReasoningPart,
      FilePart,
      AttachmentRefPart,
      ToolPart,
      StepStartPart,
      StepFinishPart,
      SnapshotPart,
      PatchPart,
      AgentPart,
      RetryPart,
      CompactionPart,
    ])
    .meta({
      ref: "Part",
    })
  export type Part = z.infer<typeof Part>

  export const Assistant = Base.extend({
    role: z.literal("assistant"),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    error: z
      .discriminatedUnion("name", [
        AuthError.Schema,
        NamedError.Unknown.Schema,
        OutputLengthError.Schema,
        AbortedError.Schema,
        StructuredOutputError.Schema,
        ContextOverflowError.Schema,
        APIError.Schema,
      ])
      .optional(),
    parentID: z.string(),
    modelID: z.string(),
    providerId: z.string(),
    accountId: z.string().optional(),
    /**
     * @deprecated
     */
    mode: z.string(),
    agent: z.string(),
    variant: z.string().optional(),
    path: z.object({
      cwd: z.string(),
      root: z.string(),
    }),
    summary: z.boolean().optional(),
    cost: z.number(),
    tokens: z.object({
      total: z.number().optional(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    structured: z.any().optional(),
    finish: z.string().optional(),
  }).meta({
    ref: "AssistantMessage",
  })
  export type Assistant = z.infer<typeof Assistant>

  export const Info = z.discriminatedUnion("role", [User, Assistant]).meta({
    ref: "Message",
  })
  export type Info = z.infer<typeof Info>

  // responsive-orchestrator R2/R3/R6/R7: wake-only notice the background
  // task watcher appends to parent session info.json#pendingSubagentNotices
  // when a subagent reaches terminal state. Rendered as a one-line
  // system-prompt addendum on the next prompt assemble, then removed.
  // Source-of-truth schema lives at
  // /specs/responsive-orchestrator/data-schema.json#PendingSubagentNotice.
  export const PendingSubagentNotice = z
    .object({
      jobId: z.string(),
      childSessionID: Identifier.schema("session"),
      status: z.enum(["success", "error", "canceled", "rate_limited", "quota_low", "worker_dead", "silent_kill"]),
      finish: z.enum(["stop", "error", "length", "canceled", "rate_limited", "quota_low", "worker_exited", "no_progress_timeout"]),
      elapsedMs: z.number().int().nonnegative(),
      at: z.string(),
      errorDetail: z
        .object({
          message: z.string().optional(),
          code: z.string().optional(),
          resetsInSeconds: z.number().int().optional(),
        })
        .optional(),
      rotateHint: z
        .object({
          exhaustedAccountId: z.string(),
          exhaustedAt: z.string().optional(),
          remainingPercent: z.number().min(0).max(100).optional(),
          directive: z.literal("rotate-before-redispatch"),
        })
        .optional(),
      cancelReason: z.string().max(500).optional(),
      result: z
        .object({
          type: z.enum(["inline", "attachment_ref"]),
          text: z.string().optional(),
          refID: z.string().optional(),
          byteSize: z.number().int().nonnegative().optional(),
          estTokens: z.number().int().nonnegative().optional(),
          preview: z.string().optional(),
        })
        .optional(),
    })
    .meta({ ref: "PendingSubagentNotice" })
  export type PendingSubagentNotice = z.infer<typeof PendingSubagentNotice>

  export const Event = {
    Updated: BusEvent.define(
      "message.updated",
      z.object({
        info: Info,
      }),
    ),
    Removed: BusEvent.define(
      "message.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
      }),
    ),
    PartUpdated: BusEvent.define(
      "message.part.updated",
      z.object({
        part: Part,
        delta: z.string().optional(),
        // When delta is provided, part.text is stripped from the event to avoid
        // O(n²) amplification. Consumers must accumulate text from deltas.
        // textLength lets consumers detect desync without needing the full text.
        textLength: z.number().optional(),
      }),
    ),
    PartRemoved: BusEvent.define(
      "message.part.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
        partID: z.string(),
      }),
    ),
  }

  export const WithParts = z.object({
    info: Info,
    parts: z.array(Part),
  })
  export type WithParts = z.infer<typeof WithParts>

  /**
   * Known parameter renames across tool schema versions.
   * Maps: toolName → { oldParamName → newCanonicalName }
   * Used to normalize historical tool call inputs in LLM context
   * so the model doesn't learn/copy stale parameter names.
   */
  const TOOL_PARAM_MIGRATIONS: Record<string, Record<string, string>> = {
    apply_patch: { patchText: "input", patch_text: "input" },
  }

  /**
   * Normalize a historical tool call's input to match the current schema.
   * Returns a new object if migration was applied, or the original if no changes needed.
   * Never modifies the original input — read-only transform.
   */
  function normalizeToolCallInput(toolName: string, input: unknown): unknown {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input
    const migrations = TOOL_PARAM_MIGRATIONS[toolName]
    if (!migrations) return input

    const obj = input as Record<string, unknown>
    let needsMigration = false
    for (const oldKey of Object.keys(migrations)) {
      if (oldKey in obj && !(migrations[oldKey] in obj)) {
        needsMigration = true
        break
      }
    }
    if (!needsMigration) return input

    const normalized = { ...obj }
    for (const [oldKey, newKey] of Object.entries(migrations)) {
      if (oldKey in normalized && !(newKey in normalized)) {
        normalized[newKey] = normalized[oldKey]
        delete normalized[oldKey]
      }
    }
    return normalized
  }

  /**
   * Filter `part.metadata` down to entries safe to feed back as
   * AI SDK `providerMetadata`. Provider metadata schema requires every
   * top-level value to be a Record (object) — historical writers
   * (command-handler-executor stored `{ title: "..." }`) violated this
   * and broke whole sessions until manually wiped. Strip any value
   * that isn't a plain object before forwarding.
   */
  function safeProviderMetadata(metadata: unknown): Record<string, any> | undefined {
    if (!metadata || typeof metadata !== "object") return undefined
    const out: Record<string, any> = {}
    let kept = 0
    for (const [k, v] of Object.entries(metadata as Record<string, unknown>)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = v as Record<string, unknown>
        kept++
      }
    }
    return kept > 0 ? out : undefined
  }

  export function toModelMessages(input: WithParts[], model: Provider.Model): ModelMessage[] {
    const result: UIMessage[] = []
    const toolNames = new Set<string>()

    const toModelOutput = (output: unknown) => {
      if (typeof output === "string") {
        return { type: "text", value: output }
      }

      if (typeof output === "object") {
        const outputObject = output as {
          text: string
          attachments?: Array<{ mime: string; url: string }>
        }
        const attachments = (outputObject.attachments ?? []).filter((attachment) => {
          return attachment.url.startsWith("data:") && attachment.url.includes(",")
        })

        return {
          type: "content",
          value: [
            { type: "text", text: outputObject.text },
            ...attachments.map((attachment) => ({
              type: "media",
              data: attachment.url.split(",")[1] ?? attachment.url,
              mediaType: attachment.mime,
            })),
          ],
        }
      }

      return { type: "text", value: JSON.stringify(output, null, 2) }
    }

    for (const msg of input) {
      if (msg.parts.length === 0) continue

      if (msg.info.role === "user") {
        const userMessage: UIMessage = {
          id: msg.info.id,
          role: "user",
          parts: [],
        }
        result.push(userMessage)
        for (const part of msg.parts) {
          if (part.type === "text" && !part.ignored)
            userMessage.parts.push({
              type: "text",
              text: part.text,
            })
          // text/plain and directory files are converted into text parts, ignore them
          if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory")
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })
          if (part.type === "attachment_ref")
            userMessage.parts.push({
              type: "text",
              text:
                `<attachment_ref ref_id="${part.ref_id}" mime="${part.mime}" bytes="${part.byte_size}" estimated_tokens="${part.est_tokens}"` +
                `${part.filename ? ` filename="${part.filename}"` : ""}>` +
                `${part.preview ? `\n<preview>${part.preview}</preview>` : ""}` +
                "\nRaw attachment content is stored by reference. Use attachment query tools when detailed content is needed." +
                "\n</attachment_ref>",
            })

          if (part.type === "compaction" || part.type === "compaction-request") {
            userMessage.parts.push({
              type: "text",
              text: "What did we do so far?",
            })
          }
          if (part.type === "subtask" && part.command) {
            userMessage.parts.push({
              type: "text",
              text: "The following tool was executed by the user",
            })
          }
        }
      }

      if (msg.info.role === "assistant") {
        const continuationResetDecision = evaluateContinuationReset({
          current: {
            providerId: msg.info.providerId,
            modelID: msg.info.modelID,
            accountId: msg.info.accountId,
          },
          next: {
            providerId: model.providerId,
            modelID: model.id,
            accountId: (model as { accountId?: string }).accountId,
          },
        })
        const flushRemoteRefs = continuationResetDecision.flushRemoteRefs

        if (
          msg.info.error &&
          !(
            MessageV2.AbortedError.isInstance(msg.info.error) &&
            msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
          )
        ) {
          continue
        }

        // Skip empty responses (finish=unknown, 0 tokens) — these are failed API calls
        // that produced no content. Sending them as empty assistant messages confuses the model.
        const info = msg.info as Assistant
        if (
          info.finish === "unknown" &&
          info.tokens?.input === 0 &&
          info.tokens?.output === 0 &&
          !msg.parts.some((p) => p.type === "text" || p.type === "tool" || p.type === "reasoning")
        ) {
          continue
        }
        const assistantMessage: UIMessage = {
          id: msg.info.id,
          role: "assistant",
          parts: [],
        }
        const replayDebug: ContinuationReplayDebug = {
          textParts: 0,
          textItemIds: 0,
          reasoningParts: 0,
          reasoningItemIds: 0,
          toolParts: 0,
          toolItemIds: 0,
        }
        for (const part of msg.parts) {
          if (part.type === "text")
            if (part.metadata?.excludeFromModel === true) continue
            else
              (replayDebug.textParts++,
                hasRemoteItemId(part.metadata) && replayDebug.textItemIds++,
                assistantMessage.parts.push({
                  type: "text",
                  text: part.text,
                  ...(flushRemoteRefs ? {} : { providerMetadata: safeProviderMetadata(part.metadata) }),
                }))
          if (part.type === "tool") {
            replayDebug.toolParts++
            if (hasRemoteItemId(part.metadata)) replayDebug.toolItemIds++
            toolNames.add(part.tool)
            if (part.state.status === "completed") {
              // AI SDK v5 requires output to be an object with `text` field, not a bare string
              // Also must not contain undefined values (GitHub issue vercel/ai#8520)
              const outputText = part.state.time.compacted
                ? "[Old tool result content cleared]"
                : (part.state.output ?? "")
              const attachments = part.state.time.compacted ? [] : (part.state.attachments ?? [])
              // Always use object format with `text` key for consistent handling in toModelOutput
              // Only include attachments field if there are actual attachments (avoid undefined values)
              const output = attachments.length > 0 ? { text: outputText, attachments } : { text: outputText }

              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: normalizeToolCallInput(part.tool, part.state.input) ?? {},
                output,
                ...(flushRemoteRefs ? {} : { callProviderMetadata: safeProviderMetadata(part.metadata) }),
              })
            }
            if (part.state.status === "error")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: normalizeToolCallInput(part.tool, part.state.input) ?? {},
                errorText: part.state.error ?? "[Unknown error]",
                ...(flushRemoteRefs ? {} : { callProviderMetadata: safeProviderMetadata(part.metadata) }),
              })
            // Handle pending/running tool calls to prevent dangling tool_use blocks
            // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
            if (part.state.status === "pending" || part.state.status === "running")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: normalizeToolCallInput(part.tool, part.state.input) ?? {},
                errorText: "[Tool execution was interrupted]",
                ...(flushRemoteRefs ? {} : { callProviderMetadata: safeProviderMetadata(part.metadata) }),
              })
          }
          if (part.type === "reasoning") {
            replayDebug.reasoningParts++
            if (hasRemoteItemId(part.metadata)) replayDebug.reasoningItemIds++
            assistantMessage.parts.push({
              type: "reasoning",
              text: part.text,
              ...(flushRemoteRefs ? {} : { providerMetadata: safeProviderMetadata(part.metadata) }),
            })
          }
        }
        if (
          !flushRemoteRefs &&
          (replayDebug.textItemIds > 0 || replayDebug.reasoningItemIds > 0 || replayDebug.toolItemIds > 0)
        ) {
          debugCheckpoint("message-v2", "assistant replay metadata preserved", {
            messageID: msg.info.id,
            sessionID: msg.info.sessionID,
            providerId: msg.info.providerId,
            modelID: msg.info.modelID,
            replay: replayDebug,
          })
        }
        if (
          flushRemoteRefs &&
          (replayDebug.textItemIds > 0 || replayDebug.reasoningItemIds > 0 || replayDebug.toolItemIds > 0)
        ) {
          // [log-volume] per-message replay checkpoint disabled — ~5.5% of debug.log bytes.
          if (false) debugCheckpoint("message-v2", "assistant replay metadata flushed", {
            messageID: msg.info.id,
            sessionID: msg.info.sessionID,
            providerId: msg.info.providerId,
            modelID: msg.info.modelID,
            snapshot: buildInvalidationDebugSnapshot({
              current: {
                providerId: msg.info.providerId,
                modelID: msg.info.modelID,
                accountId: msg.info.accountId,
              },
              next: {
                providerId: model.providerId,
                modelID: model.id,
                accountId: (model as { accountId?: string }).accountId,
              },
              decision: continuationResetDecision,
              replay: replayDebug,
              compactionParts: msg.parts.filter((part) => part.type === "compaction" || part.type === "compaction-request").length,
            }),
          })
        }
        if (assistantMessage.parts.length > 0) {
          result.push(assistantMessage)
        }
      }
    }

    const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }])) as ToolSet

    return convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        tools,
      },
    )
  }

  // stream / parts / get delegate to StorageRouter (storage/router.ts).
  // Router decides per-call whether SqliteStore or LegacyStore answers
  // (DD-9 signature compatibility, dual-track per session). See
  // /specs/session-storage-db, task 3.5.
  export const stream = fn(Identifier.schema("session"), async function* (sessionID) {
    yield* StorageRouter.stream(sessionID)
  })

  export const parts = fn(Identifier.schema("message"), async (messageID) => {
    return StorageRouter.parts(messageID)
  })

  export const get = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input): Promise<WithParts> => {
      return StorageRouter.get(input)
    },
  )

  export async function filterCompacted(
    stream: AsyncIterable<MessageV2.WithParts>,
    contextLimit?: number,
  ): Promise<{ messages: MessageV2.WithParts[]; stoppedByBudget: boolean }> {
    const result = [] as MessageV2.WithParts[]
    const completed = new Set<string>()
    let accumulatedTokens = 0
    let stoppedByBudget = false
    const tokenBudget = contextLimit != null ? contextLimit * 0.7 : undefined
    for await (const msg of stream) {
      result.push(msg)

      // Stop only at a compaction anchor — the authoritative boundary written by A or B compaction.
      // tool-call summaries and assistant summary fields are NOT boundaries.
      const hasCompactionAnchor = msg.parts.some((p: any) => p.type === "compaction")
      if (hasCompactionAnchor) break

      if (msg.info.role === "assistant" && (msg.info as any).summary && (msg.info as any).finish) {
        completed.add((msg.info as any).parentID)
      }

      // Token budget guard: stop scanning if we'd exceed 70% of context limit.
      //
      // DD-6 / INV-5: read the stored tokens_total from assistant message
      // info directly (column on SQLite, info.tokens.total on the live
      // shape) instead of re-stringifying the entire message + parts.
      // This is the hot path that was multi-MB-per-round on long sessions.
      // User messages don't carry tokens; estimate from text-part length
      // (cheap — user inputs are normally small).
      if (tokenBudget != null) {
        let msgTokens: number
        if (msg.info.role === "assistant") {
          const t = (msg.info as MessageV2.Assistant).tokens
          msgTokens =
            t?.total ??
            (t?.input ?? 0) +
              (t?.output ?? 0) +
              (t?.cache?.read ?? 0) +
              (t?.cache?.write ?? 0)
        } else {
          // User message: small approximation by joining text parts only.
          // Avoids stringifying tool-result payloads that may have been
          // attached as parts but don't bear meaningful token cost from
          // the prompt's perspective at this filter stage.
          let userBytes = 0
          for (const p of msg.parts) {
            if (p.type === "text" && typeof (p as { text?: string }).text === "string") {
              userBytes += (p as { text: string }).text.length
            }
          }
          msgTokens = userBytes / 4
        }
        accumulatedTokens += msgTokens
        if (accumulatedTokens > tokenBudget) {
          stoppedByBudget = true
          break
        }
      }
    }
    result.reverse()
    return { messages: result, stoppedByBudget }
  }

  const isOpenAiErrorRetryable = (e: APICallError) => {
    const status = e.statusCode
    if (!status) return e.isRetryable
    // openai sometimes returns 404 for models that are actually available
    return status === 404 || e.isRetryable
  }

  function trimErrorString(input: string | undefined) {
    const value = input?.trim()
    if (!value) return undefined
    if (value === "[object Object]") return undefined
    return value
  }

  function serializeUnknownDebug(input: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
    if (input == null) return undefined
    if (typeof input === "string") {
      if (depth === 0) return undefined
      return input.length > 8000 ? input.slice(0, 8000) + "…" : input
    }
    if (typeof input === "number" || typeof input === "boolean") {
      if (depth === 0) return undefined
      return input
    }
    if (typeof input === "bigint") return input.toString()
    if (typeof input === "function") return `[Function ${input.name || "anonymous"}]`
    if (depth >= 5) return "[MaxDepth]"
    if (typeof input !== "object") return String(input)

    if (seen.has(input)) return "[Circular]"
    seen.add(input)

    if (input instanceof Error) {
      const err = input as Error & { cause?: unknown; issues?: unknown; data?: unknown }
      const result: Record<string, unknown> = {
        name: err.name,
        message: err.message,
      }
      if (err.stack) result.stack = err.stack
      if (err.cause !== undefined) result.cause = serializeUnknownDebug(err.cause, seen, depth + 1)
      if (err.issues !== undefined) result.issues = serializeUnknownDebug(err.issues, seen, depth + 1)
      if (err.data !== undefined) result.data = serializeUnknownDebug(err.data, seen, depth + 1)
      return result
    }

    if (Array.isArray(input)) {
      return input.slice(0, 20).map((item) => serializeUnknownDebug(item, seen, depth + 1))
    }

    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input).slice(0, 50)) {
      result[key] = serializeUnknownDebug(value, seen, depth + 1)
    }
    return result
  }

  function collectUnknownStrings(input: unknown, out = new Set<string>(), seen = new WeakSet<object>(), depth = 0) {
    if (input == null || depth >= 5) return out
    if (typeof input === "string") {
      const value = trimErrorString(input)
      if (value) out.add(value)
      return out
    }
    if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") {
      out.add(String(input))
      return out
    }
    if (typeof input !== "object") return out
    if (seen.has(input)) return out
    seen.add(input)

    if (input instanceof Error) {
      collectUnknownStrings(input.message, out, seen, depth + 1)
      collectUnknownStrings(
        (input as Error & { cause?: unknown; data?: unknown; stack?: unknown }).cause,
        out,
        seen,
        depth + 1,
      )
      collectUnknownStrings((input as Error & { data?: unknown }).data, out, seen, depth + 1)
      return out
    }

    if (Array.isArray(input)) {
      for (const item of input.slice(0, 20)) collectUnknownStrings(item, out, seen, depth + 1)
      return out
    }

    for (const value of Object.values(input).slice(0, 50)) {
      collectUnknownStrings(value, out, seen, depth + 1)
    }
    return out
  }

  function extractRequestIds(input: unknown, out = new Set<string>(), seen = new WeakSet<object>(), depth = 0) {
    if (input == null || depth >= 5) return out
    if (typeof input === "string") {
      const matches = input.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)
      for (const match of matches ?? []) out.add(match)
      return out
    }
    if (typeof input !== "object") return out
    if (seen.has(input)) return out
    seen.add(input)

    if (input instanceof Error) {
      extractRequestIds(input.message, out, seen, depth + 1)
      extractRequestIds((input as Error & { cause?: unknown; data?: unknown }).cause, out, seen, depth + 1)
      extractRequestIds((input as Error & { data?: unknown }).data, out, seen, depth + 1)
      return out
    }

    if (Array.isArray(input)) {
      for (const item of input.slice(0, 20)) extractRequestIds(item, out, seen, depth + 1)
      return out
    }

    for (const [key, value] of Object.entries(input).slice(0, 50)) {
      if (/request.?id/i.test(key) && typeof value === "string") out.add(value)
      extractRequestIds(value, out, seen, depth + 1)
    }
    return out
  }

  function extractStatusCodes(input: unknown, out = new Set<number>(), seen = new WeakSet<object>(), depth = 0) {
    if (input == null || depth >= 5) return out
    if (typeof input !== "object") return out
    if (seen.has(input)) return out
    seen.add(input)

    if (input instanceof Error) {
      extractStatusCodes(
        (input as Error & { cause?: unknown; data?: unknown; statusCode?: unknown }).cause,
        out,
        seen,
        depth + 1,
      )
      extractStatusCodes((input as Error & { data?: unknown; statusCode?: unknown }).data, out, seen, depth + 1)
      const statusCode = (input as any).statusCode
      if (typeof statusCode === "number") out.add(statusCode)
      return out
    }

    if (Array.isArray(input)) {
      for (const item of input.slice(0, 20)) extractStatusCodes(item, out, seen, depth + 1)
      return out
    }

    for (const [key, value] of Object.entries(input).slice(0, 50)) {
      if ((key === "status" || key === "statusCode") && typeof value === "number") out.add(value)
      extractStatusCodes(value, out, seen, depth + 1)
    }
    return out
  }

  function summarizeUnknownError(input: unknown, providerId: string, message: string) {
    const strings = [...collectUnknownStrings(input)].filter((value) => value !== message)
    const requestIds = [...extractRequestIds(input)]
    const statusCodes = [...extractStatusCodes(input)]
    const hints: string[] = []

    const headline: string[] = []
    headline.push(`Provider ${providerId} returned an unknown error.`)
    if (statusCodes.length > 0) headline.push(`Status ${statusCodes[0]}.`)
    if (requestIds.length > 0) headline.push(`Request ID ${requestIds[0]}.`)

    const detail = strings.find((value) => value !== "server_error" && value !== providerId && value.length > 8)
    if (detail && detail !== message) {
      hints.push(`Detail: ${detail}`)
    }
    for (const id of requestIds.slice(0, 2)) {
      hints.push(`Request ID: ${id}`)
    }
    for (const status of statusCodes.slice(0, 2)) {
      hints.push(`Status: ${status}`)
    }
    if (/help\.openai\.com/i.test(message) || strings.some((value) => /help\.openai\.com/i.test(value))) {
      hints.push("Upstream provider asked for support escalation; include the request ID when reporting.")
    }

    return {
      summary: headline.join(" ").trim(),
      hints,
    }
  }

  function extractReadableUnknownMessage(input: unknown) {
    if (input instanceof Error) {
      const errorLike = input as Error & { cause?: unknown; data?: unknown }
      return (
        trimErrorString(input.message) ??
        trimErrorString((errorLike.data as any)?.message) ??
        trimErrorString((errorLike.cause as any)?.message) ??
        trimErrorString((errorLike.cause as any)?.data?.message) ??
        input.name
      )
    }

    if (typeof input === "object" && input !== null) {
      const obj = input as Record<string, any>
      return (
        trimErrorString(obj.message) ??
        trimErrorString(obj.data?.message) ??
        trimErrorString(obj.error?.message) ??
        trimErrorString(obj.error?.data?.message) ??
        trimErrorString(obj.code) ??
        "Unexpected object error"
      )
    }

    return String(input)
  }

  function unknownErrorData(input: unknown, ctx: { providerId: string }) {
    const message = extractReadableUnknownMessage(input)
    const debug = serializeUnknownDebug(input)
    const extra = summarizeUnknownError(input, ctx.providerId, message)
    if (debug && typeof debug === "object") {
      return {
        message,
        debug: debug as Record<string, unknown>,
        summary: extra.summary,
        hints: extra.hints.length > 0 ? extra.hints : undefined,
      }
    }
    return {
      message,
      summary: extra.summary,
      hints: extra.hints.length > 0 ? extra.hints : undefined,
    }
  }

  export function fromError(e: unknown, ctx: { providerId: string }) {
    switch (true) {
      case e instanceof DOMException && e.name === "AbortError":
        return new MessageV2.AbortedError(
          { message: e.message },
          {
            cause: e,
          },
        ).toObject()
      case MessageV2.OutputLengthError.isInstance(e):
        return e
      case LoadAPIKeyError.isInstance(e):
        return new MessageV2.AuthError(
          {
            providerId: ctx.providerId,
            message: e.message,
          },
          { cause: e },
        ).toObject()
      case (e as SystemError)?.code === "ECONNRESET":
        return new MessageV2.APIError(
          {
            message: "Connection reset by server",
            isRetryable: true,
            metadata: {
              code: (e as SystemError).code ?? "",
              syscall: (e as SystemError).syscall ?? "",
              message: (e as SystemError).message ?? "",
            },
          },
          { cause: e },
        ).toObject()
      case APICallError.isInstance(e):
        const parsed = ProviderError.parseAPICallError({
          providerId: ctx.providerId,
          error: e,
        })
        if (parsed.type === "context_overflow") {
          return new MessageV2.ContextOverflowError(
            {
              message: parsed.message,
              responseBody: parsed.responseBody,
            },
            { cause: e },
          ).toObject()
        }

        return new MessageV2.APIError(
          {
            message: parsed.message,
            statusCode: parsed.statusCode,
            isRetryable: parsed.isRetryable,
            responseHeaders: parsed.responseHeaders,
            responseBody: parsed.responseBody,
            metadata: parsed.metadata,
          },
          { cause: e },
        ).toObject()
      case e instanceof Error:
        // Plain Error path — covers raw transport-layer throws (e.g.
        // codex-provider transport-ws.ts wrapping the upstream context_length_exceeded
        // event into `new Error("Codex WS: Your input exceeds the context window of this model")`).
        // Without this check the error gets boxed as NamedError.Unknown and
        // bypasses the processor.ts:1842 ContextOverflowError → needsCompaction
        // auto-heal branch, surfacing a user-visible terminal red toast.
        if (ProviderError.isOverflowMessage(e.message)) {
          return new MessageV2.ContextOverflowError(
            {
              message: e.message,
            },
            { cause: e },
          ).toObject()
        }
        return new NamedError.Unknown(unknownErrorData(e, ctx), { cause: e }).toObject()
      default:
        try {
          const parsed = ProviderError.parseStreamError(e)
          if (parsed) {
            if (parsed.type === "context_overflow") {
              return new MessageV2.ContextOverflowError(
                {
                  message: parsed.message,
                  responseBody: parsed.responseBody,
                },
                { cause: e },
              ).toObject()
            }
            return new MessageV2.APIError(
              {
                message: parsed.message,
                isRetryable: parsed.isRetryable,
                responseBody: parsed.responseBody,
              },
              {
                cause: e,
              },
            ).toObject()
          }
        } catch (error) {
          debugCheckpoint("message-v2", "failed to parse unknown stream error", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return new NamedError.Unknown(unknownErrorData(e, ctx), { cause: e }).toObject()
    }
  }

  export const updateMessage = fn(Info, async (info) => {
    await StorageRouter.upsertMessage(info)
    Bus.publish(Event.Updated, { info })
  })

  export const updatePart = fn(
    z.union([z.object({ part: Part, delta: z.string().optional() }), Part]),
    async (input) => {
      const part = "part" in input ? input.part : input
      const delta = "delta" in input ? input.delta : undefined
      await StorageRouter.upsertPart(part)
      Bus.publish(Event.PartUpdated, { part, delta })
      return part
    },
  )

  export const remove = fn(
    z.object({ sessionID: z.string(), messageID: z.string() }),
    async ({ sessionID, messageID }) => {
      const { removeMessageInfo, removePartFile } = await import("./storage/legacy")
      await removeMessageInfo(sessionID, messageID)
      const p = await parts(messageID)
      for (const part of p) {
        await removePartFile(messageID, part.id)
      }
      Bus.publish(Event.Removed, { sessionID, messageID })
    },
  )

  export function toModelMessagesCompact(input: WithParts[], model: Provider.Model): ModelMessage[] {
    const history = toModelMessages(input, model)
    // Always keep system prompt and last few turns
    return history
  }
}
