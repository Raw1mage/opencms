# Event: subsession UI cleanup

Date: 2026-03-28
Status: Completed

## 需求

- 移除 subsession 畫面底部佔位過大的 observation-only 提示文字框。
- 將 subsession 中 subagent status bar 右側的外連按鈕改為返回 main session 的入口。

## 範圍 (IN / OUT)

### IN

- subsession session page / child-session 視圖相關前端元件
- subagent status bar 右側按鈕行為
- 必要 event / validation / architecture sync 記錄

### OUT

- 不改動 subagent runtime / worker lifecycle
- 不新增新的 navigation fallback 機制
- 不重做整體 session 頁面佈局

## 任務清單

- [x] 定位 observation-only 提示框與 status bar 右側按鈕的實作位置
- [x] 實作移除 observation-only 提示框
- [x] 實作右側按鈕返回 main session
- [x] 驗證 UI 行為與型別/建置
- [x] 同步 event 與 architecture 文件

## Debug / Design Checkpoints

### Baseline

- subsession 畫面底部目前存在大面積 observation-only 提示框，占用可視空間。
- subagent status bar 右側目前為外連圖示按鈕，但使用者需求是將其作為返回 main session 的入口。
- 目標是純前端控制面修正，不觸動子代理執行契約與 backend 流程。

### Instrumentation Plan

- 先定位 child session / parent session 視圖相關元件與文案來源。
- 確認目前右側按鈕的 click target、route 來源、與 parent session 資訊取得方式。
- 優先沿用既有 session navigation 機制，不新增隱式 fallback。

### Execution

- 定位到 `packages/app/src/pages/session/session-prompt-dock.tsx` 同時負責 pinned subagent status surface 與 child-session prompt 區塊。
- 在 `SessionPromptDock` 新增 `parentSessionHref`，使 child/subsession 視圖可沿用既有 parent session route。
- 右側外連按鈕在 parent view 維持開啟 child session；在 child/subsession view 改為返回 parent session。
- 移除 child/subsession 視圖底部 observation-only 提示框，改為 child session 不渲染 prompt input / fallback block。
- `packages/app/src/pages/session.tsx` 傳入既有 parent route：`/${params.dir}/session/${info()?.parentID}`。

### Root Cause

- 既有 `SessionPromptDock` 將 parent view 與 child/subsession view 共用同一個 active-child status bar 與 prompt 區塊實作，但 child 分支仍保留早期 observation-only 大型 fallback 文案。
- 同一顆右側按鈕僅綁定 open-child session 行為，沒有針對 child/subsession 視圖切換為 parent navigation，因此 UX 與使用者期望不一致。

### Validation

- `bun turbo typecheck --filter @opencode-ai/app` — passed
- 靜態檢查：
  - `packages/app/src/pages/session/session-prompt-dock.tsx:81-94` child session 時按鈕目標改為 `parentSessionHref`
  - `packages/app/src/pages/session/session-prompt-dock.tsx:204-212` child session 不再渲染 observation-only 提示框
  - `packages/app/src/pages/session.tsx:1833-1837` 已傳入 parent session href
- 限制：尚未執行瀏覽器 E2E；目前無直接覆蓋 `SessionPromptDock` child-session 分支的既有測試。

## Architecture Sync

- Updated — `specs/architecture.md` 已補充 active-child pinned status surface 在 child/subsession 視圖的返回 parent session affordance，並記錄 child session 不渲染 observation-only 底部提示框。