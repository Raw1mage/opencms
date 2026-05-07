# 2026-05-05 Mobile image link black screen

## 需求

- 使用者回報：「秀圖link有bug，我手機上點了，畫面全黑」。
- 後續補充：手機版點檔案連結不會開 filetab 顯示檔案，`.svg` 與 `.md` 都不會。
- 後續補充：不是可開檔案的內容不要渲染成超連結；截圖中 `bun --check packages/mcp/system-manager/src/index.ts` / `bun eslint packages/mcp/system-manager/src/index.ts` 被整段誤渲染為 link。

## 範圍(IN)

- 釐清手機版點開圖片 / fileview link 的 UI 控制路徑。
- 修正手機版 file pane 開啟後沒有渲染檔案內容的問題。
- 驗證窄螢幕條件下圖片預覽不再落到空白/黑色 review fallback。
- 修正 assistant Markdown 檔案連結在手機版能進入 session filetab，涵蓋 `opencode-file://`、`.svg` 與 `.md`。
- 修正 UI file-path linkifier：inline code 只有在內容是單一檔案 reference token 時才產生 `opencode-file://` link；shell command 不可整段 link。

## 範圍(OUT)

- 不改 backend file API。
- 不改 provider/account/runtime 狀態流程。
- 不新增 fallback mechanism；修正既有 mobile file-pane routing。

## 任務清單

- [x] Baseline：讀 `specs/architecture.md` 與 session rich content / file-tab 實作。
- [x] Root cause / implementation：手機 filePane fallback 改成渲染 active file tab。
- [x] Validation：執行前端型別/測試或最小可用檢查。
- [x] Follow-up：手機版 `.svg` / `.md` 檔案連結改走 filetab adapter。
- [x] Follow-up：不可開檔案內容 / inline shell command 不再被整段 linkify。

## Debug checkpoints

### Baseline

- 症狀：手機點圖片/秀圖 link 後畫面全黑。
- 影響範圍：session 頁手機版檔案預覽路徑。
- 初始假設：link click 或圖片載入失敗。

### Instrumentation Plan

- Boundary 1：assistant Markdown 圖片 link click handler (`SessionTurn`) 是否阻止預設導頁並觸發 image/file load。
- Boundary 2：message timeline 在 mobile file pane 狀態下渲染哪個 fallback。
- Boundary 3：file tab content 是否本身能渲染 image/SVG。
- Boundary 4：assistant Markdown anchor click handler 是否只處理 inline image，而未把一般檔案連結交給 session filetab authority。
- Boundary 5：UI `linkifyFileReferences` 是否把 inline code command 誤判為單一檔案 reference。

### Execution Evidence

- `packages/ui/src/components/session-turn.tsx` 會攔截絕對圖片路徑並呼叫 `inlineImage.load`，同頁展開 inline preview。
- `packages/app/src/pages/session.tsx` 的 `mobileChanges = !isDesktop() && view().filePane.opened()`。
- `MessageTimeline` 在 `mobileChanges` 時只顯示 `mobileFallback`。
- 目前 `mobileFallback` 固定是 `reviewContent(...)`，而真正的 `SessionSidePanel` file content 只在 `desktopFilePaneOpen()` 時接收 `fileOpen=true`。
- Follow-up evidence：`packages/ui/src/components/session-turn.tsx` 原本只對 local image extension 做 inline image expansion；`opencode-file://` 與 `.md` 沒有 session-page adapter，`.svg` 也被 inline image path 攔截而不會進 filetab。
- Follow-up evidence：`packages/ui/src/components/file-path-link.ts` 在 inline code branch 會把整段 backtick 內容交給 `detectFileReference`；內容如 `bun --check packages/mcp/system-manager/src/index.ts` 因含 `/` 且以 `.ts` 結尾，被誤判為 relative file path。

### Root Cause

- 手機版 file pane 開啟後，session timeline 被替換成 review fallback；檔案預覽元件沒有在手機主區域渲染。
- 因此 open_fileview / 圖片 link 在手機上看起來像打開深色空畫面，而不是圖片內容。
- Follow-up root cause：檔案連結 click routing 與 filetab authority 沒有共用 contract。手機版即使已修好 file pane content，assistant Markdown 的 `.svg`/`.md` link 仍不會呼叫 session page `openTab(...)`，因此不會建立/啟用 filetab。
- Follow-up implementation：`SessionTurn` 新增 `fileLink.open(path)` adapter；`opencode-file://` 一律交給 filetab，`.svg`/`.md`/`.markdown` local links 也交給 filetab，並保留 raster image inline preview。`MessageTimeline` 將 adapter 轉交 session page，`session.tsx` 以既有 `openTab(file.tab(path))` 開啟並載入 active file tab。
- Follow-up root cause 2：inline code linkifier 缺少「單一檔案 token」守門；shell command 是可複製命令，不是可開檔案內容。
- Follow-up implementation 2：`packages/ui/src/components/file-path-link.ts` 新增 inline-code whitespace guard；含 whitespace 的 inline code 保持純 code，不產生 anchor；單一檔案 reference 如 `packages/.../index.ts` 仍可 link。

### Validation

- `bun --filter @opencode-ai/app typecheck`：passed。
- `bun eslint "packages/app/src/pages/session.tsx"`：passed。
- Manual code-path validation：mobile `view().filePane.opened()` no longer renders `reviewContent` as the `MessageTimeline` fallback; it renders a `Tabs` root containing the active `FileTabContent`, preserving image/SVG branches from `packages/app/src/pages/session/file-tabs.tsx`.
- Follow-up validation: `bun --filter @opencode-ai/app typecheck` passed after file-link adapter change.
- Follow-up validation: `bun eslint "packages/app/src/pages/session.tsx" "packages/app/src/pages/session/message-timeline.tsx" "packages/ui/src/components/session-turn.tsx"` passed.
- Follow-up manual code-path validation: tapping `opencode-file://...`, `.svg`, or `.md` assistant Markdown links now prevents default navigation and calls session page `openTab(file.tab(path))`; on mobile, the already-fixed `mobileFilePaneContent()` renders the active `FileTabContent` branch for SVG/Markdown.
- Follow-up validation 2: `bun test "packages/ui/src/components/file-path-link.test.ts"` passed.
- Follow-up validation 2: `bun --check "packages/ui/src/components/file-path-link.ts"` passed.
- Follow-up validation 2: `bun eslint "packages/ui/src/components/file-path-link.ts" "packages/ui/src/components/file-path-link.test.ts"` passed.

## Architecture Sync

- Updated `specs/architecture.md` Frontend File / Rich Content Surfaces to record the mobile session-page file-pane authority path.
- Follow-up sync: Updated `specs/architecture.md` to record the assistant Markdown rich-link adapter split: raster image inline preview vs `opencode-file://` / SVG / Markdown filetab routing.

## XDG backup

- Created pre-edit whitelist backup: `/home/pkcs12/.config/opencode.bak-20260505-1402-mobile-image-link`。
- Created follow-up pre-edit whitelist backup: `/home/pkcs12/.config/opencode.bak-20260505-1500-mobile-filetab-links/`.
