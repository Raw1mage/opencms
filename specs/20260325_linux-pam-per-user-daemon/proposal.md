# Proposal

## Why
- 現有 per-user daemon 已以 Linux PAM 作為主要入口，但使用者在 Google API / Gmail / Calendar 場景下已形成 Linux account ↔ Google account 的實際關聯。
- 希望 gateway 在登入階段能理解這種關聯，提供相容的 Google 登入路徑，但不得破壞 Linux user 為主體的既有安全邊界。
- 目標是讓「已綁定」的 Google 身分能對應到正確的 per-user daemon，並對未綁定身分採取明確拒絕，而不是 silent fallback。

## Original Requirement Wording (Baseline)
- "現在本系統是用linux pam認證使用者後進入per user daemon。在使用中，每個user可能透過google api認證而產生衍生應用，如gmail, calendar。也就是linux account和google account產生了相關性。這讓我思考有沒有可能在gateway登入階段新增google登入的相容功能，由gateway判斷user相關性而給予對應的per-user daemon"

## Requirement Revision History
- 2026-03-25: 釐清為「Linux PAM 仍維持主入口、Google 僅作相容登入路徑」，且 Google 必須事前綁定有效 Linux 帳號。
- 2026-03-25: 明確設定未綁定 Google 身分時 gateway 必須拒絕，不可自動 fallback 到其他 user。

## Effective Requirement Description
1. Gateway SHALL 保持 Linux PAM 作為主要登入與 per-user daemon 授權來源。
2. Gateway MAY 接受 Google 登入作為相容入口，但僅能在該 Google 身分已與有效 Linux 帳號完成綁定時，將請求導向對應的 per-user daemon。
3. Gateway SHALL 對未綁定的 Google 身分明確拒絕，並要求先以 Linux 登入完成綁定。

## Scope
### IN
- Gateway Google login 相容入口的政策與邊界定義
- Linux user ↔ Google identity 綁定模型的方向收斂
- 未綁定身分的 fail-fast 行為
- 與 gauth.json / Google OAuth 現況的契合或切分

### OUT
- 實際 code 改動
- 前端綁定頁面
- OAuth token 格式重構
- 變更 PAM 主登入流程

## Non-Goals
- 不把 Google account 變成主登入主體
- 不允許未綁定 Google 身分直接進入 daemon
- 不在此階段處理 OAuth token 生命週期改寫

## Constraints
- Linux user 為主體真相來源
- 禁止 silent fallback / auto-match
- gateway 必須 fail fast 並保留可審核的拒絕原因
- 需兼容既有 shared Google OAuth token 設計
- 綁定資料需以全域 module 形式管理，集中於 `/etc/opencode/`
## What Changes
- 新增 gateway 層的 Google 相容登入判斷
- 新增或定義 Google 身分到 Linux user 的綁定查詢契約
- 調整登入失敗/未綁定時的回應語義
- 明確切分 shared token 與 identity binding 的責任

## Capabilities
### New Capabilities
- Google-compatible gateway login: 以既有綁定資料導向正確 per-user daemon
- Binding-aware rejection: 對未綁定 Google 身分提供明確拒絕訊息

### Modified Capabilities
- Linux PAM login: 維持現況，不被 Google login 取代
- Google OAuth: 仍作為 API 授權來源，但不直接等於 daemon 身分

## Impact
- `daemon/opencode-gateway.c`: login path must branch on Linux PAM vs Google compatibility
- `specs/architecture.md`: gateway identity boundary and registry placement are now documented
- `docs/events/event_20260325_gateway_google_login_binding.md`: task-local rationale and decisions are recorded
- Future binding registry implementation under `/etc/opencode/` will need explicit ownership and persistence rules
