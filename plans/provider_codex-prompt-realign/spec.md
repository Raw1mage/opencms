# Spec

## Purpose

把 OpenCode codex provider 的 prompt 結構**無條件對齊**上游 codex-cli (`refs/codex/codex-rs/core/`)，讓 OpenAI Responses API 的 prefix cache 在 delta=true 模式下能正常命中（cached_tokens >= 90% input_tokens 在第二 turn 之後）。

## Requirements

### Requirement: Persona File Aligned With Upstream
The system SHALL ship the upstream `refs/codex/codex-rs/protocol/src/prompts/base_instructions/default.md` 整份內容作為 codex driver 人格檔。

#### Scenario: Bundled persona matches upstream byte-for-byte
- **GIVEN** opencode-codex-provider 啟動於 codex/gpt-5.5 model
- **WHEN** `SystemPrompt.provider(model)` 回傳 driver text
- **THEN** 該 text 的 md5 等於 `refs/codex/codex-rs/protocol/src/prompts/base_instructions/default.md` 的 md5
- **AND** `packages/opencode/src/session/prompt/codex.txt` 與 `templates/prompts/drivers/codex.txt` 兩份檔內容也與上游 hash 相同

#### Scenario: Model-specific persona fallback
- **GIVEN** opencode codex provider 收到 model.api.id=`gpt-5.2-codex`
- **WHEN** `SystemPrompt.provider(model)` 查找 model-specific prompt md
- **THEN** 找到對應的 `gpt-5.2-codex_prompt.md` 就用該檔；找不到 fallback 到 default.md

### Requirement: instructions Field Carries Driver Only
The system SHALL put **only** the driver persona text in the Responses API `instructions` field. SYSTEM.md / AGENTS.md / userSystem / agent prompt / identity 一律不可進該欄位。

#### Scenario: Stable instructions across turns
- **GIVEN** 同一個 codex session 連續兩 turn 都跑在同一 driver
- **WHEN** 兩 turn 的 outbound request 被攔截
- **THEN** 兩個 request 的 `instructions` 欄位 byte 完全一致（hash 相同）

### Requirement: input[] Begins With Developer + User Bundle
The system SHALL inject two bundled `ResponseItem` 在 `input[]` 開頭（在對話歷史之前）：第一個 developer-role bundle、第二個 user-role bundle。

#### Scenario: Developer bundle 包 OpenCode protocol + 可選 fragment
- **GIVEN** session 已載入 SYSTEM.md, MCP apps, available skills
- **WHEN** request 組好
- **THEN** `input[0]` 是 developer-role item，內容依序包含：RoleIdentity → OpencodeProtocolInstructions → PermissionsInstructions（如有）→ AppsInstructions → AvailableSkillsInstructions → 其他 OpenCode-only fragment
- **AND** 每塊 fragment 用其 START_MARKER / END_MARKER 包裹（empty marker 跳過 wrapping）

#### Scenario: User bundle 包 AGENTS.md + EnvironmentContext
- **GIVEN** session 在 `/home/pkcs12/projects/foo`，且 `~/.config/opencode/AGENTS.md` 與 `<root>/AGENTS.md` 都存在
- **WHEN** request 組好
- **THEN** `input[1]` 是 user-role item，內容依序：UserInstructions(global) → UserInstructions(project) → EnvironmentContext
- **AND** UserInstructions 用 `# AGENTS.md instructions for <dir>\n\n<INSTRUCTIONS>\n<text>\n</INSTRUCTIONS>` 包裝
- **AND** EnvironmentContext 用 `<environment_context>` / `</environment_context>` 包裝

### Requirement: prompt_cache_key Equals Pure threadId
The system SHALL set `prompt_cache_key = threadId`（即 sessionId），不再加 accountId 前綴。

#### Scenario: Same session, different accounts, same cache_key
- **GIVEN** session A 先用 account X 發一個 request、後 rotation 到 account Y 發另一個 request
- **WHEN** 兩個 outbound request 被攔截
- **THEN** 兩者的 `prompt_cache_key` byte 完全一致（不被 accountId 影響）

### Requirement: Legacy CONTEXT PREFACE Removed
The system SHALL NOT 注入 OpenCode 自製的 `## CONTEXT PREFACE — read but do not echo` user-role 訊息。T1/T2/trailing 三層概念解構到對應 fragment。

#### Scenario: No CONTEXT PREFACE marker in any outbound input[]
- **GIVEN** 任何 codex provider session 的 turn
- **WHEN** outbound request 被攔截、解析 input[] 所有 user-role item 的 text content
- **THEN** 沒有任何 item 的 text 含子字串 `## CONTEXT PREFACE`

### Requirement: Cache Recovery Validated
The system SHALL 在 healthy delta 模式下從第二 turn 開始達到 cached_tokens >= 90% input_tokens。

#### Scenario: Two-turn smoke test
- **GIVEN** 全新 codex session 在乾淨工作目錄
- **WHEN** 連續發兩個 user message, 兩 turn 完成
- **THEN** 第二 turn 的 USAGE log 顯示 `cached_tokens` >= 0.9 * `input_tokens`
- **AND** cached_tokens 不是 4608 這類 stuck 值

## Acceptance Checks

- 三份 codex.txt（bundled / template / upstream reference）md5 一致：`7a62de0a7552d52b455f48d9a1e96016`
- 同 session 同 driver 連續兩 turn，outbound `instructions` byte 一致（hash equal）
- 同 session rotate 帳號前後，`prompt_cache_key` 不變
- Healthy delta turn `cached_tokens >= 0.9 * input_tokens` 從第二 turn 開始
- 任何 outbound input[] item 的 text 都不含子字串 `## CONTEXT PREFACE`
- Subagent session 啟動時 RoleIdentity fragment body 包含 `Current Role: Subagent`
- `wiki_validate` 對本 plan 沒有未解的 broken_links / drift 警報

## Boundaries

- 本 spec 只規範 codex provider 的 prompt 結構；anthropic / google 不在本 spec 範圍
- 上游無對應的 OpenCode 自有 fragment（OpencodeProtocolInstructions / RoleIdentity / LazyCatalogInstructions / 等）允許新增，但必須在 design.md 證成、有明確 ROLE + START_MARKER + END_MARKER + body 規格
- 對話歷史（已持久化的 user/assistant/function_call 訊息）照原樣餵給模型；新結構只影響「組裝下一個 turn 的 prefix」
- Stage 切換期間提供 feature flag `OPENCODE_CODEX_LEGACY_INSTRUCTIONS=1` 走舊路徑，預設 off
