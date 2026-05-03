# Errors: docx-upload-autodecompose

Every failure mode the system can hit, with the user-visible message
the AI sees in the routing hint, the recovery path, and which layer
owns it. No silent failures (AGENTS.md rule 1) — every entry below
must surface with the listed wording.

## Format

| code | layer | trigger | manifest reason (verbatim) | recovery |
|---|---|---|---|---|

## Error Catalogue

| code | layer | trigger | manifest reason | recovery |
|---|---|---|---|---|
| `DECOMPOSE_TIMEOUT` | dispatcher | docxmcp extract_all does not return within 30 s | `docxmcp 服務暫時無回應 (timeout 30s)` | AI advises user to retry upload; if persistent, ops investigates docxmcp service health |
| `DOCXMCP_PROTOCOL_ERROR` | dispatcher | docxmcp returned an MCP-level error (token_not_found, invalid args, internal exception) | `docxmcp 處理錯誤：<one-line summary of error>` | AI advises user to retry; ops checks docxmcp logs |
| `DOCXMCP_ENTRY_MISSING` | dispatcher | extract_all entry not registered on the host's docxmcp build | `docx 處理工具暫不可用，請聯繫管理員更新` | Ops bumps docxmcp submodule pointer; do NOT silently fall back to AI-driven docxmcp path |
| `DOCX_INVALID_ZIP` | docxmcp | source.docx is not a valid zip / lacks word/document.xml | `docx 內部結構不完整，缺少 word/document.xml` | AI asks user to re-upload from a known-good source |
| `DOCX_TEMPLATE_INVALID` | docxmcp | template.dotx round-trip validation fails | (degraded only — no failure manifest; raw XML kept; manifest still status=ok) | Implementation drops template.dotx, keeps raw style XML; manifest's template entry summary notes "raw XML only" |
| `LEGACY_SCAN_EMPTY` | dispatcher (legacy scanner) | scanner produced no runs ≥ minimum length after density threshold | `OLE2 解析失敗：找不到主要文字流` | AI asks user to convert to .docx |
| `LEGACY_SCAN_EXCEPTION` | dispatcher (legacy scanner) | scanner threw (e.g. byte access error, decoding panic) | `舊式 Office 檔案解析錯誤：<exception class>` | AI asks user to convert to .docx; ops checks for fixture-specific bug |
| `VERSION_RENAME_PARTIAL` | dispatcher (version-rename helper) | renaming the OLD pair (source file + bundle dir) failed mid-way | `舊版本歸檔失敗，新檔暫不接受。請使用者改檔名或先清除 incoming/<stem>*` | Rollback both renames; reject the new upload; surface to user; admin investigates fs permissions |
| `VERSION_RENAME_COLLISION` | dispatcher (version-rename helper) | timestamped sibling `incoming/<stem>-<ts>.<ext>` already exists | (handled internally — appends `-1`, `-2`, …; no failure manifest) | None — silently disambiguates suffix; both file and dir use the same final suffix to keep the pair aligned |
| `MANIFEST_WRITE_FAILED` | dispatcher | host filesystem error during manifest write | `磁碟寫入錯誤：無法寫入 manifest（<errno>）` | Ops investigates disk; retry by user not useful |
| `UNSUPPORTED_FORMAT` | dispatcher | mime is xlsx / pptx | `此格式（<xlsx \| pptx>）目前不支援自動拆解；請使用者轉成 .docx 後再上傳` | AI advises user to convert; future xlsx-mcp / pptx-mcp closes the gap |

## Error message constraints (reinforces DD-6)

For every entry above with a `manifest reason` cell:

- **Exactly one sentence.** No multi-line. No bullet points.
- **Plain language only.** No stack trace. No file path. No
  internal class / function names. No mime string verbatim
  (use the user-facing format name: "docx", "舊式 Office", etc.).
- **Always carries enough information for the AI to relay it
  faithfully to the user** without having to ask follow-up
  diagnostic questions.
- **Always written in the user's interface language.** This catalogue
  shows the Traditional Chinese forms used in this deployment;
  i18n for other locales is out of scope for this spec but the
  reason field is locale-aware by design.

## Failed-manifest cache policy (DD-12)

Failed manifests ARE cached on disk. A re-upload with matching
`source.sha256 + source.filename` returns the cached failure
manifest — the dispatcher does NOT re-attempt decompose on
re-upload. To retry, the user must do one of:

1. Modify the file content (any change → new sha → cache miss → fresh attempt)
2. Manually clear: `rm -rf incoming/<stem>/` (then re-upload triggers fresh attempt)

The routing hint MUST flag a cached-failure result explicitly with
the `**過去拆解曾失敗**` prefix and include both retry paths in
plain language so the AI can relay them to the user. See DD-12.

## Telemetry mapping

Every entry above (except internally-handled ones marked with
`(handled internally)`) emits one `incoming.decompose` event with
`status = "failed"` (or `"unsupported"`) and `reason` matching the
manifest reason. Cache-hit on a failed manifest emits
`incoming.decompose` with `cache: "hit"` and `status: "failed"`
(not a fresh decompose attempt). See observability.md.
