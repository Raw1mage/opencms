# Event: OpenAI GPT-5.4 Model Selector Alignment

## 需求

- 檢查 opencode 內使用的 OpenAI plugin / model registry 是否需要更新。
- 確認 `openai-gpt-5.4` 推出後，opencode 的 model selector 能看見並使用對應模型。

## 範圍

IN:
- 檢查 OpenAI 模型來源鏈路：`models.dev` snapshot/cache、OpenAI fallback model list、Codex/OpenAI plugin 過濾邏輯。
- 若缺少 `gpt-5.4` / `gpt-5.4-pro`，補齊 repo 內可見性與可選擇性所需更新。
- 驗證 CLI / runtime 端是否仍能列出 OpenAI 模型。

OUT:
- 不修改 OpenAI API 以外的 provider 行為。
- 不調整 rotation 推薦、agent score、預設工作流模型偏好，除非發現 selector 可見性被其直接阻斷。

## 任務清單

- [x] 確認官方 / 上游模型清單是否已包含 `gpt-5.4`
- [x] 盤點 repo 內 OpenAI 模型來源與 fallback
- [x] 更新必要程式碼與 snapshot
- [x] 驗證 selector / CLI 可見性
- [x] 完成 Architecture sync 檢查與 event validation

## Debug Checkpoints

### Baseline

- 已閱讀 `docs/ARCHITECTURE.md`。
- 本地盤點結果：
  - `packages/opencode/src/provider/models-snapshot.ts` 未找到 `gpt-5.4`
  - `packages/opencode/src/cli/cmd/models.ts` 的 `OPENAI_MODELS` 停在 `gpt-5.2` / `gpt-5.2-codex`
  - `packages/opencode/src/plugin/antigravity/plugin/model-registry.ts` 的 OpenAI defaults 也停在 `gpt-5.2` / `gpt-5.2-codex`
- 上游盤點結果：
  - `https://models.dev/api.json` 的 `openai.models` 已包含 `gpt-5.4`、`gpt-5.4-pro`

### Execution

- 執行 `bun run models:update-snapshot`
  - 重新生成 `packages/opencode/src/provider/models-snapshot.ts`
  - 使內建 offline snapshot 納入 `openai/gpt-5.4`、`openai/gpt-5.4-pro`
- 更新 OpenAI fallback 清單：
  - `packages/opencode/src/cli/cmd/models.ts`
  - `packages/opencode/src/plugin/antigravity/plugin/model-registry.ts`
- 補入模型：
  - `gpt-5.3-codex`
  - `gpt-5.4`
  - `gpt-5.4-pro`

### Validation

- 上游驗證：
  - `jq -r '.openai.models | keys[]' <(curl -fsSL https://models.dev/api.json) | rg '^gpt-5'`
  - 結果確認 `gpt-5.4`、`gpt-5.4-pro` 已存在於上游 `models.dev`
- 本地 snapshot 驗證：
  - `bun -e "import { snapshot } from './packages/opencode/src/provider/models-snapshot.ts'; console.log(Object.keys(snapshot.openai.models).filter((id) => id.startsWith('gpt-5')).join('\n'))"`
  - 結果已列出 `gpt-5.4`、`gpt-5.4-pro`
- Fallback 驗證：
  - `packages/opencode/src/cli/cmd/models.ts` 的 `OPENAI_MODELS` 已包含 `gpt-5.4`
  - `packages/opencode/src/plugin/antigravity/plugin/model-registry.ts` 的 OpenAI defaults 已包含 `gpt-5.4`
- 未執行完整 typecheck / test suite
  - 原因：本次變更為 snapshot + fallback 清單更新，已以 targeted runtime inspection 驗證
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅更新模型資料與 fallback 清單，未改變 provider graph、runtime boundary、selector 架構或 API contract
