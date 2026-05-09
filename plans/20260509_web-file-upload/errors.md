# Errors

## Error Catalogue

| Code                                  | Layer  | Status | Message                                                         | Recovery                                                     |
| ------------------------------------- | ------ | ------ | --------------------------------------------------------------- | ------------------------------------------------------------ |
| `FILE_OP_PATH_ESCAPE`                 | Server | active | Operation target is outside the active project.                 | Choose a file or folder inside the active project.           |
| `FILE_OP_INVALID_NAME`                | Server | active | Filename is invalid.                                            | Use a basename without path separators.                      |
| `FILE_OP_DUPLICATE`                   | Server | active | A file or folder with this name already exists.                 | Pick a different name or manually remove the existing item.  |
| `FILE_OP_TARGET_NOT_DIRECTORY`        | Server | active | Operation target is not a directory.                            | Choose a directory in the File tab.                          |
| `FILE_OP_SOURCE_NOT_FOUND`            | Server | active | Source file or folder no longer exists.                         | Refresh the tree and retry.                                  |
| `FILE_OP_CONFIRMATION_REQUIRED`       | Server | active | This destructive operation requires confirmation.               | Confirm delete before retrying.                              |
| `FILE_OP_PERMISSION_DENIED`           | Server | active | Current user cannot write to the destination.                   | Choose a writable folder.                                    |
| `FILE_OP_DESTINATION_AMBIGUOUS`       | Server | active | Destination path cannot be resolved safely.                     | Choose an explicit writable destination.                     |
| `FILE_OP_PREFLIGHT_REQUIRED`          | Server | active | External destination writes require a successful preflight.     | Run destination preflight and confirm the resolved path.     |
| `FILE_OP_NOT_FILE`                    | Server | active | Operation requires a file, but the target is not a file.        | Choose a file target.                                        |
| `FILE_RECYCLEBIN_RESTORE_CONFLICT`    | Server | active | Restore target already exists.                                  | Rename or move the existing target before restoring.         |
| `FILE_RECYCLEBIN_METADATA_INVALID`    | Server | active | Recyclebin metadata is missing or unsafe.                       | Refresh recyclebin state; restore manually if needed.        |
| `FILE_DOWNLOAD_DIRECTORY_UNSUPPORTED` | Server | active | Directory download is not available in this phase.              | Download individual files or request archive-download scope. |
| `FILE_UPLOAD_TOO_LARGE`               | Server | pending| File is too large to upload.                                    | Reduce file size or use another transfer method.             |
| `FILE_CLIPBOARD_INVALID_STATE`        | UI     | active | Paste is unavailable because no valid copy/cut item is pending. | Copy or cut an item inside this project first.               |

## Status legend

- **active**: code is present in `File.OperationCode` enum (or, for UI codes, expected to be raised client-side) and may be returned today.
- **pending**: catalogued by spec but not yet present in the backend enum. Phase 2.5 must add it to `File.OperationCode` together with the upload route. Until then, do not write client-side branches that match this string.

## Sync rules

- The authoritative server enum is `File.OperationCode` in `packages/opencode/src/file/index.ts`. Any catalogue addition here must be paired with an enum addition there in the same change.
- UI-only codes (`FILE_CLIPBOARD_INVALID_STATE`) must never be returned by a server route; they are produced by the frontend when a precondition for issuing a request is missing.
- Tests and SDK consumers should reference codes via the enum, not via string literals from this document, so drift surfaces as a type error rather than as a silent miss.

## Audit notes (2026-05-09)

- `FILE_UPLOAD_TOO_LARGE` was listed here without a backing enum entry. Marked **pending** until Phase 2.5 lands.
- `FILE_CLIPBOARD_INVALID_STATE` was orphaned: no UI code references it yet because Phase 4 has not started. The code is reserved; expect the first reference in Phase 4.1 (`tasks.md`).
