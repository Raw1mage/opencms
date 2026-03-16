# RBAC Hooks for Kill-switch and Control Messages

目的：定義在哪些層級與時機點執行授權檢查（RBAC + MFA）以保護 per-task control 與 global kill 操作。

1. Permission model

- `kill_switch:trigger` — 能夠觸發 global kill-switch（需 MFA）
- `task:control` — 能夠對單一 request_id 發送 control message（pause/resume/cancel）

2. 檢查位置

- API endpoints (POST /api/admin/kill-switch, POST /api/tasks/{id}/control): 檢查 JWT 與角色，對 destructive 操作要求 MFA 或二次確認。
- Control gateway (broker ingress): 所有來自 UI 的 control message 先通過 gateway，gateway 將作 final RBAC check 與 audit 寫入，然後轉發到 pubsub。

3. UI 行為

- 若使用者在對話框輸入如 "stop that job" 類的自然語句，系統在 UI 顯示解析結果並要求確認；若該動作為 destructive（取消 long-running job），要求 MFA 流程再送出 control。

4. Audit

- 所有成功或失敗的授權事件都寫入 audit store：{ request_id?, initiator, action, permission_required, granted: true|false, timestamp, reason }
