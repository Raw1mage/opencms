# Event: Unify Changes and Context into Secondary Sidebar

Date: 2026-03-08
Status: Done

## 需求

- 將「異動清單」改為顯示在第二層 sidebar 中。
- 將「上下文」改為顯示在第二層 sidebar 中。
- 第一層 sidebar 不再承載異動清單或上下文，只在 file view 發生時開啟。
- context 按鈕從 prompt 區移到右上角工具按鈕列。
- terminal 維持底部 panel，不合併進 sidebar。

## 範圍

IN:

- `/home/pkcs12/projects/opencode/packages/app/src/context/layout.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/index.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/components/session/session-header.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/components/session-context-usage.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/components/prompt-input.tsx`
- `/home/pkcs12/projects/opencode/docs/events/event_20260308_unify_changes_context_into_secondary_sidebar.md`

OUT:

- terminal panel 架構變更
- file view 內容元件重寫
- 後端 API / session protocol 變更

## 任務清單

- [x] 追查目前 changes/context/files/status 的容器分工
- [x] 擴充第二層 sidebar mode，納入 `changes/context`
- [x] 調整第一層 sidebar 僅在 file view 發生時顯示
- [x] 將 context 按鈕移到右上角工具列，並自 prompt 區移除
- [x] 驗證 sidebar 行為並完成 Architecture Sync 記錄

## Debug Checkpoints

### Baseline

- 現行 UI 中，`changes` 由 review panel 承載，`context` 作為 review panel 內 tab。
- 第二層 sidebar (`layout.fileTree`) 目前僅承載 `files/status`。
- prompt 區右下角有 `SessionContextUsage` 按鈕；header 右上工具列則有 changes/files/status/terminal 按鈕。

### Execution

- `layout.fileTree.mode` 擴充為 `changes | context | files | status`，讓第二層 sidebar 可統一承載異動清單與上下文。
- `review.toggle` 改為切換第二層 sidebar 的 `changes` mode，而不是切換第一層 review panel。
- `SessionContextUsage` 改為直接開啟第二層 sidebar 的 `context` mode，並從 prompt 區移除，改放到 header 右上工具列。
- `SessionSidePanel` 重構為：
  - 第一層容器只在 active file tab 存在時顯示（file view 容器）
  - 第二層容器依 `layout.fileTree.mode` 顯示 `changes/context/files/status`
- `SessionPage` 的 diff 載入條件改為觀察第二層 sidebar 是否在 `changes` mode；file tree 載入只在 `files` mode 時觸發。
- Follow-up fixes:
  - 第一層 file view 容器新增右上角 `×` 關閉鈕，透過清空 active file tab 關閉容器。
  - 修正 `×` 實作為直接關閉目前 active file tab，避免僅 `setActive(undefined)` 導致容器視覺上未真正收起。
  - 第一層 file view 容器的 resize handle 最小寬度由 `450` 降至 `280`，允許向右收窄。
  - `context` 按鈕改為與其他工具按鈕一致：第二次點擊時會關閉第二層 sidebar。
  - `SessionContextTab` 移除 raw messages / 原始訊息區塊，只保留統計、breakdown 與 system prompt。
  - 由於單一 `aside` 同時承載 file pane 與 tool sidebar 導致 close 行為互相干擾，最終將 `session-side-panel.tsx` 重寫為兩個獨立 sibling panes：
    - `session-file-pane`
    - `session-tool-sidebar`
  - 第二層 sidebar 的 `×` 現在只負責關閉 `session-tool-sidebar`；第一層 file pane 的 `×` 只負責關閉 file pane。
  - 由於使用者回報 tool sidebar 點擊後仍未顯示，新增 runtime debug checkpoints：
    - `session-header.tsx`：按鈕 click 前後的 `layout.fileTree.opened/mode`
    - `index.tsx`：page shell 的 `fileOpen/toolOpen` 計算
    - `session-side-panel.tsx`：component render 時的 `toolOpen/sideMode/width`
  - 根因確認：實際路由仍走 `packages/app/src/pages/session.tsx`，而非先前多次修改的 `packages/app/src/pages/session/index.tsx`；前者仍以舊版 `SessionSidePanel` props (`open/reviewOpen/contextOpen`) 呼叫新元件，導致 `toolOpen/fileOpen` 為 `undefined`。
  - 已將 `packages/app/src/pages/session.tsx` 同步到新 pane API，並將 page shell 寬度責任改為僅由 file pane 影響；tool sidebar 改為獨立顯示條件。
  - file view tab 列新增：
    - 滑鼠滾輪可水平捲動 tab strip
    - 點選/切換 active file tab 時自動 scroll into view
  - file content 容器調整為保留可拖曳 scrollbar，方便長程式碼以滑鼠操作水平/垂直捲軸。

### Validation

- `bun run build`（workdir: `packages/app`）
  - 通過，Vite production build 成功。
- `bun test --preload ./happydom.ts ./src/components/prompt-input/submit.test.ts ./src/pages/session/file-tab-scroll.test.ts`（workdir: `packages/app`）
  - 通過，6 tests / 0 fail。
- `./webctl.sh dev-refresh && ./webctl.sh status`
  - 通過，`Health: {"healthy":true,"version":"local"}`。
- 再次 `bun run build` / `./webctl.sh dev-refresh && ./webctl.sh status`
  - 通過；follow-up 修正後 runtime 仍 healthy。
- pane rewrite 後再次驗證：
  - `bun run build` 通過
  - `bun test --preload ./happydom.ts ./src/components/prompt-input/submit.test.ts ./src/pages/session/file-tab-scroll.test.ts` 通過
  - `./webctl.sh dev-refresh && ./webctl.sh status` 通過，health healthy
- active route (`src/pages/session.tsx`) 修正後再次驗證：
  - `bun run build` 通過
  - `./webctl.sh dev-refresh && ./webctl.sh status` 通過，health healthy
- grep spot checks：
  - `SessionContextUsage` 已自 prompt input 移除，只保留於 header/context 元件本身。
  - `session-side-panel.tsx` 已移除 `context` / `review` tab content，改由第二層 sidebar mode 渲染。
  - `session-context-tab.tsx` 已不再渲染 `context.rawMessages.title` 與 raw message accordion。
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅重組 webapp 右側 UI panel 分工與觸發路由，未變更後端協議、session data model 或整體系統架構。
