# Spec: bare_chat_session

## Purpose

讓同機外部 app（首例 cecelearn）透過 opencode daemon 的 unix socket 開一個「乾淨」對話 session：system prompt 只由呼叫端提供，不被 opencode 的 driver / AGENTS.md / SYSTEM.md / agent prompt / identity 污染；重用 daemon 的帳號池與結構化輸出能力。

## Requirements

### Requirement: Bare session 只用呼叫端 system prompt

#### Scenario: 外部 app 開 bare session 送對話

- **GIVEN** daemon 在 unix socket 上運行、Claude 帳號已登入
- **WHEN** 呼叫端 `POST /api/v2/session/{id}/message` 帶 `agent:"bare"` + `system:"<小雞老師 persona>"` + `parts`
- **THEN** 送給 LLM 的 system prompt 只含呼叫端的 `system` 內容
- **AND** 不含 opencode 的 driver / AGENTS.md / SYSTEM.md / agent prompt / [IDENTITY REINFORCEMENT]

#### Scenario: 一般 session 不受影響

- **GIVEN** bare 模式已實作
- **WHEN** 呼叫端開普通 top-level session（不帶 `agent:"bare"`）
- **THEN** system prompt 維持原本七層組裝（driver + AGENTS.md + SYSTEM.md + agent + identity + userSystem）
- **AND** 既有行為零退化

### Requirement: Bare session 結構化輸出

#### Scenario: 帶 json_schema 在 Claude 上強制結構化

- **GIVEN** bare session 指定 Claude provider（claude-cli）
- **WHEN** 呼叫端 message 帶 `format:{type:"json_schema", schema:<intent schema>}`
- **THEN** daemon 註冊 StructuredOutput tool（input_schema = 呼叫端 schema）
- **AND** toolChoice 設為 required，Claude provider 映射成 `{type:any}`
- **AND** 回應為 schema 受限的結構化 JSON

#### Scenario: 模型未產出結構化輸出時明確報錯

- **GIVEN** bare session 帶 json_schema
- **WHEN** 模型未呼叫 StructuredOutput tool（純文字回應）
- **THEN** daemon 回 StructuredOutputError，不靜默回自由文字（天條 #11）

### Requirement: Bare session 借用帳號（POC 固定 pin）

#### Scenario: POC 固定帳號

- **GIVEN** claude-cli family 有帳號 `claude-cli-subscription-claude-cli-d5002de6`（yeatsluo@g.ncu.edu.tw）
- **WHEN** 呼叫端 message 帶 `model:{providerId:"claude-cli", modelID:"claude-opus-4-8", accountId:"claude-cli-subscription-claude-cli-d5002de6"}`
- **THEN** daemon 用該固定帳號的 OAuth 憑證打 Claude
- **AND** 不觸發 rotation pool、無 cross-family fallback
- **AND** 呼叫端完全不接觸憑證

#### Scenario: 指定帳號不存在時 fail-fast

- **GIVEN** bare session 指定一個不存在的 accountId
- **WHEN** 送 message
- **THEN** daemon 明確報錯，不靜默 fallback 到其他帳號（天條 #11）

### Requirement: Bare session 不掛內建工具、不自主推進

#### Scenario: 不掛 opencode 內建工具

- **GIVEN** bare session
- **WHEN** 送 message
- **THEN** 工具集只含 format:json_schema 的 StructuredOutput tool（若有 format）
- **AND** 不含 read/edit/bash/task 等 opencode 內建工具

#### Scenario: 不觸發 autorun continuation

- **GIVEN** bare session 完成一輪回應
- **WHEN** runLoop 評估是否 continue
- **THEN** bare session 被識別為 passthrough、不自主推進、不進 plan-builder continuation
- **AND** 純一問一答

## Acceptance Checks

- [ ] bare session 的 LLM system prompt 經 log/trace 驗證只含呼叫端 system（無 AGENTS.md/SYSTEM.md/driver/identity）。
- [ ] 普通 session 的 system prompt 七層組裝零退化（回歸測試）。
- [ ] bare session 帶 json_schema + Claude → 回 schema 受限 JSON（端到端 POC，固定帳號）。
- [ ] 模型未產出結構化 → StructuredOutputError，非靜默自由文字。
- [ ] bare session 固定 accountId → 用該帳號、不 rotation、不 cross-family。
- [ ] 指定不存在帳號 → fail-fast 報錯。
- [ ] bare session 工具集不含 opencode 內建工具。
- [ ] bare session 不觸發 autorun continuation。
- [ ] cecelearn 經 unix socket 端到端跑通一輪小雞老師對話（POC）。
