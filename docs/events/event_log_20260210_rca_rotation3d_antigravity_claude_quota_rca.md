# Event: rotation3d antigravity Claude quota misclassification

Date: 2026-02-10
Status: Done

## 1. 症狀

- 使用 antigravity Claude model 時，系統反覆回報 `Selected account rate limited for claude`。
- 同時間 cockpit quota 顯示 `remainingFraction > 0`，表示帳號仍有可用額度。
- 使用者觀察到 rotation3d 重複 fallback，造成體感像是「跳針重試」。

## 2. RCA (Root Cause)

### Root Cause A — rotation3d quota 判斷條件過寬

檔案：`packages/opencode/src/account/rotation3d.ts`

舊邏輯將以下情況一律視為 quota exhausted：

- `remainingFraction <= 0`
- **或** `resetTime > now`

但 cockpit 可能同時回傳：

- `remainingFraction > 0`
- `resetTime` 仍是未來時間

此時模型其實可用，卻被誤判為 quota limited。

### Root Cause B — fixed account 路徑過度信任本地 cooldown

檔案：`packages/opencode/src/plugin/antigravity/index.ts`

在 `account_rotation = fixed` 模式下，挑選固定帳號時會先讀本地 `rateLimitResetTimes.claude`。
若本地狀態殘留（stale），即使 cockpit 已恢復可用，仍會直接擋下並拋出 rate limited。

## 3. 修復

### Fix A — rotation3d 條件收斂

只在以下情況視為 quota limited：

1. `remainingFraction` 是數字且 `<= 0`。
2. `remainingFraction` 缺失 (`undefined`) 且 `resetTime > now`。

### Fix B — fixed 模式加入 cockpit re-validation

在固定帳號路徑且命中 Claude local cooldown 時：

1. 呼叫 cockpit (`fetchModelQuotaResetTime`) 重新驗證該 model。
2. 若 `remainingFraction > 0`：
   - 清除 `rateLimitResetTimes.claude`
   - 重置 `consecutiveFailures`
   - `requestSaveToDisk()` 持久化
   - 放行該固定帳號

## 4. 驗證

執行測試：

- `bun test packages/opencode/src/plugin/antigravity/plugin/accounts.test.ts packages/opencode/src/plugin/antigravity/plugin/model-specific-quota.test.ts`
- 結果：`82 pass, 0 fail`

## 5. 影響範圍

- 主要改善 antigravity Claude 在 fixed 模式下的誤判與不必要 fallback。
- 降低「明明有額度卻被判定 rate-limited」的機率。
