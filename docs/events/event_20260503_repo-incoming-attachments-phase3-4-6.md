# 2026-05-03 — repo-incoming-attachments / Phase 3+4+6 Slice Summary

合併 phase 3（dispatcher 全套）、phase 4（tool-write hook）、phase 6（docs sync）。phase 5（docker 真實 e2e）刻意留給 user 手動 smoke — 配套說明在最末段。

## Phase 3 — dispatcher

實作 `packages/opencode/src/incoming/dispatcher.ts` 從 stub 改為完整 stage-in / publish-out / sha-keyed cache：

- **DD-3 mount 邊界**：`STAGING_BASE = ~/.local/share/opencode/log/...mcp-staging/` 是唯一容器看得到的根。容器內路徑 `/state/staging/<sha>.<ext>` 與 `/state/bundles/<sha>/`。
- **DD-11 + DD-15 publish**：`copyTreeWithFallback` 先比 `st_dev`，相同走 `link()` 遞迴硬連結；不同或 EXDEV 走 `cp -r`，emit `mcp.dispatcher.cross-fs-fallback` event。
- **DD-14 result rewriting**：`rewriteResultPaths` 走樹替換 string 欄。dispatcher 自己保留 `(stagingPath, repoPath)` mapping，不需 mcp app 配合。
- **DD-16 manifest integrity**：cache-hit publish 之前 `verifyManifest`，sha 不一致 emit `mcp.dispatcher.cache-corrupted` 並 fall through 到 cache-miss；manifest 不存在則 log warning 但 v1 仍允許 publish。
- **DD-17 cache hit short-circuit**：`before()` 偵測 stem 對應 sha 已有完整 bundle → publish + 設 `ctx.skipMcpCall=true` + 給 wrapper 一個 synthesized result，**不呼叫 mcp tool**。
- **break-on-write helper**：`breakHardLinkBeforeWrite(path)` 給 phase 4 / 任何寫入 `incoming/<stem>/**` 路徑前用。
- 所有 path-collecting / staging 路徑的 sync 版本走 `fssync.*Sync` API，因為 args rewriter 是同步 walker。

`packages/opencode/src/mcp/index.ts:convertMcpTool` 加上：
- 新 `serverName?: string` 參數，從 `mcpapp-<id>` 切出 `appId`
- execute 包成 `dispatcher.before → client.callTool(rewrittenArgs) | synthesized result → dispatcher.after`
- 任一 dispatcher 步驟 throw → fall back to raw mcp result，warn log

## Phase 4 — tool-write hook

`packages/opencode/src/incoming/index.ts` 新增兩個 helper：

- `maybeBreakIncomingHardLink(filepath)` — 路徑在 `<projectRoot>/incoming/**` 內且 `st_nlink > 1` 才 detach；否則 silent no-op
- `maybeAppendToolWriteHistory(filepath, toolName, sessionID)` — 路徑在 `incoming/<file>` → 寫進 `incoming/.history/<file>.jsonl`；路徑在 `incoming/<stem>/<rel>` → 寫進 `incoming/.history/<stem>.bundle.jsonl`

Edit / Write tool 兩個寫入點都包進這對 helper：
- `tool/write.ts` line 45 (Bun.write)
- `tool/edit.ts` line 64 (新建檔) + line 100 (in-place edit)

Bash tool 不 hook（無從攔截 shell 命令的 fs 寫入）。OQ-8 提到的「集中 fs adapter」未來可解。drift 偵測（DD-6）是漏 Bash 的 safety net。

## Task 2.6 — 移除 docx pandoc 特化

`tool/attachment.ts` 的 `extractDocxMarkdown`、`isDocxMime`、`DOCX_MIME` 常量、`defaultAgentForMime` 的 docx 分支整段移除。docx 現在透過 `docxmcp` + `IncomingDispatcher` 處理；如使用者真的要走 reader-subagent 路徑讀 docx，需要明確傳 `agent="docx-reader"`。對應 test 改成 assert「沒指定 agent 時 docx 應該 reject」。

## Phase 6 — docs sync

- `specs/architecture.md` 加一段 `## Incoming Attachments Lifecycle (2026-05-03)`，描述三層模型、dispatcher 邊界、observability 入口、cross-repo contract。
- `~/projects/docxmcp/HANDOVER.md` 「不要重新討論」清單：
  - 「Bundle 預設落點：XDG_STATE + by-session」標 SUPERSEDED → 指向本 spec
  - 新增「Bundle manifest.json 必含 sha256」DD-16 跨 repo 約定
  - 新增「Multi-tool sub-namespace」OQ-7 約定

## Log system — 給 user 實測用

opencode daemon 的 log 從 `~/.local/share/opencode/log/debug.log` 出來，每行 JSON。本 spec 寫的事件 service tag：

```
"service":"incoming.history"        # 履歷 append / drift detect / rotate
"service":"incoming.dispatcher"     # cache hit/miss/corrupted/cross-fs/publish
"service":"incoming.tool-hook"      # tool-write hook break / append
```

**tail 命令（推薦你 ssh / tmux 開一窗跑）**：

```bash
tail -F ~/.local/share/opencode/log/debug.log | grep -E '"service":"incoming'
```

**Bus event 也想看，再開一窗**：

```bash
tail -F ~/.local/share/opencode/log/debug.log | grep -E '(incoming\.history|mcp\.dispatcher)'
```

事件清單：
- `incoming.history.appended` — 履歷新增（含 source: upload / upload-dedupe / upload-conflict-rename / tool:* / drift-detected / bundle-published）
- `mcp.dispatcher.cache-hit` — sha-keyed bundle 命中、跳過 mcp tool
- `mcp.dispatcher.cache-miss` — 真的呼叫 mcp tool
- `mcp.dispatcher.cache-corrupted` — bundle manifest sha 對不上目錄名
- `mcp.dispatcher.cross-fs-fallback` — repo 與 staging 不同 fs，cp 取代 link
- `incoming.dispatcher.publish-failed` — bundle 寫回 incoming/ 失敗（disk full、permission）

## Manual smoke procedure（phase 5 你的功課）

1. **重啟 daemon**（讓 phase 1-4 程式被載入）。daemon restart 由你決定何時做（memory rule 規定要徵得你同意）。重啟後 daemon process 跑的就是新版。
2. **開兩個 tail 窗**（上面命令）。
3. 在某個 git project 的 opencode session 內**上傳一個 .docx**：
   - 預期 log：`incoming.history.appended source=upload`
   - 預期 fs：`<projectRoot>/incoming/<filename>` 出現、`incoming/.history/<filename>.jsonl` 第一行為 upload
4. 對話請 AI 跑 `docx_decompose(incoming/<filename>)`：
   - 預期 log（首次）：`mcp.dispatcher.cache-miss` → docxmcp 容器執行
   - 預期 fs：`<projectRoot>/incoming/<stem>/{description.md,outline.md,...}` 出現、`incoming/.history/<stem>.bundle.jsonl` 寫一筆 `bundle-published`
5. **同 session 再呼叫一次同檔**：
   - 預期 log：`mcp.dispatcher.cache-hit`（manifest 對得上時）
   - 預期 fs：bundle 不被重新 link，`incoming/<stem>/` 不變
6. **跨 project 測試 cache 共用**：另一個 git project 上傳完全相同內容的 docx，再叫 docx_decompose。預期 cache-hit + 跳過 docxmcp 容器。
7. **break-on-write 驗證**：用 AI Edit tool 改 `incoming/<stem>/description.md`。改完用 `stat` 看 cache 端 (`~/.local/share/opencode/log/...mcp-staging/docxmcp/bundles/<sha>/description.md`) 的 inode 不變。
8. **drift safety net**：用 host shell `echo 'tampered' > <projectRoot>/incoming/foo.docx`，下次 attachment tool 讀履歷會 emit `incoming.history.appended source=drift-detected`。

如果第 4 步 docxmcp 容器尚未實作 manifest.json（DD-16），cache-hit 永遠不會發生；每次都 cache-miss + 重算。對 docxmcp 軌 B 的提示已寫入 docxmcp HANDOVER.md。

## Validation

- `bun test packages/opencode/test/incoming/ packages/opencode/src/tool/attachment.test.ts` — **51/51 PASS**, 147 expects, 1.73 s
- `tsc --noEmit` 對 incoming/ + dispatcher.ts + mcp/index.ts + tool/(edit|write).ts + attachment.ts 全清；剩下 mcp/index.ts:1053 是 pre-existing 不關本次
- `plan-validate` 13/13 PASS at state=implementing
- AC-01..AC-15c 對應的 unit / integration test 全部走過。AC-13（mount 列表審計）只能在真實 docker run 下檢查 → 第 3 步 manual smoke 觀察 docker run command 的 -v 參數即可

## Drift handled

無新增 drift。原 R1-S2 fail-fast → graceful fallback 在 phase 2 已處理。

## Remaining

- **Phase 5 manual smoke** — 你做（log + procedure 在上面）
- **Phase 6.3-6.6** — docxmcp PLAN_opencode_integration.md 軌 B 文件同步、docs/events launch event、client UI 改顯示 repoPath、web UI cache-hit 標記。這些非阻擋；可跟 docxmcp Wave 3 合併處理。
- **Phase 7 promote 到 verified** — 等你 manual smoke 確認沒 regression 再走（一條 plan-promote 命令）
- **OQ-7/8/9** — implementing 中觀察到的 P1，目前還沒踩到，post-launch 再評估
