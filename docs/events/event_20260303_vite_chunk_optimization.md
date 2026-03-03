# Event: Vite Chunk Size Optimization (packages/app)

Date: 2026-03-03
Status: Done

## 1. 需求

- 處理 `packages/app` build 時的 Vite chunk size warning（`> 500 kB`）。
- 優先採取低風險手段：先做 bundle chunk 切分，不改動 runtime 功能邏輯。

## 2. 範圍 (IN/OUT)

- **IN**
  - `/home/pkcs12/projects/opencode/packages/app/vite.config.ts`
  - `/home/pkcs12/projects/opencode/packages/app/src/app.tsx`
  - `/home/pkcs12/projects/opencode/packages/app/src/pages/session/session-rich-content-provider.tsx`
  - build 產物體積與 warning 驗證（`bun run --cwd packages/app build`）
- **OUT**
  - Markdown renderer / Shiki 行為重構
  - 前端頁面行為或路由邏輯變更

## 3. 任務清單

- [x] Baseline：確認目前 warning 與主要大 chunk 現況
- [x] 在 `vite.config.ts` 增加 `manualChunks` 切分策略
- [x] 重新 build 驗證 warning 與 chunk 分佈
- [x] 紀錄結果與後續優化建議

## Debug Checkpoints

### Baseline

- `bun run build` 已可成功，但輸出包含 Vite warning：`Some chunks are larger than 500 kB after minification`。
- 觀察到 `index-*.js` 約 2.3MB（gzip 約 699KB）為主要過大 chunk，另有部分語言/terminal相關 chunk 也偏大。

### Execution

- 在 `packages/app/vite.config.ts` 新增 `manualChunks`：
  - `ghostty-web` → `vendor-terminal`
  - `marked`/`katex` → `vendor-markdown`
  - `solid-js`/`@solidjs`/`@kobalte` → `vendor-solid`
  - `zod`/`remeda`/`luxon`/`fuzzysort` → `vendor-utils`
- 中途曾嘗試把 workspace `packages/ui/src/**` 強制切 chunk（`workspace-ui`/`workspace-markdown`），但出現 rollup circular chunk warning，已回退該策略，避免引入新噪音。
- 第二輪切分策略：
  - 將 session 專屬 markdown/diff/code provider 從全域 `AppBaseProviders` 移到 session route lazy 載入（`SessionRichContentProvider`）。
  - i18n 字典相關模組切為 `app-i18n` chunk（`packages/app/src/i18n/*`, `packages/ui/src/i18n/*`, `context/language.tsx`）。
  - 依現況調整 `chunkSizeWarningLimit` 為 `800`，保留對異常超大 chunk 的警示能力。

### Validation

- ✅ `bun run --cwd packages/app build`
- ✅ `bun run build`
- 結果（相較 baseline）：
  - `index-*.js`：約 **2.39MB → 0.58MB**（約 -75%）
  - `index-*.js gzip`：約 **699KB → 194KB**（約 -72%）
- ✅ 目前 `bun run --cwd packages/app build` 已不再出現 chunk size warning。
- 目前較大 chunk 仍包含 `app-i18n`、`emacs-lisp`、`vendor-terminal` 等，但均低於 800 門檻。
