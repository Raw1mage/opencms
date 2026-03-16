# Design：技術方案與決策

1. State store 選擇

- 使用 Redis（快速）或 etcd（強一致）做為狀態 key。若系統已有 DB table 模式，也可用 RDBMS。
- 實作建議：以 `kill_switch:state` key 儲存 JSON，並設 TTL 支援自動過期。

2. Snapshot orchestration

- Snapshot 包含：最近 1000 行系統 log 摘要（或相依時間範圍）、active sessions list、outstanding tasks、provider usage sample。
- Snapshot 生成可同步或非同步；建議先同步啟動 snapshot job，回傳 snapshot_url 當任務完成時更新。

3. Agent integration

- 所有 agent 在 `start_task()` 前呼叫 `KillSwitchService.check()`；如果 state.active 則拒絕。
- 若使用 job queue (Bull/Sidekiq)，在 dispatcher 層先檢查狀態。

4. Soft-kill signaling

- 建議使用 control channel（例如 Redis pub/sub 或 internal RPC）發送 `shutdown_graceful` 訊號給 worker。

5. Hard-kill execution

- Worker manager 需能根據 request_id 查到相關 worker PIDs 或 runtime handle，再執行 OS kill 或容器 stop。

6. Security

- API 必須加 RBAC 與 MFA；API 也需 rate-limit 並驗證服務帳號。

7. Observability

- 每次 trigger 將產生 audit entry 與 snapshot link；發送 Slack Alert 並標記 incident channel。

8. Implementation notes

- 先以最小可行性實作（API + state + agent check）再補 snapshot 與 UI。

## Autorunner — 前/背景互動模型（foreground/background interaction model）

目標：在保持傳統回合制對話習慣下，使 Autorunner 能在背景持續執行工作，同時讓使用者能在前景自由互動與觀察進度；並允許透過對話或控制介面變更背景 runner 狀態。

設計要點：

- 1. 保持回合制輸入習慣：使用者在 UI 中仍以回合制輸入 prompt，系統在接收輸入後會回傳 acknowledgement（已接收並排入處理）。
- 2. 非阻斷式執行：收到並確認後，Autorunner 將在背景啟動工作流程，但不阻塞使用者繼續輸入新的 prompts 或與系統對話。前景輸入權會立即還給使用者。
- 3. 狀態可視化：新增三個視覺化元件——思考鏈圖示（inline progress chip）、sidebar task monitor card（列出 background tasks 與狀態、request_id、ETA、links to snapshot/logs）、以及顯眼的 kill-switch 狀態 indicator。這些元件均透過訂閱 runner status (WebSocket / EventStream) 更新。
- 4. 動態控制：正在執行中的 runner 可以被：
  - a) 使用者在對話中以特殊命令或自然語句請求變更（由 NLU 層解析並映射到 runner control actions）；
  - b) 透過 sidebar 或按鈕直接對指定 request_id 執行操作（pause/resume/cancel/priority-change）；
  - c) 系統級 kill-switch 可立即改變全域或指定 scope 的 runner 狀態（soft/hard semantics）。

實作影響與需求：

- A) 協定：需要一套 lightweight runner-control protocol（基於現有 control channel）：events { task_started, task_progress, task_completed, task_failed, task_heartbeat } + control messages { pause, resume, cancel, set_priority, snapshot }. 每個 event 包含 request_id、initiator、timestamp、meta。
- B) 前端：非阻斷輸入欄位、inline progress indicator、sidebar task monitor、對話式控制介面（可將自然語句映射到 control messages），以及 audit UI（查看 who did what）。
- C) 後端：每個 background task 需產生唯一 request_id、維護可查詢的狀態、並能接收 control messages；scheduler/agent-launcher 必須監聽 control channel 並具備安全檢查（RBAC）。
- D) NLU mapping：簡短自然語句（例如 "stop that job" 、"pause current run"）可先透過 heuristic matcher 映射到 control actions；嚴格或危險的操作（cancel global）需 MFA/explicit confirmation。

驗收準則（Acceptance Criteria）：

- 1. 使用者在提交 prompt 後可立即繼續輸入下一個 prompt；背景 runner 正常執行且 sidebar 顯示該背景任務。
- 2. 前端能對單一 request_id 發送 pause/resume/cancel 指令，後端能在 5s 內回應並將狀態更新廣播出去。
- 3. 使用自然語句在對話中觸發 runner control（non-destructive commands）時，系統提供解析結果並要求確認；確認後執行控制。
- 4. 所有 control actions 與狀態變更均寫入 audit log 並可在事件快照中重演。

測試要點：

- 單元：runner control messages 的序列化 / 安全檢查 / state transitions。
- 集成：WebSocket 訂閱的即時更新、sidebar 與 inline indicator 的同步性。
- E2E：使用者端提交 prompt -> background task start -> 在對話中下 pause -> task pauses -> resume -> complete。
