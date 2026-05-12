# Proposal: provider_apply-patch-metadata-strip

## Why

- `apply_patch` tool stores **full file content twice** (`metadata.files[].before` + `metadata.files[].after`) for every patch. In a single heavy-coding session against `drawmiat/webapp/grafcet_renderer.py` (~388KB file), 110 patches accumulated **43 MB** of duplicate file bodies on disk — 99.3% of the apply_patch storage footprint.
- Measured on session `ses_1e738d1c8ffeen3y8zPoXjsQ02` (2026-05-12): single patch payload = 818 KB, of which `before` 387.5 KB + `after` 389 KB. Actual `state.input` (the diff itself) was only 7 KB; `state.output` was 78 bytes.
- These fields are confirmed NOT serialized into the LLM prompt — they live in `state.metadata`, and `message-v2.ts:1062-1069` `toModelMessages` only emits `state.output` + `state.attachments`. The waste is **pure on-disk inflation** (session DB size, load latency, NAS backup volume).
- Precedent exists: `write.ts` and `edit.ts` underwent the **identical removal** in commit `mobile-session-restructure` (2026-04-23). See [packages/opencode/src/snapshot/index.ts:191-196](packages/opencode/src/snapshot/index.ts#L191-L196): *"before/after removed. The git snapshot repo is the authoritative source of file content history; duplicating bodies here was pure waste (~90% of session storage)."* `apply_patch` was skipped at the time and never followed up.
- The system itself already treats these fields as waste: `dreaming.ts:223-233` `pruneToolMetadata()` actively strips them with a `[dream-pruned: dropped N bytes of file before snapshot]` stub during dream-pruning passes. We are completing what dreaming.ts already does opportunistically.

## Original Requirement Wording (Baseline)

- "事實證明rotation的時候，runloop就會停下來..." → digression into quota burn investigation
- "30分鐘以內可以耗光5H用量" → quota waste investigation
- "Fix B我覺得還有用一點" → user selected disk-savings track over read-dedup
- "請確認一下掃一下全域。確認可行再建plan" → feasibility-confirmed, build plan

## Requirement Revision History

- 2026-05-12: initial draft created via plan-init.ts
- 2026-05-12: scoped to apply_patch only (write/edit already done); UI consumers identified and replacement path chosen

## Effective Requirement Description

1. Remove `before` and `after` fields from `apply_patch` `state.metadata.files[]` at the tool return site.
2. Update the three UI consumers in `packages/ui/src/components/message-part.tsx` to render diffs from the existing `diff` (hunk format) field, falling back to git snapshot reconstruction when full bodies are needed.
3. Update the one test fixture in `packages/opencode/src/session/storage/dreaming.test.ts` to reflect the new shape.
4. Clean up dead UI code at `message-part.tsx:1625,1629` that already references non-existent `edit.ts` `filediff.before/after` (residue from prior write/edit migration).
5. Migration is **lazy**: existing session DBs keep their fat metadata untouched; UI must gracefully degrade when `before`/`after` are absent. No mandatory vacuum.

## Scope

### IN
- `packages/opencode/src/tool/apply_patch.ts` — drop `before` / `after` from `ApplyPatchFileMetadata` type and from the return value.
- `packages/ui/src/components/message-part.tsx` — three consumer sites (lines 1769-1770, 1808-1809) replaced with hunk-based diff renderer; dead code at 1625, 1629 removed.
- `packages/opencode/src/session/storage/dreaming.test.ts:309` — fixture updated.
- Verification: replay an existing session in UI to confirm diff display still works for legacy patches that still carry before/after, AND for new patches that don't.

### OUT
- **No retroactive vacuum** of existing session DBs. They stay as-is.
- **No change to LLM prompt construction.** This change is invisible to model context.
- **No change to write.ts / edit.ts.** Already done in 2026-04-23.
- **No change to snapshot system.** It remains the authoritative source.
- **Not in scope: read-tool dedup.** Earlier proposal (Fix A) rejected — the model has no memory and would need re-reads anyway.

## Non-Goals

- Token-burn reduction. The 30-min/5H quota burn is a separate problem (per-turn gross context ~170k × N turns); this plan only addresses on-disk waste.
- Vacuum CLI for historical sessions. Could be a follow-up but explicitly deferred to keep this hotfix-scoped.
- Diff-rendering library swap. Keep `useDiffComponent()` API; only change the data feeding it.

## Constraints

- UI must remain functional for **old sessions** whose stored metadata still includes `before`/`after`. The consumers must gracefully use them when present and fall back when absent.
- Test suite must pass without modification of unrelated tests.
- Snapshot system must continue to be the canonical source of file-content history (no regression of `Snapshot.restore` / `Snapshot.diff`).

## What Changes

- `ApplyPatchFileMetadata` type narrows from `{filePath, relativePath, type, diff, before, after, additions, deletions}` to `{filePath, relativePath, type, diff, additions, deletions}` (+ optional `movePath` if used).
- New apply_patch invocations write smaller metadata: a 388KB file's patch goes from ~818 KB → ~14 KB (~58× reduction).
- UI diff viewer accepts hunk-only input; for sessions that need full-content side-by-side rendering, fall back to `git show <snapshot-hash>:<path>` (already available via `Snapshot.diff()`).

## Capabilities

### New Capabilities
- *None.* This is removal of redundancy.

### Modified Capabilities
- `apply_patch` tool: smaller `state.metadata` payload; semantic of `state.output` and `state.input` unchanged.
- UI diff rendering for apply_patch: now driven by `diff` hunks (matching how `edit` and `write` already render), with snapshot fallback for full-content views.

## Impact

- **Token cost**: zero. Not in LLM prompt.
- **Disk size**: typical session DB drops ~80-90% in apply_patch-heavy workflows (matching prior write/edit migration's ~90% claim).
- **NAS rsync**: proportional reduction in daily backup volume.
- **Session load latency**: smaller payload_json blobs → faster SQLite reads, faster restore.
- **Risk surface**: UI rendering path — needs visual verification on both old (with before/after) and new (without) sessions before merging.
- **Code anchors**:
  - [packages/opencode/src/tool/apply_patch.ts:406-415](packages/opencode/src/tool/apply_patch.ts#L406-L415) — return statement
  - [packages/opencode/src/tool/apply_patch.ts:27-37](packages/opencode/src/tool/apply_patch.ts#L27-L37) — type definition
  - [packages/ui/src/components/message-part.tsx:1769-1770](packages/ui/src/components/message-part.tsx#L1769-L1770) — multi-file diff viewer
  - [packages/ui/src/components/message-part.tsx:1808-1809](packages/ui/src/components/message-part.tsx#L1808-L1809) — single-file detail
  - [packages/ui/src/components/message-part.tsx:1625,1629](packages/ui/src/components/message-part.tsx#L1625) — dead code from edit-tool migration
  - [packages/opencode/src/session/storage/dreaming.test.ts:309](packages/opencode/src/session/storage/dreaming.test.ts#L309) — fixture
  - [packages/opencode/src/snapshot/index.ts:191-196](packages/opencode/src/snapshot/index.ts#L191-L196) — precedent comment
  - [packages/opencode/src/session/storage/dreaming.ts:223-233](packages/opencode/src/session/storage/dreaming.ts#L223-L233) — existing pruning logic
