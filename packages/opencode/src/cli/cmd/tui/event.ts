import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "@/util/log"
import z from "zod"

const toastTraceLog = Log.create({ service: "toast.trace" })
const DEFAULT_TOAST_TTL_MS = 5_000

export const ToastScope = z.enum(["system", "user", "workspace", "session"])
export type ToastScope = z.infer<typeof ToastScope>

export const ToastShowInput = z.object({
  title: z.string().optional(),
  message: z.string(),
  variant: z.enum(["info", "success", "warning", "error"]),
  duration: z.number().default(5000).optional().describe("Duration in milliseconds"),
  ttlMs: z.number().positive().optional().describe("Maximum age in milliseconds before the frontend must drop display"),
  scope: ToastScope.optional().describe("Audience/sensitivity scope for this toast"),
})
export type ToastShowInput = z.input<typeof ToastShowInput>

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
      emittedAt: z.number().describe("Publish timestamp in epoch milliseconds for freshness checks"),
      ttlMs: z.number().positive().describe("Maximum age in milliseconds before the frontend must drop display"),
      scope: ToastScope.describe("Audience/sensitivity scope for this toast"),
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
 * Publish a toast with publish-time instrumentation. Stamps emittedAt/ttlMs so
 * the SSE handler and frontend can compute traversal latency and drop stale
 * display requests. Logs the call site and message preview to debug.log so we
 * can correlate with toast appearance.
 *
 * Why this exists: we observe rate-limit / rotation toasts surfacing to the
 * UI minutes after the underlying event, especially when a new session or
 * subagent boots. This helper times each publish so RCA can prove whether
 * the latency lives in publish→SSE→browser, or in something earlier (the
 * decision to publish itself being late). Toasts are ephemeral UI signals;
 * frontend display is freshness-gated by ttlMs.
 */
export async function publishToastTraced(properties: ToastShowInput, context?: { source: string }) {
  const emittedAt = Date.now()
  const ttlMs = properties.ttlMs ?? properties.duration ?? DEFAULT_TOAST_TTL_MS
  const scope = properties.scope ?? "user"
  toastTraceLog.info("toast publish", {
    emittedAt,
    ttlMs,
    scope,
    source: context?.source ?? "unknown",
    variant: properties.variant,
    title: properties.title,
    messagePreview: properties.message.slice(0, 120),
  })
  return Bus.publish(TuiEvent.ToastShow, { ...properties, emittedAt, ttlMs, scope })
}

export function isToastEvent(event: unknown): event is {
  payload: { type: "tui.toast.show"; properties: { emittedAt: number; ttlMs: number; scope: ToastScope } }
} {
  const payload = (event as any)?.payload
  return payload?.type === "tui.toast.show"
}
