# Spec: Kill-switch 行為需求與場景

1. Trigger path

- 操作者透過 Web / TUI / API 提交 trigger 請求，需包含 reason，系統回傳 request_id 與 snapshot_url（若有）。

2. Status path

- GET status 應回傳 active boolean、initiator、initiated_at、mode、scope、ttl、snapshot_url。

3. Soft-pause semantics

- 接到 trigger 後：
  - 標記全域狀態為 `soft_paused`，拒絕 new task scheduling （回 409 或自定錯誤碼）。
  - heartbeat/worker control channel 送出 graceful-shutdown signal 給 running workers（或把標記加入 worker check loop）。

4. Hard-kill semantics

- 若在 soft_timeout 內仍有 running workers，系統對其執行 force_terminate（透過 process kill 或 worker API），並記錄 termination reason。

5. Cancel path

- 授權使用者可 CALL cancel endpoint 以解除暫停，系統回復為 inactive，並允許新任務排程。

6. Edge cases

- 如果 trigger 時 snapshot 失敗：仍應完成 state write 並在 audit 記錄 snapshot failure。
- 多次快速觸發：應提供幂等性（同一 initiator + reason 在短時間內視為相同 request_id）。
