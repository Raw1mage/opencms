# Event: Codex submodule GPT-5.5 inventory

## 需求

- 盤點 `refs/codex` submodule 是否已支援 `gpt-5.5`
- 若上游已支援，將支援能力同步到 `codex` provider plugin

## 範圍

- IN: `refs/codex/`, `packages/opencode-codex-provider/`, `packages/opencode/src/provider/`
- OUT: 任何與 `gpt-5.5` 無關的 codex runtime 重構

## 任務清單

1. [x] 盤點 `refs/codex` submodule 目前版本與 model 清單
2. [x] 比對本地 codex provider plugin 的 model registry
3. [x] 判斷是否需要新增 `gpt-5.5` 支援
4. [x] 記錄結論與驗證結果

## Baseline

- 使用者要先確認目前 vendored `refs/codex` 是否已有 `gpt-5.5` 能力，再決定是否更新本地 provider plugin。
- 目前本地 codex provider plugin 顯式維護一份 model 清單，因此是否支援新 model 必須先看 submodule/上游證據，再看本地 registry 是否要跟進。

## Instrumentation Plan

- 讀 `refs/codex/codex-rs/models-manager/models.json`，確認上游 model catalog 是否有 `gpt-5.5`
- 全 repo 搜尋 `gpt-5.5` 與 `codex`，確認本地尚未存在對應支援
- 讀 `packages/opencode-codex-provider/src/models.ts` 與 `packages/opencode/src/provider/provider.ts`，確認本地 codex provider registry 現況
- 用 git 檢查 `refs/codex` submodule 目前 commit 與最近歷史

## Execution

- 初始盤點時，`refs/codex` submodule 指向 `d0eff703837cbc9a6dea5a7f3dedc921aeeab0ab`（`rust-v0.0.2504301132-5231-gd0eff70383`）
- 使用者後續要求「拉最新」後，已對 `refs/codex` 執行 `git fetch origin --tags`，並將 submodule 更新到 `a9c111da544c976d591343db5493a7da283b72e5`（`origin/main`）
- 新舊 HEAD 之間存在大量上游更新，但在最新 `origin/main` 內容裡仍未找到 `gpt-5.5`
- `refs/codex/codex-rs/models-manager/models.json` 目前明確列出 `gpt-5.3-codex`、`gpt-5.4`、`gpt-5.2-codex` 等模型，但未出現 `gpt-5.5`
- 全 repo 對 `gpt-5.5` 搜尋結果為空；`refs/codex` 最新 `origin/main` 與本 repo packages 都沒有任何 `gpt-5.5` 字串
- `packages/opencode-codex-provider/src/models.ts` 與 `packages/opencode/src/provider/provider.ts` 的 codex model catalog 也都停在 `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex`

## Root Cause / 結論

- 即使把 `refs/codex` 拉到最新 `origin/main`，vendored codex upstream 仍然**沒有** `gpt-5.5` 的明確支援證據。
- 既然上游 submodule 現況尚未提供 `gpt-5.5` model entry，本地 `codex` provider plugin 不應自行猜測補上，以免製造 fake support / drift。
- 因此本次為 **no-op**：不更新 `packages/opencode-codex-provider/` 與 `packages/opencode/src/provider/` 的 codex model registry。

## 驗證結果

- `git -C refs/codex fetch origin --tags` 成功
- `git -C refs/codex rev-parse HEAD`（更新前）→ `d0eff703837cbc9a6dea5a7f3dedc921aeeab0ab`
- `git -C refs/codex rev-parse origin/main` → `a9c111da544c976d591343db5493a7da283b72e5`
- `git -C refs/codex checkout --detach origin/main` 成功；目前 `refs/codex` HEAD = `a9c111da544c976d591343db5493a7da283b72e5`
- `git -C refs/codex grep -n 'gpt-5\.5' origin/main --` → 無結果
- `git -C refs/codex log --oneline --grep='gpt-5\.5' --all` → 無結果
- `grep gpt-5\.5 packages` → 無結果

## 影響檔案

- `refs/codex` submodule pointer 更新到最新 upstream `origin/main`
- 無 `codex` provider plugin 程式碼變更
- 更新本 event log：`docs/events/event_20260424_codex_gpt55_inventory.md`

## Architecture Sync

- Verified (No doc changes)
- 依據：本次僅確認目前 submodule 與本地 provider registry 均未支援 `gpt-5.5`，未改變模組邊界、資料流或 runtime 行為
