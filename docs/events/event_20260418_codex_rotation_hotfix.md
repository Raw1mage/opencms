# Event: Codex Provider Rotation Hotfix

## 背景

使用者回報兩個 production 問題，都集中在 codex provider 的 rotation 行為：

1. **Codex 5H 用量竭盡時不會觸發 rotation**。Codex subscription 共用 ChatGPT 的 5 小時 wham/usage 視窗，用盡後 upstream 回 429；但 cockpit-strategy 原本只跑 openai family，codex 帳號的錯誤只能走 passive 分類，結果程式卡在同一個已限流的帳號上，session 停下來。
2. **Codex rotation 誤切到 anthropic / gemini**。當下使用 codex 時，rotation 3D 會挑健康分數最高的任何 provider；但 codex 的系統設計前提是「同一 subscription 家族之間輪替」，切到 claude 或 gemini 會造成身份錯位，且多數情況下 anthropic/gemini 也沒有 codex 帳號可接手。

使用者選項 A：「codex family 硬性 same-provider-only（內建行為，不給 config）」。

## 修法總覽（四階段）

計畫位址：`plans/codex-rotation-hotfix/`（spec / design / tasks / handoff / idef0 / grafcet / c4 / sequence 共 10 份 artifact）。

### Phase 1 — Codex 加入 cockpit strategy

- **檔案**：`packages/opencode/src/account/rate-limit-judge.ts`
- **修法**：
  - `getBackoffStrategy` 新增 codex → cockpit 路徑
  - `fetchCockpitBackoff` 的 providerId 檢查從 `=== "openai"` 改為 `COCKPIT_WHAM_USAGE_FAMILIES.has(...)`（set = openai + codex）
  - 每個 cockpit 分支加 `log.info` — healthy / exhausted / unavailable 三種決策都留痕
- **測試**：`test/account/codex-cockpit-backoff.test.ts` — 7 tests pass（含 getBackoffStrategy gate、codex 走 openai quota endpoint、非 cockpit provider short-circuit、cockpit 失敗 fail-open）
- **Test-only export**：`__testOnly_fetchCockpitBackoff` + fixture re-export 解決動態 import 順序

### Phase 2 — Candidate filter 支援 codex quota

- **檔案**：`packages/opencode/src/account/rotation3d.ts`
- **修法**：抽出 pure helper `evaluateWhamUsageQuota(providerId, accountId, quotas)`，在 `buildFallbackCandidates` 的 `enrich` 流程中用它判定 `exhausted`。`WHAM_USAGE_FAMILIES` set 覆蓋 openai + codex。
- **測試**：`test/account/codex-quota-candidate-filter.test.ts` — 9 tests pass（set 成員、hourlyRemaining ≤ 0、weeklyRemaining ≤ 0、null quota、unknown 帳號、非 wham 家族等情境）

### Phase 3 — Codex family 硬性 same-provider-only

- **檔案**：
  - `packages/opencode/src/account/rotation3d.ts` — 新增 `enforceCodexFamilyOnly(current, candidates)`，在 codex 當下時把非 codex 候選從候選池中剔除，並 `log.info` 每一筆被剔除的決策
  - `packages/opencode/src/account/rate-limit-judge.ts` — 新增 `CodexFamilyExhausted` NamedError（data: providerId / accountId / modelId / triedCount / message）
  - `packages/opencode/src/session/llm.ts::handleRateLimitFallback` — findFallback 回 null 且 current 是 codex 時 throw `CodexFamilyExhausted`
  - `packages/opencode/src/session/processor.ts` — catch block 內三個 `LLM.handleRateLimitFallback` 呼叫點（temporary-error / permanent-error / retry-path）各自 wrap `try/catch`，把 `CodexFamilyExhausted.isInstance` 轉成「surface error + set session idle + break」
- **preflight 路徑**：preflight 在 outer try 區段內，throw 會被 outer catch 承接，`isModelTemporaryError` 與 `isModelPermanentError` 都不會匹配 codex NamedError，會順流至 error-surface 終結 session。稽核完成。
- **測試**：`test/account/codex-family-only-fallback.test.ts` — 6 tests pass（codex current 剔除 anthropic/gemini、空池情境、非 codex current 不受影響、非 codex 候選高 priority 仍被剔除、NamedError shape + isInstance）

### Phase 4 — Passive classification belt-and-suspenders

- **檔案**：`packages/opencode/src/account/rotation/backoff.ts::parseRateLimitReason`
- **修法**：新增 codex 5H / response-time-window / weekly 的訊息 pattern，一律 map 到 `QUOTA_EXHAUSTED`。即使 cockpit 暫時不可用，passive 分類也會把帳號鎖在長時間 backoff 而非短 RPM backoff。
- **測試**：`src/account/rotation/backoff.test.ts` — 新增 11 tests（10 個 codex drain 訊息 + 1 個非匹配訊息應 fall through），全部 pass；現有 3 tests 不動

## Test Summary

- Phase 1: 7 pass
- Phase 2: 9 pass
- Phase 3: 6 pass
- Phase 4: 11 pass + 3 pre-existing = 14 pass
- 總計新增：33 tests pass，零 regression

## AGENTS.md 合規

- **第零條**：所有變更先有 plan（`plans/codex-rotation-hotfix/`）
- **第一條（no silent fallback）**：
  - cockpit 的 healthy / exhausted / unavailable 決策都 `log.info`
  - `enforceCodexFamilyOnly` 每個被剔除的候選都 `log.info`（含 rejected provider/account/model）
  - codex 家族空池不返回 null，明確 throw `CodexFamilyExhausted`

## 使用者可見行為變化

1. **Codex 帳號 5H 用盡**：系統會自動輪替到同家族其他 codex 帳號；若全家族都用盡，UI 會顯示 `CodexFamilyExhausted` 訊息（含「等待下個 5H 視窗重置或手動切換 provider」建議），而不是停滯或誤切到 anthropic。
2. **Codex 模式下不再自動跨 provider**：這是硬性行為；manual override（UI / webapp 手動選 opencode/anthropic/gemini）不受影響。

## 遺留 / 後續追蹤

- `rotation3d-guard.test.ts` 有 3 個 pre-existing failures（`getProviderWaitTime` 未實作），與本 hotfix 無關。
- `session/processor.ts:317` 的 `l.warn` typo（commit 102f3548c3）pre-existing，與本 hotfix 無關。
- 未計畫修改 webapp/TUI 顯示邏輯；CodexFamilyExhausted 透過既有 `MessageV2.fromError` 管道顯示，UX 後續可再評估是否需要專屬圖示 / 建議行動。

## 相關檔案

- Plan 位址：`plans/codex-rotation-hotfix/`
- 測試集中位置：`packages/opencode/test/account/`、`packages/opencode/src/account/rotation/backoff.test.ts`
- 主要改動：`rate-limit-judge.ts` / `rotation3d.ts` / `session/llm.ts` / `session/processor.ts` / `rotation/backoff.ts`
