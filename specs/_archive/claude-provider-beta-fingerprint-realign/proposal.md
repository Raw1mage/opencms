# Proposal: claude-provider-beta-fingerprint-realign

## Why

`@opencode-ai/provider-claude` 是 opencode 對 Anthropic API 的「官方 CLI 模擬」層。User-Agent、attribution salt、CLIENT_ID 等靜態指紋都已對齊 claude-code v2.1.112，但 **`anthropic-beta` header 的組裝邏輯**跟上游的 `ZR1` 函式不等價。

跨上游 `cli.js`（pinned `refs/claude-code-npm/` v2.1.112）核對後，找到 5 個具體偏差：

1. `claude-code-20250219` 在我們是 MINIMUM_BETAS 永遠送，**上游對 Haiku 模型不送**。
2. `context-management-2025-06-27` 在我們是 MINIMUM_BETAS 永遠送，**上游是三重條件閘**（firstParty + `!DISABLE_EXPERIMENTAL_BETAS` + 模型條件）。對 Bedrock / Vertex / 第三方 gateway 多發這個 beta，server 可能 400。
3. `redact-thinking-2026-02-12` **我們完全沒送**；上游在 OAuth + thinking 啟用 + `showThinkingSummaries !== true` 時送。
4. **Push 順序不一致**：上游順序 `claude-code → oauth → context-1m → interleaved-thinking → redact-thinking → context-management → structured-outputs → web-search → prompt-caching`；我們是 minimum 先、conditional 後。對於 server-side 做 beta-string fingerprint hash 的場景會被識破。
5. `prompt-caching-scope-2026-01-05` 我們的條件是 `isOAuth`，上游用 `ja()`（疑似等價但需 grep 驗證）。

驗證已完成的部分（不在此 plan 範圍）：`ATTRIBUTION_SALT="59cf53e54c78"`、`CLIENT_ID="9d1c250a-..."`、所有 9 個 beta flag 字串本身——一字不差。

## Original Requirement Wording (Baseline)

- 「開一個 PLAN 講清楚」（在使用者完成 npm source pull + fingerprint 驗證討論之後提出）
- 對應前情提要：使用者要求 (a) bump claude-code submodule (b) 同步 provider plugin (c) 加 Opus 4.7 (d) 抓 npm source 進 refs (e) 做 fingerprint 比對。前 4 項已 commit (`4f6039bf1`, `e5c285b40`)；本 plan 處理第 5 項揭露的 5 個偏差。

## Requirement Revision History

- 2026-05-03: initial draft created via plan-init.ts
- 2026-05-03: 5 個 beta-assembly 偏差項目正式立 plan（先前已在對話中口頭確認）

## Effective Requirement Description

1. 重構 `packages/provider-claude/src/protocol.ts` 的 `assembleBetas()`，使其輸出（順序 + 內容）跟上游 `ZR1` 函式對任意 (model × auth × env × provider) 組合等價。
2. 拆掉 `MINIMUM_BETAS` 這個概念——上游沒有「永遠送」的 beta 集合，應該模仿上游用「逐項條件 push」的結構。
3. 補上 `redact-thinking-2026-02-12` 的條件 push。
4. 不擴張 wire-level 行為到 `structured-outputs-2025-12-15` / `web-search-2025-03-05`（前者要 tengu feature flag，後者只在 vertex/foundry provider 觸發；opencode 用直接 Anthropic 路徑，碰不到）——但程式碼結構要保留將來容易加。
5. 釐清 `prompt-caching-scope-2026-01-05` 的條件，並寫成可追溯到上游 cli.js 行號的註解。

## Scope

### IN
- `packages/provider-claude/src/protocol.ts`：`assembleBetas()` 重構、`MINIMUM_BETAS` 拆解、新增 helper（`isHaikuModel`、`isFirstParty`、`shouldRedactThinking` 等）
- `packages/provider-claude/src/headers.ts`：可能需新增 `provider`（"firstParty" / "bedrock" / "vertex" / "foundry"）參數傳遞
- `packages/provider-claude/src/provider.ts`：呼叫端把 `provider` / `showThinkingSummaries` 等新條件變數轉發進來
- 新增 unit test：對 (haiku, opus, sonnet) × (oauth, apiKey) × (有/無 1M context) × (firstParty / bedrock / vertex) 矩陣斷言預期 beta 序列
- 更新 `plans/claude-provider/protocol-datasheet.md` 對應段落到 v2.1.112 邏輯

### OUT
- `structured-outputs-2025-12-15` 實際 wire-level 觸發（要等 tengu flag 機制接上）
- `web-search-2025-03-05`（vertex/foundry-only，不在 opencode 直連路徑）
- 任何非 beta-header 的 fingerprint 對齊（system block layout、cache TTL、thinking camelCase 正規化——前次 context layer 審查找到的另兩個議題，將另開 plan）
- 升 npm reference 到 v2.1.113+（已知是 native binary，無 JS source 可驗）

## Non-Goals

- 不改 message / system block 結構（已驗證乾淨）
- 不改 SSE 解析、token refresh、auth flow
- 不引入 AI SDK 任何新依賴
- 不為將來 Bedrock/Vertex 支援做提前抽象——只在現有條件邏輯上對齊

## Constraints

- AGENTS.md 第一條「禁止靜默 fallback」：條件 push 必須明確；找不到對應上游條件時，明確標註 TODO 而非預設 push 或預設不 push
- AGENTS.md「外部 plugin 必須分析後重構，不可直接 merge」：本 plan 即在執行此精神
- 不可引入 AI SDK pollution（前次 context layer 審查已立此原則）
- 任何條件變數命名需可追溯到 cli.js 內的 minified 變數名（如 `// upstream: i7()`、`// upstream: ja()`）便於日後升級對照
- **opencode 本地端只使用 OAuth token 存取 Anthropic server**（無 API-key 路徑）。`assembleBetas()` 函式介面仍接受 `isOAuth` 以保留上游模型完整性 + 測試矩陣可驗 false 分支，但 `provider.ts` 呼叫端永遠硬寫 `isOAuth: true`。任何「fallback 到 API key」的程式碼路徑都禁止存在。
- opencode 執行於 daemon mode，**`isInteractive` 永遠為 false**。這跟 claude-code CLI 的 interactive TTY 模式是刻意分歧的 deployment topology — 不是 bug。`redact-thinking-2026-02-12` 因此在 opencode runtime 永不觸發；測試矩陣仍涵蓋 true 分支以保上游 fidelity。

## What Changes

- `assembleBetas()` 從「拼接 MINIMUM_BETAS + conditional」改成「上游風格的逐項條件 push」
- `AssembleBetasOptions` 介面新增 `provider`（enum）、`showThinkingSummaries`（bool）、`disableExperimentalBetas`（bool）三個欄位
- `MINIMUM_BETAS` 常數移除（其成員的條件分散到對應 push 區塊）
- 新增 `redact-thinking-2026-02-12` 的常數定義 + 條件 push
- `convertSystemBlocks` / `provider.ts` 必要時轉發新欄位
- protocol-datasheet.md § Beta Flag Assembly 段落改寫，附 cli.js 偏移座標

## Capabilities

### New Capabilities
- **Beta-fingerprint parity with claude-code 2.1.112**：對所有 (model, auth, provider) 組合產生與上游一字一句相同的 `anthropic-beta` header
- **Redacted thinking 模式支援**：當 OAuth 認證 + thinking 啟用 + 不顯示 thinking 摘要時，正確發送 `redact-thinking-2026-02-12`

### Modified Capabilities
- `assembleBetas()`：輸入介面新增 3 個欄位；輸出順序與條件邏輯改變
- Haiku 模型走 claude-provider 時：不再多帶 `claude-code-20250219`（之前是 fingerprint mismatch）
- 非 firstParty 走法（雖目前 opencode 沒走第三方 gateway，但程式碼預留）：不送 `context-management-2025-06-27`

## Impact

- **直接影響**：所有透過 `@opencode-ai/provider-claude` 發出的 Anthropic API 請求，header 順序 + 內容會變
- **使用者面**：應該無感（如果 server 過去有靜默接受我們的多送 beta；如果有 fingerprint 比對就會從失敗變成功）
- **回歸風險**：`context-management-2025-06-27` 從必送變條件送——若 opencode 某些 prompt 行為實質依賴此 beta，需要確保條件閘正確判斷為 true
- **測試需求**：必須加矩陣 unit test，避免下次升級又偏離
- **文件**：
  - `plans/claude-provider/protocol-datasheet.md` § 9 重寫
  - `specs/architecture.md` 不需動（claude-provider 內部變動不上架構層）
- **後續 plan 預留**：context-layer 審查找到的另兩個 polish 點（thinking camelCase normalize、static cache TTL=1h）會另開 plan
