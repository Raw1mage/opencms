# Event: GPT-5.5 minimal support

## 需求

- 依據 `refs` 外部 repo 已可實際調用 `gpt-5.5` 的證據，為本 repo 補上最小可行支援
- 以現有 `gpt-5.4` / `gpt-5.3-codex` 路徑比照新增 `gpt-5.5`

## 範圍

- IN: `packages/opencode/src/provider/`, `packages/opencode-codex-provider/src/`, 最小相關測試/驗證
- OUT: 與 `gpt-5.5` 無關的 provider 重構、額外 fallback 機制、新 transport

## 任務清單

1. [x] 備份指定 config 檔快照
2. [x] 補齊 `gpt-5.5` provider / codex catalog
3. [x] 驗證 model surface 與最小型測試結果
4. [x] 同步 event 結論與 architecture 判斷

## Baseline

- 既有分析顯示 runtime 調用鏈沒有把 GPT-5 寫死在 `gpt-5.4`；主要 gate 是 model 是否存在於最終 catalog。
- `refs` 外部 repo 已提供 `gpt-5.5` server-side 可接受的實務證據，因此本次採最小本地 surface 補齊策略。

## Instrumentation Plan

- 先備份 `accounts/config` 相關檔案快照，避免測試或 provider 初始化污染本機設定
- 修改 `provider.ts`、`model-curation.ts`、`opencode-codex-provider/src/models.ts`
- 執行最小針對性驗證，確認 `Provider.getModel()` 路徑可接受 `gpt-5.5`

## Execution

- 依使用者最新指示，未備份整個 XDG；僅備份 `accounts.json`、`opencode.json`、`managed-apps.json`、`gauth.json`、`mcp.json`
- 備份目錄：`/home/pkcs12/.config/opencode.bak-20260424-1454-gpt55-minimal-support`
- 在 `packages/opencode/src/provider/provider.ts` 新增 `codex` provider 的 `gpt-5.5` surface
- 在 `packages/opencode/src/provider/model-curation.ts` 新增 OpenAI curated addition `gpt-5.5`
- 在 `packages/opencode-codex-provider/src/models.ts` 新增 `gpt-5.5` 的 context/output metadata
- 新增最小 regression：
  - `packages/opencode/test/provider/provider.test.ts`
  - `packages/opencode/test/provider/transform.test.ts`

## Root Cause / 結論

- 現有 runtime 的主要硬 gate 是 `Provider.getModel()` 是否能在最終 `provider.models` 找到 model，而不是 downstream transport 另有 `gpt-5.4` allowlist。
- 在已知 server 可接受 `gpt-5.5` 的前提下，本 repo 最小缺口確實是 local catalog / metadata surface，而不是 protocol 重做。
- 實作後已證明：
  - `openai/gpt-5.5` 可被 curated surface resolve
  - `gpt-5.5` 會沿用既有 GPT-5 reasoning variant 邏輯
- 本次**沒有**新增 fallback 或 request rewrite；僅比照 `gpt-5.4` 補齊最小 surface。

## 驗證結果

- `OPENCODE_TEST_LEGACY_PROVIDER_SUITE=1 bun test "/home/pkcs12/projects/opencode/packages/opencode/test/provider/provider.test.ts" --test-name-pattern "getModel resolves curated openai gpt-5.5 model"` ✅
- `bun test "/home/pkcs12/projects/opencode/packages/opencode/test/provider/transform.test.ts" --test-name-pattern "gpt-5.5 uses standard gpt-5 reasoning variants"` ✅

## Architecture Sync

- Verified (No doc changes)
- 依據：本次僅補現有 provider/model catalog 與對應測試，未改變模組邊界、資料流、狀態機或 runtime transport 架構
