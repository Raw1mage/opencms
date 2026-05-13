# Tasks: provider_apply-patch-metadata-strip

## M1 — Narrow apply_patch return shape

- [x] M1-1 Drop `before: string` and `after: string` properties from `ApplyPatchFileMetadata` interface at `packages/opencode/src/tool/apply_patch.ts:27-37`.
- [x] M1-2 In the per-file metadata construction at `packages/opencode/src/tool/apply_patch.ts:406-415`, stop assigning `before` and `after`. Keep `oldContent`/`newContent` local variables only long enough to feed `computeDiff()`, then discard.
- [x] M1-3 Verify `bun run typecheck` (or repo equivalent) is green for the tool package after the type change.
- [x] M1-4 Confirm no other source file references `ApplyPatchFileMetadata.before` / `.after`: `git grep -nE "files\\[[0-9]*\\]?\\.(before|after)" packages/opencode/src/`. Expect zero hits outside the test fixture (M3).

## M2 — Migrate UI consumers to hunk-format diff

- [x] M2-1 Multi-file viewer at `packages/ui/src/components/message-part.tsx:1769-1770`: replace `before={{ name: file.filePath, contents: file.before }}` / `after={{ name: file.filePath, contents: file.after }}` with hunk-format feed (e.g. pass `file.diff` to the diff component the same way `edit`/`write` already do — match their call shape exactly).
- [x] M2-2 Single-file detail at `packages/ui/src/components/message-part.tsx:1808-1809`: same migration as M2-1, using `file().diff` (Solid signal accessor).
- [x] M2-3 Remove dead code at `packages/ui/src/components/message-part.tsx:1625` (`props.metadata?.filediff?.before`) and `:1629` (`...after`). The fallback to `props.input.oldString` / `props.input.newString` is the live path; the dead lines just clutter.
- [x] M2-4 Confirm the UI component file has zero remaining `\.before` / `\.after` field accesses in the apply_patch + edit render blocks: `git grep -nE "\\.(before|after)\\b" packages/ui/src/components/message-part.tsx`. Manually inspect any remaining hits — likely none, or only within strings/comments.
- [x] M2-5 `bun run typecheck` (or repo equivalent) green for the ui package.

## M3 — Update dreaming pruning test fixture

- [x] M3-1 At `packages/opencode/src/session/storage/dreaming.test.ts:309`, the existing assertion expects `before` to contain `"dream-pruned: dropped 300,000 bytes of file before snapshot"`. This stays VALID as long as the fixture INPUT still constructs a part with `before`/`after` populated (testing the pruner's legacy-shape support). Ensure the fixture-construction code explicitly sets `before` and `after` on the fake apply_patch part, even though new real apply_patch invocations no longer emit them. Add a one-line comment: `// legacy-shape fixture — new apply_patch payloads omit before/after; pruner still strips them when present in old sessions.`
- [x] M3-2 Run `bun test packages/opencode/src/session/storage/dreaming.test.ts` and confirm pass.

## M4 — Live verification

Per user direction on 2026-05-12 ("我的系統現在沒有肉眼看diff的需求"), live UI inspection (M4-3, M4-4) and live payload-size measurement (M4-1, M4-2) are deferred. Coverage is satisfied by static checks instead — see AC table in spec.md and the verification event log.

- [x] M4-1 ~~Start the daemon...~~ — DEFERRED per user opt-out.
- [x] M4-2 ~~Inspect the persisted SQLite row...~~ — DEFERRED. Verified analytically: post-change per-file metadata is `{filePath, relativePath, type, diff, additions, deletions, movePath?}`. Diff is hunk-only and bounded by `ToolBudget`. Total well under 20 KB regardless of source file size.
- [x] M4-3 ~~Inspect the rendered diff in the web UI...~~ — DEFERRED. Verified structurally: `Diff` wrapper's `rawDiff` branch calls `processFile()` and feeds `instance.render({ fileDiff })` — same `FileDiff` class used today, just different input path. Typecheck green; @pierre/diffs native API used as documented.
- [x] M4-4 ~~Open a pre-existing session DB...~~ — DEFERRED. Backwards compat verified by code reading: `Diff` wrapper's `parsedDiff()` createMemo returns undefined when `rawDiff` is absent → falls through to the existing oldFile/newFile path → legacy sessions render exactly as before.
- [x] M4-5 Record verification evidence as an event log (static-check based, since live verification was opted out).

## M5 — Plan-doc finalization

- [x] M5-1 Tick all AC-1..AC-8 in `spec.md`.
- [x] M5-2 `spec_record_event` with summary `"apply_patch metadata strip verified"` and the M4 evidence summary in body.
- [x] M5-3 `plan_advance` to `verified`.

> **Graduation gate (not a task)**: `verified → living` transition (`plan_graduate`) is user-only per AGENTS.md zone contract. AI MUST NOT call `plan_graduate` itself; wait for explicit user trigger.
