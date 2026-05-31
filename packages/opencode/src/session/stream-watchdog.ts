/**
 * Stream-watchdog policy (provider-aware), extracted from llm.ts so the
 * timeout decisions are unit-testable without spinning up the LLM stack.
 *
 * Why these watchdogs exist: the codex provider (and occasionally others) can
 * wedge a stream at 0 bytes — no tokens, no error, no close. Without a
 * watchdog the runloop awaits forever and only the client's own fetch timeout
 * surfaces it, leaving an empty assistant shell + state=running that the
 * zombie-sweep can't touch because the runloop is still live.
 *
 * Why they must be provider-aware: claude-opus on large prompt-cache contexts
 * legitimately goes SILENT for long stretches and must NOT be killed at codex
 * thresholds. Two measured cases:
 *   1. >178s of server-side cache-read + thinking before the FIRST token on
 *      200K+ token contexts (this is why the 60s first-chunk watchdog is
 *      codex-only — see FIRST_CHUNK_WATCHDOG_FAMILIES).
 *   2. >90s between opening a tool_use block (`tool-input-start`) and emitting
 *      the first `input_json_delta` while it generates a large tool input
 *      (e.g. a multi-KB `write`). Observed 2026-05-31 (ses_18d7f02e): a
 *      `write` tool_use stalled 90s pre-input → the 90s idle watchdog fired →
 *      `UpstreamIdleClose` mid-report-write. The pre-2026-05-31 comment
 *      claimed claude "never trips" the idle watchdog — falsified by this.
 *
 * Note on incremental streaming: ai-sdk v5 `onChunk` fires for
 * `tool-input-start` / `tool-input-delta` (verified against ai@5.0.119), so a
 * healthily-streaming large tool input already re-arms the idle watchdog every
 * delta. Only the PRE-first-delta gap (case 2) needs the wider budget below.
 */

/** Idle watchdog (re-arms on every chunk): abort after this much silence. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000

/**
 * claude budget: above its measured worst-case mid-stream gap (case 2 ≈ 90s,
 * with headroom against the 178s prefill case) while still bounded well under
 * the provider-level 300_000ms AbortSignal.timeout so a genuine wedge is still
 * caught (just later) instead of hanging to the hard ceiling.
 */
export const CLAUDE_STREAM_IDLE_TIMEOUT_MS = 240_000

/** First-chunk watchdog (does NOT re-arm): only for the codex 0-byte open-but-never-emits wedge. */
export const FIRST_CHUNK_WATCHDOG_FAMILIES: ReadonlySet<string> = new Set(["codex"])

/** Providers that get the wider idle budget instead of the 90s default. */
export const LONG_IDLE_PROVIDERS: ReadonlySet<string> = new Set(["claude-cli"])

/** Resolve the chunk-idle timeout for a provider. */
export function streamIdleTimeoutMs(providerId: string): number {
  return LONG_IDLE_PROVIDERS.has(providerId) ? CLAUDE_STREAM_IDLE_TIMEOUT_MS : DEFAULT_STREAM_IDLE_TIMEOUT_MS
}

/** Whether this provider arms the (codex-only) first-chunk watchdog. */
export function usesFirstChunkWatchdog(providerId: string): boolean {
  return FIRST_CHUNK_WATCHDOG_FAMILIES.has(providerId)
}
