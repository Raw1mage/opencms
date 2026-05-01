import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "@/util/log"
import z from "zod"

const toastTraceLog = Log.create({ service: "toast.trace" })

export const TuiEvent = {
  ProviderRefresh: BusEvent.define("tui.provider.refresh", z.object({})),
  PromptAppend: BusEvent.define("tui.prompt.append", z.object({ text: z.string() })),
  CommandExecute: BusEvent.define(
    "tui.command.execute",
    z.object({
      command: z.union([
        z.enum([
          "session.list",
          "session.new",
          "session.share",
          "session.interrupt",
          "session.compact",
          "session.page.up",
          "session.page.down",
          "session.line.up",
          "session.line.down",
          "session.half.page.up",
          "session.half.page.down",
          "session.first",
          "session.last",
          "prompt.clear",
          "prompt.submit",
          "agent.cycle",
        ]),
        z.string(),
      ]),
    }),
  ),
  ToastShow: BusEvent.define(
    "tui.toast.show",
    z.object({
      title: z.string().optional(),
      message: z.string(),
      variant: z.enum(["info", "success", "warning", "error"]),
      duration: z.number().default(5000).optional().describe("Duration in milliseconds"),
      // Trace-only timestamp stamped at publish time. Used to measure
      // publish→SSE→browser latency (RCA for "toast appears minutes late").
      // Frontend MUST NOT use this to drop events — toasts are always shown.
      emittedAt: z.number().optional(),
    }),
  ),
  SessionSelect: BusEvent.define(
    "tui.session.select",
    z.object({
      sessionID: z.string().regex(/^ses/).describe("Session ID to navigate to"),
    }),
  ),
}

/**
 * Publish a toast with publish-time instrumentation. Stamps emittedAt so the
 * SSE handler and frontend can compute traversal latency. Logs the call site
 * and message preview to debug.log so we can correlate with toast appearance.
 *
 * Why this exists: we observe rate-limit / rotation toasts surfacing to the
 * UI minutes after the underlying event, especially when a new session or
 * subagent boots. This helper times each publish so RCA can prove whether
 * the latency lives in publish→SSE→browser, or in something earlier (the
 * decision to publish itself being late). Frontend MUST display every toast
 * regardless of emittedAt; this stamp is for tracing only.
 */
export async function publishToastTraced(
  properties: Omit<z.input<typeof TuiEvent.ToastShow.properties>, "emittedAt">,
  context?: { source: string },
) {
  const emittedAt = Date.now()
  toastTraceLog.info("toast publish", {
    emittedAt,
    source: context?.source ?? "unknown",
    variant: properties.variant,
    title: properties.title,
    messagePreview: properties.message.slice(0, 120),
  })
  return Bus.publish(TuiEvent.ToastShow, { ...properties, emittedAt })
}

export function isToastEvent(event: unknown): event is { payload: { type: "tui.toast.show"; properties: { emittedAt?: number } } } {
  const payload = (event as any)?.payload
  return payload?.type === "tui.toast.show"
}
