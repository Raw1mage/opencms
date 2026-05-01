import z from "zod"

import { Tweaks } from "@/config/tweaks"
import { emitBoundaryRoutingTelemetry } from "@/session/compaction-telemetry"
import { Router as StorageRouter } from "@/session/storage/router"
import type { SessionStorage } from "@/session/storage"
import { Tool } from "./tool"

type AttachmentQueryReader = Pick<typeof StorageRouter, "getAttachmentBlob">
let attachmentQueryReader: AttachmentQueryReader = StorageRouter

export function setAttachmentQueryReaderForTesting(reader?: AttachmentQueryReader) {
  attachmentQueryReader = reader ?? StorageRouter
}

const parameters = z.object({
  ref_id: z.string().describe("The attachment_ref ref_id to inspect in the current session namespace"),
  mode: z.enum(["digest", "vision", "task_result"]).optional().describe("Query mode. Defaults to digest."),
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
    "Inspect a session-scoped attachment_ref by ref_id. Returns bounded previews/metadata for large text or task-result refs; image vision requests fail explicitly unless a vision worker is configured.",
  parameters,
  async execute(params, ctx) {
    const mode = params.mode ?? "digest"
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
    if (mode === "vision" || (mode === "digest" && kind === "image")) {
      emitBoundaryRoutingTelemetry({
        boundary: "attachment_query",
        action: "capability_error",
        refID: params.ref_id,
        mime: blob.mime,
        byteSize: blob.byteSize,
        estTokens: blob.estTokens,
        hasFilename: !!blob.filename,
        reason: "vision_capability_unavailable",
      })
      throw new Error(
        `attachment_ref ${params.ref_id} is an image (${blob.mime}), but no vision-capable worker is configured for attachment queries. Configure an explicit vision worker/model and retry with mode=vision; no model fallback was attempted.`,
      )
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
          { ...base, note: "Binary attachment metadata only; raw content is not injected." },
          null,
          2,
        ),
      }
    }

    const preview = decodeTextPreview(blob.content, previewBytes)
    const truncated = blob.byteSize > previewBytes
    const label = mode === "task_result" || kind === "task_result" ? "task_result" : "digest"
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
