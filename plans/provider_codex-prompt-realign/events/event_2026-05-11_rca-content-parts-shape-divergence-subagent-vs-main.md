---
date: 2026-05-11
summary: "RCA hypothesis — content parts shape divergence (1 joined vs N split) explains subagent-cache-works / main-cache-stuck-4608"
---

# RCA hypothesis — content parts shape divergence (subagent OK / main stuck at 4608)

## TL;DR (hypothesis, not yet A/B verified)

**Subagent sessions cache normally because their user-bundle has only one section (`environment_context`). Main sessions stuck at the 4608 floor because their user-bundle has multiple sections (`AGENTS.md global` + `AGENTS.md project` + `environment_context`) and our assembler joins them into a single `InputText` ContentItem, diverging from upstream's `Vec<ContentItem>` shape. Server prefix-cache likely keys on `content[]` structure, not flat text — same bytes, different shape → cache miss.**

The earlier closing note ([#20301](https://github.com/openai/codex/issues/20301) GPT-5.5 model regression) still stands as a contributing factor; this RCA explains the **structural mechanism by which OpenCode is hit harder than upstream codex-cli** — we're sending an upstream-wire-incompatible shape on top of an already-degraded server cache.

## Evidence trail (this session, daemon /run/user/1000/opencode-per-user-daemon.log)

### Cross-table over ~55 sessions in last 2h

Filtered to "stuck at 4608 floor across turn 2+3":

| session | first-item role | items | t1_in | t2_cache | t3_cache |
|---|---|---|---|---|---|
| aN1FlERPqRS | developer | 3 | 18512 | **4608** | **4608** |
| iAmGx2FCuOs | developer | 3 | 18521 | **4608** | **4608** |
| Yxgv2Y1O1Q2 | developer | 3 | 23398 | **4608** | 0 |
| MxiuDTtThZ2 | user      | 2 | 33733 | **4608** | 0 |

Healthy comparison (subagent path):

| session | first-item role | items | t1_in | t2_cache | t3_cache |
|---|---|---|---|---|---|
| ses_1e9e540ebffebzo1g0Jo3NdkLX | user | 4 | 15756 | 0 (lag) | **40448** → 77824+ |

Earlier hypothesis "role=developer triggers it" was **falsified** — many `developer/3` sessions cache fine (`ieU7oSTLOPY` t2=30208, `1zCoAvEa6GG` t2=34304, etc.) and one user/2 also stuck (`MxiuDTtThZ2`). Role is not the lever.

### What actually differs (code-level)

The only `if (!subagentSession)` branch in the entire prompt-assembly path is at [packages/opencode/src/session/llm.ts:1017-1035](packages/opencode/src/session/llm.ts#L1017-L1035):

```ts
if (!subagentSession) {
  const instructionPrompts = await InstructionPrompt.system(input.sessionID)
  for (const item of instructionPrompts) {
    fragments.push(buildUserInstructionsFragment({ ... }))  // AGENTS.md
  }
}
fragments.push(buildEnvironmentContextFragment({ ... }))
```

This pushes 2+ extra `role: "user"` fragments into the bundle for main sessions, 0 extra for subagents.

### Wire shape divergence — the actual lever

[refs/codex/codex-rs/core/src/context_manager/updates.rs:182-202](refs/codex/codex-rs/core/src/context_manager/updates.rs#L182-L202) (upstream):

```rust
fn build_text_message(role: &str, text_sections: Vec<String>) -> Option<ResponseItem> {
    let content = text_sections
        .into_iter()
        .map(|text| ContentItem::InputText { text })  // ONE ContentItem PER section
        .collect();
    Some(ResponseItem::Message { role, content, ... })
}
```

[refs/codex/codex-rs/core/src/session/mod.rs:2717-2738](refs/codex/codex-rs/core/src/session/mod.rs#L2717-L2738) pushes **multiple independent strings** into `contextual_user_sections`:

```rust
contextual_user_sections.push(UserInstructions { ... }.render());   // section 1
contextual_user_sections.push(EnvironmentContext { ... }.render()); // section 2
```

→ Upstream wire is:

```jsonc
{ "role": "user", "content": [
    { "type": "input_text", "text": "<agents_global>" },
    { "type": "input_text", "text": "<agents_project>" },
    { "type": "input_text", "text": "<env_ctx>" }
] }
```

[packages/opencode/src/session/context-fragments/assemble.ts:77-81](packages/opencode/src/session/context-fragments/assemble.ts#L77-L81) (ours):

```ts
return {
  role,
  text: rendered.map((r) => r.text).join(FRAGMENT_SEP),  // join into ONE string
  fragmentIds: rendered.map((r) => r.id),
}
```

[packages/opencode/src/session/llm.ts:1067-1071](packages/opencode/src/session/llm.ts#L1067-L1071):

```ts
bundleMessages.push({
  role: "user",
  content: [{ type: "text", text: userBundle.text }],  // ONE part containing joined string
  providerOptions: { codex: { kind: "user-bundle" } },
})
```

→ Our wire is:

```jsonc
{ "role": "user", "content": [
    { "type": "input_text", "text": "<agents_global>\n\n<agents_project>\n\n<env_ctx>" }
] }
```

**Same bytes when flattened, different shape.** Subagent has 1 section so 1-part-shape **accidentally matches upstream's 1-element Vec**, cache works. Main has 3 sections so 1-part-shape **diverges from upstream's 3-element Vec**, cache misses everything after instructions+tools (≈ 4608 tokens, the observed floor).

## Why this was not caught earlier

- A.2/A.3 reviews focused on **text content** alignment (markers, body, ordering), not on **content[] cardinality**
- assemble.ts top comment says "Mirrors upstream codex-cli's `build_initial_context()` output shape" — comment was aspirational; implementation collapsed Vec into a single string
- Most session-stable testing used short prompts where user-bundle ended up with 1-2 sections; the regression only fires when N ≥ 2 user-role fragments coexist (main path with AGENTS.md is the everyday trigger)

## Proposed fix (Option A — minimal, upstream-faithful)

Change [`BundledMessage.text: string`](packages/opencode/src/session/context-fragments/assemble.ts) → `parts: string[]`.

Then [llm.ts:1059-1071](packages/opencode/src/session/llm.ts#L1059-L1071):

```ts
if (developerBundle) {
  bundleMessages.push({
    role: "user",
    content: developerBundle.parts.map((text) => ({ type: "text", text })),
    providerOptions: { codex: { kind: "developer-bundle" } },
  })
}
if (userBundle) {
  bundleMessages.push({
    role: "user",
    content: userBundle.parts.map((text) => ({ type: "text", text })),
    providerOptions: { codex: { kind: "user-bundle" } },
  })
}
```

`convert.ts` already maps `ModelMessage.content[]` to `Vec<ContentItem::InputText>` 1:1, so no change there.

Files touched: `assemble.ts` (return shape), `llm.ts` (bundle emission, ~6 lines). Reversible. Type-safe.

## A/B verification protocol

1. Apply the patch to a single daemon.
2. Restart daemon (user-gated; do **not** auto-restart).
3. Open a fresh main-role session with at least one AGENTS.md present.
4. After turn 2, grep `/run/user/1000/opencode-per-user-daemon.log` for `[CODEX-WS] USAGE session=<new_id>`.
5. Pass criterion: `cached_tokens` ≥ 5× t1_in (i.e. server cached the conversation body, not just instructions+tools) by turn 3.
6. Fail criterion: `cached_tokens` stays at 4608 — hypothesis falsified, revert.

If pass: also verify developer-bundle the same way (developer-bundle currently has 3 fragments in main, so it's subject to the same divergence — fixing user-bundle alone might leave half the cache potential on the table).

## What this RCA does NOT claim

- That GPT-5.5 server cache regression ([#20301](https://github.com/openai/codex/issues/20301)) is fixed by this change — it is not. Upstream codex itself only gets ~55% hit rate on GPT-5.5 today. This patch closes the **additional** gap between upstream and OpenCode by removing the shape divergence; it cannot exceed upstream's own ceiling.
- That this is the **only** lever. There may be other accumulated subtle divergences (developer-bundle internal ordering, fragment marker text, etc.). This is the first concrete code-level structural divergence identified with clear upstream side-by-side.

## State

- **Theory**: documented, code anchors captured.
- **A/B test**: not yet executed — pending user approval to patch + restart daemon.
- **Related**: plan `provider_codex-prompt-realign` already at `implementing`; if hypothesis confirms, this becomes Stage A.6 (or extends A.2 retroactively).

---

## Reviewer addendum (2026-05-11, codex/cli-reversed-spec auditor)

Added by the agent currently authoring `specs/codex/cli-reversed-spec/` Chapter 04 (Context Fragment Assembly). This RCA is **independently cross-anchored** to the chapter's audited claims (refs/codex SHA `76845d716b`). Notes for the implementing agent below.

### Cross-reference to audited upstream contract

Chapter 04 of the reversed-spec audits the exact upstream code path this RCA cites:

- **Ch04 C5** anchors `build_text_message` at [`refs/codex/codex-rs/core/src/context_manager/updates.rs:178`](refs/codex/codex-rs/core/src/context_manager/updates.rs#L178). The audit pinned: `text_sections.into_iter().map(|text| ContentItem::InputText { text }).collect()` — **one ContentItem per section**, exactly as this RCA argues. This is not a contested claim; it's audited upstream truth.
- **Ch04 D4-1** datasheet's example payload shows the multi-element `content` array for the developer Message (3 InputText entries when 3 sections are present). Server-side, the prefix-cache contract operates on this `Vec<ContentItem>` shape.
- **Ch04 OpenCode delta map A4.3** (recently audited) wrote: "OpenCode wraps the developer bundle as a single ModelMessage with role: 'user' + `providerOptions.codex.kind = 'developer-bundle'` marker". That delta described the role-marker bridge but **did not catch the parts-vs-joined cardinality regression**. This RCA refines/corrects the chapter's delta map.

The reviewer will record a Ch04 supplemental event noting the RCA's refinement of A4.3 after this implementation lands.

### Approval

**Approved to execute.** The fix is minimal, reversible, and structurally aligned with the audited upstream behaviour. The A/B protocol is concrete and falsifiable.

### Implementation caveats (please address during patching)

1. **Both bundles** must use the parts-array shape, not only user-bundle. The developer-bundle in main sessions has 3 fragments (RoleIdentity + opencode_protocol/SYSTEM.md + opencode_agent_instructions), subject to the same divergence. The Option A patch already covers both — make sure no one strips the developer-bundle change "for simplicity" mid-implementation; it would leave 50%+ of the cache potential on the table.

2. **`.text` field consumers must be migrated.** After `BundledMessage.text: string` → `parts: string[]`, grep for any remaining `.text` reads:

   ```bash
   grep -rn "developerBundle\.text\|userBundle\.text\|developerBundleForTelemetry\.text\|userBundleForTelemetry\.text" packages/opencode/src/
   ```

   Likely sites needing migration:
   - [`llm.ts:1090-1093`](packages/opencode/src/session/llm.ts#L1090-L1093) — `prompt.bundle.assembled` telemetry's `totalChars: developerBundle.text.length` / `userBundle.text.length`. Replace with `parts.reduce((s, p) => s + p.length, 0)`.
   - [`llm.ts:1250-1251`](packages/opencode/src/session/llm.ts#L1250-L1251) — telemetry `chars: developerBundleForTelemetry.text.length` / `tokens: Token.estimate(developerBundleForTelemetry.text)`. Replace with `parts.join('\n\n').length` and `Token.estimate(parts.join('\n\n'))`.
   - Any test fixtures using `.text` directly.

   These are non-functional (telemetry only) but missing them yields broken char/token counts in `bus.llm.prompt.telemetry` events and degrades observability.

3. **Empty-part defensive filter.** If any fragment renders to empty string (e.g. AGENTS.md missing in dev environment, or `agent.prompt` is empty for some agent variant), the parts array will contain `""` entries. Two options:

   - **In `assemble.ts`**: filter `rendered = rendered.filter(r => r.text.length > 0)` before mapping. Cleaner — keeps the bundle parts list well-formed for all consumers.
   - **At emission site**: `parts.filter(t => t.length > 0).map(text => ({ type: "text", text }))`. Looser — defers to caller.

   Prefer the first. Empty `InputText` parts are wire-legal but may behave unpredictably (some backends drop them, some count them). Upstream codex-cli's `build_text_message` filters at the `text_sections: Vec<String>` level by only pushing non-empty strings into the vec — same end state.

4. **Verify your A/B session is genuinely fresh.** "Open a fresh main-role session" must mean a brand-new session id with **no prior chain state**. If the daemon was reusing a WS connection cached from before the patch, the chain's history items would still be the old joined-shape ones server-side, and the new shape won't extend that prefix cleanly. Either:
   - Restart the daemon between patch and test (RCA step 2 already specifies this — good), AND
   - Open the session via the web UI's "new chat" button, not by resuming an existing session URL.

5. **Pass criterion clarification.** The criterion `cached_tokens ≥ 5× t1_in` works because t1's input is roughly bundle+history=t1_in, and the floor is ~4608. If t1_in is 18000 and t2 cached_tokens jumps to 20000+ that's a clear pass. If it stays at 4608 ± 100 that's a clear fail. Anything in between (e.g. 12000) is **ambiguous** — could mean partial cache hit on tools-only + bundle prefix. In ambiguous outcomes, run a third turn and watch for cumulative growth (cached_tokens monotonically increasing turn over turn indicates lineage is healing).

6. **Reviewer's request: capture concrete numbers in the RCA file when done.** Whether pass or fail, append a "Verification result" section with the actual `cached_tokens` values at turn 1/2/3 of the test session, plus the session id. This becomes part of the audit trail for the reversed-spec Chapter 04 supplemental event.

### What this RCA does NOT need to address

- The `x-codex-window-id` in `client_metadata` discussion from `specs/provider/codex-installation-id/` is a separate question and is **upstream-aligned on the WS path** (audited as Ch08 C5 of the reversed-spec). Do not change `buildClientMetadata` as part of this fix; that's a different surface.
- The GPT-5.5 server-side cache regression (#20301) ceiling is unchanged by this fix. Even after pass, expect cache hit rate < upstream's already-degraded ~55%. The win is **closing the OpenCode-vs-upstream gap**, not exceeding upstream's ceiling.

### Coordination with the reversed-spec author

This reviewer is continuing the `specs/codex/cli-reversed-spec/` audit (currently at Chapter 09 next, 8/12 chapters audited at SHA `76845d716b`). When the A/B verification result comes back, please drop a one-line update in this same file under `## Verification result` so the reviewer can record a Ch04 supplemental event closing the loop. No further coordination needed — work in parallel.

Approved. Good hunting.
