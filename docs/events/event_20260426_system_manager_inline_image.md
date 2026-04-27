# Event: system-manager inline image display tool

Date: 2026-04-26
Status: Completed
Workspace: `/home/pkcs12/projects/opencode`

## 需求

- 將對話流中直接顯示 SVG/image 的能力收斂為 opencode 自有 tool-result 顯示契約，並提供給 `system-manager` MCP tool 系統使用。
- 讓 agent 可在使用者要求「秀圖 / inline 顯示結果」時，不必開側邊 fileview，也不必由每個圖形 MCP 自行實作顯示邏輯。
- 使用者後續要求 JPG/GIF/PNG 等圖片路徑連結在對話中可點擊展開 inline image。
- 使用者指出手機 file explorer 點 SVG 只顯示文字內容，需改為渲染預覽。

## 範圍 (IN / OUT)

### IN

- 新增 `display_inline_image` MCP tool schema。
- 新增 handler：從明確的絕對 image path 讀取 SVG/PNG/JPEG/GIF/WebP 並回傳 inline tool result。
- SVG 以 opencode-owned `--- SVG: <title> ---` + SVG text envelope 回傳，並由前端 generic SVG block renderer 渲染。
- 點陣圖以 MCP image content (`type: image`, `data`, `mimeType`) 回傳。
- 對話 assistant response 中的絕對圖片路徑 / `file://` 圖片連結，點擊後在同一 response 下方 inline 展開。
- 手機 files tool page 對 image MIME（含 SVG）使用 `<img>` data URL 預覽，而不是一律當文字 `<pre>` 顯示。
- 更新 `specs/architecture.md` 中 rich content/tool-result 邊界說明。

### OUT

- 不改 `open_fileview` 的側邊檢視行為。
- 不新增任意文字/HTML inline 注入能力。
- 不改 sanitize/markdown parser 本身；圖片路徑展開在 app/UI click handling 與既有 file API 邊界完成。

## 任務清單

- [x] 確認 system-manager tool schema 與 `open_fileview` 實作位置。
- [x] 新增 image MIME allowlist 與 10MB 大小限制。
- [x] 新增 `display_inline_image` schema 與 handler。
- [x] 新增 assistant response 圖片路徑連結 click-to-expand inline preview。
- [x] 修正手機 file explorer image/SVG 預覽路徑。
- [x] 執行 system-manager tests。
- [x] 更新 architecture/event log。

## Debug Checkpoints

### Baseline

- Baseline symptom: SVG block output could be rendered for some diagram tools, but `system-manager_display_inline_image` initially fell through to plain text because the inline renderer was tool-specific instead of envelope-based.
- `system-manager_open_fileview` 只寫入 KV 觸發側邊 file viewer，不會在對話流內顯示圖片。

### Instrumentation / Boundary Plan

- MCP schema boundary：`packages/mcp/system-manager/src/index.ts` 的 `ListToolsRequestSchema`。
- MCP handler boundary：同檔 `CallToolRequestSchema`。
- Rich-content boundary：`specs/architecture.md` 已記錄 file-viewer 與 tool-result display surface 的差異。
- Assistant response boundary：`packages/ui/src/components/session-turn.tsx` 渲染 assistant Markdown；由 app 層 `message-timeline.tsx` 注入既有 file loader/preview adapter。
- Mobile files boundary：`packages/app/src/pages/session/tool-page.tsx` 是手機/tool files 的簡化檔案檢視路徑，原本只顯示文字內容。
- File tab boundary：`packages/app/src/pages/session/file-tabs.tsx` 是主要檔案總管 tab；原 SVG preview 分支只依賴精確 `image/svg+xml` MIME，若 file API 回 `text/plain` 或帶 charset 的 MIME，會落回文字 code renderer。

### Execution

- 新增 `INLINE_IMAGE_MIME_BY_EXT` 與 `INLINE_IMAGE_MAX_BYTES`。
- 新增 `display_inline_image` tool：要求 absolute path，拒絕非 image MIME、MIME/副檔名不一致、非檔案、超過大小限制的輸入。
- SVG 回傳文字 SVG block；其他 image 回傳 base64 MCP image content。
- `diagram-tool.tsx` exposes a generic `SvgBlockTool` / `hasSvgBlockOutput()` renderer contract for opencode-owned SVG block envelopes.
- `message-part.tsx` now routes any tool output containing the SVG block envelope to `SvgBlockTool` when no more-specific tool renderer is registered. This removes the need for drawmiat-specific duplicate registration.
- `SessionTurn` 新增可選 `inlineImage` adapter；點擊 assistant response 內的絕對圖片路徑或 `file://` 圖片連結時，透過既有 file API 載入並在 response 下方顯示 preview。
- `MessageTimeline` 提供 `file.load` / `file.get` adapter，支援 SVG text/base64 與 base64 點陣圖 data URL。
- `tool-page.tsx` 在 mobile/files view 偵測 image MIME，對 SVG/PNG/JPEG/GIF/WebP 直接渲染 `<img>`，非 image 維持原文字/二進位 fallback。
- `file-tabs.tsx` 的 SVG/image 判斷改為副檔名 + MIME prefix 雙重判斷；`.svg` 即使 MIME 不是精確 `image/svg+xml` 也會走 `SvgViewer` 預覽。
- `tool-page.tsx` 與 `message-timeline.tsx` 同步採用 SVG 副檔名 + MIME prefix 判斷，避免同類 fallback 到文字。

### Validation

- `bun test "packages/mcp/system-manager/src/system-manager-http.test.ts" "packages/mcp/system-manager/src/system-manager-session.test.ts"`
  - Result: 10 pass / 0 fail
- `bun run verify:typecheck`
  - Result: blocked by local environment: `error: Script not found "turbo"`
- `bun --check "packages/mcp/system-manager/src/index.ts"`
  - Result: pass
- `bun x tsc -p "packages/ui/tsconfig.json" --noEmit && bun x tsc -p "packages/app/tsconfig.json" --noEmit`
  - Result: pass
- `bun --filter @opencode-ai/ui typecheck`
  - Result: pass
- `bun --check` on Solid frontend files
  - Result: not applicable; blocked by existing Solid/Kobalte server-side client-only initialization during check, so package TypeScript checks were used instead.

### Architecture Sync

- Architecture Sync: Updated
- 比對依據：本次新增 system-manager MCP tool-result rich display surface、assistant response inline image preview、mobile files image preview，並將 SVG block rendering 改為 opencode-owned generic envelope renderer，影響既有 rich content/file-viewer 邊界描述，因此已更新 `specs/architecture.md` 的 `Frontend File / Rich Content Surfaces`。

## Remaining

- 需要重啟 / refresh MCP tool registry 後，新 tool 才會出現在目前 session 的可用工具清單中。
