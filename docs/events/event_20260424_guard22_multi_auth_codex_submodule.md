# Event: Add guard22 multi-auth codex submodule and inspect GPT-5.5 support

## 需求

- 將 `https://github.com/guard22/opencode-multi-auth-codex.git` 加到 `/refs` 當 submodule
- 分析此 repo 如何支援 `gpt-5.5`

## 範圍

- IN: `.gitmodules`, `refs/guard22-opencode-multi-auth-codex/`, 相關分析紀錄
- OUT: 將該 repo 的功能直接移植進本 repo runtime

## 任務清單

1. [x] 建立 event 紀錄
2. [x] 新增 submodule 到 `/refs`
3. [x] 讀取該 repo 的 model / config 實作
4. [x] 整理 `gpt-5.5` 支援機制與結論
5. [x] 驗證並同步 architecture 判斷

## Baseline

- 使用者提供外部 repo URL，要求將其加入本 repo 的 `/refs`，並分析其 `gpt-5.5` 支援方式。
- 初步 GitHub metadata 顯示此 repo 是一個外部 multi-account codex plugin，而非目前 opencode 內建 `@opencode-ai/codex-provider`。

## Instrumentation Plan

- 新增 git submodule 到 `refs/guard22-opencode-multi-auth-codex`
- 讀取該 repo 的 `src/models.ts`、`src/index.ts`、相關 tests / README
- 搜尋 `gpt-5.5` 命中點，確認它是硬編碼 allowlist、alias、fallback，還是動態能力判定

## Execution

- 已執行 `git submodule add -f https://github.com/guard22/opencode-multi-auth-codex.git refs/guard22-opencode-multi-auth-codex`
- submodule 路徑：`refs/guard22-opencode-multi-auth-codex/`
- `src/models.ts` 明確把 `gpt-5.5` 納入 `MODEL_LIMITS` 與 `getDefaultModels()`，並為它建立 `none/low/medium/high/xhigh` 變體，以及 `gpt-5.5-fast`
- `src/index.ts` 設定 `DEFAULT_LATEST_CODEX_MODEL = 'gpt-5.5'`
- `src/index.ts::normalizeModel()` 不是單純接受 `gpt-5.5`；它還支援在 `OPENCODE_MULTI_AUTH_PREFER_CODEX_LATEST=1` 時，把較舊選擇（`gpt-5.4`、`gpt-5.3-codex`、`gpt-5.2-codex`、`gpt-5-codex`）映射成最新 backend model（預設 `gpt-5.5`）
- `src/index.ts::config()` 會把 `gpt-5.5` / `gpt-5.5-fast` 動態注入 `config.provider.openai.models` 與 `whitelist`
- `src/index.ts` 也會在 `-fast` 變體上轉成 `service_tier=priority`
- `src/probe-limits.ts` 把 `gpt-5.5` 放在 `DEFAULT_PROBE_MODELS` 第一順位，用來探測 quota / rate limit 能力
- README 明確說明：若 OpenCode 本體還沒接受 `openai/gpt-5.5`，就維持選 `gpt-5.4`，再靠 plugin 的 latest-model mapping 把 request 實際送成 `gpt-5.5`

## Root Cause / 結論

- 這個外部 repo **不是**靠「只加一份 model 描述檔」就調用 `gpt-5.5`。
- 它能 work 的原因是三層一起做：
  1. **描述/目錄層**：`src/models.ts` 補 `gpt-5.5` 的 limits、variants、fast 變體
  2. **runtime config 注入層**：`src/index.ts::config()` 在執行時把 `gpt-5.5` / `gpt-5.5-fast` 塞進 OpenCode 的 `openai.models` 與 `whitelist`
  3. **request rewrite / backend mapping 層**：`src/index.ts::normalizeModel()` 可把 `gpt-5.4` 等舊 model selection 改送成 `gpt-5.5`
- 因此，若回到本 repo 當前內建 `codex` provider，要「簡單加描述檔就能調用 `gpt-5.5`」的前提是：
  - 本體沒有更早的 model-id 驗證 gate 擋住選擇
  - transport/request path 允許原樣把 `model: 'gpt-5.5'` 送到 backend
  - compaction / limit metadata 對新 model 有合理值
- 以本 repo 現況看，**只改單一描述檔不夠**；至少要同步 `packages/opencode/src/provider/provider.ts` 的 provider registry 與 `packages/opencode-codex-provider/src/models.ts` 的 native catalog。若要仿外部 plugin 那種「舊選擇自動映射到新 backend model」，還得再補 request-side mapping，而不只是 registry 描述。

## 驗證結果

- `.gitmodules` 新增 `refs/guard22-opencode-multi-auth-codex`
- submodule clone 成功：`refs/guard22-opencode-multi-auth-codex/`
- `grep gpt-5\.5 refs/guard22-opencode-multi-auth-codex` 命中 `src/models.ts`、`src/index.ts`、`src/probe-limits.ts`、`README.md`、unit tests
- `tests/unit/models.test.ts` 驗證 `gpt-5.5` default / reasoning / fast variants
- `tests/unit/index-config.test.ts` 驗證 runtime config injection 會把 `gpt-5.5` / `gpt-5.5-fast` 注入 OpenCode config

## Architecture Sync

- Verified (No doc changes)
- 依據：本次新增的是 `/refs` 外部參考 submodule，並做外部 plugin 行為分析；未改變本 repo 既有 runtime 模組邊界或資料流
