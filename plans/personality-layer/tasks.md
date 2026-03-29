# Tasks

## 1. 解耦 capabilities flags + 修復 codex driver 載入

- [ ] 1.1 在 capabilities.ts 中拆 `useInstructionsOption` 為 `wireFormatInstructions` 和 `skipProviderPrompt` 兩個獨立 flag
- [ ] 1.2 修改 llm.ts：`provider_prompt` block 的載入條件改為基於 `skipProviderPrompt`，不再跟 wire format 綁定
- [ ] 1.3 修改 llm.ts：wire format 決策（是否用 `options.instructions`）改為基於 `wireFormatInstructions`
- [ ] 1.4 設定 codex capability：`wireFormatInstructions=true, skipProviderPrompt=false`
- [ ] 1.5 驗證：codex provider 的 prompt output 包含 `gpt-5.4.txt` 內容
- [ ] 1.6 驗證：anthropic、copilot 等其他 provider 行為無 regression

## 2. Personality 基礎設施

- [ ] 2.1 新增 `session/prompt/personalities/` 目錄
- [ ] 2.2 從 codex-rs 移植 `pragmatic.txt`（`refs/codex/codex-rs/core/templates/personalities/gpt-5.2-codex_pragmatic.md`）
- [ ] 2.3 從 codex-rs 移植 `friendly.txt`（`refs/codex/codex-rs/core/templates/personalities/gpt-5.2-codex_friendly.md`）
- [ ] 2.4 建立 `default.txt` — 使用 codex-rs 的 default personality 或空檔案
- [ ] 2.5 在 system.ts 新增 `SystemPrompt.personality(name)` 函數：讀取 personality 檔案，支援 XDG override
- [ ] 2.6 在 `SystemPrompt.provider()` 中加入 `{{ personality }}` 替換邏輯
- [ ] 2.7 Config schema（config.ts）新增 `personality?: "pragmatic" | "friendly" | "default"` 欄位
- [ ] 2.8 在 llm.ts 或 system.ts 中讀取 config personality，傳入 provider prompt 載入

## 3. Driver prompt 模板化

- [ ] 3.1 修改 `drivers/codex/gpt-5.4.txt`：抽出人格段落，替換為 `{{ personality }}`
- [ ] 3.2 評估其他 codex driver 檔案是否需要同步加佔位符
- [ ] 3.3 驗證：personality=pragmatic 時 prompt 正確替換
- [ ] 3.4 驗證：personality=friendly 時 prompt 正確替換
- [ ] 3.5 驗證：無佔位符的 driver 檔案行為不變

## 4. 驗證 + 同步

- [ ] 4.1 逐一比對所有 provider 的 prompt output 無 regression
- [ ] 4.2 同步 `templates/` 目錄
- [ ] 4.3 記錄到 `docs/events/`
- [ ] 4.4 typecheck 確認 0 new errors
