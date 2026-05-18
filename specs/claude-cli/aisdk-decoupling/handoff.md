# Handoff: claude-cli AI SDK 脫離

## Execution Contract

Builder 將執行 5 個 phase（Phase 0-4），把 `anthropic.ts` 的活邏輯搬入 `plugin/claude-cli/`，刪除死代碼，rewire imports，更新 tests。不改 `provider-claude/`，不動 global orchestration。

**Phase 0 是 gate**：若 fetch interceptor 不是死代碼（被觸發），必須停止並回報，不得繼續。

## Required Reads

Before writing any patch, read:

1. **`packages/opencode/src/plugin/anthropic.ts`**（全檔 624 行）
   - L65-104：`authorize()` + `exchange()`（搬到 auth.ts）
   - L106-567：`AnthropicAuthPlugin` — auth.loader 全體
   - L113-131：loader 回傳結構（重點：L143-546 是 fetch interceptor 死代碼）
   - L548-564：`getModel`（搬到 index.ts）
   - L568-621：`auth.methods`（搬到 auth.ts）

2. **`packages/opencode/src/plugin/claude-native.ts`**（L1-50）
   - L6：`import { AnthropicAuthPlugin } from "./anthropic"` — 要改
   - 理解 FFI bridge wrap 邏輯

3. **`packages/opencode/src/plugin/index.ts`**
   - 找到 `claude-cli` 的 plugin registration 行

4. **`packages/provider-claude/src/provider.ts`**（L50-57）
   - `createClaudeCode()` 的 signature 和 `ClaudeCodeProviderOptions`
   - 確認 `ClaudeCredentials` type 的 shape

5. **`packages/provider-claude/src/auth.ts`**
   - `isClaudeCredentials()` 的 type guard
   - `ClaudeCredentials` type definition

6. **`packages/opencode/src/plugin/copilot-cli/index.ts`**（參考 pattern，不需要完整讀）

## Stop Gates In Force

- **CLAUDE.md — XDG 備份**：Phase 1 第一個編輯前，備份 `~/.config/opencode/` 關鍵設定檔
- **CLAUDE.md — 禁止 daemon lifecycle**：不可自行 spawn/kill/restart daemon
- **Memory — Restart Daemon Requires User Consent**：修完先問，不自行 restart
- **Memory — No Silent Fallback**：若 provider-claude import 失敗，明確報錯
- **Phase 0 Gate**：fetch interceptor 若被觸發，停止回報
- **Zero global impact**：不動 `streamText`、`tool`、`LanguageModelV2` 等 global 層

## Execution-Ready Checklist

- [ ] 已讀 anthropic.ts 全檔，理解三段結構（auth → fetch interceptor → getModel + methods）
- [ ] 已讀 claude-native.ts，理解 FFI bridge wrap 邏輯
- [ ] 已讀 provider-claude/provider.ts，確認 createClaudeCode signature
- [ ] 已讀 provider-claude/auth.ts，確認 ClaudeCredentials shape
- [ ] 已確認 plugin/index.ts 中 claude-cli 的 registration 方式
- [ ] 已備份 ~/.config/opencode/（CLAUDE.md 規範）
- [ ] Phase 0 驗證已通過（fetch interceptor confirmed dead）
