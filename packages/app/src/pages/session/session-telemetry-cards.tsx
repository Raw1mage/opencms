import { For, Show, createSignal, type JSX } from "solid-js"
import type { SessionTelemetry } from "@/context/global-sync/types"

type CollapsibleCardProps = {
  marker: string
  title: string
  expanded?: boolean
  onToggle?: () => void
  children: JSX.Element
}

function TelemetryCardShell(props: CollapsibleCardProps) {
  return (
    <div class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 flex flex-col gap-2">
      <button type="button" class="flex items-start gap-2 min-w-0 text-left" onClick={() => props.onToggle?.()}>
        <span class="text-11-medium text-text-weak shrink-0">{props.marker}</span>
        <div class="min-w-0 flex-1">
          <div class="text-12-medium text-text-strong break-words">{props.title}</div>
        </div>
        <Show when={props.onToggle}>
          <span class="text-12-medium text-text-base shrink-0">{(props.expanded ?? true) ? "▼" : "▶"}</span>
        </Show>
      </button>
      <Show when={props.expanded ?? true}>{props.children}</Show>
    </div>
  )
}

const tokenLine = (label: string, value?: number) => {
  if (value === undefined || value <= 0) return undefined
  return `${label} ~${value.toLocaleString()} tok`
}

const compactLine = (label: string, active: boolean, detail?: string) => {
  if (!active && !detail) return undefined
  return `${label} ${active ? "active" : (detail ?? "recorded")}`
}

function telemetryFallback(
  phase: SessionTelemetry["promptPhase"] | SessionTelemetry["roundPhase"],
  empty: string,
  error?: string,
) {
  if (phase === "loading") return "Loading telemetry…"
  if (phase === "error") return error ?? "Telemetry unavailable."
  if (phase === "disabled") return "Telemetry unavailable for this session."
  return empty
}

function quotaFallback(phase: SessionTelemetry["quota"]["phase"], empty: string, error?: string) {
  if (phase === "loading") return "Loading quota telemetry…"
  if (phase === "error") return error ?? "Quota telemetry unavailable."
  if (phase === "disabled") return "Quota telemetry unavailable for this session."
  return empty
}

function quotaTone(pressure: SessionTelemetry["quota"]["pressure"]) {
  if (pressure === "critical") return "critical"
  if (pressure === "high") return "warning"
  return "neutral"
}

function quotaPressureLabel(pressure: SessionTelemetry["quota"]["pressure"]) {
  if (pressure === "critical") return "Critical pressure"
  if (pressure === "high") return "High pressure"
  if (pressure === "medium") return "Elevated pressure"
  return "Stable"
}

export function PromptTelemetryCard(props: {
  telemetry?: SessionTelemetry
  expanded?: boolean
  onToggle?: () => void
}) {
  const [showAllBlocks, setShowAllBlocks] = createSignal(false)
  const visibleBlocks = () =>
    showAllBlocks() ? (props.telemetry?.prompt.blocks ?? []) : (props.telemetry?.prompt.blocks.slice(0, 3) ?? [])
  const hiddenCount = () => Math.max(0, (props.telemetry?.prompt.blocks.length ?? 0) - 3)

  return (
    <TelemetryCardShell marker="[P]" title="Prompt blocks" expanded={props.expanded} onToggle={props.onToggle}>
      <Show
        when={props.telemetry?.promptPhase === "ready"}
        fallback={
          <div
            classList={{
              "text-12-regular": true,
              "text-text-weak": props.telemetry?.promptPhase !== "error",
              "text-text-danger": props.telemetry?.promptPhase === "error",
            }}
          >
            {telemetryFallback(
              props.telemetry?.promptPhase ?? "empty",
              "No prompt telemetry yet.",
              props.telemetry?.error,
            )}
          </div>
        }
      >
        <>
          <div class="text-11-regular text-text-weak break-words">
            {props.telemetry?.summary.injectedCount ?? 0} injected
            {(props.telemetry?.summary.skippedCount ?? 0) > 0
              ? ` · ${props.telemetry?.summary.skippedCount ?? 0} skipped`
              : ""}
            {(props.telemetry?.summary.estimatedPromptTokens ?? 0) > 0
              ? ` · ~${(props.telemetry?.summary.estimatedPromptTokens ?? 0).toLocaleString()} tok`
              : ""}
          </div>
          <For each={visibleBlocks()}>
            {(block) => (
              <div class="rounded-md border border-border-weak-base bg-surface-panel px-2.5 py-2 flex flex-col gap-1">
                <div class="flex items-start justify-between gap-2">
                  <div class="text-11-medium text-text-strong break-words min-w-0 flex-1">{block.name}</div>
                  <span
                    classList={{
                      "text-11-medium shrink-0": true,
                      "text-success": block.outcome === "injected",
                      "text-warning": block.outcome === "skipped",
                    }}
                  >
                    {block.outcome}
                  </span>
                </div>
                <div class="text-11-regular text-text-weak break-words">
                  {[block.sourceFile, block.kind, block.injectionPolicy]
                    .filter((value): value is string => !!value)
                    .join(" · ")}
                  {block.estimatedTokens ? ` · ~${block.estimatedTokens.toLocaleString()} tok` : ""}
                </div>
                <Show when={block.skipReason}>
                  {(reason) => <div class="text-11-regular text-warning break-words">Skip: {reason()}</div>}
                </Show>
              </div>
            )}
          </For>
          <Show when={hiddenCount() > 0 || ((props.telemetry?.prompt.blocks.length ?? 0) > 3 && showAllBlocks())}>
            <button
              type="button"
              class="w-fit text-11-regular text-text-weak hover:text-text-strong transition-colors"
              onClick={() => setShowAllBlocks((value) => !value)}
            >
              {showAllBlocks() ? "Show fewer blocks" : `+${hiddenCount()} more blocks`}
            </button>
          </Show>
        </>
      </Show>
    </TelemetryCardShell>
  )
}

/**
 * 2026-05-09 ring buffer of recent rotation/compaction events from
 * Session.execution.recentEvents. Hand-typed here; the SDK gen file
 * picks it up on the next sync:back. See packages/opencode/src/session/
 * index.ts SessionRecentEvent.
 */
export type RecentExecutionEvent = {
  ts: number
  kind: "rotation" | "compaction"
  rotation?: {
    fromProviderId?: string
    fromAccountId?: string
    toProviderId?: string
    toAccountId?: string
    reason?: string
  }
  compaction?: {
    observed: string
    kind?: string
    success: boolean
    tokensBefore?: number
    tokensAfter?: number
  }
}

function shortAccount(accountId?: string): string {
  if (!accountId) return "?"
  // Strip the "codex-subscription-" prefix and trailing "-thesmart-cc" /
  // "-gmail-com" / etc to keep ring lines compact. Keeps the human-readable
  // identity (e.g. yeatsraw, ivon0829, service).
  return accountId
    .replace(/^codex-subscription-/, "")
    .replace(/^codex-/, "")
    .replace(/-(thesmart-cc|gmail-com|sob-com-tw|gmail|outlook-com)$/, "")
}

function formatRecentEventLine(
  e: RecentExecutionEvent,
  accountLabel?: (accountId?: string, providerId?: string) => string | undefined,
): string {
  const t = new Date(e.ts)
  const hh = t.getHours().toString().padStart(2, "0")
  const mm = t.getMinutes().toString().padStart(2, "0")
  if (e.kind === "rotation" && e.rotation) {
    const r = e.rotation
    const from = accountLabel?.(r.fromAccountId, r.fromProviderId) ?? shortAccount(r.fromAccountId)
    const to = accountLabel?.(r.toAccountId, r.toProviderId) ?? shortAccount(r.toAccountId)
    const reason = r.reason ? ` (${r.reason.toLowerCase().replace(/_/g, " ")})` : ""
    return `${hh}:${mm} rotation: ${from} → ${to}${reason}`
  }
  if (e.kind === "compaction" && e.compaction) {
    const c = e.compaction
    const kind = c.kind ? `, ${c.kind}` : ""
    const tokens =
      c.tokensBefore !== undefined && c.tokensAfter !== undefined
        ? ` (${(c.tokensBefore / 1000).toFixed(0)}k → ${(c.tokensAfter / 1000).toFixed(0)}k)`
        : ""
    return `${hh}:${mm} compaction: ${c.observed}${kind}${c.success ? "" : " ✗"}${tokens}`
  }
  return `${hh}:${mm} (unknown event)`
}

export function RoundSessionTelemetryCard(props: {
  telemetry?: SessionTelemetry
  accountLabel?: (accountId?: string, providerId?: string) => string | undefined
  recentEvents?: RecentExecutionEvent[]
  expanded?: boolean
  onToggle?: () => void
}) {
  const roundPairs = (): string[] => {
    const telemetry = props.telemetry
    if (!telemetry) return []
    return [
      telemetry.round.sessionId ? `session ${telemetry.round.sessionId}` : undefined,
      telemetry.round.roundIndex ? `round ${telemetry.round.roundIndex}` : undefined,
      telemetry.round.requestId ? `request ${telemetry.round.requestId}` : undefined,
    ].filter((value): value is string => !!value)
  }

  const roundLines = (): string[] => {
    const telemetry = props.telemetry
    if (!telemetry) return []
    return [
      tokenLine("Prompt", telemetry.round.promptTokens),
      tokenLine("Response", telemetry.round.responseTokens),
      tokenLine("Reasoning", telemetry.round.reasoningTokens),
      tokenLine("Cache read", telemetry.round.cacheReadTokens),
      tokenLine("Cache write", telemetry.round.cacheWriteTokens),
      telemetry.round.totalTokens && telemetry.round.totalTokens > 0
        ? `Round total ~${telemetry.round.totalTokens.toLocaleString()} tok`
        : undefined,
      compactLine("Compaction", telemetry.round.compacting, telemetry.round.compactionResult),
      telemetry.round.compactionDraftTokens
        ? `Compaction draft ~${telemetry.round.compactionDraftTokens.toLocaleString()} tok`
        : undefined,
    ].filter((value): value is string => !!value)
  }

  const sessionLines = (): string[] => {
    const telemetry = props.telemetry
    if (!telemetry) return []
    const account =
      props.accountLabel?.(telemetry.sessionSummary.accountId, telemetry.sessionSummary.providerId) ??
      telemetry.sessionSummary.accountId
    return [
      telemetry.sessionSummary.totalRequests > 0 ? `${telemetry.sessionSummary.totalRequests} requests` : undefined,
      telemetry.sessionSummary.cumulativeTokens > 0
        ? `Cumulative ~${telemetry.sessionSummary.cumulativeTokens.toLocaleString()} tok`
        : undefined,
      telemetry.sessionSummary.durationMs !== undefined
        ? `Duration ${Math.max(0, Math.round(telemetry.sessionSummary.durationMs / 1000))}s`
        : undefined,
      telemetry.sessionSummary.compactionCount > 0
        ? `${telemetry.sessionSummary.compactionCount} compaction events`
        : undefined,
      telemetry.sessionSummary.compacting ? "Session compacting" : undefined,
    ].filter((value): value is string => !!value)
  }

  return (
    <TelemetryCardShell
      marker="[S]"
      title="Round / Session telemetry"
      expanded={props.expanded}
      onToggle={props.onToggle}
    >
      <Show
        when={props.telemetry?.roundPhase === "ready"}
        fallback={
          <div
            classList={{
              "text-12-regular": true,
              "text-text-weak": props.telemetry?.roundPhase !== "error",
              "text-text-danger": props.telemetry?.roundPhase === "error",
            }}
          >
            {telemetryFallback(
              props.telemetry?.roundPhase ?? "empty",
              "No round telemetry yet.",
              props.telemetry?.error,
            )}
          </div>
        }
      >
        <>
          <Show when={roundPairs().length > 0}>
            <div class="text-11-regular text-text-weak break-words">{roundPairs().join(" · ")}</div>
          </Show>
          <For each={roundLines()}>
            {(line) => <div class="text-11-regular text-text-weak break-words">{line}</div>}
          </For>
          <Show when={sessionLines().length > 0}>
            <div class="rounded-md border border-border-weak-base bg-surface-panel px-2.5 py-2 flex flex-col gap-1">
              <div class="text-11-medium text-text-strong">Session summary</div>
              <For each={sessionLines()}>
                {(line) => <div class="text-11-regular text-text-weak break-words">{line}</div>}
              </For>
            </div>
          </Show>
          <Show when={(props.recentEvents?.length ?? 0) > 0}>
            <div class="rounded-md border border-border-weak-base bg-surface-panel px-2.5 py-2 flex flex-col gap-1">
              <div class="text-11-medium text-text-strong">
                Recent events ({props.recentEvents?.length})
              </div>
              <For each={(props.recentEvents ?? []).slice().reverse()}>
                {(event) => (
                  <div class="text-11-regular text-text-weak break-words font-mono">
                    {formatRecentEventLine(event, props.accountLabel)}
                  </div>
                )}
              </For>
            </div>
          </Show>
        </>
      </Show>
    </TelemetryCardShell>
  )
}

export type SessionTelemetryCardProps = {
  telemetry?: SessionTelemetry
  accountLabel?: (accountId?: string, providerId?: string) => string | undefined
  expanded?: boolean
  onToggle?: () => void
}

export function AccountQuotaReuseCard(props: SessionTelemetryCardProps) {
  const accountIdentity = () => {
    const telemetry = props.telemetry
    if (!telemetry) return []
    const account =
      props.accountLabel?.(telemetry.quota.accountId, telemetry.quota.providerId) ?? telemetry.quota.accountId
    return [telemetry.quota.providerId, account, telemetry.quota.modelId].filter((value): value is string => !!value)
  }

  const demandLines = () => {
    const telemetry = props.telemetry
    if (!telemetry) return []
    return [
      telemetry.round.totalTokens && telemetry.round.totalTokens > 0
        ? `Current demand ~${telemetry.round.totalTokens.toLocaleString()} tok`
        : undefined,
      telemetry.sessionSummary.cumulativeTokens > 0
        ? `Rolling session ~${telemetry.sessionSummary.cumulativeTokens.toLocaleString()} tok`
        : undefined,
      telemetry.sessionSummary.totalRequests > 0
        ? `${telemetry.sessionSummary.totalRequests} requests in session`
        : undefined,
      "Remaining tokens not exposed by current telemetry",
    ].filter((value): value is string => !!value)
  }

  const eventLines = () => {
    const telemetry = props.telemetry
    if (!telemetry) return []
    return telemetry.quota.recentEvents
      .slice(-3)
      .reverse()
      .map((entry) => {
        const message = entry.message?.trim()
        return `${entry.state}${message ? ` · ${message}` : ""}`
      })
  }

  return (
    <TelemetryCardShell marker="[Q]" title="Account / quota reuse" expanded={props.expanded} onToggle={props.onToggle}>
      <Show
        when={props.telemetry?.quota.phase === "ready"}
        fallback={
          <div
            classList={{
              "text-12-regular": true,
              "text-text-weak": props.telemetry?.quota.phase !== "error",
              "text-text-danger": props.telemetry?.quota.phase === "error",
            }}
          >
            {quotaFallback(props.telemetry?.quota.phase ?? "empty", "No quota telemetry yet.", props.telemetry?.error)}
          </div>
        }
      >
        <>
          <Show when={accountIdentity().length > 0}>
            <div class="text-11-regular text-text-weak break-words">{accountIdentity().join(" / ")}</div>
          </Show>
          <div class="flex flex-wrap gap-2">
            <span
              class="inline-flex h-5 px-1.5 items-center rounded-full border text-[11px] font-medium"
              classList={{
                "bg-surface-base text-text-muted border-border-weak-base":
                  quotaTone(props.telemetry?.quota.pressure ?? "low") === "neutral",
                "bg-warning/12 text-warning border-warning/20":
                  quotaTone(props.telemetry?.quota.pressure ?? "low") === "warning",
                "bg-danger/12 text-danger border-danger/20":
                  quotaTone(props.telemetry?.quota.pressure ?? "low") === "critical",
              }}
            >
              {quotaPressureLabel(props.telemetry?.quota.pressure ?? "low")}
            </span>
            <span class="inline-flex h-5 px-1.5 items-center rounded-full border text-[11px] font-medium bg-surface-base text-text-muted border-border-weak-base">
              {props.telemetry?.quota.activeIssues.length ?? 0} active issues
            </span>
            <span class="inline-flex h-5 px-1.5 items-center rounded-full border text-[11px] font-medium bg-surface-base text-text-muted border-border-weak-base">
              {props.telemetry?.quota.recentEvents.length ?? 0} recent events
            </span>
          </div>
          <div class="rounded-md border border-border-weak-base bg-surface-panel px-2.5 py-2 flex flex-col gap-1">
            <div class="text-11-medium text-text-strong">Quota window</div>
            <For each={demandLines()}>
              {(line) => <div class="text-11-regular text-text-weak break-words">{line}</div>}
            </For>
          </div>
          <Show when={props.telemetry?.quota.activeIssues.length}>
            <div class="rounded-md border border-border-weak-base bg-surface-panel px-2.5 py-2 flex flex-col gap-1">
              <div class="text-11-medium text-text-strong">Health alerts</div>
              <For each={props.telemetry?.quota.activeIssues.slice(0, 3) ?? []}>
                {(issue) => (
                  <div class="text-11-regular text-warning break-words">
                    {issue.type} · {issue.message}
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={eventLines().length > 0}>
            <div class="rounded-md border border-border-weak-base bg-surface-panel px-2.5 py-2 flex flex-col gap-1">
              <div class="text-11-medium text-text-strong">Recent quota events</div>
              <For each={eventLines()}>
                {(line) => <div class="text-11-regular text-text-weak break-words">{line}</div>}
              </For>
            </div>
          </Show>
        </>
      </Show>
    </TelemetryCardShell>
  )
}

export function QuotaPressureCompactCallout(props: SessionTelemetryCardProps) {
  const visible = () =>
    props.telemetry?.quota.phase === "ready" &&
    (props.telemetry.quota.pressure === "high" || props.telemetry.quota.pressure === "critical")
  const account = () => {
    const telemetry = props.telemetry
    if (!telemetry) return undefined
    return props.accountLabel?.(telemetry.quota.accountId, telemetry.quota.providerId) ?? telemetry.quota.accountId
  }

  return (
    <Show when={visible()}>
      <div
        class="rounded-md border px-3 py-2 flex flex-col gap-1"
        classList={{
          "border-warning/30 bg-warning/8": props.telemetry?.quota.pressure === "high",
          "border-danger/30 bg-danger/8": props.telemetry?.quota.pressure === "critical",
        }}
      >
        <div
          class="text-11-medium break-words"
          classList={{
            "text-warning": props.telemetry?.quota.pressure === "high",
            "text-danger": props.telemetry?.quota.pressure === "critical",
          }}
        >
          {quotaPressureLabel(props.telemetry?.quota.pressure ?? "low")}
        </div>
        <div class="text-11-regular text-text-weak break-words">
          {[props.telemetry?.quota.providerId, account()].filter((value): value is string => !!value).join(" / ")}
          {props.telemetry?.round.totalTokens
            ? ` · round ~${props.telemetry.round.totalTokens.toLocaleString()} tok`
            : ""}
        </div>
        <Show when={props.telemetry?.quota.activeIssues[0]}>
          {(issue) => (
            <div class="text-11-regular text-text-weak break-words">
              {issue().type} · {issue().message}
            </div>
          )}
        </Show>
      </div>
    </Show>
  )
}

export function SessionTelemetryCards(props: SessionTelemetryCardProps): JSX.Element {
  return (
    <>
      <PromptTelemetryCard telemetry={props.telemetry} />
      <RoundSessionTelemetryCard telemetry={props.telemetry} accountLabel={props.accountLabel} />
      <QuotaPressureCompactCallout telemetry={props.telemetry} accountLabel={props.accountLabel} />
    </>
  )
}
