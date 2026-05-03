# Tasks: docx-upload-autodecompose

Phases are rhythmic checkpoints (per plan-builder §16.5), not pause
gates. The build loop runs phases back-to-back unless a real stop gate
fires (see handoff.md).

Cross-repo: phases 1–2 land in docxmcp first, phases 3–8 land in
opencode and bump the docxmcp submodule pointer. All within one
coordinated change set.

## 1. Build the all-in-one decompose entry on docxmcp

- [x] 1.1 Add `bin/extract_all.py` orchestrator that calls existing extract_text / extract_outline / extract_chapter as Python functions (not subprocesses) over the unpacked tree
- [x] 1.2 Add template extraction sub-step: copy `word/styles.xml`, `word/theme/theme*.xml`, `word/numbering.xml`, `word/settings.xml`, `word/fontTable.xml` from the unpacked tree to `<doc-dir>/template/`
- [x] 1.3 Add `template.dotx` repackager: copy source.docx, rename to .dotx
- [x] 1.4 Add manifest emitter: write `<doc-dir>/manifest.json` per data-schema.json with `decomposer = "docxmcp.extract_all"`
- [x] 1.5 Add validator step for `template.dotx`: opens via OpcPackage (not Document — python-docx refuses .dotx by content type) and checks document + styles parts present; on failure drop the .dotx but keep raw XML
- [x] 1.6 Register `extract_all` in `bin/_mcp_registry.py`
- [x] 1.7 Smoke test: 29 KB → 63 ms; 8.4 MB → 913 ms; 56 MB → 72 s (full path; the 56 MB result is what triggered DD-1 amendment + DD-11)

## 1b. Async refactor (added in-place 2026-05-03 per DD-1 amend + DD-11)

- [x] 1b.1 Split extract_all into fast phase (outline + template + manifest skeleton) and background phase (body + chapters + tables + media)
- [x] 1b.2 Skip `collect_toc_titles` in the fast outline path (16 s saved on 56 MB fixture; TOC enrichment only useful for editing flows that call extract_outline directly)
- [x] 1b.3 Implement detached background via double-fork (parent → intermediate → grandchild reparented to PID 1); falls back to non-daemon thread on platforms without fork
- [x] 1b.4 Write `_PENDING.md` markers in chapters/, tables/, media/ at fast-phase return; remove markers on background completion
- [x] 1b.5 Add `extract_all_collect` MCP tool: blocks up to `wait` seconds (default 60) waiting for background_status to flip from running; returns updated manifest; bundle producer ships the new files
- [x] 1b.6 Smoke test 56 MB fixture: fast 10.4 s + background 46 s; manifest correctly flips running→done; markers cleaned up; 25 files indexed

## 1c. docxmcp incremental-bundle support (added in-place 2026-05-03)

- [x] 1c.1 Replace the per-call `pre_snapshot` model in `bin/mcp_server.py` with a per-token `_last_bundled_state` registry; bundle producer diffs against this and updates it after each ship
- [x] 1c.2 Smoke-test polling: 5 rounds (initial → no-change → add → modify → no-change) verify each round ships exactly the new/modified files

## 1d. Dispatcher-side polling support (will land in opencode phase 3)

- [ ] 1d.1 After publishing the fast-phase bundle, start a polling loop: every 5 s call `extract_all_collect` with `wait=0`
- [ ] 1d.2 On each poll's bundle return, publish the new files into the same `incoming/<stem>/` tree (overwrites manifest; if pending markers are absent from the bundle, they have been removed by docxmcp and dispatcher should also remove the host-side copies)
- [ ] 1d.3 Stop polling when the returned manifest's `background_status != "running"` OR after 180 s safety cap
- [ ] 1d.4 Re-render routing hint after each poll that brought new files; the next AI turn sees a progressively more complete tree
- [ ] 1d.5 If the safety cap is hit while still running, surface "background extraction taking longer than expected; continuing in container, will not be visible on host until next collect call" in routing hint
- [ ] 1d.6 If polling returns with `background_status = "failed"`, stop polling and surface the `background_error` in routing hint

## 2. Ship docxmcp container (rebuild + restart, NOT submodule pointer)

Per DD-10 rewrite: docxmcp is an independently-deployed Docker
service, not a git submodule of opencode. The "ship" step is a
container rebuild + restart, which requires user consent because it
briefly interrupts any in-flight docx work on the host.

- [x] 2.1 Commit Phase 1 / 1b / 1c changes to docxmcp `main` (commits d155f90 + eeae97e)
- [x] 2.2 Get user consent for container rebuild + restart
- [x] 2.3 `docker compose -p docxmcp-pkcs12 build && up -d` (done 2026-05-03; container healthy; 22 tools registered including extract_all + extract_all_collect)
- [x] 2.4 Verify by manual call: `extract_all` over MCP against a known fixture; confirms tool reachable from opencode side

## 3. Wire the upload-time decompose hook into tryLandInIncoming

Per DD-9 (rewritten 2026-05-03): the hook lives in
`packages/opencode/src/session/user-message-parts.ts` inside
`tryLandInIncoming`, NOT in `incoming/dispatcher.ts` (which is the
MCP-tool dispatcher, a different concern).

- [ ] 3.1 Add `packages/opencode/src/incoming/office-mime.ts` helper: classifies mime + filename extension into `docx | doc | xls | ppt | xlsx | pptx | non-office`
- [ ] 3.2 Add `packages/opencode/src/incoming/manifest.ts`: read / write helpers for `incoming/<stem>/manifest.json`; validates against `data-schema.json`
- [ ] 3.3 Add cache lookup helper: given `(stem, sha256, filename)`, read prior manifest if present, return `hit | fresh | regen` per DD-5 + DD-12 (DD-12: failed manifests count as `hit`)
- [ ] 3.4 Add a 30 s hard timeout wrapper around the `extract_all` MCP call (using AbortController; on abort the failure-recorder writes `DECOMPOSE_TIMEOUT`)
- [ ] 3.5 Wire `tryLandInIncoming`: AFTER successful land for an Office mime, call the dispatch hook synchronously; do not return until the fast phase has either landed its bundle OR failed/unsupported
- [ ] 3.6 Office hook integrates with `IncomingHistory` so the upload entry's history journal gets `decompose:<status>` annotation
- [ ] 3.7 Unit test: tryLandInIncoming with Office mime + non-Office mime; confirm Office triggers hook, non-Office does not

## 4. Paired version-rename helper (replaces existing nextConflictName behaviour for Office uploads)

- [ ] 4.1 Add `packages/opencode/src/incoming/version-rename.ts`. Helper takes `{stem, ext, projectRoot, oldUploadedAtIso}` and atomically renames BOTH `incoming/<stem>.<ext>` → `incoming/<stem>-<ts>.<ext>` AND `incoming/<stem>/` → `incoming/<stem>-<ts>/`
- [ ] 4.2 Atomicity: rename source file first; if dir rename fails, roll back the source file rename. Both succeed or both revert.
- [ ] 4.3 Suffix collision (sibling already at `<stem>-<ts>.*` exists): append `-1`, `-2`, ... — same suffix on both file and dir to keep the pair aligned
- [ ] 4.4 Wire into `tryLandInIncoming`: when sha drift detected for an Office mime, call this helper instead of `nextConflictName` on that path
- [ ] 4.5 Unit test: two uploads same name different content; expect canonical pair + one timestamped sibling pair; verify pair alignment (manifest's source.filename matches its sibling on disk)
- [ ] 4.6 Unit test: simulated dir-rename failure; verify source file rename was rolled back (no half-state on disk)

## 5. Rewrite the legacy OLE2 scanner to preserve layout

- [ ] 5.1 In `packages/opencode/src/tool/attachment.ts` (or extract to a shared module if dispatcher will own it; suggested: lift to `packages/opencode/src/incoming/legacy-ole2-scanner.ts`)
- [ ] 5.2 Two-pass scan: ASCII / UTF-8 single-byte; UTF-16LE
- [ ] 5.3 Preserve CR / LF / tab as structural newlines; preserve leading whitespace; do not dedup; prefer UTF-16LE pass when byte coverage overlaps
- [ ] 5.4 Apply density threshold (configurable via tweaks.cfg, default 0.4) to drop pure-noise lines
- [ ] 5.5 Write output to `<stem>/body.md` and `<stem>/manifest.json` with `decomposer = "opencode.legacy_ole2_scanner"`
- [ ] 5.6 Wire .doc / .xls / .ppt mimes in the dispatcher to call this scanner instead of going to docxmcp
- [ ] 5.7 Unit test against a known reference .doc fixture: verify ≥ 90% of newlines and leading whitespace preserved (per AC-10)

## 6. Wire xlsx / pptx unsupported path + failure recorder

- [ ] 6.1 Add unsupported note writer: takes stem, writes `incoming/<stem>/unsupported.md` with the canonical "convert to docx" message + manifest with status=unsupported
- [ ] 6.2 Add failure recorder: takes stem + reason string, writes `incoming/<stem>/failure.md` + manifest with status=failed
- [ ] 6.3 Wire xlsx / pptx mimes in the dispatcher to call the unsupported writer
- [ ] 6.4 Wire all decompose paths to call the failure recorder on exception / timeout
- [ ] 6.5 Verify: failure recorder is called for docxmcp timeout, docxmcp protocol error, legacy scanner exception, unsupported writer file IO error

## 7. Rewrite the routing hint generator

- [ ] 7.1 In `packages/opencode/src/session/message-v2.ts`, replace the docx / xlsx / pptx routing hint blocks with a single manifest reader
- [ ] 7.2 Implement the fold rule (DD-7): lists ≤ 4 show all, lists > 4 show first + `（還有 N 份，共 M 份）`
- [ ] 7.3 Implement the soft-fail wording (DD-6): always include the failure reason verbatim from manifest
- [ ] 7.4 Implement the unsupported wording (DD-7 + spec.md): always advise convert-to-docx
- [ ] 7.5 Always close every variant with the two-line action contract
- [ ] 7.6 Snapshot tests for each variant: small docx, large docx (fold), legacy .doc, unsupported .xlsx, soft-fail timeout

## 8. Strip docx / Office branches from the AI-callable upload-time tool

- [ ] 8.1 Remove the `OFFICE_MIME_REDIRECT` map from `packages/opencode/src/tool/attachment.ts`
- [ ] 8.2 Remove the OLE2 fallback scanner from attachment (lifted to phase 5's location)
- [ ] 8.3 Remove the docx / .doc / .xls / .ppt / .xlsx / .pptx error messages from the `mode='read'` path
- [ ] 8.4 Update tool description: "AI-callable query tool for image / PDF / text / JSON refs only"
- [ ] 8.5 Update `attachment.test.ts`: remove docx and OLE2 tests (their replacements live in dispatcher tests)
- [ ] 8.6 Verify `grep -E "doc|xls|ppt|office" packages/opencode/src/tool/attachment.ts` returns nothing format-related

## 9. Telemetry + gitignore + verification + DD-14 follow-ups

- [ ] 9.1 Add `incoming.decompose` event emission in dispatcher (mime, byte_size, duration_ms, cache, status, reason?)
- [ ] 9.2 Verify docxmcp `_token_store` TTL ≥ MAX_BACKGROUND_AGE (DD-14 G13); extend to 1800 s if shorter
- [ ] 9.3 Add `/incoming/` to `.gitignore`
- [ ] 9.4 Run full attachment test suite: must still pass for image / PDF / text / JSON paths
- [ ] 9.5 Run integration test: upload a real-world docx end-to-end; assert manifest written, routing hint rendered, AI session sees the hint
- [ ] 9.6 Stale-running recovery test (DD-14 G6/G7/G8): seed a manifest with bg=running + uploaded_at > MAX_BACKGROUND_AGE; re-upload same file; assert version-rename of stale + fresh decompose
- [ ] 9.7 Container-restart recovery test (DD-14 G7): start fast phase + collect call returns token_not_found; assert manifest flips to failed with the canned reason; no infinite poll
- [ ] 9.8 Sync `specs/architecture.md` upload section with the new SOP
- [ ] 9.9 Promote spec to `verified`
