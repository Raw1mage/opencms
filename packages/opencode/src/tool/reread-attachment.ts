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
    .describe("The original filename of a previously-attached image. Match the filename exactly as it appeared on upload."),
})

interface MessageWithParts {
  parts?: ReadonlyArray<{ type: string; mime?: string; filename?: string; repo_path?: string }>
}

/**
 * Walk session messages newest-first, return the most recent
 * inline-eligible attachment_ref (mime image/* + repo_path populated)
 * matching `filename`. Pure helper — exported for unit testing.
 */
export function findInlineableAttachment(
  messages: ReadonlyArray<MessageWithParts>,
  filename: string,
): { type: string; mime?: string; filename?: string; repo_path?: string } | undefined {
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi]
    for (const part of msg?.parts ?? []) {
      if (part.type !== "attachment_ref") continue
      if (part.filename !== filename) continue
      if (!part.repo_path || !part.mime?.startsWith("image/")) continue
      return part
    }
  }
  return undefined
}

/**
 * attachment-lifecycle v4 (DD-21): voucher tool.
 *
 * The model calls this when an image's prior text reference (annotation /
 * filename) does not give it enough information and it wants the actual
 * pixels back in context. The tool does NOT return the image bytes — it
 * appends the filename to `session.execution.activeImageRefs` so the NEXT
 * turn's preface trailing tier emits the inline file block. This keeps
 * binary churn out of the conversation history (Phase B cache locality
 * principle) while still giving the model a path back to the pixels.
 */
export const RereadAttachmentTool = Tool.define("reread_attachment", {
  description:
    "Queue a previously-attached image for inline viewing on your NEXT response. Use this when the prior text reference for an image is not enough to answer accurately. The image is NOT returned in this tool's result — instead, the actual pixels appear inline in the context preface of your next turn. `filename` must match the original upload exactly.",
  parameters,
  async execute(
    params,
    ctx,
  ): Promise<{
    title: string
    metadata: { error?: string; activeSetSize?: number }
    output: string
  }> {
    const cfg = Tweaks.attachmentInlineSync()
    if (!cfg.enabled) {
      return {
        title: params.filename,
        metadata: { error: "inline_disabled" },
        output: "Image inline rendering is disabled by operator configuration. Use attachment(mode=read, agent=vision) instead.",
      }
    }

    const messages = await Session.messages({ sessionID: ctx.sessionID }).catch(() => [] as MessageV2.WithParts[])
    const matched = findInlineableAttachment(messages, params.filename)

    if (!matched) {
      return {
        title: params.filename,
        metadata: { error: "attachment_not_found" },
        output: `No attached image named '${params.filename}' is available in this session. Confirm the filename matches the original upload.`,
      }
    }

    const session = await Session.get(ctx.sessionID).catch(() => undefined)
    const prior = session?.execution?.activeImageRefs ?? []
    const next = addOnReread(prior, params.filename, { max: cfg.activeSetMax })
    if (next !== prior) {
      await Session.setActiveImageRefs(ctx.sessionID, next).catch((err) => {
        log.warn("setActiveImageRefs failed", {
          sessionID: ctx.sessionID,
          filename: params.filename,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }

    return {
      title: params.filename,
      metadata: { activeSetSize: next.length },
      output: `Image '${params.filename}' queued for inline viewing on your next turn.`,
    }
  },
})
