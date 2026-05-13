---
date: 2026-05-12
summary: "apply_patch metadata strip verified via static checks (visual deferred per user)"
---

# apply_patch metadata strip verified via static checks (visual deferred per user)

Implementation landed on beta worktree branch `beta/apply-patch-metadata-strip`, commit `1848d989a` ("feat(apply_patch): strip before/after metadata, render via pierre patch path"). M1+M2+M3 executed; M4 live verification opted out by user ("我的系統現在沒有肉眼看diff的需求").

## What changed

- `packages/opencode/src/tool/apply_patch.ts` — `ApplyPatchFileMetadata` no longer carries `before` / `after`; per-file metadata construction stops assigning them.
- `packages/ui/src/pierre/index.ts` — `DiffProps` adds optional `rawDiff: string` + `filename: string`; `before`/`after` made optional.
- `packages/ui/src/components/diff.tsx` — when `rawDiff` is provided, parses via `processFile()` and feeds `instance.render({ fileDiff })`; falls through to existing oldFile/newFile path otherwise.
- `packages/ui/src/components/diff-ssr.tsx` — same dual-path treatment for `hydrate()`.
- `packages/ui/src/components/message-part.tsx` — apply_patch render sites switch to `rawDiff={file.diff} filename={...}`; dead `filediff?.before`/`.after` code paths in edit-tool block removed.
- `packages/opencode/src/session/storage/dreaming.test.ts` — clarifying comment added explaining the fixture is intentional legacy-shape coverage for pruner backwards-compat.

## Verification matrix

| AC | Method | Result |
|----|--------|--------|
| AC-1 | grep `^\s*(before\|after): string` in apply_patch.ts | PASS — zero matches |
| AC-2 | analytical bound on per-file metadata size | PASS — well under 20 KB |
| AC-3 | grep `.before`/`.after` in apply_patch + edit render blocks | PASS — zero matches |
| AC-4 | visual: new-session UI render | DEFERRED per user opt-out |
| AC-5 | visual: legacy-session UI render | DEFERRED per user opt-out |
| AC-6 | `bun test dreaming.test.ts` | PASS — 8/8, 34 expect() calls |
| AC-7 | grep `state.metadata` in message-v2.ts | PASS — zero matches (invariant preserved) |
| AC-8 | repo-wide grep for `metadata.files[].before/.after` | PASS — only the intentional dreaming.test.ts fixture |

## Typecheck

- `packages/ui` — clean
- `packages/app` — clean
- `packages/opencode` — clean for affected files (pre-existing errors in unrelated `theme.tsx` and `compaction.ts` ignored)
- `packages/enterprise` — share-page typecheck errors on `[shareID].tsx:112-123` predate this branch (mobile-session-restructure cleanup debt from 2026-04-23); not in scope.

## Followups recorded in design.md

- FU-1 (apply_patch FileTime guard) — REJECTED after analysis: apply_patch's unified-diff input format carries context lines that self-validate against on-disk drift; the codex parser rejects context-mismatched patches, so `FileTime.assert` would be redundant guardrail. Memorialized in design.md to prevent future re-derivation.
- FU-2 (historical session metadata vacuum CLI) — DEFERRED per DD-4 ("avoid risky one-shot disk rewrite for now"). If picked up, fork `cli/cmd/maintenance/migrate-strip-diffs.ts` walker targeting `parts.payload_json` rows with `apply_patch` tool, stripping `state.metadata.files[].before/.after`.

## Sibling plan opened during this work

- `meta_session-knowledge-distillation` at state=proposed — stub for the broader vision of auto-extracting essence knowledge from session transcripts into specbase wiki / KB. Independent of apply_patch; recorded to prevent the idea from being lost.

## Deferred work

If visual verification is ever required, run:
1. Start beta daemon: `OPENCODE_DATA_HOME=/tmp/opencode-beta-verify cd /home/pkcs12/projects/opencode-beta && bun packages/opencode/src/index.ts`
2. Open web UI, new session, invoke apply_patch on a tracked file (preferably ≥100 KB).
3. `sqlite3 /tmp/opencode-beta-verify/storage/session/<new-sid>.db "SELECT LENGTH(payload_json) FROM parts WHERE json_extract(payload_json,'$.tool')='apply_patch';"` — expect < 20 KB.
4. Visually confirm hunks render with +/- markers.
5. Open an existing session (e.g. `ses_1e738d1c8ffeen3y8zPoXjsQ02`) and confirm legacy before/after parts still render without warning.

