# Spec: claude-cli AI SDK 脫離

## Purpose

整合分散的 claude-cli provider 邏輯（`anthropic.ts` + `provider-claude/` + `claude-native.ts`），確認 `provider-claude` 是唯一 data path，移除 `anthropic.ts` 中的死代碼（fetch interceptor），建立統一的 `plugin/claude-cli/` 薄包裝層。

## Requirements

### Requirement: R1 — Self-contained plugin directory

plugin/claude-cli/ 目錄必須包含 index.ts（Hooks entry）和 auth.ts（OAuth PKCE），取代原有的 anthropic.ts 單檔。

#### Scenario: Plugin registration

- **GIVEN** OpenCMS 啟動
- **WHEN** plugin registry 載入 `claude-cli` plugin
- **THEN** 從 `plugin/claude-cli/index.ts` import `ClaudeCliPlugin`
- **AND** plugin 回傳 Hooks 物件，含 `auth.provider === "claude-cli"`

#### Scenario: OAuth login flow preserved

- **GIVEN** 使用者未登入 claude-cli
- **WHEN** 使用者選擇 "Claude account with subscription" login method
- **THEN** 產生 OAuth PKCE authorize URL（platform.claude.com）
- **AND** 使用者貼入 authorization code 後完成 token exchange
- **AND** auth 存入 accounts.json

### Requirement: R2 — Dead code removal

anthropic.ts 的 fetch interceptor（L143-546）確認為死代碼後刪除。所有 claude-specific 邏輯（mcp_ prefix、identity、beta flags、billing header）已在 provider-claude 有對應實作。

#### Scenario: Fetch interceptor never invoked

- **GIVEN** anthropic.ts fetch interceptor 加入死代碼檢測 log
- **WHEN** 執行完整 claude-cli session（text streaming + tool calls）
- **THEN** log 中無 fetch interceptor 觸發紀錄
- **AND** session 功能完全正常

### Requirement: R3 — getModel delegates to provider-claude

plugin 的 auth.loader 回傳 getModel，呼叫 `createClaudeCode()` from `@opencode-ai/provider-claude`。不經 `@ai-sdk/anthropic`。

#### Scenario: Model creation path

- **GIVEN** claude-cli session 開始
- **WHEN** `Provider.getLanguage(model)` 被呼叫
- **THEN** `modelLoaders['claude-cli']` 呼叫 plugin 的 getModel
- **AND** getModel 呼叫 `createClaudeCode(credentials).languageModel(modelId)`
- **AND** 回傳 `ClaudeCodeLanguageModel`（LanguageModelV2 實作）
- **AND** `@ai-sdk/anthropic` 不在 import chain 中

### Requirement: R4 — Zero regression

遷移後現有功能完全保留：text streaming、multi-turn tool calls、token refresh、subscription auth。

#### Scenario: Full session regression

- **GIVEN** 遷移完成，anthropic.ts 已刪除
- **WHEN** 執行 claude-cli session，含 text + tool call + multi-turn
- **THEN** streaming 正常，tool calls 正確觸發與回傳
- **AND** token 自動 refresh（若過期）
- **AND** test suite 全部通過

## Acceptance Checks

- [ ] **AC-1**: `plugin/anthropic.ts` 已刪除
- [ ] **AC-2**: `plugin/claude-cli/` 目錄存在，含 `index.ts` + `auth.ts`
- [ ] **AC-3**: `plugin/index.ts` import 指向 `claude-cli/index.ts`
- [ ] **AC-4**: `plugin/claude-native.ts` import 指向 `claude-cli/index.ts`
- [ ] **AC-5**: claude-cli session 功能正常（streaming + tool calls + token refresh）
- [ ] **AC-6**: `createAnthropic` 不在 claude-cli 的 import chain 中
- [ ] **AC-7**: test suite 通過
