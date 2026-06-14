# Bug Report: Anthropic 400 "does not support assistant message prefill" when conversation ends with an assistant message

## Summary

When the claude provider sends a request whose `messages` array ends with an `assistant`-role message, Anthropic's `/v1/messages` endpoint rejects it with:

```
invalid_request_error: This model does not support assistant message prefill. The conversation must end with a user message.
```

This was observed live in an interactive session: an assistant turn ended with a `question` (MCP) tool call, the user answered, and on the continuation turn the runtime serialized the conversation with the prior assistant message still trailing (no synthesized user turn), then dispatched it to the claude provider. Anthropic returned HTTP 400 and the turn failed.

## Environment

- Date: 2026-05-29
- Repo: `/home/pkcs12/projects/opencode`
- Provider: `packages/provider-claude` (native Anthropic provider, `globalThis.fetch` + HTTP SSE)
- Endpoint: `POST {baseURL}/v1/messages?beta=true` (`provider.ts:207`)
- Agent role: Main Agent / orchestrator
- Model class: Claude (Anthropic) — prefill of assistant messages is NOT supported for these models

## Impact

- The turn fails outright with a 400; no assistant output is produced.
- Reproducible whenever the last serialized message has `role: "assistant"` at request time — e.g. after a tool-call-terminated assistant turn followed by a continuation that does not append a user/tool message, or when a turn's `stop_reason` is mis-mapped and the runloop re-requests with the assistant reply trailing.
- Provider-specific: codex/OpenAI does not have this constraint, so the same conversation shape succeeds on codex and fails on claude. This makes the failure look intermittent / model-dependent.

## Evidence

- `packages/provider-claude/src/sse.ts:44-48` — existing comment documents a known causal chain for this exact 400:
  > "Anthropic emits the final stop_reason on message_delta (NOT message_stop); cache it per-stream so message_stop can map it. Without this every turn finished as 'other' instead of 'stop', so the runloop thought the turn wasn't done and re-requested with the assistant reply trailing → Anthropic 400 'does not support assistant message prefill'."
- `packages/provider-claude/src/convert.ts:53-164` (`convertPrompt`) — converts LMv2 messages to Anthropic messages by linear pass-through. There is **no guard** that ensures the resulting `messages` array ends with a `user`-role message. An assistant message with non-empty blocks is pushed as-is (`convert.ts:137-139`), and `tool` messages are converted to `user`-role (`convert.ts:155-156`) — so a trailing assistant turn with no following tool result stays trailing.
- Observed live error string:
  > `invalid_request_error: This model does not support assistant message prefill. The conversation must end with a user message.`

## Reproduction

1. Use the claude provider in an interactive session.
2. Have the assistant end a turn with a tool call that yields control back without appending a user/tool message (e.g. the `question` MCP tool, or any path where `stop_reason` mis-maps to "other").
3. Continue the session so the runtime serializes the conversation and dispatches to the claude provider.
4. Observe the request `messages` array ends with `role: "assistant"`.
5. Anthropic returns HTTP 400 `invalid_request_error: This model does not support assistant message prefill`.

## Expected Behavior

- The claude provider (or the message-serialization layer upstream of it) must guarantee the Anthropic `messages` array ends with a `user`-role message before dispatch.
- If the conversation legitimately ends with an assistant message at continuation time, the runtime should either:
  - append a synthesized user/tool turn (e.g. tool-result for the pending tool call) so the request is well-formed, or
  - fail fast with a clear internal diagnostic ("trailing assistant message — claude requires user-terminated conversation") instead of forwarding an invalid request to Anthropic.
- This is a normalization concern, not a fallback: it should be an explicit, observable guard with a loud error, not a silent fixup that masks an upstream serialization bug.

## Actual Behavior

- `convertPrompt` forwards the trailing assistant message verbatim.
- Anthropic rejects with 400; the turn dies.
- Because codex tolerates the same shape, the failure presents as model-specific and confusing.

## Suspected Causes

1. **Missing trailing-assistant normalization** in `convertPrompt` / the pre-dispatch path (`convert.ts`). No invariant enforces "messages ends with user".
2. **`stop_reason` mis-mapping** (documented at `sse.ts:44-48`) is one upstream trigger: a turn finishing as "other" instead of "stop" causes the runloop to re-request with the assistant reply trailing. The `lastStopReason` cache mitigates that specific path, but the conversion layer still has no defensive guard against any other path that leaves an assistant message trailing.
3. **Tool-call-terminated turns + continuation** (e.g. `question` MCP tool) can produce a serialized conversation whose last message is the assistant tool-call turn with no following tool-result/user turn.

## Acceptance Criteria

- A guard (in `convertPrompt` or the layer that builds the Anthropic request) verifies the `messages` array is non-empty and ends with `role: "user"`; if not, it is corrected via an explicit, documented rule or rejected with a loud internal error before the HTTP call.
- A regression test in `packages/provider-claude/test/` covers: a conversation ending with (a) a plain assistant text turn, (b) an assistant tool-call turn with no following tool-result — asserting the dispatched request is user-terminated (or fails fast with the documented diagnostic).
- The fix does not introduce a silent fallback that hides an upstream serialization defect (per AGENTS.md天條: fail fast, explicit, evidence-preserving — no silent fallback).
- Behavior parity note documented: codex tolerates trailing-assistant shapes; claude does not. The normalization belongs at the claude boundary (or, preferably, the provider-agnostic serialization layer with a claude-specific assertion).

## Next-Session Checklist

- Inspect the message-serialization path feeding `convertPrompt` (session/message-v2 → provider call) to find where a trailing assistant message can survive to dispatch.
- Decide placement: provider-agnostic "ensure user-terminated" normalization vs claude-only guard. Prefer the upstream serialization layer if codex/other providers also benefit, with a claude-side assertion as a backstop.
- Add the regression tests described in Acceptance Criteria.
- Cross-check the `question` MCP tool continuation path specifically — confirm whether the runtime appends a synthetic user/tool turn after a tool-call-terminated assistant turn, and whether that path was the live trigger.
- Verify interaction with the `sse.ts:44-48` stop_reason mapping so the two mitigations do not mask each other.

---

## Resolution (cross-checked 2026-05-29, Claude Code)

Cross-checked this report against the live evidence — **all findings confirmed correct**:

- Root cause (request `messages` ends with assistant → 400) — confirmed via `diag.preLLM` tail of `ses_18bb63dd5ffeSYce587EHwnOVf`: `user → assistant(tool-calls) → assistant(tool-calls)` (consecutive assistant turns, the second trailing with an unsatisfied tool_use).
- The `sse.ts` `stop_reason` mapping (now fixed) was one upstream trigger; the conversion layer indeed had **no user-terminated guard** for the other paths (e.g. `question`-tool continuation producing consecutive assistant messages). Confirmed.
- Provider-specific (codex tolerates, claude rejects). Confirmed.

**Fix applied** (honoring the report's "no silent fallback" / AGENTS.md天條 requirement):
- `convert.ts` `convertPrompt` now strips trailing assistant messages so the request is always user-terminated, AND returns `droppedTrailingAssistants` (count). This is an explicit, documented normalization — **not silent**.
- `provider.ts` logs a loud `console.warn` whenever the guard fires, referencing this report, so the upstream serialization defect stays visible instead of being masked.
- Regression test: `packages/provider-claude/test/convert-guard.test.ts` covers (a) trailing plain-assistant turn, (b) assistant tool-call turn with no following tool-result, plus the unchanged normal/tool-terminated and user-only cases. 4/4 pass.

**Still open (upstream root cause — backstop in place, not yet root-fixed):**
The provider guard prevents the 400 and surfaces the defect, but does NOT fix *why* opencode's serialization emits consecutive assistant messages (a tool result not threaded back between two assistant turns). Per this report's Next-Session Checklist, the upstream path (`session/message-v2` → provider call, specifically the `question`-MCP-tool continuation) still needs investigation. The new `console.warn` will now make those occurrences diagnosable in production logs.

Deployed: rebuilt + restarted via `webctl.sh restart --force`.

---

## Upstream root cause FOUND + FIXED (2026-05-29, follow-up)

The "Next-Session Checklist" item — *why does serialization emit a
non-user-terminated conversation* — is resolved.

**Root cause:** `packages/opencode/src/session/prompt.ts` (the `isLastStep`
branch) appended the max-steps notice as a trailing `{ role: "assistant",
content: MAX_STEPS }` message. `prompt/max-steps.txt` is instruction-style
("MAXIMUM STEPS REACHED … Tools are disabled … Respond with text only … overrides
ALL instructions"), but injecting it as an assistant turn makes the conversation
end on an assistant message. Anthropic rejects that ("does not support assistant
message prefill"); codex/OpenAI tolerated it — hence the claude-only,
"intermittent" (fires on max-steps) presentation. It was NOT the `question` tool
itself; that path just tended to reach max-steps.

**Fix (commit 5d7481bfa):** move the directive into the `system` dynamic tier
(`...(isLastStep ? [MAX_STEPS] : [])`) and drop the trailing assistant message.
Provider-agnostic, no prefill, no trailing assistant. The `convertPrompt`
trailing-assistant guard (edcc20356) remains as defense-in-depth + loud signal
for any other path.

Status: **RESOLVED** (root cause fixed + backstop + regression test). Deployed
via webctl restart --force (v…291550).
