# Teardown — Beta-header pipeline & server-side fallback (Claude Code CLI 2.1.169)

> Source: native binary `@anthropic-ai/claude-code-linux-x64@2.1.169`
> (`BUILD_TIME 2026-06-08T03:22:12Z`, `GIT_SHA eb44edf196b8a320135d5a27a3cfba37773ce0cd`).
> Method: static teardown of the embedded JS bundle (the main npm package no
> longer ships a readable `cli.js` — only a wrapper that launches the per-platform
> native binary, so the protocol truth now lives solely in the compiled binary).
> Symbol names are the minified identifiers in this build; they drift between
> releases (re-anchor on the string literals, not the var names).
>
> **Why this chapter exists.** The fingerprint sync (VERSION + axios UA) is
> string-presence only; it cannot tell whether the *betas-assembly logic* still
> matches what opencode replicates. This is the behavioural teardown of that
> logic for 2.1.169. It surfaced one genuine divergence on opus-4-8 (§5).

---

## §1 Pipeline overview

The `anthropic-beta` header value for a `/v1/messages` request is produced by a
4-stage pipeline:

```
register  →  WW6(base)  →  QU/ZW6 (per-platform)  →  cH (per-request adds)  →  GW6 (egress filter)  →  IW (→ header strings)
```

| Symbol | Role |
|--------|------|
| `tj(featureKey, header)` | Registers one beta as `Object.freeze({name, header})`. All 28 are registered in the `$E` module-init block; the frozen array is `DA_`, and `PGK = Map(header → beta)`. |
| `IW(arr)` | `arr.map(b => b.header)` — final projection of beta-objects to wire strings. |
| `WW6(H)` | **Base builder** (memoized). Decides the default beta set from model + auth + platform + statsig gates. §2. |
| `QU(H)` | Production wrapper: `WW6(H)`, minus `v36` on bedrock. `v36 = {interleaved_thinking, long_context, tool_search}`. |
| `ZW6(H)` | `WW6(H) ∩ v36` (used where only the v36 subset is wanted). |
| `cH(req)` | **Per-request finalizer**: starts from the base set and adds runtime-gated betas (fast-mode, extended-cache-ttl, effort, task-budgets, afk-mode, server-side-fallback, fallback-credit). §3. |
| `GW6(H)` | **Egress filter**: `PW6() ? H : H.filter(b => FFK.has(b))`. Non-first-party callers are stripped to `FFK = {claude_code, interleaved_thinking, long_context, context_management, structured_outputs, web_search, effort, tool_search, afk_mode}`. |

Key predicates (verified in this build):

| Predicate | Meaning |
|-----------|---------|
| `Mq()` | Active vendor route: `firstParty` / `anthropicAws` / `foundry` / `vertex` / `bedrock` / `mantle`. |
| `PW6()` | `Mq() ∈ {firstParty, anthropicAws, foundry}` — "first-party-ish". |
| `hyH()` | experimental betas disabled (`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`) **or** HIPAA mode. |
| `SN()` | `PW6() && !hyH()` — first-party with experimental betas enabled. |
| `hq()` | OAuth-authenticated with a valid scope set (subscription login). |
| `bW(H)` | model id matches `/\[1m\]/i` — 1M-context-eligible. |
| `iX$(H)` | interleaved-thinking eligible: foundry→true; first-party→not `claude-3-*`; `haiku-4-5`/`claude-3-*`→false; else true. |
| `O98(H)` | mid-conversation-system gate. **§5.** |

---

## §2 `WW6` base builder (decoded)

```js
WW6 = memoize((H) => {
  const $ = [], q = isHaiku(H), K = Mq(), _ = SN()
  if (!q)                                              $.push(claude_code)            // nNH
  if (hq() || (PW6() && !$j$() && eJ()))               $.push(oauth_auth)             // BjH
  if (bW(H))                                           $.push(long_context)           // Ec  (context-1m)
  if (!env.DISABLE_INTERLEAVED_THINKING && iX$(H))     $.push(interleaved_thinking)   // ucH
  if (_ && iX$(H) && !F6() && !A98())                  $.push(redact_thinking)        // Cj$
  if (_ && iX$(H) && statsig("tengu_chert_bezel",F))   $.push(thinking_token_count)   // o88  ← gate default FALSE
  if (_ && DW6())                                      $.push(narration_summaries)    // bj$
  const A = YV_(H)                                                                    // (f = USE_API_CONTEXT_MANAGEMENT && false = false)
  if (ES(Mq()) && !hyH() && (false || A))              $.push(context_management)     // iNH
  if (ES(Mq()) && !hyH() && SyH(H) && statsig("tengu_tool_pear",F)) $.push(structured_outputs) // W8H ← gate default FALSE
  if (K === "vertex" && zV_(H))                        $.push(web_search)             // Rj$
  if (K === "foundry")                                 $.push(web_search)             // Rj$
  if (_)                                               $.push(prompt_caching_scope)   // BcH
  if (O98(H))                                          $.push(mid_conversation_system)// $a  ← opus-4-8 TRUE (§5)
  if (env.ANTHROPIC_BETAS)                             $.push(...userBetas)
  return $
})
```

Note: `effort`, `task_budgets`, `extended_cache_ttl`, `fast-mode`, `afk-mode`,
`server_side_fallback`, `fallback_credit` are **not** in the base set — they are
added later by `cH` (§3) under runtime conditions.

### Resolved beta set for opencode's primary config

For a first-party **OAuth** request on **`claude-opus-4-8[1m]`** with thinking on
(`Mq()=firstParty`, `hq()=true`, `bW=true`, `iX$=true`, `SN()=true`):

| Beta | Pushed? | Why |
|------|---------|-----|
| `claude-code-20250219` | ✅ | non-haiku |
| `oauth-2025-04-20` | ✅ | `hq()` |
| `context-1m-2025-08-07` | ✅ | `[1m]` model |
| `interleaved-thinking-2025-05-14` | ✅ | `iX$` |
| `redact-thinking-2026-02-12` | ⚠️ | `SN && iX$ && !F6() && !A98()` (interactive/print-mode dependent) |
| `prompt-caching-scope-2026-01-05` | ✅ | `SN()` |
| **`mid-conversation-system-2026-04-07`** | ✅ | **`O98` → true for opus-4-8** |
| `thinking-token-count-2026-05-13` | ❌ | statsig `tengu_chert_bezel` default **false** |
| `structured-outputs-2025-12-15` | ❌ | statsig `tengu_tool_pear` default **false** |
| `narration_summaries` / `web_search` / `context_management` | ❌ | gate not met on this path |

---

## §3 `cH` per-request finalizer (runtime-gated adds)

Starting from `P8 = [...base]`:

```js
if (model 1M-eligible && !P8.has(context-1m))   P8.push(long_context)          // top-up
if (fastMode && !P8.has(fast-mode))             P8.push(speed)                 // pcH  (fast-mode-2026-02-01)
if (afkBedrock3P)                               P8.push(afk_mode)              // yG
if (cacheTTL === "1h" && SN())                  P8.push(extended_cache_ttl)    // rNH  (paired with cache_control.ttl="1h")
$tf(effortValue, …, P8)                          // effort (mcH) when an effort value is set
qtf(taskBudget, …, P8)                           // task_budgets (r88) when a task budget is set
Ktf(outputFormat, …, P8)                         // output_format → extra body output_config (NOT a beta in the usual case)
Yb4(serverRefusalFallback, model, P8, …)         // server_side_fallback (HE) — §4
wb4(creditLaneArmed || fallbackCreditCode, P8,…) // fallback_credit (hc)      — §4
// final body field:  betas: IW(GW6(XK))
```

opencode parity: fast-mode / effort / task-budgets / extended-cache-ttl are all
plumbed in `assembleBetas` (`protocol.ts`). The fallback pair is **never armed**
by opencode (§4).

---

## §4 NEW in 2.1.169 — server-side fallback + usage-credit continuation

Two new betas, `server-side-fallback-2026-06-01` (`HE`) and
`fallback-credit-2026-06-09` (`hc`), implement a quota/billing **continuation**
mechanism. Neither is sent on a normal request — both are gated on request-level
config that the client only sets *after* the server signals a fallback is
available.

### Wire shape
- `Yb4(serverRefusalFallback, model, betas, …)`: when `serverRefusalFallback` is
  defined **and** `model === serverRefusalFallback.forModel`, it registers `HE`
  and returns `{ fallbacks: [{ model: <fallbackModel> }] }` — i.e. the request
  body gains a top-level **`fallbacks: [{model}]`** array, and `server-side-fallback`
  is added to `anthropic-beta`.
- `wb4(armed, betas, …)`: when a fallback-credit lane is armed
  (`fallbackCreditLaneArmed === true || fallbackCreditCode !== undefined`), adds
  `fallback-credit` to `anthropic-beta`.
- `Mb4(resp)`: extracts a server-issued **`fallback_credit_token`** (string,
  1–2048 chars) from the response, to be replayed on the continuation request.
- `jb4`: builds a `{ type:"fallback", from:{model}, to:{model} }` record.

### Response telemetry (new header family)
The server reports unified rate-limit / overage / fallback state via new
**response** headers (not request headers):
`anthropic-ratelimit-unified-fallback`, `…-overage-status`,
`…-overage-disabled-reason`, `…-overage-reset`, `…-representative-claim`,
`…-status`, `…-reset`, `…-upgrade-paths`.

### Credit-token validation errors
`credit_malformed` (`fallback_credit_token: invalid or malformed`),
`credit_wrong_org` (`…does not belong to this organization`),
`credit_expired` (`…has expired`),
`credit_invalid_model` (`…is not valid for model`).

### opencode verdict
**Not applicable.** opencode never sets `serverRefusalFallback` /
`refusalFallbackModel` / `fallbackCreditCode`, so it never emits either beta or
the `fallbacks` body field, and never replays a credit token. No action — but
documented so a future "continue on overage" feature has the wire contract.

---

## §5 DIVERGENCE — `mid-conversation-system-2026-04-07` on opus-4-8

`O98(H)` (the gate for `mid_conversation_system`, `$a`):

```js
O98 = memoize((H) => {
  if (statsig("hipaa")) return false
  if (env.CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM) return true
  const override = explicitBetaFlag(H, "mid_conversation_system"); if (override !== undefined) return override
  const m = modelId(H)
  if (m.includes("claude-3-") || m === "claude-opus-4-0" || m === "claude-opus-4-1"
      || m === "claude-opus-4-5" || m === "claude-opus-4-6" || m === "claude-opus-4-7"
      || m === "claude-sonnet-4-0" || m === "claude-sonnet-4-5" || m === "claude-sonnet-4-6"
      || m === "claude-haiku-4-5") return false
  if (m === "claude-opus-4-8") return true                 // ← opus-4-8 only, among current models
  return ES(Mq())                                          // newer/unknown models: first-party-ish
})
```

**The official CLI sends `mid-conversation-system-2026-04-07` on every
`claude-opus-4-8` request** (absent HIPAA / explicit disable). Every other
currently-shipping model is explicitly `false`.

opencode's `assembleBetas` (`packages/provider-claude/src/protocol.ts`) has **no
`mid_conversation_system` step at all** — steps 7/8 are marked RESERVED for
`structured_outputs` / `web_search`, and nothing emits `$a`. opencode's primary
model is `opus-4-8`, so **this is a real `anthropic-beta` fingerprint gap on our
most-used model.**

The capability lets `system`-role content appear *mid-conversation* (not only as
the leading block). opencode currently consolidates system content (identity +
low-freq context) at the head and appends `<system-reminder>` blocks to the
**tail user turn** rather than as mid-stream system blocks, so functionally it
may not require the capability — but the official client advertises it, and the
server may branch on its presence for opus-4-8.

**Recommendation (deferred per "document, don't necessarily align"):** add a
gated step to `assembleBetas` —
`if (isOpus48(modelId) && !hipaa && !explicitDisable) betas.push("mid-conversation-system-2026-04-07")` —
behind the same first-party/OAuth conditions as the rest. Register
`BETA_MID_CONVERSATION_SYSTEM` in `protocol.ts` and the sync tool. Treat as a
fingerprint-parity change, validate against a live opus-4-8 capture before
shipping.

---

## §6 Unchanged for opencode's path (confirmed)

- **Request body fields**: `model, messages, system, tools, tool_choice, betas,
  metadata, max_tokens, thinking, temperature(cond), context_management(cond),
  stop_sequences(cond)`. No new always-on top-level field; `service_tier` /
  `output_format` are **not** present as request keys (output_format routes into
  the extra-body `output_config`). Matches the provider's convert output.
- **SSE events**: no new-in-2.1.169 event type on the subscription stream;
  `citations_delta` / `compaction_delta` / `web_search_tool_result` remain
  feature-gated (web-search / server-side-compaction) and predate 2.1.169.
- **Request headers**: set unchanged vs the §3 datasheet
  (`Authorization, anthropic-version, Content-Type, User-Agent,
  anthropic-client-platform, anthropic-beta, x-anthropic-billing-header(cond),
  x-organization-uuid(cond)`). 2.1.169's new headers are all *response*-side
  (§4 unified rate-limit family).
