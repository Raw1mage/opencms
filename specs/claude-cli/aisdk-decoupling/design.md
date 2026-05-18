# Design: claude-cli AI SDK 脫離

## Context

研究發現 `claude-cli` 的 AI SDK 依賴比預期淺：

1. **`provider-claude/` 已是獨立 LanguageModelV2 實作** — 有自建 HTTP client、SSE parser、header builder、prompt converter、auth module。8 個模組，完整的 wire format 控制。
2. **`anthropic.ts` 的 `getModel` 已經繞過 AI SDK** — 它呼叫 `createClaudeCode()`（from provider-claude），不用 `createAnthropic`（from @ai-sdk/anthropic）。
3. **`anthropic.ts` 的 fetch interceptor 是死代碼** — 因為 `getModel` 走 provider-claude 的自建 HTTP，SDK 的 fetch 不會被觸發。但 interceptor 裡有大量 claude-specific 邏輯（mcp_ prefix、identity enforcement、billing header、beta flags），跟 `provider-claude` 的邏輯**重複**。

問題是**散亂**而非**缺失**：
- `anthropic.ts`（plugin 層）：auth PKCE flow + fetch interceptor（死代碼）+ getModel
- `provider-claude/`（獨立 package）：protocol + headers + convert + sse + auth + provider
- `claude-native.ts`（FFI bridge）：嘗試載入 C lib，失敗則 wrap `anthropic.ts`
- `provider.ts`：`BUNDLED_PROVIDERS["@ai-sdk/anthropic"]` 給 legacy `anthropic` family 用

## Goals / Non-Goals

### Goals
- 整合分散的 claude-cli 邏輯為一致的 `plugin/claude-cli/` 套件
- 移除 `anthropic.ts` 中的死代碼（fetch interceptor）
- 確認 `provider-claude` 是唯一的 data path（移除任何可能回到 AI SDK 的路徑）
- 清楚界定 plugin（auth + Hooks）vs provider-package（LanguageModelV2 + protocol）的職責

### Non-Goals
- 修改 `provider-claude/` 的內部實作（它已經工作正常）
- 移除 `@ai-sdk/anthropic` 從 package.json（legacy `anthropic` family 還用）
- 動到 global orchestration（`streamText`、`tool` 等）
- 處理 `ProviderTransform` 裡的 claude-specific 分支

## Architecture

### 現況（散亂）

```
anthropic.ts (plugin)              provider-claude/ (package)
├── OAuth PKCE                     ├── protocol.ts  (constants, betas)
├── Token refresh (mutex)          ├── headers.ts   (whitelist builder)
├── fetch interceptor ← 死代碼     ├── convert.ts   (prompt → Messages API)
│   ├── mcp_ prefix               ├── sse.ts       (SSE parser)
│   ├── identity enforce           ├── auth.ts      (OAuth, refresh, profile)
│   ├── beta flags assembly        ├── models.ts    (catalog)
│   ├── billing header             └── provider.ts  (LanguageModelV2)
│   └── header scrubbing
├── getModel → createClaudeCode ──────────────────┘
└── auth.methods (OAuth UI)

claude-native.ts (FFI bridge)
└── wraps anthropic.ts + tries C lib
```

### 目標（統一）

```
plugin/claude-cli/
├── index.ts        — ClaudeCliPlugin entry, export Hooks
├── auth.ts         — OAuth PKCE + token refresh (from anthropic.ts)
└── (delegates to @opencode-ai/provider-claude for everything else)

packages/provider-claude/  (不改)
├── protocol.ts     — constants, beta assembly, billing
├── headers.ts      — header builder
├── convert.ts      — prompt/tool conversion + mcp_ prefix
├── sse.ts          — SSE parser
├── auth.ts         — token refresh with mutex, profile fetch
├── models.ts       — model catalog
├── provider.ts     — ClaudeCodeLanguageModel (LanguageModelV2)
└── index.ts        — public API

plugin/claude-native.ts  (optional FFI, wraps claude-cli plugin)
```

### 職責界定

| 職責 | 歸屬 | 理由 |
|------|------|------|
| OAuth authorize + exchange | plugin/claude-cli/auth.ts | Plugin Hooks 介面要求 |
| Token refresh with mutex | provider-claude/auth.ts | 已在那裡，跨 request 共用 |
| HTTP request building | provider-claude/provider.ts | LanguageModelV2.doStream |
| Header assembly | provider-claude/headers.ts | Wire fingerprint |
| Prompt/tool conversion | provider-claude/convert.ts | Wire format |
| SSE parsing | provider-claude/sse.ts | Wire format |
| mcp_ tool prefix | provider-claude/convert.ts | 已在那裡 |
| System prompt identity | provider-claude/provider.ts | 已在那裡 |
| Beta flags assembly | provider-claude/protocol.ts | 已在那裡 |
| Billing header | provider-claude/protocol.ts | 已在那裡 |
| getModel factory | plugin/claude-cli/index.ts | Hooks.auth.loader |
| auth.methods (OAuth UI) | plugin/claude-cli/auth.ts | Hooks 介面 |

### AI SDK 接觸面

| 層 | 用什麼 | 不用什麼 |
|---|--------|---------|
| provider-claude | `import type { LanguageModelV2, ... }` from `@ai-sdk/provider` | ~~任何 runtime import~~ |
| plugin/claude-cli | 無直接 AI SDK 接觸 | ~~@ai-sdk/anthropic~~ ~~createAnthropic~~ |
| provider.ts registry | `BUNDLED_PROVIDERS["@ai-sdk/anthropic"]` 保留給 legacy `anthropic` family | claude-cli 不經此路徑 |

## Decisions

- **DD-1**: `plugin/claude-cli/` 是薄包裝層，核心邏輯留在 `provider-claude/`。跟 copilot-cli 不同（copilot-cli 是從零自建），claude 的 provider package 已成熟，不需複製。
- **DD-2**: `anthropic.ts` 的 fetch interceptor 確認為死代碼後刪除。OAuth PKCE flow + auth.methods 搬到 `plugin/claude-cli/auth.ts`。
- **DD-3**: `claude-native.ts`（FFI bridge）保留，但改為 wrap `plugin/claude-cli/` 而非 `anthropic.ts`。
- **DD-4**: `provider.ts` 的 `createAnthropic` import 和 `BUNDLED_PROVIDERS["@ai-sdk/anthropic"]` 暫時保留——它給 legacy `anthropic` family 用（API key 直連路徑）。只有當 `anthropic` family 也遷移後才移除。
- **DD-5**: 不在此計畫中移除 `@ai-sdk/anthropic` 從 `package.json`——理由同 DD-4。
- **DD-6**: `anthropic.ts` 中的重複邏輯（token refresh、mcp_ prefix、identity、beta flags、billing header）已在 `provider-claude/` 有對應實作（且版本更新：2.1.126 vs 2.1.92）。不需搬——直接刪掉 `anthropic.ts` 的版本。

## Verification Strategy

### V1: 確認 fetch interceptor 是死代碼
- 在 `anthropic.ts` 的 `fetch()` 函數開頭加 `log.warn("DEAD CODE CHECK: fetch interceptor invoked")`
- 執行完整 session（text + tool call + streaming）
- 確認 log 從未出現

### V2: 確認 getModel 走 provider-claude
- 在 `getModel` 函數加 `log.info("CHECKPOINT: getModel via provider-claude")`
- 執行同上 session
- 確認 log 出現且 response 正常

### V3: 遷移後 regression test
- 刪除 `anthropic.ts` 後執行 existing test suite
- 確認 `anthropic.test.ts` 和 `anthropic-cli.test.ts` 對應更新或刪除
- 新建 `plugin/claude-cli/claude-cli.test.ts` 覆蓋 auth + getModel

## Risks / Trade-offs

- **Legacy `anthropic` family 受影響** — 保留 `BUNDLED_PROVIDERS["@ai-sdk/anthropic"]` 避免。但如果有 user 同時用 `anthropic` 和 `claude-cli` family，需確認行為一致。
- **FFI bridge 修改** — `claude-native.ts` 要改 import，但邏輯不變。
- **Dead code verification** — 如果 fetch interceptor 不是死代碼（某些 edge case 下被觸發），需要更仔細的遷移。V1 驗證步驟可防此風險。

## Critical Files

| File | Role | Change Type |
|------|------|-------------|
| `packages/opencode/src/plugin/claude-cli/index.ts` | Plugin entry — Hooks export, getModel | New |
| `packages/opencode/src/plugin/claude-cli/auth.ts` | OAuth PKCE + auth.methods | New (from anthropic.ts) |
| `packages/opencode/src/plugin/anthropic.ts` | Old single-file plugin | Delete |
| `packages/opencode/src/plugin/claude-native.ts` | FFI bridge | Modify (import change) |
| `packages/opencode/src/plugin/index.ts` | Plugin registry | Modify (import change) |
| `packages/provider-claude/src/` | Independent provider package | No change |

## Code Anchors

| Anchor | File | Line | Role |
|--------|------|------|------|
| AnthropicAuthPlugin | `plugin/anthropic.ts` | 106 | Current plugin entry (to be replaced) |
| fetch interceptor | `plugin/anthropic.ts` | 143 | Dead code candidate |
| getModel | `plugin/anthropic.ts` | 548 | Model factory (to be migrated) |
| auth.methods | `plugin/anthropic.ts` | 568 | OAuth UI (to be migrated) |
| ClaudeNativeAuthPlugin | `plugin/claude-native.ts` | 55+ | FFI bridge (import change) |
| createClaudeCode | `provider-claude/src/provider.ts` | 51 | Provider factory (no change) |
| BUNDLED_PROVIDERS | `provider/provider.ts` | 288 | Legacy anthropic entry (no change) |
| modelLoaders extract | `provider/provider.ts` | 1749 | getModel wiring (no change) |

## Upstream References

| Reference | Location | Purpose |
|-----------|----------|---------|
| provider-claude package | `packages/provider-claude/src/` | Already-built independent provider |
| Claude CLI ref | `refs/claude-code/` | Protocol reference (provider-claude already aligned to 2.1.126) |
| copilot-cli plugin | `plugin/copilot-cli/` | Pattern reference (but claude's is simpler: thin wrapper) |
