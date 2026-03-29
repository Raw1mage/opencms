# Spec

## Purpose

- 讓 codex provider 正確載入 per-model driver prompt，並支援可切換的人格設定

## Requirements

### Requirement: Provider Prompt Loading Independence

wire format 決策（`instructions` 欄位 vs system messages）不影響 prompt 來源載入。

#### Scenario: Codex provider loads per-model driver prompt

- **GIVEN** provider 是 codex，model 是 gpt-5.4
- **WHEN** LLM request 組裝 system prompt
- **THEN** `drivers/codex/gpt-5.4.txt` 的內容出現在最終 prompt 中

#### Scenario: Wire format uses instructions field

- **GIVEN** provider 是 codex（wireFormatInstructions=true）
- **WHEN** LLM request 送出
- **THEN** 所有 system prompt 內容合併到 `options.instructions` 欄位

#### Scenario: Non-codex provider unaffected

- **GIVEN** provider 是 anthropic
- **WHEN** LLM request 組裝 system prompt
- **THEN** 行為與修改前完全一致

### Requirement: Personality Template Substitution

driver prompt 支援 `{{ personality }}` 佔位符，載入時自動替換為選定的人格內容。

#### Scenario: Personality present in driver

- **GIVEN** `drivers/codex/gpt-5.4.txt` 含有 `{{ personality }}`
- **AND** config 設定 `personality: "pragmatic"`
- **WHEN** `SystemPrompt.provider(model)` 載入 driver
- **THEN** `{{ personality }}` 被 `personalities/pragmatic.txt` 的內容替換

#### Scenario: No personality placeholder in driver

- **GIVEN** driver 檔案不含 `{{ personality }}`
- **WHEN** `SystemPrompt.provider(model)` 載入 driver
- **THEN** driver 內容原封不動回傳（backward compatible）

#### Scenario: No personality configured

- **GIVEN** config 沒有 `personality` 欄位
- **WHEN** driver 含有 `{{ personality }}` 佔位符
- **THEN** 使用 model 的預設人格（`personalities/default.txt`）

### Requirement: Personality Selection via Config

使用者可透過 opencode.json 選擇人格變體。

#### Scenario: Config specifies personality

- **GIVEN** `opencode.json` 含 `"personality": "friendly"`
- **WHEN** session 開始並載入 system prompt
- **THEN** 使用 `personalities/friendly.txt` 的內容

#### Scenario: Personality file not found

- **GIVEN** config 設定 `"personality": "nonexistent"`
- **WHEN** 嘗試載入人格檔案
- **THEN** fallback 到 `personalities/default.txt`，不 crash

## Acceptance Checks

- [ ] codex provider request 的 prompt 中包含 `drivers/codex/gpt-5.4.txt` 的內容
- [ ] `useInstructionsOption` 被拆成兩個獨立 flag
- [ ] `{{ personality }}` 在 driver 中被正確替換
- [ ] 沒有佔位符的 driver 行為不變
- [ ] config 設 personality 後 log 可見選定人格
- [ ] 非 codex provider 行為無 regression
- [ ] `personalities/pragmatic.txt` 和 `personalities/friendly.txt` 存在且可載入
