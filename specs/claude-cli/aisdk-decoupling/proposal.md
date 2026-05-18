# Proposal: claude-cli AI SDK 脫離

## Why

OpenCMS 的 claude-cli provider 目前走兩條路徑，都有問題：

1. **AI SDK 路徑**（`createAnthropic` from `@ai-sdk/anthropic`）— AI SDK 會重新序列化 request body、注入 User-Agent suffix、用自己的 fetch wrapper 包裝 HTTP，破壞我們花大量精力 reverse engineering 後 reproduce 的 exact wire fingerprint。
2. **provider-claude 路徑**（`createClaudeCode` from `@opencode-ai/provider-claude`）— 已自建 HTTP + SSE + LanguageModelV2，但 auth 和 request transform 邏輯仍散落在 `anthropic.ts` 的 fetch interceptor 裡，且兩條路徑在 `getModel` 裡做選擇，耦合不清。

claude-specific 邏輯（`mcp_` prefix、system prompt identity enforcement、billing header、beta flags）目前寫在 `anthropic.ts` 的 fetch interceptor 內，透過攔截 AI SDK 發出的 HTTP request 再改——這本質上是在 SDK 的 data path 上 patch，不是 own the data path。

`copilot-cli` 已驗證了 self-built pattern 的可行性（9 模組，~1,500 行，E2E 8/8 green）。claude-cli 應遵循同樣方向。

## Original Requirement Wording (Baseline)

- "暫時不要動到 global logic，只針對 claude 獨立性進行修改。不要讓 claude 客製化功能污染 ai-sdk。claude 先獨立，以後再和其他 provider 合起來研究怎麼共用元件。"

## Requirement Revision History

- 2026-05-18: initial draft — from handover discussion + research audit

## Effective Requirement Description

1. **R1 Self-Built Data Path**: claude-cli 擁有自己的 HTTP client + SSE parser，不經 AI SDK provider factory
2. **R2 Fingerprint Protection**: headers（anthropic-version, anthropic-beta, User-Agent 等）和 body shape 由 plugin 直接控制
3. **R3 Self-Contained Plugin**: 所有 claude-specific 邏輯（auth, mcp_ prefix, system prompt, billing header）集中在 `plugin/claude-cli/` 內
4. **R4 Minimal AI SDK Surface**: 唯一 AI SDK 接觸點是 `import type LanguageModelV2`（type contract, 非 runtime）
5. **R5 Zero Global Impact**: 不動 `streamText`、`tool`、`LanguageModelV2` 介面等 global 層

## Scope

### IN
- 整合 `anthropic.ts` + `provider-claude/` 為統一的 `plugin/claude-cli/` 套件
- 自建 Anthropic Messages API HTTP client（取代 `@ai-sdk/anthropic` 的 `createAnthropic`）
- 保留現有 OAuth PKCE auth flow（搬入 plugin）
- 保留現有 request transform（mcp_ prefix, identity, beta headers, billing header）搬入 plugin
- 保留 FFI bridge（`claude-native.ts`）作為可選增強
- `provider.ts` 的 `BUNDLED_PROVIDERS` 移除 `createAnthropic` import

### OUT
- Global orchestration（`streamText`, `generateText`, `tool`, `jsonSchema` 等）— 不動
- `LanguageModelV2` 介面重新定義 — 照用 AI SDK 的
- `ProviderTransform` 裡的 claude-specific 分支（toolCallId sanitize, cache control markers）— 暫不動，等共用元件階段處理
- 其他 provider（codex, copilot, gemini 等）— 不動
- `@ai-sdk/anthropic` package 從 package.json 移除 — 其他 provider 可能間接用到，暫保留

## Non-Goals

- 取代 AI SDK 的 orchestration 層（`ai` core package）
- 建立 cross-provider 共用元件（留給未來 phase）
- 修改 provider-claude C library（`libclaude_provider.so`）

## Constraints

- 必須遵守 `@opencode-ai/plugin` Hooks interface（auth.loader + auth.methods）
- Token refresh 必須有 mutex（防止 concurrent refresh race）— 現有邏輯已有，搬過去
- 不能破壞現有 claude-cli 帳號登入流程
- 不能靜默 fallback（AGENTS.md 第一條）
- 實作前備份 `~/.config/opencode/`（CLAUDE.md 規範）

## What Changes

- `packages/opencode/src/plugin/claude-cli/` — NEW: 完整 self-contained plugin 套件
- `packages/opencode/src/plugin/anthropic.ts` — DELETE or DEPRECATE（邏輯搬入 claude-cli/）
- `packages/opencode/src/plugin/claude-native.ts` — MODIFY: 改為 wrap claude-cli plugin（而非 anthropic plugin）
- `packages/opencode/src/plugin/index.ts` — MODIFY: import 指向新位置
- `packages/opencode/src/provider/provider.ts` — MODIFY: 移除 `createAnthropic` import，claude-cli 路徑走 plugin getModel

## Capabilities

### New Capabilities
- **Direct wire control**: Plugin 直接組 HTTP request，不經 AI SDK 重新序列化
- **Fingerprint integrity**: Headers 和 body shape 100% 由 plugin 控制

### Modified Capabilities
- **Auth flow**: 邏輯不變，程式碼位置從 `anthropic.ts` 搬到 `plugin/claude-cli/auth.ts`
- **Request transform**: 邏輯不變，從 fetch interceptor 搬到 request builder

## Impact

- `plugin/claude-cli/` — 新建 ~8 個模組
- `plugin/anthropic.ts` — 退役
- `plugin/claude-native.ts` — 修改 import 指向
- `plugin/index.ts` — 修改 import
- `provider/provider.ts` — 移除 1 行 createAnthropic import + 對應 BUNDLED_PROVIDERS entry

## Evidence

| Claim | Source |
|-------|--------|
| AI SDK 重新序列化破壞 fingerprint | Handover doc + copilot-cli DD-7/DD-9 |
| copilot-cli self-built pattern 可行 | `plugin/copilot-cli/` E2E 8/8 green |
| provider-claude 已有獨立 LanguageModelV2 | `packages/provider-claude/src/provider.ts` |
| anthropic.ts fetch interceptor 內容 | `packages/opencode/src/plugin/anthropic.ts` L106-624 |
| createAnthropic 唯一 import 點 | `packages/opencode/src/provider/provider.ts` L28 |
