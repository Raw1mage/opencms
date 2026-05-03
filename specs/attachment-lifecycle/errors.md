# Errors: attachment-lifecycle

## Error Catalogue

### ~~E-ATTACHMENT-EXPIRED~~ (v1, SUPERSEDED 2026-05-04)

Removed under DD-4'. No GC, no time-based expiry. Reread failure now folds into `E-ATTACHMENT-NOT-FOUND` regardless of cause (file removed by user, never landed for legacy session, etc).

### E-ATTACHMENT-NOT-FOUND (model-facing tool error)

| 欄位 | 值 |
|---|---|
| **Code** | `attachment_not_found` |
| **Source** | `tool/reread-attachment.ts` |
| **Layer** | tool result |
| **Throw site** | (1) requested filename matches no dehydrated part in this session, OR (2) sanitization rejects the input (path traversal etc), OR (3) **(v2 2026-05-04)** part has `repo_path` but the file at `<worktree>/<repo_path>` no longer exists (user removed it via `git clean` / `rm`) |
| **User-visible message** | Case 1/2: "No staged attachment named '<filename>' found in this session." Case 3: "Image '<filename>' is no longer at <worktree>/<repo_path>. Please ask the user to re-upload." |
| **Recovery** | Model self-corrects by listing prior attachments mentally / asks user to re-upload |
| **Telemetry** | `attachment.reread.not_found { sessionID, filename, reason: "no-matching-part" \| "invalid-filename" \| "file-removed-from-repo" }` |

### W-DEHYDRATION-SKIPPED (telemetry-only, not thrown)

Multiple sub-cases all surface as `attachment.dehydrate.skipped`:

| Reason | Trigger |
|---|---|
| `non-image-mime` | mime starts with anything other than `image/` (DD-3 v1 scope) |
| `failed-turn` | `finish !== "stop"` (DD-10) |
| `already-dehydrated` | part already has `dehydrated === true` (DD-5 idempotency) |
| `dehydrate-disabled` | tweaks.cfg `attachment_dehydrate_enabled=false` |
| `binary-missing-from-sqlite` | sqlite attachments table doesn't have the binary (already moved or never had it) — log warn, skip |

| 欄位 | 值 |
|---|---|
| **Code** | (no throw; telemetry only) |
| **Source** | `processor.ts` post-completion hook |
| **Telemetry** | `attachment.dehydrate.skipped { sessionID, filename, reason }` |
| **User-visible** | none |
| **Recovery** | Natural — non-image / failed turn / disabled don't need recovery; rare `binary-missing-from-sqlite` indicates upstream race or earlier failure (treat as defensive) |

### ~~E-INCOMING-WRITE-FAILED~~ (v1, SUPERSEDED 2026-05-04)

Removed. attachment-lifecycle does not write binaries (DD-2'). Upload write failures are owned by `repo-incoming-attachments`'s own error handling.

### ~~E-GC-SWEEP-FAILED~~ (v1, SUPERSEDED 2026-05-04)

Removed. No GC under DD-4'.

## Error budget / SLO

| Event | Tolerance | Alert |
|---|---|---|
| `attachment_not_found` reason=no-matching-part | < 1% of reread calls (model rarely typos filename) | persistent > 5% → review tool prompt clarity |
| `attachment_not_found` reason=file-removed-from-repo | depends on user `git clean` cadence; no SLO | n/a |
| `attachment_not_found` reason=invalid-filename | < 0.1% (model attempting `..`) | any non-trivial rate → review tool description |
