# Spec: attachment-lifecycle

## Purpose

Image attachments uploaded by the user collapse into a small text annotation after the assistant turn that processed them finishes; the original binary is staged in a per-session XDG path so the model can re-read on demand. Cuts recurring per-turn input token cost dramatically without sacrificing recall.

## Glossary

| 詞 | 意義 |
|---|---|
| **Hydrated attachment** | The full `attachment_ref` part with binary still in conversation history (the only state pre-dehydration) |
| **Dehydrated attachment** | The same `attachment_ref` part rewritten to carry only `{filename, sha256, annotation, incoming_path}`; binary moved to filesystem |
| ~~**Incoming staging**~~ → see **Repo incoming** | (v1, SUPERSEDED 2026-05-04) — staging path no longer at `~/.local/state/opencode/incoming/`; see Repo incoming below |
| **Repo incoming** (v2) | Filesystem location `<session.project.worktree>/incoming/<filename>` owned by `repo-incoming-attachments` spec. attachment-lifecycle reuses without writing — `attachment_ref.repo_path` already records this path. |
| **`reread_attachment` tool** | Tool the model calls to fetch the binary back from incoming and inject as a fresh `attachment_ref` in the next turn |
| **Annotation** | Plain text replacing the binary; in v1 this is a verbatim slice of the assistant turn's response text (no extra LLM call) |
| **GC sweep** | Background pass that deletes incoming/`<sid>`/ folders for sessions deleted > 7 days ago |

## Requirements

### Requirement: Dehydrate every image attachment after its first read

#### Scenario: assistant turn with `finish="stop"` triggers dehydration
- **GIVEN** a user message with one or more `attachment_ref` parts of mime type `image/*`
- **AND** the assistant message replying to that user message reaches `finish="stop"`
- **WHEN** the post-completion hook fires
- **THEN** for each image `attachment_ref` part on that user message:
  - The binary is moved from session sqlite `attachments` table to `~/.local/state/opencode/incoming/<sessionID>/<filename>`
  - The `attachment_ref` part is rewritten in place: original payload fields preserved, plus `dehydrated: true`, `annotation: <verbatim assistant response text>`, `sha256: <hex>`, `incoming_path: <abs path>`
  - The on-disk binary file's permissions are 0644 (readable by the same user)

#### Scenario: non-image attachments are not dehydrated in v1
- **GIVEN** a user message with an attachment_ref of mime type `application/pdf`
- **WHEN** the assistant turn completes
- **THEN** the attachment_ref is left untouched (still hydrated)
- **AND** a telemetry event `attachment.dehydrate.skipped { reason: "non-image-mime" }` is emitted

#### Scenario: failed turns do not dehydrate
- **GIVEN** an assistant message with `finish="error"` or `finish="abort"`
- **WHEN** the post-completion hook evaluates
- **THEN** dehydration does NOT run for that turn's attachments

### Requirement: Subsequent LLM calls send dehydrated stub instead of binary

#### Scenario: model wire payload contains text annotation only
- **GIVEN** a session where image `attachment_ref` parts have been dehydrated
- **WHEN** the next LLM call assembles `messages[]`
- **THEN** the dehydrated `attachment_ref` parts serialize to a small text content block with shape `<dehydrated_attachment filename="..." sha256="...">${annotation}</dehydrated_attachment>` — NOT the original image binary
- **AND** the `est_tokens` of the new payload reflects annotation length (≤ 1K typical), not original image tokens (typically 7K-167K)

### Requirement: Model can re-read a staged attachment via tool

#### Scenario: `reread_attachment(filename)` returns fresh binary
- **GIVEN** a dehydrated `attachment_ref` with `filename="image (3).png"` and binary at `~/.local/state/opencode/incoming/<sid>/image (3).png`
- **WHEN** the model calls `reread_attachment({filename: "image (3).png"})`
- **THEN** the tool reads the file, returns `{type: "image", url: "data:image/png;base64,...", est_tokens, byte_size}`
- **AND** the next turn's user message inherits this fresh image (via tool result handling)

#### Scenario: file missing returns error
- **GIVEN** the binary at `<worktree>/<repo_path>` has been removed by the user (e.g. `git clean`, manual delete, never landed for legacy session)
- **WHEN** the model calls `reread_attachment({filename: "image (3).png"})`
- **THEN** the tool returns an error: `{error: "attachment_not_found", message: "Image '<file>' is no longer at <worktree>/<repo_path>. Please ask the user to re-upload if you need to look at it."}`

### Requirement: Staging is per-session and isolated

#### Scenario: each session has its own incoming directory
- **GIVEN** sessions A and B both upload an image named `image.png`
- **WHEN** both turns dehydrate
- **THEN** they live at separate paths: `~/.local/state/opencode/incoming/sesA/image.png` and `~/.local/state/opencode/incoming/sesB/image.png`
- **AND** subagent dispatched from session A does NOT inherit session A's incoming

~~### Requirement: Garbage collection sweep~~

**(v1, SUPERSEDED 2026-05-04)** Removed under design.md DD-4'. Binary lifecycle is owned by `repo-incoming-attachments` (per-project, user-managed via `git clean` / `.gitignore` / manual `rm`). attachment-lifecycle has no GC sweep, no TTL, no daemon-startup hook, no cron timer. Reread errors with `attachment_not_found` if user has removed the file from `<worktree>/incoming/`.

### Requirement: Dehydration is one-way unless reread

#### Scenario: previously-dehydrated attachment cannot be silently re-hydrated
- **GIVEN** an `attachment_ref` part already has `dehydrated: true`
- **WHEN** the post-completion hook runs again on a later turn
- **THEN** the part is skipped (idempotent — no double dehydration, no annotation overwrite)

## Acceptance Checks

| Check | How verified |
|---|---|
| 10-image session sees ≥ 90% reduction in image tokens between first turn and second turn after dehydration | Manual smoke + telemetry comparison |
| `attachment.dehydrated` event fires once per image post-turn | Unit test on processor.ts hook |
| Wire payload for next LLM call contains `<dehydrated_attachment>` not raw image | Integration test with mock provider |
| `reread_attachment` tool returns valid image content | Unit test |
| ~~GC sweep deletes `<sid>` dirs after 7-day TTL~~ | (v1, SUPERSEDED 2026-05-04 — no GC; user-managed) |
| Subagent does not inherit parent's incoming | Integration test |
| Non-image mimes (PDF) NOT dehydrated in v1 | Unit test |

## Out-of-scope (explicit)

- PDF / text / code attachment dehydration (separate spec, deferred)
- Audio / video attachments (deferred)
- Pre-emptive image compression (separate concern)
- Cross-session attachment sharing
- UI changes beyond an optional "compressed" badge
- Annotation quality enhancement (e.g. dedicated LLM call for richer annotations) — v2 candidate

## Dependencies

- [prompt-cache-and-compaction-hardening](../prompt-cache-and-compaction-hardening/) (Phase B landed) — provides the static-system + preface architecture this slots into; conversation history dehydration is independent
- `MessageV2.AttachmentRefPart` — extended with optional dehydration metadata fields
