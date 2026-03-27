# Design

## Context
- 現有架構是 Linux PAM 認證成功後，由 gateway 導向 per-user daemon。
- Google OAuth 目前主要用於 managed apps（如 Gmail / Calendar）的共用 token 與 scope 管理，`gauth.json` 的既有角色是 shared OAuth token storage。
- 使用者希望 gateway 能理解 Linux account 與 Google account 的關聯，但不改變 Linux user 為主體的安全模型。

## Goals / Non-Goals
**Goals:**
- 保持 Linux PAM 為主登入與授權來源
- 為已綁定 Google 身分提供 gateway 相容登入路徑
- 對未綁定身分採取明確拒絕

**Non-Goals:**
- 不讓 Google 身分取代 Linux user
- 不新增 silent fallback 或自動猜測對應帳號

## Decisions
- 綁定關係以 Linux user 為主，Google account 為附屬關聯；gateway 只做查詢與路由，不改變主體。
- Google login 僅在事前已綁定時可用；未綁定時直接拒絕並提示先用 Linux PAM 完成綁定。
- `gauth.json` 目前更像 shared OAuth token 容器，不應直接視為 binding registry。
- 綁定欄位優先從 Google email 開始，但設計上應保留 future-proof 空間以補強 stable identity。
- 綁定 registry 以全域 module 方式部署到 `/etc/opencode/`，由 gateway 查詢，避免 token 與 identity binding 混責任。

## Data / State / Control Flow
- Linux login flow：PAM → gateway → uid → per-user daemon（現況維持）
- Google login flow：Google auth → binding registry lookup → 若對應到既有 Linux user 則導向該 user daemon
- 未綁定 flow：Google auth → lookup miss → gateway 明確拒絕，不進入 daemon
- 綁定資料 flow：binding registry 置於 `/etc/opencode/` 的全域 module 中，shared OAuth token 仍留在 `gauth.json`，兩者不可混用

## Risks / Trade-offs
- Email 作為綁定鍵可能受變更影響 -> 後續可補 stable identifier，但先以可實作性收斂
- 若 binding registry 設在中心層，可能引入額外同步成本 -> 需明確定義單一寫入入口
- 若直接綁到 `gauth.json`，會把 token 與 identity binding 混在一起 -> 不建議，避免責任耦合

## Critical Files
- /home/pkcs12/projects/opencode/daemon/opencode-gateway.c
- /home/pkcs12/projects/opencode/specs/architecture.md
- /home/pkcs12/projects/opencode/docs/events/event_20260325_gateway_google_login_binding.md
- /home/pkcs12/projects/opencode/plans/20260325_linux-pam-per-user-daemon/idef0.json
- /home/pkcs12/projects/opencode/plans/20260325_linux-pam-per-user-daemon/grafcet.json
- /home/pkcs12/projects/opencode/plans/20260325_linux-pam-per-user-daemon/c4.json
- /home/pkcs12/projects/opencode/plans/20260325_linux-pam-per-user-daemon/sequence.json
