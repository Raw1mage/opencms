# Tasks: repo-incoming-attachments

執行清單。每個 phase（`## N. ...` block）是 implementing-state TodoWrite 一次載入的單位。phase 內 task ID 對應到 spec.md 的 R / DD / Acceptance Check / sequence.json scenario，方便 sync drift 偵測時 trace 回 spec。

任何寫入 `incoming/<stem>/**` 的程式碼都要走 `incoming.dispatcher` 的 break-on-write helper（DD-11）。tool 直接 `fs.writeFile` 進 incoming 路徑屬於繞過、會在 phase 5 的 test vector 抓到。

---

## 1. Foundation：incoming module skeleton + paths + history

- [x] 1.1 建立 `packages/opencode/src/incoming/` 模組骨架：`paths.ts`, `history.ts`, `dispatcher.ts`, `index.ts` 公開 API
- [x] 1.2 實作 `paths.resolveProjectIncoming(sessionId)`：對應 R1-S1 / R1-S2，沒 project path 直接 reject
- [x] 1.3 實作 `paths.sanitize(filename)`：DD-12 NFC normalize → strip control chars → 256 chars cap → reject path traversal
- [x] 1.4 實作 `paths.nextConflictName(dir, filename)`：DD-8 `(N)` 後綴遞增，對應 SEQ-UPLOAD-CONFLICT 的 MSG-4
- [x] 1.5 實作 `history.appendEntry(filepath, entry)`：jsonl O_APPEND，advisory file lock 防 race（RK-2 緩解）
- [x] 1.6 實作 `history.readTail(filepath)`：取最後一筆 + history 行數計算（用於 historyVersion）
- [x] 1.7 實作 `history.lookupCurrentSha(filepath)`：DD-6 cheap stat → drift 偵測 → 視需要 append `drift-detected`，對應 SEQ-DRIFT-DETECT
- [x] 1.8 實作 `history.rotate(filepath)`：DD-13 ≥1000 行時 atomic rename `<filename>.<unix-ts>.jsonl`
- [x] 1.9 unit tests：`packages/opencode/test/incoming/paths.test.ts` + `history.test.ts` 覆蓋 sanitize / conflict / append / rotate / drift 各路徑

## 2. Upload Route：直連 incoming/，廢除 attachment cache 寫入

- [x] 2.1 在 `packages/opencode/src/server/routes/file.ts`（或現行 upload route）新增「resolveProjectIncoming → atomic write」主路徑，串流計算 sha256（RK-7 緩解）
- [x] 2.2 實作 dedupe / conflict-rename / fresh upload 三條分支判斷，對應 R5-S1 / R5-S2 / R1-S1
- [x] 2.3 上傳成功 emit Bus event `incoming.history.appended`（observability.md `evt:upload.received`）
- [x] 2.4 `attachment_ref` 回傳 schema 改成含 `repoPath` / `sha256` / `historyVersion` / `status`，保留 deprecated `refID` 別名（RK-6 緩解）
- [ ] ~~2.5 移除「上傳寫入 `~/.local/state/opencode/attachments/<refID>.*`」程式碼路徑；舊讀取路徑保留在 R10 走 fallback 報錯~~ (v1, SUPERSEDED 2026-05-03 — 此檔案路徑不存在)
- [ ] ~~2.5' 演進 SessionStorage.AttachmentBlob 結構~~ (v2, SUPERSEDED 2026-05-03 — DD-17 改為不動 schema)
- [ ] ~~2.5'' 改 getAttachmentBlob 雙路徑~~ (v2, SUPERSEDED 2026-05-03 — 改寫如下)
- [x] 2.5\* (v3, ADDED 2026-05-03)：在 [message-v2.ts](../../packages/opencode/src/session/message-v2.ts) 的 `AttachmentRefPart` zod schema 加 `repo_path?: string` + `sha256?: string` 兩欄（passthrough 即可）。**不動** SQL schema、不動 storage 介面
- [x] 2.5\*\* (v3, ADDED 2026-05-03)：[user-message-parts.ts:routeOversizedAttachment](../../packages/opencode/src/session/user-message-parts.ts) 改寫主路徑：resolveProjectIncoming → sanitize filename → atomic write to `<repo>/incoming/<filename>` → streaming sha256 → IncomingHistory.appendEntry → 把 `repo_path` + `sha256` 塞回 AttachmentRefPart、**不再呼叫 upsertAttachmentBlob**
- [x] 2.5\*\*\* (v3, ADDED 2026-05-03)：[tool/attachment.ts](../../packages/opencode/src/tool/attachment.ts) 雙路徑讀取 — 找到對應 part，先看 `part.repo_path`：在 → 從 repo 讀 bytes 組 AttachmentBlob；不在 → 走既有 `getAttachmentBlob` legacy path 撈舊 attachments 表（R10'-S2）。repo file 不存在則明確報錯 INC-3001'，不退回 legacy（R10'-S3）
- [x] 2.6 (deferred to phase 3) 刪除 `packages/opencode/src/tool/attachment.ts` 既有 docx 特化分支（pandoc subprocess、`extractDocxMarkdown` 提取等）— 移除前需要 dispatcher 在 phase 3 接通，否則 docxmcp 還沒掛上時 docx 檔案讀不開；維持 pandoc 路徑當 transitional fallback 直到 phase 3 完成
- [-] 2.6.1 (deferred to phase 3, see slice summary) 把 `tool/attachment.ts` 內 `attachmentKind` / `metadataFor` 等 helper 改為「從 AttachmentBlob row 拿 `repoPath` 後展示給 LLM 的是 repo-relative path 而非 refID」，配合 client 端 UI 也顯示 `incoming/合約.docx`
- [x] 2.7 integration tests：`packages/opencode/test/incoming/upload.test.ts` 跑 SEQ-UPLOAD-NEW / DEDUPE / CONFLICT 三個 scenario

## 3. mcp Dispatcher：stage-in / publish-out + sha-keyed cache

- [x] 3.1 在 `packages/opencode/src/incoming/dispatcher.ts` 實作 `before(toolName, args, appId)` → 解析 args 中的 incoming 路徑、stage 到 `mcp-staging/<app-id>/staging/<sha>.<ext>`
- [x] 3.2 實作 `lookupBundleCache(sha, appId)`：stat `mcp-staging/<app-id>/bundles/<sha>/`，命中時跳過 mcp tool（SEQ-MCP-DISPATCH-CACHE-HIT）
- [x] 3.3 實作 `after(toolName, result, ctx)` → 把 staging bundle hard-link 回 `<repo>/incoming/<stem>/`（DD-11）；同 fs 才嘗試 link，異 fs 直接 cp -r、emit `mcp.dispatcher.cross-fs-fallback`（DD-15）；append `bundle-published` 履歷
- [x] 3.3.1 實作 `rewriteResultPaths(result, ctx)`：DD-14 scoped string replacement，把 result 內所有 `/state/...` 與 `<staging-host>/...` 路徑反向映射成 `<repo>/incoming/...`，dispatcher 自己保留 (stagingPath, repoPath) 對應對；result 為 JSON 時 walk 所有 string field、為 text 時整段 replace
- [x] 3.3.2 cache-hit publish 前先讀 `bundles/<sha>/manifest.json`、比對 `manifest.sha256 == 目錄名 sha`（DD-16）；不一致 emit `mcp.dispatcher.cache-corrupted` + fall through 到 cache-miss 路徑；manifest 不存在則 log warning 但允許 publish（v1 漸進保護）
- [x] 3.4 實作 `breakHardLinkBeforeWrite(path)`：stat → if `st_nlink > 1` 則 `cp+rename`；提供給 Edit/Write/Bash tool 共用
- [x] 3.5 在 `packages/opencode/src/mcp/index.ts:convertMcpTool` execute 包裝：呼叫 `dispatcher.before` → 原 client.callTool → `dispatcher.after`
- [x] 3.6 path rewrite：args 中 `incoming/<filename>` → `/state/staging/<sha>.<ext>`，result 路徑反向映射
- [x] 3.7 cache hit / miss 各 emit Bus event（observability.md `evt:dispatcher.cache-hit` / `cache-miss`）
- [x] 3.8 integration test：`packages/opencode/test/incoming/dispatcher-cache-miss.test.ts` + `dispatcher-cache-hit.test.ts` 各跑一個 fake mcp app 走完 flow

## 4. Tool-write Hook：Edit / Write / Bash 觸碰 incoming/ 後補履歷

- [x] 4.1 找出所有對 host fs 寫入的 tool entry（Edit, Write, Bash 至少；另外掃 `packages/opencode/src/tool/` 找有寫檔的）
- [x] 4.2 在 tool execute 後加 hook：若有任何 path match `<repo>/incoming/**`，呼叫 `incoming.history.touchAfterWrite(path, source: "tool:<name>")`
- [x] 4.3 hook 內部：`break-on-write`（若 nlink>1）→ 重算 sha256 → append history entry
- [x] 4.4 對應 R6-S1 / R6-S2、SEQ-TOOL-WRITE-HOOK
- [x] 4.5 negative test：故意有一個 tool 繞過 hook 直接 fs.writeFile，驗證 cache 內容**會**被污染（這是 RK-1/RK-3 的 known gap，confirm test 是用來鎖住 break-on-write 規則覆蓋率，未來新加 tool 必須過此 test）

## 5. End-to-end：docxmcp 接到新 dispatcher、跑通完整流程

- [ ] 5.1 docxmcp `mcp.json` 不變（仍 mount `/state`），但實際 mount 由 dispatcher 改成 `~/.local/state/opencode/mcp-staging/docxmcp/:/state`（DD-5 的通用結構）
- [ ] 5.2 在 docxmcp 容器內驗證可以從 `/state/staging/<sha>.docx` 讀檔、寫產物到 `/state/bundles/<sha>/`
- [ ] 5.3 跑 SEQ-MCP-DISPATCH-CACHE-MISS：上傳 → docx_decompose → 確認 `incoming/<stem>/` 出現預期內容
- [ ] 5.4 跑 SEQ-MCP-DISPATCH-CACHE-HIT：在另一個 project session 上傳同 sha 內容 → 確認 mcp tool 沒被呼叫、bundle 直接 hard-link publish
- [ ] 5.5 跑 SEQ-UPLOAD-CONFLICT：模擬 docx_recompose 改寫原檔後再上傳原版 → 確認落 `<filename> (2).docx`、新獨立履歷、原檔履歷 append `upload-conflict-rename`
- [ ] 5.6 break-on-write 驗證：先 publish bundle，然後用 Edit tool 改 `incoming/<stem>/description.md` → 用 `stat` 確認 cache 端 `mcp-staging/.../bundles/<sha>/description.md` 的 inode 沒變（沒被污染）
- [ ] 5.7 drift 驗證：用 host shell 直接 `echo` 改寫 `incoming/X.docx`，下次 history lookup 應 append `source: drift-detected`
- [ ] 5.8 cross-fs fallback 驗證：把 `<repo>` 放在 tmpfs / 不同 mount point，confirm dispatcher.publish 走 `cp -r` 路徑、emit `cross-fs-fallback` event、功能照常（DD-15 / TV-17）
- [ ] 5.9 docxmcp manifest.json 合約驗證：confirm docxmcp v1 在 `bundles/<sha>/manifest.json` 寫入符合 [BundleManifest schema](data-schema.json) 的 JSON、含 sha256；故意 corrupt manifest 後 confirm dispatcher fall-through 重算 + emit `cache-corrupted`（DD-16 / TV-18）
- [ ] 5.10 result path rewriting 驗證：docxmcp tool result 內含 `/state/bundles/<sha>/description.md` 字串，dispatcher.after 必須改寫成 `incoming/合約/description.md` 才回給 LLM（DD-14 / TV-19）

## 6. Documentation + Cross-repo sync

- [x] 6.1 更新 `specs/architecture.md`：新增「Incoming Attachments Lifecycle」段落，描述 incoming/ 模型、履歷契約、mcp dispatcher 邊界、break-on-write 規則
- [x] 6.2 docxmcp repo `HANDOVER.md`「不要重新討論」清單中「Bundle 預設落點：XDG_STATE + by-session」標 `[SUPERSEDED 2026-05-03 → opencode/specs/repo-incoming-attachments/]`
- [x] 6.2.1 docxmcp repo `HANDOVER.md`「不要重新討論」新增一條：「每個 bundle 必含 `manifest.json`，schema 見 opencode/specs/repo-incoming-attachments/data-schema.json#BundleManifest，至少 sha256/appId/appVersion/createdAt」(DD-16 跨 repo contract)
- [x] 6.2.2 docxmcp 軌 B1 (`bin/docx_decompose.py`) 實作必須包含寫 `manifest.json` 的最後一步；這條任務在 docxmcp Wave 3 軌 B 執行，但本 spec 在這裡留 trace 紀錄
- [x] 6.2.3 multi-tool sub-namespace 規約寫進 docxmcp `HANDOVER.md`：core decompose 寫 `incoming/<stem>/{description.md, outline.md, media/}`，其他 tool（grep/to_images）必須用 `incoming/<stem>/<tool-name>/` 子目錄（OQ-7）
- [ ] 6.3 docxmcp repo `PLAN_opencode_integration.md` 軌 B 預期 bundle 落點段落同步更新
- [ ] 6.4 開 docs/events 寫一篇 launch event：`docs/events/event_<launch-date>_repo-incoming-attachments-launch.md`
- [ ] 6.5 client（web、TUI）upload UI：將 attachment 卡片顯示文字從 ref 改為 `<repo>/incoming/<filename>`，與 `repoPath` 欄位對應
- [ ] 6.6 web UI 顯示 dispatcher cache-hit 時的視覺提示（「從快取載入，未重算」）— 對應 observability.md `evt:dispatcher.cache-hit`

## 7. Verification + Promotion

- [ ] 7.1 跑全套 unit + integration tests，確認 15 條 Acceptance Check 全綠
- [ ] 7.2 手動 smoke：上傳 → decompose → recompose → 再上傳 → drift → 跨 session cache hit
- [ ] 7.3 `bun run scripts/plan-sync.ts specs/repo-incoming-attachments/` 跑一次最終 sync，確認沒 drift warning
- [ ] 7.4 promote `verified`：`bun run scripts/plan-promote.ts specs/repo-incoming-attachments/ --to verified --reason "all 15 ACs pass; manual smoke OK"`
- [ ] 7.5 PR merge into baseBranch
- [ ] 7.6 promote `living`：`--to living --reason "merged"`
