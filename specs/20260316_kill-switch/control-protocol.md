# Control Protocol（runner-control protocol）

目的：定義 worker 與 orchestrator 之間的 control messages 與事件格式，支援 pause/resume/cancel/snapshot/set_priority 等指令，並包含 seq-num/ACK 與 RBAC 檢查點。

消息格式（JSON）：

- Event (from worker -> orchestrator)
  - { type: 'event', name: 'task_started'|'task_progress'|'task_completed'|'task_failed'|'task_heartbeat', request_id, seq, timestamp, meta }

- Control (from orchestrator/UI -> worker)
  - { type: 'control', action: 'pause'|'resume'|'cancel'|'snapshot'|'set_priority', request_id, seq, initiator, timestamp, meta }

要求：

- 每個 control message 必含 seq（整數）以利原子比對；worker 僅接受 seq > last_seq。
- Worker 必須對 control message 回 ACK：{ type: 'ack', request_id, seq, status: 'accepted'|'rejected'|'error', timestamp, reason? }
- 若 ACK 未回或回 error，orchestrator 在 timeout (configurable, default 5s) 後進行 fallback（例如強制 kill）。

傳輸層選項：

- Redis pub/sub（快速原型）或 WebSocket / NATS（更完整可靠性）。

安全：

- Control gateway 必須在接受 control message 時進行 RBAC 檢查（見 rbac-hooks.md），並記錄 audit entry。

實作提示：

- 在 worker 層維護 last_seq 與 pending_control_map，並在執行控制後上報 event/ack。
