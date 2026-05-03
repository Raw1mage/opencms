# Tasks: attachment-lifecycle

> Execution surface: `/home/pkcs12/projects/opencode-worktrees/attachment-lifecycle` on branch `beta/attachment-lifecycle`.
> Spec writes (this file, design.md, etc.): mainRepo at `/home/pkcs12/projects/opencode`.
> Always `source .beta-env/activate.sh` before any `bun test` / `bun run` in beta worktree.

User-framed as a "small hotfix" — 3 implementation phases, no feature flag, direct-ship architecture.

> **Recalibration v2 (2026-05-04)**: discovered `repo-incoming-attachments` (state=`implementing`) already owns the binary lifecycle (per-project `<worktree>/incoming/<filename>` + `attachment_ref.repo_path` + sha256 dedup). attachment-lifecycle scope reduces to: schema delta (2 fields) + post-completion hook + reread tool. **No IncomingStore, no GC** — the binary lives in the repo and is user-managed. Per design.md DD-2' / DD-4' / DD-15 / DD-16.

## 0. Prerequisites

- [x] T.0.1 Create beta worktree (done 2026-05-04):
  ```
  git worktree add -b beta/attachment-lifecycle \
    /home/pkcs12/projects/opencode-worktrees/attachment-lifecycle main
  ```
- [x] T.0.2 Bootstrap `.beta-env/activate.sh` (XDG isolation pointed at the new worktree path); `theme/opencode.json` copied; `bun install` ran clean.
- [x] T.0.3 Baseline test sweep on `packages/opencode/src/session/` — 52 Phase A/B tests pass (matches main).
- [x] T.0.4 (NEW) Read [`specs/repo-incoming-attachments/`](../repo-incoming-attachments/) — confirm `attachment_ref.repo_path` is populated by `routeOversizedAttachment` for all NEW image uploads. Skip dehydration when `repo_path` is undefined (DD-15).

## 1. Phase T.1 — Foundation: schema + AnnotationExtractor

- [ ] T.1.1 Extend `MessageV2.AttachmentRefPart` schema with **two** new optional fields (DD-16):
  - `dehydrated?: z.boolean()`
  - `annotation?: z.string().max(4000)`
  - (already-existing `repo_path?` and `sha256?` from repo-incoming spec — reused, no change.)
  - Roundtrip test: old part with no fields parses; new part with `dehydrated=true` + annotation parses; annotation > 4000 chars rejects.

- ~~T.1.2 IncomingStore filesystem wrapper~~ **(removed by v2 recalibration — `<worktree>/incoming/` already owned by `repo-incoming-attachments`; reread tool reads via existing `tool/attachment.ts` pattern using `repo_path`)**

- [ ] T.1.2 (renumbered) New helper in `packages/opencode/src/session/processor.ts` (or extracted to `attachment-annotator.ts`):
  - `extractAnnotation(responseText: string): string` — trim + 4000 char cap + head/tail truncation marker (DD-12).
  - 6 unit tests: under cap / at cap / over cap (head+tail) / empty / whitespace-only / multi-line preservation.

- [ ] T.1.3 (renumbered) Tweaks knobs in `packages/opencode/src/config/tweaks.ts`:
  - `attachment_dehydrate_enabled: boolean` (default true)
  - `attachment_annotation_max_chars: number` (default 4000)
  - ~~`attachment_incoming_ttl_days`~~ (removed — no GC under DD-4')

## 2. Phase T.2 — Behavior: DehydrationHook + WireFormatTransformer

- [ ] T.2.1 Wire post-completion hook in `processor.ts`:
  - After assistant message reaches `finish="stop"`, scan parent user message for image `attachment_ref` parts
  - Skip if part already `dehydrated === true` (DD-5)
  - Skip if mime not `image/*` (DD-3 v1 scope)
  - Skip if `finish !== "stop"` (DD-10)
  - **Skip if `repo_path` is undefined** (DD-15 — pre-repo-incoming legacy attachment, no binary location to point reread at)
  - For each remaining: `extractAnnotation` → `Session.updatePart` setting `dehydrated=true` + `annotation` (`repo_path` and `sha256` already populated by repo-incoming, leave them alone) → emit telemetry. **No binary movement; binary already at `<worktree>/<repo_path>`.**

- [ ] T.2.2 Branch wire-format conversion in `MessageV2.toModelMessages` (or equivalent serializer):
  - When `attachment_ref.dehydrated === true`: emit `{type: "text", text: <dehydrated_attachment filename="..." sha256="..." repo_path="...">annotation</dehydrated_attachment>}`
  - When `dehydrated !== true`: existing image content block path (whether legacy sqlite-blob or repo-incoming dual-read) (DD-8)
  - 6 tests cover both branches + idempotency (re-serialize same part → same bytes).

- [ ] T.2.3 Integration test (lightweight): synthesize a session with 1 user message + 1 image attachment (with `repo_path` populated, simulating post-repo-incoming upload) + 1 finished assistant message; run dehydration hook; confirm:
  - attachment_ref part has `dehydrated=true` + annotation populated
  - `repo_path` and `sha256` unchanged
  - file at `<worktree>/<repo_path>` is **untouched** (we don't move it)
  - subsequent toModelMessages emits `<dehydrated_attachment>` text block (not image content block)

## 3. Phase T.3 — RereadAttachmentTool

- [ ] T.3.1 New file `packages/opencode/src/tool/reread-attachment.ts`:
  - Tool name: `reread_attachment`
  - Input schema: `{filename: string}`
  - Body: walk session messages, find a `attachment_ref` with matching filename + `dehydrated=true` + `repo_path` populated; resolve absolute path via `IncomingPaths.projectRoot()` + part.repo_path; read bytes via `fs.readFile`. If found → return `{type: "image", url: data URI, est_tokens, byte_size}`; if file missing → `{error: "attachment_not_found", message: ...}`; if no matching dehydrated part → `{error: "attachment_not_found", message: ...}`.
  - 5 tests: happy (post-dehydration reread) / file deleted from repo / no matching part / multi-attachment match-by-filename / telemetry emit.

- [ ] T.3.2 Register tool in `packages/opencode/src/tool/index.ts` core registry. Description tells model when to use:
  ```
  Re-read a previously dehydrated image attachment. Use when the <dehydrated_attachment> annotation is insufficient and you need to look at the original image content. Filename matches the original attachment filename (visible in the dehydrated_attachment tag).
  ```

- [ ] T.3.3 Integration test: dehydrate (with `repo_path` populated) → call `reread_attachment(filename)` → confirm fresh image content returned, sourced from `<worktree>/<repo_path>`.

~~## 4. Phase T.4 — GarbageCollector + cron~~

**Removed by v2 recalibration 2026-05-04**. Per DD-4', binaries persist in `<worktree>/incoming/<filename>` for the lifetime of the project repo; cleanup is the user's choice via `git clean` / `.gitignore` / manual `rm`. Reread errors with `attachment_not_found` if user has removed the file.

## 5. Phase T.5 — Validation + finalize

- [ ] T.5.1 Full test sweep on beta worktree: `bun test packages/opencode/src/session/ packages/opencode/src/provider/ packages/opencode/src/tool/` — confirm zero new regressions vs main baseline.
- [ ] T.5.2 `bun run typecheck` no new errors (excluding pre-existing share-next.ts noise).
- [ ] T.5.3 Manual smoke: in dev daemon, upload an image, observe response, then send another turn — confirm `attachment.dehydrated` log + token count drops in second turn's input.
- [ ] T.5.4 Manual reread test: in dev session post-dehydration, ask model "look at the previous screenshot again" — observe model calls `reread_attachment` and gets image back.
- [ ] T.5.5 Phase summary `docs/events/event_<YYYYMMDD>_attachment-lifecycle-landed.md` with commit hashes + observed token reduction.
- [ ] T.5.6 Rebase to latest main; merge clean.
- [ ] T.5.7 STOP for user finalize approval.

## 6. Phase T.6 — Finalize + cleanup

- [ ] T.6.1 `git merge --no-ff beta/attachment-lifecycle` into main (in mainRepo).
- [ ] T.6.2 `plan-promote --to verified` then `--to living`.
- [ ] T.6.3 `git worktree remove` + `git branch -d beta/attachment-lifecycle`.
- [ ] T.6.4 Daemon restart (per `feedback_restart_daemon_consent` — pause and ask first).

## Dependencies between phases

- T.0 done — unblocks all
- T.1 (schema + annotator + tweaks) → T.2 (behavior consumes new schema)
- T.2 (dehydration hook + serializer) → T.3 (reread tool depends on dehydrated parts existing)
- ~~T.4 (GC)~~ removed under v2 recalibration
- T.5 (validation) gate after T.1-T.3 all green
- T.6 (finalize) after user approval

## Stop gates

- ~~T.0.1 fail~~ T.0 已完成 2026-05-04
- T.5.7 STOP for user finalize approval
- T.6.4 daemon restart needs explicit user "重啟嗎？" consent
- Any test red → stop, fix, no skip
- Pre-repo-incoming legacy attachment (`repo_path` undefined) detected during T.2.1 hook design — confirm DD-15 skip behavior is correct, no test regression
