# Event: Frontend OOM RCA — 2026-04-20

一天的 session，使用者從「瀏覽器 Out of Memory 打不開 webapp」開始回報，
層層挖到多個獨立問題。本文件只記事實 + 開放項目；**不含**修法細節（留給
後續 plan 處理）。

---

## Issue 索引（9 個獨立問題）

| # | Title | Status | 後續追的 plan slug |
|---|---|---|---|
| I-1 | 大 session / streaming part OOM | 部分修（lazyload plan phase 3+4 ship 於 beta） | `frontend-session-lazyload`（已 planned） |
| I-2 | Project storage 878 筆 /tmp 殭屍 | storage 清理 + server 過濾 dead worktree | — |
| I-3 | session list 退回 roots-only + 保留 limit fallback | 已 revert commit `c32b9612b` 的誤用 | — |
| I-4 | stale-status state machine wrong layer (commit `2fa1b0b2d`) | frontend 整塊 revert，backend 保留 | **需新 plan：data-freshness 重寫 Problem 2** |
| I-5 | frontend build 被兩個 pre-existing bug 卡死 | drive-by fix（i18n quoting + SDK v2 barrel） | — |
| I-6 | FoldableMarkdown 空白渲染（我新引入的 regression） | 改 Switch/Match 模式已修 | — |
| I-7 | test 跑 bun test 會把 Project / Session 寫進真 XDG storage | **未修**，是 I-2 的根因 | **需新 plan：test storage 隔離** |
| I-8 | 閒置 TUI 在 pts/4 持續燒 93% CPU 5 小時 | 使用者手動 kill 關掉，但根因未查 | **需新 plan：TUI reactive hot-loop RCA** |
| I-9 | Client ↔ Server 無 schema/version 協商 | 設計缺口 | **需新 plan：runtime version handshake** |

**總計：9 個 issue，3 個已完整解決，4 個部分解決，2 個完全未修需獨立 plan。**

---

## 詳細脈絡

### I-1 大 session / streaming part OOM（原始症狀）

- 使用者回報：瀏覽器打開 webapp 後自動跳到最後一個 active session，tab 直接 Out of Memory
- 觀察：daemon log 顯示 `totalPartChars=3035961` 單一 part 累積 3MB+ 文字、`updates=10000+` delta
- 根因：AI SDK 每次 delta 會 rebuild 整段文字；SSE `message.part.updated` 把 rebuild 結果推到前端；前端對每次 rebuild 都 re-render
- 已啟動 plan：`specs/frontend-session-lazyload/`（seven-state 已推到 `implementing`，beta 分支 4 個 commit：meta endpoint、tweaks.cfg keys、part-level tail-window + fold UI、scroll-spy + 動態 page size）

### I-2 Project storage 878 筆 /tmp 殭屍

- 觀察：`GET /api/v2/project` 回 898 筆、response 183KB；前端 Solid 為每筆建 reactive entry → bootstrap 時 OOM
- 細分：878 筆 `worktree` 在 `/tmp/opencode-test-*`、20 筆真實專案、2 個死目錄
- 已做：
  - 878 筆備份到 `~/opencode-project-storage.bak-20260420-1542/`
  - `packages/opencode/src/project/project.ts` `Project.list()` 過濾 `worktree` 不存在者（log.warn 留痕）
- **未解的根因**：見 I-7

### I-3 session list 一次載 root + 所有 subsession

- commit `c32b9612b` (2026-04-09) 的 `loadRootSessionsWithFallback` 移除 `roots: true`、同時 fallback 路徑也拿掉 `limit`
- 使用者記憶：「原本 session list 有 lazy load，只列近一週，顯示更多按鈕被動加載」→ 那個行為被這個 commit 打壞
- 已做：`packages/app/src/context/global-sync/session-load.ts` 恢復 `roots: true` 且 fallback 路徑也保留 `limit`

### I-4 stale-status state machine 方向錯了（核心 OOM 兇手）

- 症狀：試過所有帳號、清瀏覽器、incognito 都 OOM 在進入點
- 追查 frontend 最近 12–24 小時 commit → `2fa1b0b2d` 「fix subagent continuation and stale web status handling」
- 根因分析：
  - 該 commit 綁了兩個問題：Problem 1 subagent continuation (backend，寫得對) + Problem 2 stale web status handling (frontend，方向錯)
  - Problem 2 設計預設：「連線斷是罕見事件，斷了用 UI 強提醒」
  - 實際情境：有 proxy / NAT / keepalive timeout 的網路，SSE 斷斷續續是**常態**（本機 gateway↔browser 每 ~250ms flap）
  - 把「連線 health」當「資料 freshness」的代理 → 每次瞬斷都觸發 `connectionStatus` 狀態機、toast、memo、force-sync，放大成 OOM
  - 在 SSE for-await 每 event 都 `setConnected()` 呼叫一次，signal 讀寫風暴
- 已做：
  - Frontend 8 個檔案退到 `2fa1b0b2d~1` 狀態（preserving 後續 commit `b93d83804` 等的無關改動）
  - 刪掉 2 份描述錯方向的 event docs (`event_20260419_web_connection_stale_status_*.md`)
  - Backend subagent continuation 相關（session/todo.ts、tool/task.ts、coding.txt）保留不動
- **未解**：Problem 2（stale UI detection）需要用**正確方向**重寫——見新 plan

### I-5 frontend build pre-existing bug

- 發現於 `./webctl.sh dev-refresh` 的 frontend build step 失敗
- Bug A：15 個 `packages/ui/src/i18n/*.ts` 的 `ui.question.unreadable` 字串缺引號，esbuild 解析失敗（早上 02:35 引入）
- Bug B：`packages/sdk/js/src/v2/index.ts` 用 `export * from "./server.js"` 把 `node:child_process` 拖進 browser bundle
- 已做：為 16 個 locale 補引號；v2/index.ts 改為只 re-export 型別

### I-6 FoldableMarkdown 空白渲染（我 intro 的 regression）

- Phase 3 lazyload 寫的 `FoldableMarkdown` 四個 `<Show>` 漏掉 `streaming && !truncated` 情境，text/reasoning part 整段不 render
- 已改用 `<Switch>` 加顯式 `"full"` default fallback

### I-7 test 污染真 XDG storage

- `packages/opencode/src/global/index.ts:30` 的 `OPENCODE_DATA_HOME` 只在預設 XDG path `EACCES` 時才當 fallback
- `bun test` 一般在 user 權限下，不觸發 fallback → 直接寫 `~/.local/share/opencode/storage/project/`、`/storage/session/`
- 因此測試每跑一次就留 project / session 垃圾（I-2 的根因）
- auto-memory `feedback_beta_xdg_isolation.md` 也曾提到這個（2026-04-18 codex-rotation-hotfix 測試把真 accounts.json 壓爛）
- **未修**：需要 test 強制設 `OPENCODE_DATA_HOME` 或 `XDG_*_HOME` 到 tmpdir，或改 Global.Path 邏輯優先讀 env

### I-8 閒置 TUI 93% CPU 5 小時

- 追到 `bun run dev` 進 TUI 主入口 → `packages/opencode/src/cli/cmd/tui/`
- `strace -c` 2 秒內 1164 futex + 87 sched_yield → thread contention hot loop
- State `S`（interruptible sleep）+ 93% CPU 矛盾合理：被頻繁喚醒，但 snapshot 大多落在 sleep phase
- 沒有 `connectionStatus` 相關（已 grep 確認）
- 使用者已手動 kill 3803824
- **未修**：TUI 內部 reactive loop 有 bug，來源未查

### I-9 Client ↔ Server 無版本協商

- 從 I-8 衍生的觀察：iterative dev 階段長活的舊 TUI / 舊瀏覽器 tab 繼續用舊程式
- 舊 client + 新 server 可能：
  - 舊 schema 寫入 storage → 新 server 讀失敗或讀到混雜資料
  - 舊 API 契約打新 server → schema 驗證爆
  - 舊 client 消費新 event 種類 / 名稱對不上
  - 舊 client autonomous loop 持續污染 storage
  - 舊 client 持續觸發舊 bug
- 目前 opencode 無任何 server-restart broadcast / schemaVersion / build hash 比對
- **未設計**：之後可用 `/version` + client boot 時自檢；或 server restart 時廣播 `server.restart` event

---

## 已啟動 / 已 merge 的 plan

| Plan | State | 分支 | 說明 |
|---|---|---|---|
| `specs/frontend-session-lazyload/` | `implementing` | `beta/frontend-session-lazyload` → `test/frontend-session-lazyload` | Phase 1 (server meta + tweaks) + Phase 3 (part cap) + Phase 4 (scroll-spy + meta-driven page size) 已 commit；Phase 2 (escape hatch UI) 未做 |

## 尚未 commit 的狀態（test/frontend-session-lazyload working tree）

截至寫此 log 時：

```
 M packages/app/src/components/prompt-input.tsx      ← 退回 2fa1b0b2d~1
 M packages/app/src/context/global-sdk.tsx           ← 退回 2fa1b0b2d~1
 M packages/app/src/context/global-sync/session-load.ts  ← I-3 修復
 M packages/app/src/pages/layout.tsx                 ← 退回 2fa1b0b2d~1
MM packages/app/src/pages/session.tsx                ← 部分退回（保留 b93d83804 + 後續）
 M packages/app/src/pages/session/monitor-helper.ts  ← 退回 2fa1b0b2d~1
MM packages/app/src/pages/session/session-side-panel.tsx  ← 部分退回
 M packages/app/src/pages/session/tool-page.tsx      ← 退回 2fa1b0b2d~1
 M packages/app/src/pages/session/use-status-monitor.ts ← 退回 2fa1b0b2d~1
 M packages/opencode/src/project/project.ts          ← I-2 server 側修復
 D docs/events/event_20260419_web_connection_stale_status_implementation.md
 D docs/events/event_20260419_web_connection_stale_status_plan.md
```

---

## 開放項目（要在新 plan 處理）

1. **I-4 重寫 Problem 2：stale UI detection 用 data-freshness**
   - 每筆 session_status / active_child / process_card 掛 `receivedAt` timestamp
   - UI 用 freshness（距現在多久）決定是否顯示 stale 或隱藏
   - 完全不觸碰連線狀態
   - PromptInput 不再因為連線問題 block（send 本來就 queue 到 server）

2. **I-7 test storage 隔離**
   - `bun test` 必須在 tmpdir 下跑 Global.Path
   - 方案：改 `packages/opencode/src/global/index.ts` 讀 `OPENCODE_DATA_HOME` 時不只當 fallback，直接優先走
   - 或 test harness 設 env 強制導

3. **I-8 TUI hot loop RCA**
   - 在 user 有 stack trace 時用 `gdb -p <pid>` 抓
   - 或加 observability：TUI 內主要 effect 都加 log 追觸發頻率

4. **I-9 client↔server version handshake**
   - Server 啟動印 build hash，從 `/version` 暴露
   - Client 啟動拉一次、SSE event 裡每 N 分鐘夾一次比對
   - 不匹配 → client 強制 reload（瀏覽器）或顯示警告（TUI）

5. **I-1 lazyload 收尾**
   - Phase 2 escape hatch UI 跳過（Phase 3 tail-window 已解 streaming OOM）
   - 收掉 planner 暫擱置（等使用者驗證 beta/test 分支實際流暢度）
   - test/frontend-session-lazyload 分支 fetch-back / finalize 決定

---

## 重要實際數字快照

- session storage 總數：2459（其中 `/tmp` 250、活 worktree 2200、死 2）
- project storage 總數：清前 898 → 清後 20
- `/api/v2/provider` response：440KB（11 providers × 578 models，其中 vercel 235 + openrouter 216）
- `/api/v2/session?roots=true&limit=50` response：49KB / 50 items
- bundle 總大小：~16MB（main index ~705KB gzip 218KB）
- SSE disconnect 頻率（gateway↔browser path）：~250ms 週期（未查 gateway source，疑似 splice proxy idle timeout）

---

## 記憶 / 規則回顧

- `feedback_beta_xdg_isolation.md`（2026-04-18 event）已警告 bun test 污染真 XDG 問題（I-7）
- `feedback_no_silent_fallback.md` AGENTS.md 第一條（meta 呼叫失敗不 fallback、幾度在 RCA 中用到）
- `project_codex_cascade_fix_and_delta.md` AI SDK rebuild 模型的問題背景（I-1）
- `feedback_tweaks_cfg.md` 所有硬編碼閾值走 `/etc/opencode/tweaks.cfg`（I-1 的 Phase 1 遵循）
