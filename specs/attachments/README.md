# attachments

> Wiki entry. Source of truth = current code under
> `packages/opencode/src/incoming/`,
> `packages/opencode/src/session/` (attachment-related modules), and
> `packages/opencode/src/tool/{attachment,reread-attachment}.ts`.
> Consolidates three spec packages: `attachment-lifecycle` (living),
> `repo-incoming-attachments` (implementing), and
> `docx-upload-autodecompose` (implementing).

## Status

mixed — image lifecycle is `living`, repo-incoming + docx
auto-decompose are `implementing` with most of the pipeline shipped.

`attachment-lifecycle` reached `living` on 2026-05-03 carrying its
final v5 architectural pivot (pure AI-opt-in: upload announces, AI
explicitly vouchers the images it wants inlined). `repo-incoming-
attachments` and `docx-upload-autodecompose` are `implementing` — both
have multiple sync-marked drift entries indicating active code churn,
and both are wired end-to-end behind the upload entry path. Verified
state is gated on full polish + AC pass on the remaining test vectors.

## Current behavior

### Two storage paths split by mime

`buildUserMessageAttachmentRefPart` in `session/user-message-parts.ts`
classifies every above-threshold attachment as either image or non-
image (`isImage = mime.startsWith("image/")`).

- **Image** → `SessionIncomingPaths.tryLandInSession` writes bytes to
  `${Global.Path.data}/sessions/<sessionID>/attachments/<filename>`
  (default `~/.local/share/opencode/sessions/<id>/attachments/`).
  Images are debug screenshots / ephemeral content, not project
  knowledge — they stay out of the working tree.
- **Office / PDF / everything else** → `tryLandInIncoming` writes to
  `<projectRoot>/incoming/<filename>` and creates / appends
  `<projectRoot>/incoming/.history/<filename>.jsonl`. The
  `attachment_ref` part carries `repo_path` + `sha256` instead of the
  binary.

If neither landing succeeds (no project context, sanitize failure,
small enough to inline), the bytes fall back to the legacy
`AttachmentBlob` row (`upsertAttachmentBlob` with embedded `content`).
That row remains readable via the dual-path reader in
`tool/attachment.ts` (`loadAttachmentBlob`) so legacy sessions keep
working without migration.

### Repo-incoming history journal (R2 / R6 / R7)

Every write to `<projectRoot>/incoming/**` from an opencode tool path
appends one line to the matching `.jsonl` journal via
`maybeAppendToolWriteHistory` (`incoming/index.ts`). Entries record
`{ts, source, sha256, sizeBytes, mtime, sessionId}`. Sources include
`upload`, `upload-dedupe`, `upload-conflict-rename`,
`tool:Edit`, `tool:Write`, `tool:Bash`, `tool:<mcp>`, and
`drift-detected`. `IncomingHistory` exposes `appendEntry`,
`computeSha256`, and the read API consumed by the history HTTP route.

Drift safety net: stat compares mtime + size against the journal's
last entry; mismatch triggers a re-hash and a `drift-detected` append.

### Filename sanitization + dedupe vs current sha (R5)

`IncomingPaths.sanitize` enforces NFC, strips control chars, caps at
256 bytes, rejects path traversal. Dedupe and rename are decided by
the live filesystem sha — not by historical sha — so the
"upload original → tool rewrites → re-upload original" round-trip
becomes a paired-rename and not a silent collision. `nextConflictName`
appends `(N)` when the same filename arrives with a different sha.

### Docx auto-decompose at upload (synchronous fast phase)

For Office mimes (`docx`, `xls`, `ppt`, `xlsx`, `pptx`, legacy `doc`),
`landOfficeUpload` in `incoming/decompose-hook.ts` takes ownership of
the write. It runs a two-phase pipeline:

1. **Fast phase (≤30 s synchronous)** — calls `docxmcp`'s
   `extract_all` MCP tool over the HTTP-over-Unix-socket transport
   (the bind-mount staging path was retired in the
   `docxmcp-http-transport` phase 6 cutover). Receives outline +
   template + manifest, writes them to `incoming/<stem>/`, plus
   `_PENDING.md` markers in `chapters/`, `tables/`, `media/`. Then
   forwards the user message to the AI.
2. **Background phase** — docxmcp keeps producing `body.md`,
   `chapters/*.md`, `tables/*.csv`, `media/*` in a detached child
   process. The host-side `startPollLoop` (`incoming/poll-loop.ts`)
   polls `extract_all_collect` every 5 s up to a 180 s safety cap and
   publishes incremental bundles into the same `incoming/<stem>/`
   tree. Each cycle ships only files added since the previous bundle,
   removes obsolete `_PENDING.md` markers, and rewrites the manifest.

Cache hit (existing manifest with matching `source.sha256` +
`source.filename`) skips both phases. Per DD-12, **failed manifests
also count as cache hits** and surface a "過去拆解曾失敗" prefixed
routing hint that explains the two retry paths (modify file content
or `rm -rf incoming/<stem>/`).

Sha drift triggers paired version-rename
(`incoming/foo.docx` + `incoming/foo/` → suffix
`-YYYYMMDD-HHMMSS`) atomically; rollback both on any failure.

Legacy `.doc` / `.xls` / `.ppt` use the in-process
`legacy-ole2-scanner` (printable-runs scan with CR/LF/tab preserved).
Modern `.xlsx` / `.pptx` write `unsupported.md` and the manifest's
`decompose.status = "unsupported"` — no extraction attempted.

### Routing hint is a map, never content (DD-7)

`renderOfficeRoutingHint` (`incoming/routing-hint.ts`) emits one line
per artifact kind with file count + one-number summary, folds lists
> 4 with `（還有 N 份，共 M 份）`, and closes with the three-line
action contract: pull-refresh rule on line 1, "use plain read tools"
on line 2, "call docxmcp only for edits" on line 3. The hint never
inlines body text or table cells.

### Image inline lifecycle (v5 pure opt-in)

`session.execution.activeImageRefs: string[]` (schema in
`session/index.ts` L267) is the per-turn queue of filenames whose
binary will be inlined into the next preface trailing tier. Lifecycle:

- **Upload commit** — `addOnUpload` is **not** invoked for the active
  set in v5; uploads only stage binary + announce the image in the
  inventory. (`addOnUpload` exists in `active-image-refs.ts` for
  testing / future use; the production path keeps the active set
  empty until the AI vouchers in.)
- **AI opts in** — `RereadAttachmentTool`
  (`tool/reread-attachment.ts`) appends the requested filename to
  `activeImageRefs` via `Session.setActiveImageRefs` and returns a
  short text confirmation. The tool does **not** return the bytes;
  the binary appears in the next turn's preface trailing tier.
- **Preface assembly** — `session/llm.ts` (~L620) calls
  `buildAttachedImagesInventory` to build the `<attached_images>`
  text block (always emitted when ≥1 image attachment exists in the
  session), then walks every image `attachment_ref` to assemble
  `activeImageBlocks` only for filenames in `activeImageRefs`. Both
  ride `prefaceInput.trailingExtras` so they sit in the BP4 zone and
  do not invalidate the T1 / T2 prefix cache.
- **Drain** — `session/processor.ts` (~L1153) clears
  `activeImageRefs` after every `step-finish` regardless of
  `finishReason`, so image binary never accumulates across turns.
- **FIFO cap** — `ACTIVE_IMAGE_REFS_DEFAULT_MAX = 3`. Hard upper
  bound even when the AI vouchers in many filenames at once;
  configurable via `attachment_inline_active_set_max` in
  `tweaks.cfg`.

The whole subsystem is gated by `attachment_inline_enabled`
(`Tweaks.attachmentInlineSync()`); when disabled, neither inventory
nor active blocks are emitted and `RereadAttachmentTool` returns a
"feature disabled" message.

### Image fallback for non-multimodal models

`session/image-router.ts` checks the resolved model's
`capabilities.input.image`. If false, `selectImageModel` walks
`buildFallbackCandidates` (3D rotation candidates filtered by image
capability + non-rate-limited). On no match, `Bus.publish` raises a
`Session.Event.Error` and image input is blocked rather than silently
dropped. `stripImageParts` is the explicit drop helper used elsewhere
when the caller knowingly rejects images.

### MCP container boundary preserved (R8)

The `IncomingDispatcher.before` / `after` hooks rewrite repo-relative
paths in MCP tool args to upload tokens via the docxmcp HTTP socket
endpoint, then materialize returned `bundle_tar_b64` payloads back
into the bundle's repo path. The container itself does not bind-mount
`<repo>` or `$HOME`. Phase 6 retired the prior bind-mount staging
implementation entirely.

### Git stays out

`incoming/` is git-ignored at the project level; no daemon path runs
`git add`. Files appear as `untracked` until the user decides.

## Code anchors

Image lifecycle (attachment-lifecycle):
- `packages/opencode/src/session/active-image-refs.ts` — pure helpers
  (`addOnUpload`, `addOnReread`, `drainAfterAssistant`, FIFO cap).
- `packages/opencode/src/session/attached-images-inventory.ts` —
  `buildAttachedImagesInventory` text block.
- `packages/opencode/src/session/image-router.ts` — multimodal
  capability rotation; `stripImageParts`.
- `packages/opencode/src/session/llm.ts` — preface assembly site
  (~L620–L755): inventory + `activeImageBlocks` into `trailingExtras`.
- `packages/opencode/src/session/processor.ts` — drain after
  `step-finish` (~L1153).
- `packages/opencode/src/session/index.ts` —
  `execution.activeImageRefs` schema (L267), `setActiveImageRefs`
  (L715).
- `packages/opencode/src/tool/reread-attachment.ts` — voucher tool.
- `packages/opencode/src/incoming/session-paths.ts` —
  `SessionIncomingPaths` (per-session XDG image storage).

Repo incoming (repo-incoming-attachments):
- `packages/opencode/src/incoming/paths.ts` — `IncomingPaths`,
  `NoProjectPathError` (DD-1 fail-fast), `sanitize` (DD-12).
- `packages/opencode/src/incoming/history.ts` — `IncomingHistory`
  (`appendEntry`, `computeSha256`, source-kind enum).
- `packages/opencode/src/incoming/dispatcher.ts` —
  `IncomingDispatcher` HTTP-over-Unix-socket MCP arg rewrite +
  bundle publish.
- `packages/opencode/src/incoming/index.ts` — tool-write hooks
  (`maybeAppendToolWriteHistory`).
- `packages/opencode/src/session/user-message-parts.ts` —
  `tryLandInIncoming` (~L75) + image / non-image split (~L290).
- `packages/opencode/src/tool/attachment.ts` — `loadAttachmentBlob`
  dual-path read (DD-17).

Docx auto-decompose (docx-upload-autodecompose):
- `packages/opencode/src/incoming/decompose-hook.ts` —
  `landOfficeUpload`, two-phase pipeline.
- `packages/opencode/src/incoming/manifest.ts` — manifest schema +
  `lookupCache`.
- `packages/opencode/src/incoming/version-rename.ts` —
  `pairedVersionRename` for sha drift.
- `packages/opencode/src/incoming/poll-loop.ts` —
  `startPollLoop`, `extract_all_collect` polling.
- `packages/opencode/src/incoming/routing-hint.ts` —
  `renderOfficeRoutingHint` (DD-7 / DD-12 / DD-13).
- `packages/opencode/src/incoming/legacy-ole2-scanner.ts` — .doc/.xls/
  .ppt printable-runs scanner.
- `packages/opencode/src/incoming/office-mime.ts` — `classifyOffice`,
  `decomposerForKind`, `isLegacyOle2`.
- `packages/opencode/src/incoming/failure-recorder.ts` —
  `recordFailure`, `recordUnsupported`.

Config:
- `packages/opencode/src/config/tweaks.ts` —
  `attachment_inline_enabled`, `attachment_inline_active_set_max`,
  `userAttachmentMaxBytes`, `attachmentPreviewBytes`. Per-knob
  fallback defaults baked into `ATTACHMENT_INLINE_DEFAULTS`.

Tests (representative):
- `session/active-image-refs.test.ts`,
  `session/active-image-refs.lifecycle.test.ts`,
  `session/attached-images-inventory.test.ts`,
  `session/context-preface.attachment-inline.test.ts`,
  `tool/reread-attachment.test.ts`,
  `tool/attachment.test.ts`,
  `incoming/manifest.test.ts`,
  `incoming/version-rename.test.ts`,
  `incoming/routing-hint.test.ts`,
  `incoming/session-paths.test.ts`,
  `incoming/legacy-ole2-scanner.test.ts`,
  `incoming/office-mime.test.ts`.

## Notes

### What's shipped vs in-flight

Shipped to `living`:
- v5 image lifecycle end-to-end (upload → session XDG storage →
  inventory → voucher → trailing inline → drain). 76/76 tests pass on
  merge (state log entry 2026-05-03).

Shipped behind `implementing` (active drift):
- Repo-incoming write/dedupe/history/dual-path read, sanitize, drift
  detection, MCP container boundary. Two `sync` checkpoints recorded;
  the latest (2026-05-02) reported drift on `incoming/paths.test.ts`.
- Docx fast + background pipeline, paired version-rename on sha drift,
  cache-hit short-circuit (success and failure), legacy OLE2 scanner,
  routing-hint generator, soft-fail manifests. Sync checkpoints note
  drift across `file/index.ts`, `server/routes/file.ts`, and several
  provider files (2026-05-03 entry) — the ripple of moving the upload
  hook into the dispatcher.

Open work:
- `repo-incoming-attachments` AC-12 (drift detection telemetry path
  end-to-end) and the bundle-internal per-file history (called out as
  a v2 enhancement in `incoming/index.ts`'s comment).
- `docx-upload-autodecompose` AC-2b (background-phase p95 latency
  budget) and the full `tweaks.cfg` integration of the magic numbers
  in `decompose-hook.ts` (DD-14 phase 9).
- Tweaks config: only enable + active-set-max wired today; the rest
  fall back to compile-time defaults.

### Legacy compatibility

`AttachmentBlob` rows from old sessions still carry `content:
Uint8Array` and no `repo_path`. `loadAttachmentBlob` detects this and
serves bytes from the legacy column unchanged. New uploads never write
`content`; they write `repo_path` + `sha256` (or `session_path` for
images). No proactive migration runs — old rows stay where they are
until the session is deleted.

### Dehydration path is dead

The original `attachment-lifecycle` v1 design (post-turn dehydration
that mutated the `attachment_ref` part with `dehydrated: true` +
annotation, plus a 7-day GC sweep over `~/.local/state/opencode/
incoming/`) was superseded by v5. There is no GC daemon, no TTL, no
`dehydrated` flag walked by the runloop. Binary lifecycle is now
user-owned via standard filesystem tools (`git clean`, `.gitignore`,
manual `rm`), and the original-binary-in-history shape is not
mutated; the v5 active-set + drain mechanism is what keeps per-turn
cost bounded.

### Related entries

- [compaction.md](../compaction/README.md) — big-content boundary handling
  (R6 in the legacy `compaction-improvements` spec) is implemented in
  this subsystem, not the compaction runloop. Image binary in
  trailing extras (BP4 zone) is specifically positioned to preserve
  Phase B BP1/BP2/BP3 cache locality across turns.
- [mcp.md](../mcp/README.md) — `docxmcp` is an MCP app; the
  HTTP-over-Unix-socket transport, container mount discipline, and
  the Direct Render Protocol (TODO) live in MCP territory. The
  attachment subsystem only consumes the docxmcp tools via
  `MCP.execute` from `decompose-hook.ts` and the dispatcher.
- [session.md](../session/README.md) — `attachment_ref` parts ride on
  `MessageV2` user messages; the session schema's
  `execution.activeImageRefs` queue is the per-turn handoff between
  voucher tool and preface assembly.
