import z from "zod"

import { Tweaks } from "@/config/tweaks"
import { Session } from "@/session"
import { addOnReread } from "@/session/active-image-refs"
import type { MessageV2 } from "@/session/message-v2"
import { Log } from "@/util/log"

import { Tool } from "./tool"

const log = Log.create({ service: "tool.reread-attachment" })

const parameters = z.object({
  filename: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional. Filename of the image you want to inspect — must match an entry in the <attached_images> inventory exactly. " +
        "Omit to default to the most recent inline-eligible image in this session (typical case when the user just uploaded one image and immediately asked about it).",
    ),
})

interface InlineableCandidatePart {
  type: string
  mime?: string
  filename?: string
  repo_path?: string
  session_path?: string
}

interface MessageWithParts {
  parts?: ReadonlyArray<InlineableCandidatePart>
}

/**
 * Walk session messages newest-first, return the most recent
 * inline-eligible attachment_ref (mime image/* AND either repo_path OR
 * session_path populated) matching `filename`. Pure helper — exported
 * for unit testing.
 */
export function findInlineableAttachment(
  messages: ReadonlyArray<MessageWithParts>,
  filename: string,
): InlineableCandidatePart | undefined {
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi]
    for (const part of msg?.parts ?? []) {
      if (part.type !== "attachment_ref") continue
      if (part.filename !== filename) continue
      if (!part.mime?.startsWith("image/")) continue
      if (!part.repo_path && !part.session_path) continue
      return part
    }
  }
  return undefined
}

/**
 * Walk session messages newest-first, return the most recent
 * inline-eligible attachment_ref of any filename. Used as the default
 * picker when the model invokes `reread_attachment()` without a
 * `filename` argument — typical case when the user has just uploaded
 * a single image and immediately asked a question about it. Pure
 * helper — exported for unit testing.
 */
export function findMostRecentInlineableAttachment(
  messages: ReadonlyArray<MessageWithParts>,
): InlineableCandidatePart | undefined {
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi]
    for (const part of msg?.parts ?? []) {
      if (part.type !== "attachment_ref") continue
      if (!part.filename) continue
      if (!part.mime?.startsWith("image/")) continue
      if (!part.repo_path && !part.session_path) continue
      return part
    }
  }
  return undefined
}

/**
 * Voucher tool — appends the filename onto `session.execution.activeImageRefs`
 * so the NEXT turn's preface trailing tier emits inline image bytes. The
 * tool does NOT return image bytes; binary churn stays out of the
 * conversation history (Phase B cache locality principle) while still
 * giving the model a deterministic path back to the pixels.
 */
export const RereadAttachmentTool = Tool.define("reread_attachment", {
  description:
    "INSPECT / VIEW / EXAMINE / LOOK AT an image the user uploaded. Call this BEFORE any filesystem tool when the user's question references a screenshot, diagram, photo, chart, or other uploaded picture — `read`, `grep`, and `glob` CANNOT decode image binaries. " +
    "After calling, the image's pixels appear inline in your context preface starting on your NEXT response and PERSIST across subsequent turns of the current task (no need to re-call each turn). " +
    "Older active images are evicted FIFO when the active set fills up. Call again ONLY if a previous image was evicted or the user uploaded a new image you have not yet inlined. " +
    "If the current preface does not yet show pixels for an image you need, call this tool with no arguments to inline the most recent attachment, or with `filename` matching an entry in the <attached_images> inventory exactly.",
  parameters,
  async execute(
    params,
    ctx,
  ): Promise<{
    title: string
    metadata: { error?: string; activeSetSize?: number; resolvedFilename?: string }
    output: string
  }> {
    const cfg = Tweaks.attachmentInlineSync()
    if (!cfg.enabled) {
      return {
        title: params.filename ?? "(default)",
        metadata: { error: "inline_disabled" },
        output:
          "Image inline rendering is disabled by operator configuration. Use attachment(mode=read, agent=vision) instead.",
      }
    }

    const messages = await Session.messages({ sessionID: ctx.sessionID }).catch(() => [] as MessageV2.WithParts[])

    let resolvedFilename: string
    let matched: InlineableCandidatePart | undefined

    if (params.filename) {
      resolvedFilename = params.filename
      matched = findInlineableAttachment(messages, resolvedFilename)
      if (!matched) {
        return {
          title: resolvedFilename,
          metadata: { error: "attachment_not_found", resolvedFilename },
          output:
            `No attached image named '${resolvedFilename}' is available in this session. ` +
            `Check the <attached_images> inventory in your preface for exact filenames, or call reread_attachment() with no arguments to inline the most recent image.`,
        }
      }
    } else {
      matched = findMostRecentInlineableAttachment(messages)
      if (!matched || !matched.filename) {
        return {
          title: "(no images)",
          metadata: { error: "no_attachments" },
          output:
            "No image attachments are available in this session. Ask the user to upload an image, or use filesystem tools (read/grep) for text-based files.",
        }
      }
      resolvedFilename = matched.filename
    }

    const session = await Session.get(ctx.sessionID).catch(() => undefined)
    const prior = session?.execution?.activeImageRefs ?? []
    const next = addOnReread(prior, resolvedFilename, { max: cfg.activeSetMax })
    if (next !== prior) {
      await Session.setActiveImageRefs(ctx.sessionID, next).catch((err) => {
        log.warn("setActiveImageRefs failed", {
          sessionID: ctx.sessionID,
          filename: resolvedFilename,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }

    return {
      title: resolvedFilename,
      metadata: { activeSetSize: next.length, resolvedFilename },
      output:
        `Image '${resolvedFilename}' is queued and will appear inline in the preface of your NEXT response. ` +
        `It will PERSIST across subsequent turns of the current task — do NOT re-call this tool every turn. ` +
        `Active set: ${next.length} image(s).`,
    }
  },
})
