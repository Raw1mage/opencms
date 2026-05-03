# Design: attachment-lifecycle

## Context

[`MessageV2.AttachmentRefPart`](../../packages/opencode/src/session/message-v2.ts) currently keeps the binary inline in conversation history (via `payload_json.url` data URI or filesystem path). Every `LLM.stream` call resends the binary. The session sqlite `attachments` table holds the `(ref_id, content BLOB)` reverse lookup. Real-world cost: 188K image tokens accumulated over 9 turns in `ses_211c853fcfferC149YUFem6mN4`.

Phase B (`prompt-cache-and-compaction-hardening`) hardened the cache prefix architecture but leaves attachment lifecycle untouched — attachments live in the conversation tail (BP4 zone) where every change invalidates the per-turn cache anyway, so cache mechanism alone can't solve this.

This spec adds a "dehydrate after read, retain on disk" lifecycle: assistant turn completes → image attachments collapse to text annotation in conversation history → binary moves to filesystem incoming staging → model can `reread_attachment` if needed → GC after TTL.

## Goals / Non-Goals

- ≥ 90% image token reduction after first read (per session, dedupe across turns)
- Re-read latency < 100ms (filesystem read is local)
- Zero schema migration required (all schema additions optional)
- Backwards compatible: old sessions with hydrated attachments continue to work
- v1 scope strictly images; PDF / text deferred

### Non-Goals

- See [spec.md Out-of-scope](./spec.md#out-of-scope-explicit)

## Decisions

- **DD-1** **Annotation = assistant turn's response text (verbatim, no extra LLM call)**.
  - Reason: zero extra cost; response text is the highest-fidelity record of what the model extracted from the image. User explicitly chose this on 2026-05-04.
  - Consequence: if response text is sparse, annotation is sparse. Acceptable for v1; v2 can add dedicated LLM annotator if measurements justify.
  - Alternative considered: dedicated tiny LLM call (200-500 token output per image) — rejected for v1 scope.

- ~~**DD-2** **Storage path = `~/.local/state/opencode/incoming/<sessionID>/<filename>`**, an XDG state-home subtree.~~ **(v1, SUPERSEDED 2026-05-04 by DD-2'; conflicts with already-implementing `repo-incoming-attachments` spec)**

- **DD-2'** **(v2, ADDED 2026-05-04)** **Reuse the existing `repo-incoming-attachments` storage**: binaries already live at `<session.project.worktree>/incoming/<filename>` via `IncomingPaths.projectRoot()`, written by `routeOversizedAttachment` at upload time. The `attachment_ref.repo_path` field already records this absolute-or-relative path.
  - Reason: `repo-incoming-attachments` (state=`implementing`, 2 of 4 phases checked) already owns the binary lifecycle — per-project repo storage with sha256 dedup + history JSONL. Inventing a parallel XDG store would duplicate the work and contradict the user's chosen "binary belongs to repo" mental model.
  - Consequence: attachment-lifecycle does NOT move binaries. Dehydration is a pure conversation-history rewrite — flip `attachment_ref.dehydrated=true` + populate `annotation`. The `repo_path` and `sha256` fields are already present on the part (added by repo-incoming phase 2.5\*) and remain pointing at the binary.
  - Source-of-truth for path resolution: `IncomingPaths` namespace in `packages/opencode/src/incoming/paths.ts`. We never call `IncomingPaths.write()` ourselves; the `repo_path` field is populated upstream.

- **DD-3** **Always dehydrate every image attachment in the just-completed turn** (no per-image granularity).
  - Reason: simple + predictable. Binary preserved for 7 days post-`session.deleted`, so AI can reread anything within window. User explicitly chose this on 2026-05-04.
  - Consequence: 100% of image attachments get the rewrite once `finish="stop"` reached. Image tokens drop from accumulating to flat-after-first-turn.
  - Alternative considered: scan response text for image references and only dehydrate referenced ones — rejected; reference detection is brittle and the binary is recoverable anyway.

- ~~**DD-4** **TTL = 7 days after `session.deleted`** with two GC triggers: daemon startup + daily cron timer.~~ **(v1, SUPERSEDED 2026-05-04 by DD-4'; GC mechanism moot under DD-2' reuse)**

- **DD-4' (v2, ADDED 2026-05-04)** **No GC needed**. Binaries persist in `<worktree>/incoming/<filename>` for the lifetime of the project repo. Cleanup is the user's choice (e.g. `git clean`, manual `rm`, or `.gitignore` decisions per `repo-incoming-attachments` spec §IN/OUT). Reread is bounded by repo presence, not by a TTL.
  - Reason: per repo-incoming spec, "incoming 檔案是否進 git 由使用者自決" — the binary lifecycle belongs to the project, not to attachment-lifecycle.
  - Consequence: model `reread_attachment` errors with `attachment_not_found` if the user has manually deleted the file from `<worktree>/incoming/`; no `attachment_expired` time-based error class.

- **DD-5** **Dehydration is idempotent**: a part with `dehydrated: true` is skipped on re-evaluation.
  - Reason: post-completion hook may fire on retry / replay; must not double-rewrite or overwrite annotation.
  - Consequence: marker field check at the top of the hook.

- **DD-6** **Subagent has its own `incoming/<sessionID>/`** — parent attachments do NOT leak in.
  - Reason: subagent is a separate session; its attachment lifecycle is independent. Parent's attachments come in via `parentMessagePrefix` text rendering, not as live `attachment_ref` parts.
  - Consequence: subagent dehydration writes to subagent's own session dir; if subagent needs the original, it must be explicitly re-attached by the user / parent.

- **DD-7** **Schema extension on `MessageV2.AttachmentRefPart`** — optional fields:
  - `dehydrated?: boolean`
  - `annotation?: string`
  - `sha256?: string`
  - `incoming_path?: string`
  - All optional + backwards compatible. Old `attachment_ref` parts (no `dehydrated` field) parse as `dehydrated === undefined`, equivalent to false.

- **DD-8** **Wire serialization**: when `dehydrated === true`, the part renders to a text content block:
  ```
  <dehydrated_attachment filename="image (3).png" sha256="abc...">
  Annotation: <verbatim assistant response text or extracted slice>
  Note: original binary staged at <incoming_path>; call reread_attachment("image (3).png") if you need to look again.
  </dehydrated_attachment>
  ```
  - Reason: model receives the annotation + a clear hint about how to recover.
  - Consequence: replaces the original `image_url` content block in the model-message conversion path.

- **DD-9** **`reread_attachment` tool**:
  ```
  reread_attachment({ filename: string }): Promise<{ type: "image", url: string, est_tokens: number, byte_size: number } | { error: "attachment_expired" | "attachment_not_found" }>
  ```
  - Reason: model self-service for re-fetch; opt-in based on the model's judgment.
  - Consequence: tool registered globally (always available); description tells model when to use it.

- **DD-10** **Failed turns (`finish="error" | "abort"`) skip dehydration**.
  - Reason: model didn't successfully process the image; annotation would be unreliable.
  - Consequence: incoming binary stays in sqlite `attachments` table for that turn; next successful turn that re-reads it can dehydrate.

- ~~**DD-11** **GC mechanism**: a single `garbage-collect-incoming.ts` module wired into daemon startup + daily cron timer + skip immediate-on-delete for grace period.~~ **(v1, SUPERSEDED 2026-05-04 by DD-4'; no GC implemented in this spec)**

- **DD-12** **Annotation extraction**: `annotation` value = trimmed assistant response text, capped at 4000 chars (one large-paragraph worth). If response > 4000 chars, take first 2000 + last 1500 with `… [truncated] …` marker.
  - Reason: short enough to be cheap, long enough to capture a useful summary.
  - Consequence: rare cases where assistant emitted a 10K-token response and the trimmed annotation loses fidelity; user can call `reread_attachment` to recover.

- **DD-13** **Telemetry**:
  - `attachment.dehydrated { sessionID, filename, sha256, originalEstTokens, annotationChars }`
  - `attachment.dehydrate.skipped { sessionID, filename, reason }` (non-image, failed turn, already dehydrated)
  - `attachment.rereaded { sessionID, filename }`
  - `attachment.gc.swept { sessionsScanned, sessionsDeleted, bytesFreed, durationMs }`

- **DD-14** **No feature flag** (matches Phase B v2 direct-ship discipline). New behavior is the default; old sessions are not migrated; only newly-uploaded attachments enter the dehydration path. Rollback via git revert.

- **DD-15 (NEW 2026-05-04 — repo-incoming-attachments dependency)** This spec depends on `repo-incoming-attachments` having populated `attachment_ref.repo_path` for every uploaded image (already done in main, phase 2.5\*\* commit). For pre-repo-incoming legacy attachments (those with no `repo_path` field), dehydration is **skipped** (telemetry: `attachment.dehydrate.skipped { reason: "no-repo-path" }`); they keep their legacy hydrated path with binary in sqlite blob.
  - Reason: dehydration without a binary location to hand the model in `reread_attachment` is a dead end.
  - Consequence: extends DD-3's skip rules. Dehydration coverage = "post-repo-incoming uploads only", which matches the realistic scope (any session created after the repo-incoming rollout).

- **DD-16 (NEW 2026-05-04)** **Annotation field on `attachment_ref`** is added by attachment-lifecycle (this spec). `dehydrated` boolean is also added. The existing `repo_path` and `sha256` fields are reused as-is (no change). All four are optional.
  - Reason: clean separation of concerns: repo-incoming owns `repo_path` / `sha256` / upload mechanics; attachment-lifecycle owns `dehydrated` / `annotation` / lifecycle-after-read.
  - Consequence: schema delta in T.1.1 is just `dehydrated?: boolean` + `annotation?: string`.

## Risks / Trade-offs

- **R1 Annotation insufficient for image content** — DD-12's 4000-char cap may lose detail for visually rich screenshots. Mitigation: model can `reread_attachment`; v2 spec can add dedicated LLM annotator.
- ~~**R2 Disk growth** — incoming staging accumulates ~50-200KB per image × N sessions. With 7-day TTL, worst case is ~10MB-100MB depending on usage pattern. Mitigation: TTL configurable; GC telemetry visible.~~ **(v1, SUPERSEDED 2026-05-04 — under DD-2', binary lives in repo and is user-managed; disk growth is not this spec's concern)**
- **R3 Re-read miss** — model calls `reread_attachment` but the file at `<worktree>/<repo_path>` has been removed (user `git clean`, `rm`, or never landed because pre-repo-incoming session). Mitigation: tool returns clear `attachment_not_found` error; model can ask user to re-upload.
- **R4 Subagent attachment confusion** — model thinks subagent inherits parent's reread access. Mitigation: subagent gets its own incoming; tool errors with clear message.
- **R5 Dehydration during compaction race** — Phase A compaction may run concurrently with post-completion hook. Mitigation: dehydration is part-level edit on a SPECIFIC part id; compaction reads via Session.messages and won't touch parts mid-edit. Sqlite WAL handles isolation.

## Critical Files

- [packages/opencode/src/session/message-v2.ts](../../packages/opencode/src/session/message-v2.ts) — extend `AttachmentRefPart` schema with **two** new optional fields (`dehydrated`, `annotation`); reuse existing `repo_path` / `sha256` per DD-16
- [packages/opencode/src/session/processor.ts](../../packages/opencode/src/session/processor.ts) — post-completion hook scans parent user message for image `attachment_ref` parts with `repo_path` populated → flips `dehydrated=true` + extracts annotation. **Does not move binaries.**
- [packages/opencode/src/tool/reread-attachment.ts](../../packages/opencode/src/tool/reread-attachment.ts) **(NEW)** — the re-read tool. Reads bytes from `<worktree>/<repo_path>` directly via existing fs helpers.
- [packages/opencode/src/tool/index.ts](../../packages/opencode/src/tool/index.ts) — register `reread_attachment` in core tool registry
- [packages/opencode/src/incoming/paths.ts](../../packages/opencode/src/incoming/paths.ts) **(EXISTING)** — read-only consumer; `IncomingPaths.projectRoot()` to resolve absolute paths from `repo_path`
- Wire format conversion (where `attachment_ref` → AI SDK content block happens) — branch on `dehydrated` flag to emit text instead of image
- [packages/opencode/src/config/tweaks.ts](../../packages/opencode/src/config/tweaks.ts) — add `attachment_dehydrate_enabled` + `attachment_annotation_max_chars` knobs (no GC-related knobs needed under DD-4')

## Validation Strategy

- **Unit**: schema roundtrip with new fields; dehydration hook with synthetic finish="stop" message; reread tool happy + missing file paths; GC with synthetic old-session timestamps; idempotency check.
- **Integration**: end-to-end smoke — upload image, observe dehydration on next turn, see token count drop; reread flow.
- **Manual smoke**: replay a session like `ses_211c853fcffer...` (with multiple image attachments) and observe per-turn token reduction.

## Migration / Rollout

- **Dependency**: `repo-incoming-attachments` (state=`implementing`) must have populated `repo_path` on uploaded `attachment_ref` parts. As of 2026-05-03 (its phase 2.5\*\* commit), all NEW uploads do. Pre-2026-05-03 legacy sessions skip dehydration (DD-15).
- **Schema additions**: `dehydrated?` + `annotation?` — both `z.optional()`. `repo_path` / `sha256` already in schema.
- **Behavior**: new dehydration applies immediately on next assistant turn after deploy. Old hydrated attachments (no `repo_path`) stay hydrated.
- **Rollback**: git revert. Already-dehydrated parts have `dehydrated=true` field that zod will silently strip on next read; wire-format conversion reverts to the existing repo-incoming dual-read path (read binary from `<worktree>/<repo_path>` via `tool/attachment.ts` lookup). Risk is essentially zero because the binary was never moved by attachment-lifecycle — it's still at the same `repo_path` it always was.

## Open Questions

無 — 6 個 OQ 已於 2026-05-04 解決，記錄於 [proposal.md Open Questions section](./proposal.md#open-questions-resolved-2026-05-04)。

## Cross-References

- [proposal.md](./proposal.md) — Why / Scope
- [spec.md](./spec.md) — GIVEN/WHEN/THEN
- [prompt-cache-and-compaction-hardening](../prompt-cache-and-compaction-hardening/) — Phase B context
