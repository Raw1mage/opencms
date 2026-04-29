# Phase 1 — session-storage-db (Foundation: extract LegacyStore)

**Date**: 2026-04-29
**Spec**: `/specs/session-storage-db/`
**State**: planned → implementing (first checkbox triggered the transition; phase 1 now closed)
**Branch**: `beta/session-storage-db` (beta worktree, forked from `main` at `f1c08f3c1`)

## Done

- **1.1** Created `packages/opencode/src/session/storage/` with `index.ts` declaring the `SessionStorage` namespace and `Backend` contract (matches the existing call surface — `stream`, `get`, `parts`, `upsertMessage`, `upsertPart`, `deleteSession`).
- **1.2** Extracted the directory-of-small-files filesystem logic into `storage/legacy.ts` as `LegacyStore`. Behavior preserved verbatim (TOCTOU skip on `Storage.NotFoundError`, reverse-list-order stream iteration, sort-by-id parts ordering). Cross-cutting concerns (Bus events, debounce, runaway guard, usage delta tracking, transport optimization) intentionally **stayed** in `Session.updateMessage` / `Session.updatePart` — this module is a thin facade over the filesystem byte-path so a SQLite sibling can plug in via the same `Backend` contract (DD-9).
- **1.3** Added `storage/legacy.test.ts` — 12 tests, all green. Covers storage-key conventions (`["message", sid, mid]`, `["part", mid, pid]`), TOCTOU skip behavior, parts-sort ordering, reverse-list-order stream, and helper functions (`readMessageInfo` / `removeMessageInfo` / `removePartFile` / `writePartFile`). Tests use `mock.module()` to stub the `Storage` namespace, so no disk IO; safe to run inside the beta worktree without touching real `~/.local/share/opencode/`.
- **1.4** Routed every remaining `Storage.{read,write,list,remove}` call against `["message", ...]` or `["part", ...]` keys through `LegacyStore` or its helpers. Sites updated:
  - `packages/opencode/src/session/message-v2.ts` — top-level `stream` / `parts` / `get` / `updateMessage` / `updatePart` / `remove`
  - `packages/opencode/src/session/index.ts` — `Session.updateMessage` / `removeMessage` / `removePart` / `_flushPartWrite` / `Session.delete` cleanup loop
  - `packages/opencode/src/session/revert.ts` — revert removes
  - `packages/opencode/src/share/share.ts` and `share-next.ts` — shared-render single-part read fallback
  - `packages/opencode/src/cli/cmd/import.ts` — session import

  Verified by grep: zero remaining `Storage.{read,write,list,remove}` calls with `["message", ...]` or `["part", ...]` outside of `storage/legacy.ts` or test files.

## Key Decisions (no new DDs added in this phase)

Phase 1 is a verbatim refactor. No design decisions changed. The pre-existing DD-1..DD-14 in `design.md` still apply unchanged.

## Validation

- `bunx tsc --noEmit` on the affected files: clean (preexisting unrelated errors in `tui/routes/session/index.tsx`, `share-next.ts:27/35/76/...`, and `message-v2.ts:920` exist on the beta branch independently of this change).
- `bun test packages/opencode/src/session/storage/legacy.test.ts` (with `OPENCODE_DATA_HOME=/tmp/opencode-isolation-test` for safety): **12 pass / 0 fail / 14 expects**.

## Drift

- `plan-sync.ts` reports drift in 7 unrelated files (`tool/glob.ts`, `tool/grep.ts`, `tool/read.ts`, `tool/task.ts`, `tool/tool.ts`, `tool/webfetch.ts`, `plugin/src/tool.ts`). All untouched by this phase; warnings reflect beta branch's pre-existing divergence from main and not anything Phase 1 introduced. Documented and dismissed; no `amend` needed.

## Remaining

- **Phase 2** — SQLite store v1 (schema, ConnectionPool, IntegrityChecker, MigrationRunner, SqliteStore CRUD)
- **Phase 3** — Router dual-track dispatcher
- **Phase 4** — Hot path swap: new sessions default to SQLite
- **Phase 5** — Dreaming mode worker
- **Phase 6** — Debug CLI (`opencode session-inspect`)
- **Phase 7** — Observability wiring
- **Phase 8** — Hardening (fault injection + perf benchmark)
- **Phase 9** — Cleanup gates / legacy retirement plan

Next phase rolls over immediately per autorun mode (no user prompt at phase boundary).
