import { generateText } from "ai"
import z from "zod"

import { Tweaks } from "@/config/tweaks"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { emitBoundaryRoutingTelemetry } from "@/session/compaction-telemetry"
import { Router as StorageRouter } from "@/session/storage/router"
import type { SessionStorage } from "@/session/storage"
import { SystemPrompt } from "@/session/system"
import { Log } from "@/util/log"
import { Tool } from "./tool"

const log = Log.create({ service: "tool.attachment" })

type AttachmentQueryReader = Pick<typeof StorageRouter, "getAttachmentBlob">
let attachmentQueryReader: AttachmentQueryReader = StorageRouter

export function setAttachmentQueryReaderForTesting(reader?: AttachmentQueryReader) {
  attachmentQueryReader = reader ?? StorageRouter
}

type ReaderRunner = (input: {
  sessionID: string
  agent: string
  blob: SessionStorage.AttachmentBlob
  question: string
}) => Promise<{ providerId: string; modelID: string; text: string }>

let readerRunner: ReaderRunner = defaultReaderRunner

export function setReaderRunnerForTesting(runner?: ReaderRunner) {
  readerRunner = runner ?? defaultReaderRunner
}

// Back-compat shim for existing tests that still import the old name.
export const setVisionWorkerRunnerForTesting = setReaderRunnerForTesting

const DEFAULT_QUESTION =
  "The user did not ask a specific question. Produce the structured digest defined in your system prompt."

// Hard-coded mime → reader agent mapping for the well-known fixed types.
// Anything outside this table requires the orchestrator to pass `agent` explicitly.
function defaultAgentForMime(mime: string): string | undefined {
  if (mime.startsWith("image/")) return "vision"
  if (mime === "application/pdf") return "pdf-reader"
  return undefined
}

// Minimum capability required from the SSOT model for a given mime.
function requiredCapabilityForMime(mime: string): "image" | "pdf" | "text" {
  if (mime.startsWith("image/")) return "image"
  if (mime === "application/pdf") return "pdf"
  return "text"
}

async function loadSessionExecution(
  sessionID: string,
): Promise<{ model: Provider.Model; accountId?: string; parentID?: string }> {
  const session = await Session.get(sessionID)
  const exec = session?.execution
  if (!exec) {
    throw new Error(
      `attachment reader cannot resolve a session model: session ${sessionID} has no pinned execution identity`,
    )
  }
  const model = await Provider.getModel(exec.providerId, exec.modelID)
  return { model, accountId: exec.accountId, parentID: session?.parentID }
}

// Mirror the same header injection LLM.stream uses so the reader subagent
// inherits the parent session's account binding. Without this the codex /
// opencode providers fall back to whichever account is "default" in the
// process — which on a multi-account host is usually NOT the one the user
// has pinned, and rate-limit failures from a stranger account leak in.
function buildReaderHeaders(input: {
  model: Provider.Model
  sessionID: string
  accountId?: string
  parentID?: string
  agent: string
}): Record<string, string> {
  const headers: Record<string, string> = {}
  if (input.accountId) headers["x-opencode-account-id"] = input.accountId
  if (input.model.providerId.startsWith("opencode")) {
    headers["x-opencode-session"] = input.sessionID
  } else if (input.model.api.npm === "@opencode-ai/codex-provider") {
    headers["session_id"] = input.sessionID
    headers["x-opencode-session"] = input.sessionID
    headers["x-opencode-parent-session"] = input.parentID ?? ""
    // Reader is a non-interactive worker — flag it as a subagent for the
    // codex side so usage analytics / rate buckets can separate it cleanly.
    headers["x-opencode-subagent"] = input.agent
  }
  return headers
}

async function defaultReaderRunner(input: {
  sessionID: string
  agent: string
  blob: SessionStorage.AttachmentBlob
  question: string
}) {
  const systemPrompt = await SystemPrompt.agentPrompt(input.agent)
  if (!systemPrompt) {
    throw new Error(
      `attachment reader agent "${input.agent}" is not registered (no prompt found). Use a known reader (e.g. vision, pdf-reader) or register the agent.`,
    )
  }
  const { model, accountId, parentID } = await loadSessionExecution(input.sessionID)
  const required = requiredCapabilityForMime(input.blob.mime)
  const caps = model.capabilities?.input
  const capable =
    required === "image"
      ? !!caps?.image
      : required === "pdf"
        ? !!caps?.pdf || !!caps?.image
        : !!caps?.text
  if (!capable) {
    throw new Error(
      `session model ${model.providerId}/${model.id} does not support input modality "${required}" needed to read attachment_ref ${input.blob.refID} (${input.blob.mime}). Pin a model that does and retry.`,
    )
  }
  const language = await Provider.getLanguage(model)
  const headers = buildReaderHeaders({
    model,
    sessionID: input.sessionID,
    accountId,
    parentID,
    agent: input.agent,
  })
  log.info("reader subagent dispatch", {
    sessionID: input.sessionID,
    refID: input.blob.refID,
    agent: input.agent,
    providerId: model.providerId,
    modelID: model.id,
    accountId,
    mime: input.blob.mime,
    bytes: input.blob.byteSize,
  })
  const result = await generateText({
    model: language,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          { type: "file", data: input.blob.content, mediaType: input.blob.mime },
          { type: "text", text: input.question },
        ],
      },
    ],
    headers,
    maxRetries: 1,
  })
  return { providerId: model.providerId, modelID: model.id, text: result.text?.trim() ?? "" }
}

const parameters = z.object({
  ref_id: z.string().describe("The attachment_ref ref_id to inspect in the current session namespace"),
  mode: z
    .enum(["digest", "read", "vision", "task_result"])
    .optional()
    .describe(
      "Query mode. 'digest' (default) returns text preview / metadata. 'read' (alias 'vision') dispatches to a reader subagent. 'task_result' fetches a subagent result blob.",
    ),
  question: z
    .string()
    .optional()
    .describe(
      "For mode=read: the question crafted from the user's intent that the reader subagent must answer. Required when the user uploaded with intent — generic fallback is used only if the user gave no instruction.",
    ),
  agent: z
    .string()
    .optional()
    .describe(
      "For mode=read: explicit reader agent name (e.g. 'vision', 'pdf-reader'). Defaults to the hard-coded mapping by mime; required for mimes outside the mapping.",
    ),
})

function isTextLike(mime: string) {
  return mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime.endsWith("+json")
}

function isImage(mime: string) {
  return mime.startsWith("image/")
}

function attachmentKind(blob: SessionStorage.AttachmentBlob) {
  if (blob.filename?.startsWith("subagent-") && blob.filename.endsWith("-result.txt")) return "task_result"
  if (isImage(blob.mime)) return "image"
  if (isTextLike(blob.mime)) return "text"
  return "binary"
}

function decodeTextPreview(content: Uint8Array, maxBytes: number) {
  const slice = content.slice(0, Math.max(0, maxBytes))
  return Buffer.from(slice).toString("utf8")
}

function metadataFor(blob: SessionStorage.AttachmentBlob) {
  return {
    refID: blob.refID,
    mime: blob.mime,
    filename: blob.filename,
    byteSize: blob.byteSize,
    estTokens: blob.estTokens,
    createdAt: blob.createdAt,
    messageID: blob.messageID,
    partID: blob.partID,
    kind: attachmentKind(blob),
    truncated: false,
  }
}

export const AttachmentTool = Tool.define("attachment", {
  description:
    "Inspect a session-scoped attachment_ref by ref_id. For images / PDFs / other rich media, dispatch the read to a reader subagent (mode='read') with a question crafted from the user's intent. For text/json refs, returns a bounded preview (mode='digest').",
  parameters,
  async execute(params, ctx) {
    const requestedMode = params.mode ?? "digest"
    let blob: SessionStorage.AttachmentBlob
    try {
      blob = await attachmentQueryReader.getAttachmentBlob({ sessionID: ctx.sessionID, refID: params.ref_id })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emitBoundaryRoutingTelemetry({
        boundary: "attachment_query",
        action: "missing_ref",
        refID: params.ref_id,
        reason: message,
      })
      throw new Error(`attachment_ref not found or unreadable in current session: ${params.ref_id}: ${message}`)
    }

    const kind = attachmentKind(blob)
    const wantsRead =
      requestedMode === "read" ||
      requestedMode === "vision" ||
      (requestedMode === "digest" && (kind === "image" || blob.mime === "application/pdf"))

    if (wantsRead) {
      const agentName = params.agent?.trim() || defaultAgentForMime(blob.mime)
      if (!agentName) {
        emitBoundaryRoutingTelemetry({
          boundary: "attachment_query",
          action: "capability_error",
          refID: params.ref_id,
          mime: blob.mime,
          byteSize: blob.byteSize,
          estTokens: blob.estTokens,
          hasFilename: !!blob.filename,
          reason: "no_default_reader_for_mime",
        })
        throw new Error(
          `attachment_ref ${params.ref_id} (${blob.mime}) has no default reader agent. Pass an explicit "agent" name (e.g. a custom reader you have registered) and retry.`,
        )
      }
      const question = params.question?.trim() || DEFAULT_QUESTION
      let workerResult: { providerId: string; modelID: string; text: string }
      try {
        workerResult = await readerRunner({ sessionID: ctx.sessionID, agent: agentName, blob, question })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        emitBoundaryRoutingTelemetry({
          boundary: "attachment_query",
          action: "capability_error",
          refID: params.ref_id,
          mime: blob.mime,
          byteSize: blob.byteSize,
          estTokens: blob.estTokens,
          hasFilename: !!blob.filename,
          reason: "reader_failed",
        })
        throw new Error(message)
      }
      const base = metadataFor(blob)
      emitBoundaryRoutingTelemetry({
        boundary: "attachment_query",
        action: "digest",
        refID: params.ref_id,
        mime: blob.mime,
        byteSize: blob.byteSize,
        estTokens: blob.estTokens,
        hasFilename: !!blob.filename,
        reason: "reader_digest",
      })
      return {
        title: params.ref_id,
        metadata: {
          ...base,
          truncated: false,
          worker: workerResult.providerId + "/" + workerResult.modelID,
          readerAgent: agentName,
        },
        output: JSON.stringify(
          {
            ...base,
            query: "read",
            agent: agentName,
            question,
            worker: { providerId: workerResult.providerId, modelID: workerResult.modelID },
            digest: workerResult.text,
            note: "Raw bytes never enter the main agent context; this digest is the only payload returned.",
          },
          null,
          2,
        ),
      }
    }

    const cfg = Tweaks.bigContentBoundarySync()
    const previewBytes = Math.max(0, cfg.attachmentPreviewBytes)
    const base = metadataFor(blob)

    if (kind === "binary") {
      emitBoundaryRoutingTelemetry({
        boundary: "attachment_query",
        action: "digest",
        refID: params.ref_id,
        mime: blob.mime,
        byteSize: blob.byteSize,
        estTokens: blob.estTokens,
        hasFilename: !!blob.filename,
        reason: "binary_metadata_only",
      })
      return {
        title: params.ref_id,
        metadata: { ...base, truncated: false },
        output: JSON.stringify(
          {
            ...base,
            note:
              "Binary attachment metadata only; raw content is not injected. " +
              "If this needs structured reading, retry with mode='read' and an explicit agent name.",
          },
          null,
          2,
        ),
      }
    }

    const preview = decodeTextPreview(blob.content, previewBytes)
    const truncated = blob.byteSize > previewBytes
    const label = requestedMode === "task_result" || kind === "task_result" ? "task_result" : "digest"
    emitBoundaryRoutingTelemetry({
      boundary: "attachment_query",
      action: "digest",
      refID: params.ref_id,
      mime: blob.mime,
      byteSize: blob.byteSize,
      estTokens: blob.estTokens,
      previewBytes,
      truncated,
      hasFilename: !!blob.filename,
      reason: label,
    })
    return {
      title: params.ref_id,
      metadata: { ...base, truncated, previewBytes },
      output: JSON.stringify(
        {
          ...base,
          query: label,
          preview,
          truncated,
          note: truncated
            ? `Preview limited to ${previewBytes} bytes; raw content remains stored by reference.`
            : undefined,
        },
        null,
        2,
      ),
    }
  },
})
