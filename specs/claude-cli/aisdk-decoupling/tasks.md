# Tasks

## Phase 0: Verification（確認假設）

- [x] T0.1 — 在 `anthropic.ts` fetch interceptor (L143) 加 `log.warn("DEAD_CODE_CHECK: fetch interceptor invoked")`
- [x] T0.2 — 靜態分析確認 fetch interceptor 是死代碼（model.api.npm 不觸發 createAnthropic，getModel 忽略 sdk）
- [x] T0.3 — 確認 fetch interceptor 未被觸發（code path analysis: getSDK→null, loader ignores sdk）
- [x] T0.4 — 確認 `getModel` 走 provider-claude 路徑（createClaudeCode）
- [~] T0.5 — 未觸發，不需修訂

## Phase 1: 建立 plugin/claude-cli/

### 1A. Auth 模組提取（A2）

- [x] T1A.1 — 建立 `plugin/claude-cli/auth.ts`
- [x] T1A.2 — 委託 provider-claude/auth.ts 的 `authorize()`（不需複製，直接 import）
- [x] T1A.3 — 委託 provider-claude/auth.ts 的 `exchange()`（不需複製，直接 import）
- [x] T1A.4 — 建立 `authMethods` 陣列：subscription + console 兩種 login flow
- [x] T1A.5 — helper types 保留在 index.ts（ClaudeOAuthAuth, isClaudeOAuthAuth）
- [x] T1A.6 — 確認 `auth.ts` 編譯通過

### 1B. Plugin Entry 建立（A3）

- [x] T1B.1 — 建立 `plugin/claude-cli/index.ts`
- [x] T1B.2 — 實作 `ClaudeCliPlugin(input: PluginInput): Promise<Hooks>`
- [x] T1B.3 — 搬入 `auth.loader`：移除 fetch interceptor，保留 getModel + credential passthrough
- [x] T1B.4 — auth.loader 回傳值：`{ getModel, type, refresh, access, expires, orgID, email, accountId }`（無 fetch）
- [x] T1B.5 — getModel 委託 `createClaudeCode(credentials).languageModel(modelId)`
- [x] T1B.6 — import authMethods from `./auth.ts`
- [x] T1B.7 — 確認 `index.ts` 編譯通過

## Phase 2: Rewire（A4）

- [x] T2.1 — 修改 `plugin/index.ts`：comment 更新（import 不需改，已經 import claude-native）
- [x] T2.2 — 修改 `plugin/claude-native.ts`：import 從 `./anthropic` 改為 `./claude-cli`
- [x] T2.3 — 確認 `ClaudeNativeAuthPlugin` 正常 wrap 新 plugin
- [x] T2.4 — 刪除 `plugin/anthropic.ts`
- [x] T2.5 — 全 codebase grep 確認無殘留 import（僅 test files，已刪除）

## Phase 3: Test 更新（A5）

- [x] T3.1 — `anthropic.test.ts` 刪除（測試死代碼 fetch interceptor）
- [x] T3.2 — `anthropic-cli.test.ts` 刪除（測試死代碼 fetch interceptor）
- [x] T3.3 — 建立 `plugin/claude-cli/claude-cli.test.ts`（5 tests）
- [x] T3.4 — 測試覆蓋：plugin registration（provider === "claude-cli"）
- [x] T3.5 — 測試覆蓋：getModel 存在且為 function
- [x] T3.6 — 測試覆蓋：auth.methods 有 2 個 OAuth flow
- [x] T3.7 — `bun test` 全 plugin suite 14/14 pass

## Phase 4: Regression 驗證

- [~] T4.1 — 執行 claude-cli text streaming session（待 rebuild 後 runtime 驗證）
- [~] T4.2 — 執行 claude-cli tool call session（待 rebuild 後 runtime 驗證）
- [~] T4.3 — 確認 token refresh 正常（待 rebuild 後 runtime 驗證）
- [x] T4.4 — grep `@ai-sdk/anthropic` 在 claude-cli import chain 中不出現 ✓
- [x] T4.5 — 驗證結果：靜態分析 + 編譯 + unit test 全通過；runtime session 待 rebuild
