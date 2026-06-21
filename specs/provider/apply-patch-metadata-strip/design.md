# Design: provider_apply-patch-metadata-strip

## Context

`apply_patch` tool currently emits a `state.metadata` payload containing full file bodies before and after each patch (`metadata.files[].before` + `metadata.files[].after`). For a single heavy-coding session against a 388 KB file (`drawmiat/webapp/grafcet_renderer.py`), 110 patches accumulated **43 MB** of duplicate bodies on disk — 99.3% of `apply_patch` storage footprint. The fields are confirmed NOT in the LLM prompt (`message-v2.ts:1062-1069` `toModelMessages` emits only `state.output` + `state.attachments`); they're consumed only by 2 UI sites + 1 test fixture.

Sibling tools `write` and `edit` underwent the identical removal on 2026-04-23 (`mobile-session-restructure`, see [snapshot/index.ts:191-196](packages/opencode/src/snapshot/index.ts#L191-L196)). `apply_patch` was skipped at the time. `dreaming.ts:223-233` already strips these fields opportunistically with a `[dream-pruned: ...]` stub — the system internally classifies them as waste.

## Goals / Non-Goals

**Goals:**

- Eliminate ~58× per-patch disk waste for new `apply_patch` invocations.
- Align `apply_patch` shape with `write` / `edit` (already hunk-only).
- Remove dead UI code referencing `edit`-tool fields that have not existed since 2026-04-23.

**Non-Goals:**

- No retroactive vacuum of existing session DBs (DD-4).
- No change to LLM context construction — this is invisible to the model.
- No token-burn fix; that's a separate concern (gross context ~170k/turn × N turns is a different problem).
- No swap of the diff-rendering library; only the data wiring changes.
- No retry / undo / new file-content recovery mechanism — snapshot system already covers that (DD-5).

## Decisions

- **DD-1**: Drop `before` and `after` from new `apply_patch` metadata. Do NOT strip from existing session DBs. Why: lazy migration is naturally idempotent — UI must accept absent fields for new patches, and old patches continue to carry them harmlessly. Avoids any risky one-shot disk rewrite.
- **DD-2**: UI fallback is **hunk-format diff renderer**, not on-demand `git show` reconstruction. Why: hunk is already present in `metadata.diff` / `files[].diff`; matches how `edit`/`write` are already rendered. `git show` couples UI to a live git working copy and breaks for archived sessions.
- **DD-3**: Dead code at `message-part.tsx:1625, 1629` (edit-tool `filediff.before/after`, unpopulated since 2026-04-23) is removed in this same change. Why: it's residue from the prior migration; consolidating prevents two separate cleanups for the same shift.
- **DD-4**: No retroactive vacuum CLI in this plan. Why: session DBs are largely append-only; rewriting risks corruption. Existing sessions consume disk but no longer accumulate new bloat after this change. Vacuum can be a separate plan if requested.
- **DD-5**: Snapshot system (`packages/opencode/src/snapshot/`) remains the canonical source for any future "full before/after" need. Why: git-backed, content-addressed, already used by `Snapshot.restore` / `Snapshot.diff`. The `apply_patch` metadata fields were redundant to it from day one — see precedent comment.

## Risks / Trade-offs

- **UI diff visually degrades vs. side-by-side**: Mitigation: hunk renderer is the same one `edit`/`write` already use; user is already accustomed to it for those tools. Visual verification on real session pre-merge.
- **Old session UI rendering**: Old sessions still carry `before`/`after`. UI must tolerate their presence (no crash on extra fields) and absence (graceful fallback). Mitigation: read `file.diff` unconditionally; treat `before`/`after` as optional.
- **External consumers**: Repo-wide scan found 3 consumers + dead code, all internal. No plugin or external API surface exposes this metadata. Low residual risk.
- **Trade-off accepted**: legacy session DBs keep ~43 MB of bloat indefinitely. Acceptable per DD-4. NAS backup volume reduction is for go-forward sessions only.

## Critical Files

- [packages/opencode/src/tool/apply_patch.ts:27-37](packages/opencode/src/tool/apply_patch.ts#L27-L37) — `ApplyPatchFileMetadata` type narrows.
- [packages/opencode/src/tool/apply_patch.ts:406-415](packages/opencode/src/tool/apply_patch.ts#L406-L415) — return-value construction drops `before`/`after` assignment.
- [packages/ui/src/components/message-part.tsx:1625, 1629](packages/ui/src/components/message-part.tsx#L1625) — dead code from edit migration removed.
- [packages/ui/src/components/message-part.tsx:1769-1770](packages/ui/src/components/message-part.tsx#L1769-L1770) — multi-file diff viewer switches to hunk-format input.
- [packages/ui/src/components/message-part.tsx:1808-1809](packages/ui/src/components/message-part.tsx#L1808-L1809) — single-file detail switches to hunk-format input.
- [packages/opencode/src/session/storage/dreaming.test.ts:309](packages/opencode/src/session/storage/dreaming.test.ts#L309) — fixture asserts no longer applicable to new payloads; update or relax.
- [packages/opencode/src/snapshot/index.ts:191-196](packages/opencode/src/snapshot/index.ts#L191-L196) — precedent comment, unchanged.
- [packages/opencode/src/session/storage/dreaming.ts:223-233](packages/opencode/src/session/storage/dreaming.ts#L223-L233) — `pruneToolMetadata()` becomes near-no-op for new sessions; no code change required.
- [packages/opencode/src/session/message-v2.ts:1062-1069](packages/opencode/src/session/message-v2.ts#L1062-L1069) — proof point that metadata never reaches LLM (no change).

## Follow-ups (out of scope, recorded for traceability)

These are real gaps surfaced during scoping. They are NOT solved by this plan, but should not be lost.

### FU-1: ~~apply_patch FileTime guard~~ — REJECTED (not a real gap)

Initial scoping considered adding `FileTime.assert(sessionID, filepath)` to `apply_patch` to mirror what `edit` / `write` enforce ([file/time.ts:74-78](packages/opencode/src/file/time.ts#L74-L78)). Rejected after re-analysis:

`apply_patch` takes a unified-diff input whose `@@` hunks carry **context lines** that describe the expected surrounding state of the file. If the file has drifted on disk since the model formed its mental model, the codex apply_patch parser rejects the patch with a context-mismatch error — the protocol is self-validating.

`edit` / `write` need `FileTime` because their inputs (raw string-replace target / full overwrite) carry no context anchor. `apply_patch`'s input format already solves the same problem at the protocol layer. Adding `FileTime.assert` on top would be redundant guardrail and would conflate two independent sync mechanisms.

Recorded here so future agents don't re-derive the same false analogy and re-propose this.

### FU-2: No vacuum for historical `apply_patch` metadata

The 2026-04-23 mobile-session-restructure migration shipped a one-shot vacuum CLI at [packages/opencode/src/cli/cmd/maintenance/migrate-strip-diffs.ts](packages/opencode/src/cli/cmd/maintenance/migrate-strip-diffs.ts) that walks `~/.local/share/opencode/storage/session/` and strips `before`/`after` from each `user message`'s `summary.diffs[]`.

That CLI targets a different field (`summary.diffs[]` on user messages, used by mobile session restructure) — it does NOT touch our `state.metadata.files[]` on assistant tool parts. So existing sessions keep their apply_patch bloat.

If retroactive cleanup becomes desirable (e.g. NAS backup volume concern, session DB growth concern), fork the migrate-strip-diffs walker:

- Target: `parts.payload_json` rows where `type='tool'` AND `json_extract($.tool)='apply_patch'`
- Mutation: delete `state.metadata.files[].before` and `state.metadata.files[].after`
- Atomicity: per-session marker file like `.apply-patch-strip-v1.done`; backup precondition; temp+rename per row.

Not in scope here per DD-4 (avoid risky one-shot disk rewrite for now).

## Architecture

```
apply_patch.execute()                                  packages/opencode/src/tool/apply_patch.ts
  ├─ run codex apply_patch parser                       input.input → file mutations
  ├─ for each touched file:
  │    ├─ oldContent  := read disk
  │    ├─ newContent  := write disk + git snapshot
  │    ├─ fileDiff    := computeDiff(oldContent, newContent)   ← unchanged
  │    └─ fileMeta    := { filePath, relativePath, type,
  │                        diff: fileDiff,
  │                        additions, deletions, movePath? }    ← NO before/after
  ├─ aggregate metadata := { phase, files, diff: totalDiff, diagnostics }
  └─ return { output, title, metadata }

UI rendering                                            packages/ui/src/components/message-part.tsx
  ├─ multi-file viewer (L1769-1770):
  │    feed file.diff (hunk) into <Dynamic component={diffComponent} ... />
  │    where component already accepts hunk input via existing edit/write path
  ├─ single-file detail (L1808-1809): same migration
  └─ legacy fallback: if file.before/file.after present (old session), accept them;
     otherwise pure hunk rendering.

Dream-pruning                                           packages/opencode/src/session/storage/dreaming.ts
  └─ pruneToolMetadata() unchanged. For new sessions it has nothing to prune
     (no before/after fields). For old sessions it continues to strip them.
```

> **[SUPERSEDED 2026-06-20 — `dreaming-legacy-teardown`]** `dreaming.ts` (and
> with it `pruneToolMetadata()`) was deleted when the DreamingWorker + legacy
> dual-track storage was fully removed. The pruner was only ever hot during
> legacy→SQLite migration, which is complete (0 legacy dirs on the reference
> install). New `apply_patch` payloads already omit `before`/`after`, so there
> is nothing left to prune. The pruner-backwards-compat test fixture in
> `dreaming.test.ts` was removed with the file. This does not affect the
> apply-patch-metadata-strip change itself (write-path narrowing is independent
> and remains live).
