# Dynamic Context Preface

This document explains the user-role context preface introduced by **Phase B of `specs/prompt-cache-and-compaction-hardening`** (commits `1c7194055..21a08ad2e`, landed 2026-05-04). For the higher-level prompt structure see [prompt_injection.md](./prompt_injection.md).

---

## 1. Why the preface exists

Pre-Phase-B, all dynamic content (preload, today's date, enablement matched routing, skill registry) lived inside the `system` role alongside truly static layers (Driver, AGENTS.md, SYSTEM.md, etc). Any dynamic change invalidated the entire system prefix cache. The diagnostic in `cache-miss-diagnostic.ts` confirmed this churn dominated the cache miss profile.

Phase B physically separates the two responsibilities:

- **`system` role** — only carries the seven layers that are byte-stable within a session (L1, L2, L3c, L5, L6, L7, L8). One message, one cache breakpoint at its end (BP1).
- **User-role context preface** — a single user message tagged `kind="context-preface"` (per `MessageV2.User.kind`) inserted before the user's typed text. Carries the dynamic content, ranked **slow-first** so the cache prefix can still be partially shared even when the trailing portion changes.

Authority chain (SYSTEM.md > AGENTS.md > Driver > Skills) is preserved. Skills moved physically from system role to user role but their precedence relative to SYSTEM.md / AGENTS.md is unchanged because the LLM still reads system role first.

---

## 2. Tier ranking (slow-first)

| Tier | Content | Variation rate | Breakpoint |
|------|---------|----------------|------------|
| **T1 session-stable** | `## CONTEXT PREFACE` directive · README summary · cwd listing · pinned skills · today's date | Mostly stable within a single session | BP2 (after date) |
| **T2 decay-tier** | active skills · summarized skills | Tens of minutes (skill idle decay) | BP3 (after summarized) |
| **trailing per-turn** | enablement matched routing · lazy catalog hint · structured-output directive · subagent return notices · quota-low addenda | Every turn | none — rides BP4 via the user message |

The directive header is the **R1 mitigation**: `## CONTEXT PREFACE — read but do not echo` opens T1 so the LLM treats the user-role message as instruction-bearing context rather than chitchat. This is baked into the design (no A/B test gate) per Phase B v2 recalibration on 2026-05-04.

`Today's date` is positioned at the **end of T1** so cross-day cache invalidation only affects T2 onwards (per design.md DD-2). BP2 sits right after the date.

---

## 3. Producers

The preface is assembled per turn from already-resolved structured inputs:

| Source | Output |
|--------|--------|
| `getPreloadParts(sessionID)` in `session/preloaded-context.ts` | `{ readmeSummary, cwdListing }` |
| `SystemPrompt.environmentParts(model, sessionID, parentID)` in `session/system.ts` | `{ baseEnv, todaysDate }` (only `todaysDate` enters the preface; `baseEnv` rides L3c AGENTS for static system) |
| `SkillLayerRegistry.partitionForPreface(entries)` in `session/skill-layer-registry.ts` | `{ pinned, active, summarized, dropped }` |
| Plugin hook `experimental.chat.context.transform` | mutates the above before serialization |

Producers run inside `LLM.stream` for non-lite providers. Lite provider (per design.md DD-14) keeps the original single concise system prompt — no preface, no static-block decomposition.

---

## 4. The builder

`buildPreface(input)` in `session/context-preface.ts` is a pure function:

```ts
buildPreface({
  preload: { readmeSummary, cwdListing },
  skills: { pinned, active, summarized },
  todaysDate: "Sun May 04 2026",
  trailingExtras: ["lazy catalog hint", "..."],
}) => {
  parts: ContextPrefaceParts,
  contentBlocks: PrefaceContentBlock[],   // tier-tagged
  kind: "context-preface",
  t2Empty: boolean,
}
```

Same input bytes → byte-equal output. T2 is omitted entirely when both active and summarized skills are empty (drives BP3 omission per DD-3 — no relocation, just save the budget for later).

---

## 5. Cache breakpoint allocation

`ProviderTransform.applyCaching` in `provider/transform.ts` honors **two** sources of breakpoint requests:

1. **Explicit Phase B markers** — the llm.ts assembler tags T1-end and T2-end content blocks with `providerOptions._phaseBBreakpoint = true`. applyCaching marks them with `cache_control` and skips the legacy "last block of message" rule on those messages to avoid double-counting.

2. **Legacy rule** — first 2 system messages + last 2 non-system messages get `cache_control` on their last content block.

Total breakpoints in typical Phase B layout:

- **Full preface** (T1+T2+trailing): BP1 system end + BP2 t1 end + BP3 t2 end + BP4 user end = 4
- **No T2** (no active/summary skills): BP1 + BP2 + BP4 = 3 (BP3 omitted)
- **Lite provider**: BP1 + BP4 = 2 (preserved original behavior)

Anthropic's 4-BP-per-request limit is the hard ceiling.

---

## 6. Plugin contract migration

| Hook | Phase A behavior | Phase B behavior |
|------|------------------|------------------|
| `experimental.chat.system.transform` | Receives the merged 9-layer system array | **Static block only** (L1+L2+L3c+L5+L6+L7+L8). Plugins that injected dynamic content here will continue to work but should migrate. |
| `experimental.chat.context.transform` | n/a (new in Phase B) | **NEW** — receives `{ preface: { t1, t2 }, trailingExtras }` and can mutate any field before `buildPreface` serializes. |

A future release will add a deprecation warning when `experimental.chat.system.transform` mutates non-static content. Plugins that need dynamic injection should use the new `chat.context.transform` hook.

---

## 7. Compaction interplay

The compaction anchor message (per Phase A `anchor-sanitizer.ts`) lives in conversation history, NOT in the preface. The preface is rebuilt fresh per turn from live state; the anchor is the durable record of compacted history.

Phase B added one connection: the anchor's `compaction` part now persists `metadata.skillSnapshot { active, summarized, pinned }` and `metadata.pinnedByAnchor` so a future replay can reconstruct the L9 state at compaction time. See `MessageV2.CompactionPart` and `compaction.ts annotateAnchorWithSkillState`.

---

## 8. Telemetry

| Event | Source | Payload |
|-------|--------|---------|
| `prompt.preface.assembled` | `llm.ts` | `{ sessionID, staticBlockChars, staticBlockHash[0..12], t1Chars, t2Chars, trailingChars, t2Empty, breakpointPlan }` per turn |
| `compaction.cache_miss_diagnosis` | `cache-miss-diagnostic.ts` | (Phase A) Now feeds `staticBlock.hash` instead of `system.join("\n")` for sharper churn detection |
| `compaction.anchor.skill_snapshot` | `compaction.ts annotateAnchorWithSkillState` | (Phase A) Backup signal alongside the disk-persisted metadata |

Cache hit/miss events from provider response headers (`prompt.cache.{system,preface.t1,preface.t2}.{hit,miss}`) are deferred to a follow-up; for now `cachedInputTokens` in `Session.getUsage` provides the coarser signal.

---

## 9. File map

| Concern | File |
|---------|------|
| Schema (`MessageV2.User.kind`, `CompactionPart.metadata`) | `packages/opencode/src/session/message-v2.ts` |
| Pure types (`ContextPrefaceParts`, `PreloadParts`, directive header constant) | `packages/opencode/src/session/context-preface-types.ts` |
| Preload producer | `packages/opencode/src/session/preloaded-context.ts` |
| Environment date split | `packages/opencode/src/session/system.ts environmentParts` |
| Preface builder | `packages/opencode/src/session/context-preface.ts` |
| Static system block + family resolver | `packages/opencode/src/session/static-system-builder.ts` |
| Skill partition for preface | `packages/opencode/src/session/skill-layer-registry.ts partitionForPreface` |
| Cache breakpoint allocator | `packages/opencode/src/provider/transform.ts applyCaching` |
| Plugin hook type | `packages/plugin/src/index.ts experimental.chat.context.transform` |
| Assembly orchestration | `packages/opencode/src/session/llm.ts` (the non-lite branch of LLM.stream) |
| Spec package | `specs/prompt-cache-and-compaction-hardening/` |
