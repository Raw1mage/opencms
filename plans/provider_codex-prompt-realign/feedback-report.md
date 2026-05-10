# Codex Responses API — Prompt Cache Stuck at Tools-Only Floor

**Status**: Open. Likely server-side regression. Filed pending OpenAI response.

**Reporter**: OpenCode (third-party CLI/daemon built on top of `@opencode-ai/codex-provider`, a custom AI SDK V2 adapter that speaks the same Responses API wire format as `codex-rs`).

**Affected**: All ChatGPT-subscription Codex accounts in our org. Multiple GPT-5.4 and GPT-5.5 sessions show the same floor. Replicates across fresh sessions, single accounts, multiple directories.

---

## Executive summary

`usage.input_tokens_details.cached_tokens` consistently caps at **4608** across an entire codex session, regardless of:

- Model (`gpt-5.5` and `gpt-5.4` both affected)
- Account (5+ different ChatGPT subscription accounts in our org all hit the same floor)
- Working directory / repo
- Session length (turns 2–200+ all return 4608)
- WS chain delta mode (`delta=true` with `previous_response_id`) vs full re-send (`delta=false`)
- Instructions content (driver-only ~640 tok, or full system blob ~16k tok — same floor)
- Wire shape of bundle items (raw-string content vs `ContentPart[]` array — same floor)
- `prompt_cache_key` value (per-account-per-thread `codex-${acct}-${sid}` vs pure `${threadId}` — same floor)
- Bundle insertion position in `input[]` (mid-chain at `lastUserIdx` vs head at index 0 — same floor)

The 4608 figure ≈ `instructions + tools schema` token count for our setup. It looks like the prefix cache hit ends precisely where `tools` ends and the conversation chain begins.

A historical session under our same OpenCode binary on **2026-05-10 22:48–23:56** (`ses_1ee114c2cffez1xu00cIPVXLRZ`) showed cache_read growing 35,840 → 49,152 → 117,248 → 137,216 → 181,248 across consecutive turns under `delta=true` AND `delta=false`. Cache worked until something changed between then and our next sessions.

Sessions starting **2026-05-11** all stuck at 4608. Same daemon binary lineage (we restarted the daemon several times for unrelated reasons), same `@opencode-ai/codex-provider` code path, same upstream codex-cli reference at `f7e8ff8e50` (then `76845d716b` after pull).

---

## Reproduction

1. ChatGPT subscription account, OAuth credentials, codex Responses API endpoint via WebSocket transport (or HTTP fallback — same result)
2. `model: "gpt-5.5"` (also reproduces on `gpt-5.4`)
3. `store: false`, `prompt_cache_key: "<sessionId>"`, `previous_response_id: <chained>`
4. `instructions`: stable text (we tested driver-only ~2.5KB and monolithic ~65KB; both hit 4608)
5. Send a turn, observe `usage.input_tokens_details.cached_tokens = 0` (fresh)
6. Send 2nd turn with `previous_response_id` set
7. Observe `cached_tokens = 4608` regardless of `input_tokens` (which grows naturally as conversation extends)
8. Send 100+ more turns. `cached_tokens` stays at 4608. Occasional one-turn jumps to 50,688 / 71,168 right after a chain reset, then back to 4608.

---

## Diagnostic data

### Sample USAGE telemetry across 49 turns of a single session

```
[CODEX-WS] USAGE input_tokens=18512 cached_tokens=0     hasPrevResp=false  ← turn 1
[CODEX-WS] USAGE input_tokens=22098 cached_tokens=4608  hasPrevResp=true
[CODEX-WS] USAGE input_tokens=22988 cached_tokens=4608  hasPrevResp=true
[CODEX-WS] USAGE input_tokens=31345 cached_tokens=4608  hasPrevResp=true
[CODEX-WS] USAGE input_tokens=42290 cached_tokens=4608  hasPrevResp=true
... 30+ more turns same pattern ...
[CODEX-WS] USAGE input_tokens=105448 cached_tokens=4608 hasPrevResp=false  ← chain reset
[CODEX-WS] USAGE input_tokens=97730  cached_tokens=50688 hasPrevResp=true   ← peak (1 turn)
[CODEX-WS] USAGE input_tokens=101093 cached_tokens=4608 hasPrevResp=false   ← back to floor
```

### Historical comparison (working session 2026-05-10)

```
[CODEX-WS] USAGE input_tokens=36197  cached_tokens=0      hasPrevResp=false  ← turn 1
[CODEX-WS] USAGE input_tokens=36610  cached_tokens=35840  hasPrevResp=true
[CODEX-WS] USAGE input_tokens=49562  cached_tokens=36352  hasPrevResp=true
[CODEX-WS] USAGE input_tokens=50162  cached_tokens=49152  hasPrevResp=true
[CODEX-WS] USAGE input_tokens=53760  cached_tokens=53760  hasPrevResp=true   (effectively 100%)
... cache continues to grow as chain extends ...
[CODEX-WS] USAGE input_tokens=215840 cached_tokens=181248 hasPrevResp=false  ← 84% on full re-send
```

### Request body fingerprint (current broken sessions)

```json
{
  "model": "gpt-5.5",
  "instructions": "<driver text, ~640 tok, byte-stable across turns, sha256:24c40934fe30...>",
  "input": [
    { "role": "developer", "content": [{"type":"input_text","text":"<role_identity + opencode_protocol bundle, 3850 tok, byte-stable>"}] },
    { "role": "user",      "content": [{"type":"input_text","text":"<AGENTS.md + environment_context bundle, 3940 tok, byte-stable>"}] },
    /* ... conversation history reconstructed from previous_response_id chain ... */
  ],
  "tools": [/* 11 function tools, schema byte-stable */],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "prompt_cache_key": "ses_1eca32cc1ffelyxaN1FlERPqRS",
  "store": false,
  "previous_response_id": "resp_0af46a9adff..."
}
```

`driverHash`, `developerBundle.totalChars`, `userBundle.totalChars`, `prompt_cache_key`, `model`, `tools` — all verified byte-stable across turns via local telemetry. No drift.

---

## What we tried (none lifted the floor)

1. ✅ **Persona alignment**: replaced our 27-line custom driver with upstream `BaseInstructions::default()` (275 lines from `refs/codex/codex-rs/protocol/src/prompts/base_instructions/default.md`, md5 `7a62de0a7552d52b455f48d9a1e96016`). No change.

2. ✅ **`prompt_cache_key = thread_id`** (matching upstream `client.rs:713`): switched from `codex-${accountId}-${threadId}` to pure `threadId`. Verified hash stable cross-rotation. No change.

3. ✅ **Wire structure aligned to upstream**: instructions = driver only; `input[]` opens with one `developer` bundle item + one `user` bundle item, mirroring `build_initial_context()` in `core/src/session/mod.rs:2553-2761`. No change.

4. ✅ **Bundle position at `input[0]`**: confirmed bundles always at chain head, not mid-conversation (transport delta-slice correctly trims them out as already-in-chain). No change.

5. ✅ **Bundle content as raw string vs `ContentPart[]`**: tested both shapes. Raw string matched pre-break (May 9) wire that historically cached well. Both forms hit 4608. Reverted to `ContentPart[]` for upstream alignment.

6. ✅ **`finishReason` fallback fix**: when terminal `response.completed` event fails to arrive but text was emitted, we now default to `"stop"` instead of `"unknown"`. Stops a runloop empty-round guard from issuing chain resets every few turns. Visibly stabilized chain (see #6 in upstream impact below) but did not improve cache_read floor.

7. ✅ **Daemon restart**: clean process state. Same floor.

8. ✅ **New session**: cache=0 on turn 1 (correct), cache=4608 on turn 2 (stuck), confirmed across 4 fresh sessions.

9. ✅ **`gpt-5.5` → `gpt-5.4`**: same floor.

10. ✅ **Account rotation**: 5+ accounts cycled through, all stuck at 4608.

---

## Hypothesis status

- **Wire-shape mismatch** (raw string vs ContentPart[], bundle position, instructions size): Falsified by experiments 4–5 above.
- **Account-level cache fragmentation**: Plausible — historical working session was on a different account in the same org. We will test by pinning a fresh session to the historical account next, but our remaining quota across accounts is depleted from the cache miss burning ~80k input tokens at full rate per turn.
- **Server-side regression**: Strongly supported by three open OpenAI issues:
  - [openai/codex#20301](https://github.com/openai/codex/issues/20301) — "Low cache hit rate when Codex integrates with GPT-5.5"
  - [openai/codex#21756](https://github.com/openai/codex/issues/21756) — "Conversation cache unexpectedly drops to nearly zero during short continuous sessions" (filed 2026-05-08, exact match for our symptom)
  - [openai/codex#21796](https://github.com/openai/codex/issues/21796) — Codex's own engineers observe ~55% cache hit on byte-identical prefixes, indicating a broader cache anomaly even under ideal conditions

All three issues open, no assignee, no resolution.

---

## Operational impact

A single chat turn under cache=4608 with input ≈ 80k tokens costs full price for ~75k uncached tokens. With burst rate enforced by ChatGPT subscription 5h windows, an active session burns through one account's 5h quota in **~10 minutes** of conversation.

Across our 16 ChatGPT subscription accounts: 11 are now in 3–4 hour cooldowns. Only 4 retain capacity, and those will be exhausted within an hour at the current rate.

For any third-party tool relying on the Codex Responses API for non-trivial multi-turn work, the cache regression is a hard blocker.

---

## What we would like from OpenAI

1. **Acknowledge the regression** in one of the three open issues.
2. **Confirm or refute** server-side cache changes between 2026-05-10 and 2026-05-11.
3. **Document** the actual prefix cache prefix calculation for `Responses` API requests with `previous_response_id` set — the public docs do not address chain-mode interaction with prefix cache, leaving a black-box where third-party clients cannot self-debug.
4. **Surface** an `extended_cache_signature` or similar explicit field clients can use to confirm what prefix the server hashed for cache lookup. Right now we have no way to tell whether our prompts are byte-stable from the server's perspective.

---

## Repro environment

- OpenCode daemon (TypeScript/Bun), `@opencode-ai/codex-provider` ^x.x
- `refs/codex` submodule pinned at `76845d716b` (rust-v0.0.2504301132-6092)
- Linux x64, WSL2 Ubuntu
- ChatGPT subscription accounts, OAuth flow
- Tested: `gpt-5.5`, `gpt-5.4`
- WebSocket transport (also reproduces on HTTP SSE fallback)
- `store: false`
- `service_tier`: undefined (default)
- `reasoning.effort`: configured (no impact tested)

---

## Related references

- Upstream wire layout: `refs/codex/codex-rs/core/src/session/mod.rs:2553-2761` (`build_initial_context()`)
- Upstream cache key: `refs/codex/codex-rs/core/src/client.rs:713` (`prompt_cache_key = self.state.thread_id.to_string()`)
- Upstream `BaseInstructions` default: `refs/codex/codex-rs/protocol/src/prompts/base_instructions/default.md`
- OpenAI prompt-caching guide: https://developers.openai.com/api/docs/guides/prompt-caching
