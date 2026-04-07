# Proposal (v3)

> v1: C11 native plugin (abandoned — official CLI is JS)
> v2: Hook-based refactor (superseded — SDK still pollutes)
> v3: Native LanguageModelV2 provider replacing @ai-sdk/anthropic
> Updated: 2026-04-07

## Guiding Principles

1. **Fingerprint Fidelity** — Request 與官方 `claude-code@2.1.92` 完全一致。Server 不應能區分 OpenCode 與官方 CLI 的 request。
2. **Zero SDK Pollution** — HTTP 層不經過 `@ai-sdk/anthropic`，無 header 注入、無 body 中間層。
3. **Zero-Configuration Plugin Pack** — claude-cli provider 是自包含 package，host 無硬編碼。

## Why (v3)

v2 的 hook-based 重構解決了 plugin 架構問題，但沒解決根本問題：**`@ai-sdk/anthropic` 在 plugin fetch 之前注入 `anthropic-client`、`x-api-key`、自己的 `User-Agent`，plugin 必須 scrub 擦屁股**。

分析 AI SDK 結構後發現：
- Layer A（orchestration：`streamText`、tool loop）不碰 HTTP，可共用
- Layer B（types：`LanguageModelV2` interface）純型別定義，可共用
- Layer C（middleware：`wrapLanguageModel`）不碰 HTTP，可共用
- **Layer D（`@ai-sdk/anthropic`：request builder + SSE parser）是污染源，需整層替換**

分界線就是 `LanguageModelV2` interface。自己實作這個 interface，就完全控制 HTTP 層，同時享有 `streamText()` 的 orchestration 便利。

## Effective Requirement Description

1. 建立 `packages/opencode-claude-provider/` TypeScript package
2. 實作 `LanguageModelV2` interface（`doStream` + `doGenerate`）
3. 自己組 HTTP headers（whitelist 模式，從零建構）
4. 自己組 request body（LMv2 → Anthropic 格式，一次 serialize）
5. 自己解 SSE response（Anthropic SSE → LMv2 StreamPart）
6. System prompt 結構對齊官方（block 順序 + cache_control scope）
7. 清除 host 端所有 `claude-cli` 硬編碼
8. 保留 OAuth PKCE 流程（從 anthropic.ts 提取，不改行為）

## Scope

### IN

- 自製 `LanguageModelV2` provider（~800 行 TS）
- LMv2 ↔ Anthropic format converters
- SSE parser
- Header builder（whitelist 模式）
- System prompt block builder（含 cache_control）
- Auth 模組提取
- Host 端 14 處硬編碼清除

### OUT

- 不修改 `ai` core 或 `@ai-sdk/provider`（只用不改）
- 不修改其他 provider（codex/copilot/gemini-cli 仍用各自的 SDK provider）
- 不改變 OAuth 流程行為
- 不實作 2.1.92 新 API（Files API、Skills API — 後續 task）

## What Changes

| 區域 | 變更 |
|---|---|
| 新增 `packages/opencode-claude-provider/` | LanguageModelV2 impl + auth + converters + SSE parser |
| 修改 `provider/provider.ts` | claude-cli 改用 `createClaudeCode()` 取代 `createAnthropic()` |
| 刪除 `plugin/anthropic.ts` | 被 provider package 取代 |
| 刪除 `plugin/claude-native.ts` | FFI wrapper 不再需要 |
| 修改 `plugin/index.ts` | 移除 claude-cli internal plugin |
| 刪除 `custom-loaders-def.ts` anthropic 區塊 | Provider 自己管 headers |
| 修改 14 個 host 檔案 | 移除 `isClaudeCode` / `claude-cli` 硬編碼 |

## Impact

- 新增 ~800 行 TypeScript（converter + SSE + provider + headers）
- 刪除 ~600 行（anthropic.ts + claude-native.ts）
- 修改 14 個 host 檔案（刪除特例分支）
- `@ai-sdk/anthropic` 仍保留在 dependencies 中（其他 provider 可能用）
- 零 runtime behavior 變更（wire format 完全相同，只是不經過 SDK）
