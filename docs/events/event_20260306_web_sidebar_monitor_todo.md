# Event: Web Sidebar Monitor and Todo Panels

Date: 2026-03-06
Status: In Progress

## 需求

- web app 目前缺少 task monitor 與 todo list 的 sidebar 顯示面板
- 希望可在 banner bar 的 file-list 按鈕上做 toggle 輪動顯示
- 優先沿用現有 session side-panel / file-tree 架構，避免大規模重做
- mobile web 也必須看得到 file-list 切換鈕，且 monitor / todo / files 應以全版面檢視後再關閉返回對話
- mobile web 的 terminal 不應再用下半部 inline panel，而應改走獨立 full-screen terminal 頁面
- mobile web 的 file list / todo list / task monitor / terminal 既然都採獨立頁面，就應共用同一顆 launcher 按鈕進入
- task monitor 在 web 應對齊 TUI 可見行為；至少要補上與 TUI 一致的 fallback monitor row 合成邏輯，避免空白

## 範圍

### IN

- 檢查 web 端現有 session side-panel / header toggle 架構
- 盤點 monitor / todo 後端資料是否已存在並可供 web 使用
- 補齊 web 端必要 state / UI / toggle 邏輯
- 驗證 typecheck，並記錄 Architecture Sync 結果

### OUT

- 不重做整個 session 版面配置
- 不修改 TUI sidebar 行為
- 不變更 monitor / todo 後端資料模型

## 任務清單

- [ ] 盤點 web session side-panel、header file-list 按鈕、todo/monitor 資料來源
- [ ] 設計 file-list 按鈕輪動規則與 sidebar state
- [ ] 實作 web todo / monitor sidebar 與輪動切換
- [ ] 執行驗證並補齊 event / architecture sync 記錄

## Debug Checkpoints

### Baseline

- 已確認 banner file-list 按鈕位於 `packages/app/src/components/session/session-header.tsx`
- 已確認 web side-panel 位於 `packages/app/src/pages/session/session-side-panel.tsx`
- 已確認 web 端已有 todo 資料 cache：`packages/app/src/context/sync.tsx`、`packages/app/src/context/global-sync/types.ts`
- 已確認 server / SDK 存在 session top 監控 API：`packages/opencode/src/server/routes/session.ts`、`packages/sdk/js/src/v2/gen/sdk.gen.ts`
- 已確認 web 端目前尚無 monitor sidebar UI/state
- latest banner-unification round 前再次確認：`SessionHeader` 只掛在主 session 頁，`tool-page.tsx` 與 `terminal-popout.tsx` 仍各自渲染一條 local header，因此 mobile child page 會出現第二條 banner

### Execution

- 延用既有 `layout.fileTree` 狀態，將其擴充為 `mode = files | monitor | todo`，避免額外新增平行 sidebar 狀態機。
- `packages/app/src/context/layout.tsx`
  - persist 版本升級為 `layout.v7`
  - 新增 `fileTree.mode()` 與 `fileTree.show(mode)`
  - `fileTree.setTab(...)` 現在會強制切回 `files` 模式
  - `fileTree.toggle()` 改為 banner/file-list 輪動：`files -> monitor -> todo -> close`
- `packages/app/src/components/session/session-header.tsx`
  - banner file-list 按鈕沿用既有入口，但改接新的 panel cycle
- `packages/app/src/pages/session/index.tsx`
  - centered 版型判斷改為只在 `files + all` 時成立
  - `showAllFiles()` 若目前在 `monitor/todo`，會先切回 `files`
- `packages/app/src/pages/session/session-side-panel.tsx`
  - 右側 secondary panel 改為依 `layout.fileTree.mode()` 顯示 `files / monitor / todo`
  - todo panel：沿用既有 `sync.session.todo(sessionID)` 與 `sync.data.todo`
  - monitor panel：直接呼叫 `sdk.client.session.top({ sessionID, includeDescendants: true })`，顯示 branch monitor snapshot，並在 panel 開啟時每 2 秒輪詢一次
- mobile follow-up：
  - `packages/app/src/components/session/session-header.tsx`
    - file-list 按鈕從 desktop-only 改為 mobile 也可見，並放在右側控制列最右方
    - terminal 按鈕在小螢幕下不再 toggle inline panel，而是直接導向 `terminal-popout` route
  - `packages/app/src/pages/session/index.tsx`
    - mobile 下開啟 side panel 時，隱藏既有 `SessionMobileTabs`
    - inline `TerminalPanel` 只保留給大螢幕，避免手機鍵盤遮住 terminal
  - `packages/app/src/pages/session/session-side-panel.tsx`
    - 小螢幕下改為 full-screen overlay 模式，header 內建 close 按鈕，關閉後回到對話工作區
    - desktop 仍維持原本側欄模式與 resize handle
  - `packages/app/src/pages/session/terminal-popout.tsx`
    - 小螢幕下新增頂部 close/back bar
    - 若尚無任何 PTY，route 會自動建立第一個 terminal，確保 mobile 點入後不是空白頁
- launcher follow-up：
  - `packages/app/src/components/session/session-header.tsx`
    - mobile 改為單一 launcher 下拉選單，統一入口為：File list / Todo list / Task monitor / Terminal
    - desktop 保留原本 terminal / review / file tree 快捷按鈕
  - `packages/app/src/app.tsx`
    - 新增 mobile tool route：`/session/:id?/tool/:tool`
  - `packages/app/src/pages/layout.tsx`
    - `tool/:tool` route 比照 terminal popout，使用簡化 full-screen layout
  - `packages/app/src/pages/session/tool-page.tsx`
    - 新增 mobile 專用 full-screen tool page，承接 files / todo / monitor 三種頁面
  - `packages/app/src/pages/session/index.tsx`
    - mobile 不再嘗試顯示 side-panel；desktop 才保留 `SessionSidePanel`
  - `packages/app/src/pages/session/monitor-helper.ts`
    - 補上與 TUI 一致的 monitor fallback row 合成邏輯（session status + stats/messages）
  - `packages/app/src/pages/session/session-side-panel.tsx`
    - desktop monitor 顯示改用 shared monitor helper，避免 web/TUI 體感漂移
- launcher polish：
  - launcher 四個項目改為走 i18n key，繁中顯示為「檔案清單 / 工作監控 / 待辦列表 / 終端機」
  - `packages/app/src/pages/session/tool-page.tsx` 與 `terminal-popout.tsx` 的 mobile full-screen header 改成「左側標題、右側 × 關閉」設計，移除左側文字關閉按鈕
- launcher interaction polish：
  - mobile launcher 下拉內容改為四個 icon-only 入口，不再顯示文字標籤
  - tool subpage / terminal subpage 改為「點 banner 標題返回主頁」，右側 launcher 持續提供四個工具入口切換
- desktop launcher follow-up：
  - desktop 將原本分散的 files / todo / monitor / terminal 入口集中到單一 launcher
  - 顯示方式維持 desktop 既有行為：files/todo/monitor 仍走右側 side-panel，terminal 仍走底部 terminal panel
  - review toggle 保持獨立按鈕，不與四功能 launcher 混在一起
- shared-banner follow-up：
  - `packages/app/src/pages/session/tool-page.tsx`
    - 移除 child page 自帶的 local header / launcher
    - 改為直接渲染 `SessionHeader`，讓 title 與 launcher 統一回到主 banner
  - `packages/app/src/pages/session/terminal-popout.tsx`
    - 移除 mobile 專用 local header / launcher
    - 改為直接渲染 `SessionHeader`，由共享 banner 負責 terminal 子頁標題與返回互動
  - `packages/app/src/components/session/session-header.tsx`
    - mobile launcher drawer 改回文字 label 顯示，不再使用 icon-only 項目
    - launcher 仍保留在 banner 最右側；desktop 維持單一 launcher + review 獨立按鈕
- launcher UX refinement：
  - `packages/app/src/components/session/session-header.tsx`
    - launcher drawer content 改為覆寫預設 `min-width: 8rem`，使寬度跟隨實際文字，不再在右側留下過多空白
    - desktop：files / todo / monitor 若已在對應 mode 開啟，再次點擊同一項目會直接關閉 side-panel；terminal 若已開啟，再次點擊會關閉底部 terminal panel
    - mobile/subpage：若目前正在該工具頁，再次點擊同一項目會返回主 session 頁，形成一致的「按一下開、再按一下關」切換體驗
- launcher active-state polish：
  - `packages/app/src/components/session/session-header.tsx`
    - launcher drawer 會依目前狀態高亮 active tool，並在右側顯示 check indicator
    - desktop active 狀態依 `layout.fileTree.opened() + mode` 與 `view().terminal.opened()` 判定
    - mobile active 狀態依目前 route subpage（`/tool/:tool` / `/terminal-popout`）判定
- launcher final visual polish：
  - `packages/app/src/components/session/session-header.tsx`
    - active item 背景由 hover-level 提升為 pressed/active-level
    - active item label 與 check icon 改用更強的文字/圖示色，讓目前開啟項目更容易辨識

### Validation

- `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- mobile follow-up 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- launcher + monitor follow-up 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- launcher polish 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- launcher interaction polish 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- desktop launcher follow-up 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- shared-banner follow-up 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- launcher UX refinement 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- launcher active-state polish 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- launcher final visual polish 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- `git diff --stat`（截至本批）：57 files changed, 1475 insertions(+), 472 deletions(-)
- Architecture Sync: Verified (No doc changes)
  - 依據：本次與後續 follow-up 都只調整 app 端共享 banner 掛載位置、launcher 文案/寬度/active state/視覺樣式、以及前端 toggle 互動，未改動後端 monitor/todo API contract、route contract 或核心 runtime 架構。
