# Proposal: provider-account-decoupling

## Why

`(provider, account, model)` 在系統內部本來就是輪換、配額、狀態判斷的三維獨立座標 (3D rotation vector)。但實作上，codex / openai 訂閱帳號為了 OAuth/SDK 隔離，被註冊成形如 `codex-subscription-<slug>` 的「per-account providerId」。同一個帳號於是有兩種寫法並存：

- **乾淨三維形式**（bus events、message persistence、rotation 對外介面）：
  `providerId="codex"`, `accountId="codex-subscription-yeatsluo-sob-com-tw"`
- **被黏合的二合一形式**（providers registry、getSDK、auth lookup）：
  `providerId="codex-subscription-yeatsluo-sob-com-tw"`

這是 2026-05-02 「CodexFamilyExhausted 誤報」事件的根因 — `enforceCodexFamilyOnly` 用字串 `=== "codex"` 比 family，所有以 per-account providerId 加入候選池的訂閱帳號全部被當外人砍掉。已套用熱修補（`rotation3d.ts:746-775` step 3b 跳過 same-family providers），但根本的「provider 維度被拿去當 account namespace 用」沒解決，未來任何 family 比對都是地雷。

## Original Requirement Wording (Baseline)

- "我覺得很奇怪，我們不是有三個參數形成3d，共同判斷一個帳號的狀態嗎？什麼時候變成用單一名稱來判斷了？３Ｄ參數：（provider, account, model）"
- "請治本。謝謝。"

## Requirement Revision History

- 2026-05-02: initial draft (post-CodexFamilyExhausted incident, hotfix already applied to step 3b)

## Effective Requirement Description

1. provider registry 只保留 family-level providerId（如 `"codex"`、`"openai"`、`"anthropic"`），移除 `<family>-subscription-<slug>` / `<family>-api-<slug>` 形式的 per-account providerId entries。
2. SDK 載入、auth lookup、getSDK 改走 `(family, accountId)` 兩參數定址。
3. bus events、persistence、rotation 對外 API 維持現有的「乾淨三維」寫法不變 — 即 `providerId` 永遠是 family。
4. 既有資料（session messages、accounts.json、rate-limit tracker state）以 family providerId 寫成；migration 一次性把舊的 per-account providerId 形式 normalize 回 family form。
5. `enforceCodexFamilyOnly` 之類「靠字串比 family」的程式碼可以移除或退化為單純的 `providerId === family` 比對 —— 因為 candidate 的 providerId 從此一定是 family。

## Scope

### IN
- `packages/opencode/src/account/index.ts` — Account 抽象層、family 解析
- Provider 載入路徑（`provider.ts` 之類，逐一識別後在 design 階段列入）
- Auth lookup（`auth.ts`、OAuth token 儲存查詢）
- `packages/opencode/src/account/rotation3d.ts` — 移除 `enforceCodexFamilyOnly` 字串比，簡化 step 3b
- bus / message persistence 寫入端 — 確認永遠落地 family providerId
- Migration：一次性 sweep — daemon 停機後跑 migration script，把 accounts.json、所有 session messages、rate-limit tracker（runtime state，重啟即重建）裡的 per-account providerId 全改成 family form
- OAuth token 儲存格式維持原樣（user 決策 2026-05-02）：只改查詢介面，不動檔案結構或 refresh 流程
- 影響到的測試（`test/account/`、rotation 相關 test）

### OUT
- 跨 family 的 rotation 行為調整（保持現狀）
- Cockpit quota / wham/usage 端點查詢邏輯（只是 caller 介面換成 family+account）
- 前端 sidebar / admin 顯示（已用乾淨三維形式，預期零變動）
- 其他 provider 家族（gemini-cli、google-api、anthropic）若無 per-account providerId 形式則無需動

## Non-Goals

- 不重新設計 OAuth / token 儲存格式（只改查詢介面）
- 不調整 rate-limit / cooldown 演算法
- 不引入新的 provider family 分類機制 — 沿用 `Account.resolveFamily` 已知 family list

## Constraints

- 必須保留 OAuth token 隔離（每個訂閱帳號一份 access/refresh token），只是不再以「provider」名義儲存
- 必須相容既有 accounts.json 與 session storage（migration 不破壞歷史 session 重新載入）
- 不可破壞 `OPENCODE_DATA_HOME` 隔離契約（beta vs main XDG）
- AGENTS.md 第一條「No Silent Fallback」：family 解析失敗必須明確報錯，不可退回 per-account providerId 當 fallback
- **一次切換**（user 決策 2026-05-02）：不做 dual-read 鎖步；切換 commit 之前必須完成全部 storage sweep，daemon 停機後執行 migration、再啟動新版。回退靠 backup，不靠程式碼相容性
- **Backup 強制**：sweep 之前必須有 accounts.json + session/ 完整 snapshot，路徑記錄到 `.state.json.history`

## What Changes

- Provider registry 內部資料結構：從 `Map<perAccountProviderId, ProviderInstance>` → `Map<family, ProviderInstance>`，instance 內持有 account-keyed sub-state（SDK clients、token cache）
- `getSDK(providerId, accountId, ...)` 簽名：`providerId` 收進來必為 family
- Auth lookup 介面：以 `(family, accountId)` 取代既有的 `providerId=per-account` 查詢
- `enforceCodexFamilyOnly` 退化或刪除
- One-shot migration script：normalize accounts.json + session messages + rate-limit tracker 中的 providerId 字段

## Capabilities

### New Capabilities
- 無新對外能力 — 此為內部架構治理

### Modified Capabilities
- Rotation pool building (`buildFallbackCandidates`)：codex 訂閱帳號從此只走 step 1 (same-family)，不再被 step 3b 重複加入 → 池大小、候選人語意一致
- Family 比對：所有比對統一用 `=== family`，不再需要 `resolveFamily(string)` 動態解析

## Impact

- **Code**: account/、provider 載入、auth、rotation3d、可能的 cockpit 客戶端、相關 test
- **Storage**: accounts.json、session messages（migration 一次性），rate-limit tracker（runtime state，daemon restart 後重建）
- **Operators**: 行為對齊 sidebar 顯示；CodexFamilyExhausted 誤報根除
- **Docs**: `specs/architecture.md` 需新增「provider/family/account 三層命名」章節
- **Tests**: 既有 `test/account/codex-family-only-fallback.test.ts` 之類需要重寫斷言（改驗 step 1 邏輯，非字串比）
- **Migration risk**: session message 歷史記錄一次性 sweep — 必須 idempotent、必須先 backup、daemon 必須停機；若中途失敗以 backup 還原（不靠程式碼向後相容）
