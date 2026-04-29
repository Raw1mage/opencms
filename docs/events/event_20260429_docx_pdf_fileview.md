# Event 2026-04-29 — DOCX PDF fileview preview

## 需求

- `system-manager_open_fileview` 開啟 `.docx` 時，避免 HTML preview 造成 Word 版面失真。
- 以 DOCX → PDF preview 作為預設瀏覽路徑，保留頁面排版並讓文字仍可選取。

## 範圍

IN:
- `packages/mcp/system-manager/src/index.ts`: `.docx` 輸入轉成 cached PDF preview 後寫入 `fileview_open`。
- `packages/opencode/src/file/index.ts`: 讓 file API 以 base64 `application/pdf` 回傳 PDF。
- `packages/app/src/pages/session/file-tabs.tsx`: 以 iframe/browser PDF viewer 顯示 PDF。
- `specs/architecture.md`: 同步 file/rich content surface 架構描述。

OUT:
- 不新增 HTML DOCX renderer。
- 不新增 OnlyOffice / Collabora / Microsoft Office Online 整合。
- 不自動安裝 LibreOffice；缺少 `soffice/libreoffice` 時 fail fast。

## 任務清單

- [x] 定位 `open_fileview` 與 file-tab 顯示路徑。
- [x] 實作 `.docx` → PDF preview cache。
- [x] 實作 PDF file API 與前端 PDF viewer 分支。
- [x] 驗證語法與依賴狀態。
- [x] 同步架構文件。

## Debug checkpoints

### Baseline

- 需求核心是保留 DOCX 原頁排版與可選字；HTML preview 會在頁首頁尾、浮動圖片、表格寬度、分頁與中文段距上失真。
- 現有 `open_fileview` 只寫 KV 事件，前端 file-tab 再透過 file API 讀取內容。

### Instrumentation Plan

- Boundary A: `system-manager_open_fileview` 工具端是否能把 `.docx` 轉成可開啟的 PDF path。
- Boundary B: file API 是否將 `.pdf` 視為可顯示內容而非 generic binary。
- Boundary C: `file-tabs.tsx` 是否在 binary fallback 前攔截 PDF 並交給 browser PDF viewer。

### Execution

- `open_fileview` 以副檔名 `.docx` 觸發 LibreOffice headless conversion。
- PDF cache 放在來源文件目錄下 `.opencode/fileview-preview/docx/<hash>/`，避免 MCP process cwd 與前端 workspace 不一致時造成 file API project-boundary 讀取失敗。
- `File.read()` 對 `.pdf` 回傳 `{ type: "text", mimeType: "application/pdf", encoding: "base64" }`。
- `file-tabs.tsx` 新增 PDF data URL iframe 分支，順序在 generic binary fallback 前。

### Root Cause / Decision

- 原生 browser/fileview 不可靠渲染 `.docx`；HTML conversion 可選字但 fidelity 不足。
- PDF 是最小可行的中介格式：LibreOffice 負責 Word layout conversion，browser PDF viewer 負責可選字檢視。
- 依使用者 fallback 禁令，缺 LibreOffice 時不降級成 HTML 或圖片，直接報錯。

## Verification

- `bun --check packages/mcp/system-manager/src/index.ts`: pass。
- `bun --check packages/app/src/pages/session/file-tabs.tsx`: pass。
- `bun run --filter @opencode-ai/app typecheck`: blocked by existing unrelated `packages/ui/src/components/session-review.tsx` `FileDiff.before/after` type errors。
- `bun run --filter opencode typecheck`: blocked by existing unrelated provider/session/CLI type errors; includes pre-existing `FilePart.mimeType` schema mismatch in `src/server/routes/session.ts`.
- `command -v soffice || command -v libreoffice`: failed on this machine (`LibreOffice not found`), so actual DOCX→PDF conversion could not be executed here. Runtime behavior remains fail-fast with an explicit install/SOFFICE error.
- Architecture Sync: Updated `specs/architecture.md` `Frontend File / Rich Content Surfaces` to include DOCX→PDF preview path and PDF rendering contract.

## Remaining

- Install LibreOffice on the target runtime host, then manually verify `system-manager_open_fileview` against a real `.docx`.
- If very large PDFs cause UI memory pressure, consider a later paged/blob-url PDF streaming design rather than data URL embedding.
