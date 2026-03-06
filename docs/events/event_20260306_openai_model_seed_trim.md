# Event: OpenAI Model Seed Trim for Web Selector

## 需求

- webapp 的 OpenAI model list 應收斂到目前實際可用的 6 個選項：
  - `gpt-5.3-codex`
  - `gpt-5.4`
  - `gpt-5.2-codex`
  - `gpt-5.1-codex-max`
  - `gpt-5.2`
  - `gpt-5.1-codex-mini`
- 移除 webapp 中由本地/模板種子帶出的不存在 OpenAI model options。

## 範圍

IN:
- `packages/opencode/src/provider/models.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/plugin/codex.ts`
- `packages/opencode/src/provider/models-snapshot.ts`
- `packages/opencode/src/cli/cmd/models.ts`
- `packages/opencode/src/plugin/antigravity/plugin/model-registry.ts`
- `templates/opencode.json`
- `/home/pkcs12/.cache/opencode/models.json`
- `/home/pkcs12/.config/opencode/models.json`
- `/home/pkcs12/.config/opencode/opencode.json`

OUT:
- 不調整非 OpenAI provider 的 model seed

## 任務清單

- [x] 確認 webapp OpenAI 額外選項的資料來源
- [x] 收斂 OpenAI fallback/model seed 至 6 個指定選項
- [x] 同步本機使用者設定，讓 webapp 立即生效
- [x] 將 OpenAI curated filter 前推到 models.dev ingest 層
- [x] 將 OpenAI runtime/provider output 加上最終 whitelist
- [x] 清理 snapshot/cache/OAuth discovery 中的 OpenAI 舊條目
- [x] 驗證 web runtime refresh 後清單更新

## Debug Checkpoints

### Baseline

- `templates/opencode.json` 的 OpenAI models 仍包含 `gpt-5.1-codex`、`gpt-5.1` 等額外條目
- `/home/pkcs12/.config/opencode/opencode.json` 同樣保留舊的 OpenAI model 定義
- `/home/pkcs12/.config/opencode/models.json` 與 repo fallback 還包含超出 6 個名單的 OpenAI IDs

### Execution

- 將 OpenAI 預設 model seed/fallback 收斂到指定 6 個 IDs
- 將本機 `opencode.json` 的 OpenAI model 定義同步修剪
- 在 `ModelsDev.get()/refresh()` 套用 OpenAI curated filter，避免錯誤模型自 cache/snapshot/fetch 繼續傳遞
- 將 `Provider.state()` 的 OpenAI provider 最終輸出加上 whitelist，避免 `models.dev` 或 OAuth discovery 重新帶回錯誤模型
- 將 OpenAI OAuth plugin 的 model filter 收斂到同一份 6 個 curated IDs
- 重寫 bundled snapshot 與本機 `~/.cache/opencode/models.json` 的 OpenAI models 為相同 6 個 IDs
- refresh web runtime 套用更新

### Validation

- `jq '.provider.openai.models | keys' /home/pkcs12/.config/opencode/opencode.json`
  - 通過，OpenAI model definitions 已收斂為 6 個指定 IDs
- `jq '.provider.openai.models | keys' templates/opencode.json`
  - 通過，template 也同步為相同 6 個 IDs
- `jq '.openai' /home/pkcs12/.config/opencode/models.json`
  - 通過，使用者層 model registry 也同步為相同 6 個 IDs
- `jq '.openai.models | keys' /home/pkcs12/.cache/opencode/models.json`
  - 通過，models.dev cache 中的 OpenAI models 已同步為相同 6 個 IDs
- `packages/opencode/src/provider/models.ts`
  - 通過，OpenAI curated filter 已前推到 ingest 層，cache/snapshot/fetch 進系統後即收斂
- `packages/opencode/src/provider/provider.ts`
  - 通過，OpenAI provider 最終 runtime output 仍有 whitelist 作為最後防線
- `packages/opencode/src/plugin/codex.ts`
  - 通過，OpenAI OAuth discovery 只保留相同 6 個 curated IDs
- `./webctl.sh dev-refresh`
  - 通過，frontend rebuild 完成並套用
- `./webctl.sh status`
  - 通過，`Health: {"healthy":true,"version":"local"}`
- 行為驗證結論：
  - webapp 的 OpenAI 額外 model options 不再由舊 seed、cache、snapshot 或 OAuth discovery 灌入 `gpt-5.1`、`gpt-5.1-codex`、`gpt-5.4-pro`
  - 現在預期可見的 OpenAI seed 只剩 6 個指定選項
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅調整 OpenAI model curation 與本地資料清理，未改動系統架構、API contract 或 provider graph
