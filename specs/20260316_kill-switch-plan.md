# Kill-switch 計畫草案

日期：2026-03-16

目的：提供一個可受控的緊急暫停（kill-switch）機制，讓運維/安全團隊在系統或模型異常時能快速停止自動代理活動並保留完整審計證據。

目標讀者：coding agent、SRE、安全審查者、產品負責人。

一、範圍

- 影響範圍：Global（對所有 agents & sessions 生效）。
- 可選 scope：future-only / session-scoped / instance-scoped（API 參數支援）。

二、行為

- 模式：Hybrid（預設）
  - step 1 soft-pause：立即停止接受新任務、拒絕新 agent 啟動；現有任務進入 graceful shutdown window（預設 30s，可配置）。
  - step 2 強制 kill：若超時仍未結束，對仍在執行的 agent/worker 執行強制終止。

三、授權與驗證

- RBAC：新增 permission `kill_switch:trigger`，授權給 role: ops / sre / admin。
- MFA / 二次確認：API 與 UI 都需二次確認（Web 顯示彈窗 + MFA token），外部 API 呼叫限制為服務帳號 + signed JWT / mTLS。
- 審計：每次 trigger 將以不可變紀錄寫入 audit store（包含 initiator, timestamp, reason, scope, snapshot location, request id）。

四、觸發介面

- Web Admin Button：顯眼紅色按鈕，啟動前填寫 reason，並提供 quick snapshot 選項。
- TUI hotkey：例如 Ctrl+K，互動式確認流程，呼叫相同 API。
- API endpoint：受控 API，限服務帳號，支援 automation。API 需限 ACL 與 rate-limit。

五、可觀測性與證據

- 必要資料：按下時拍攝系統快照（active sessions、outstanding tasks、recent logs 摘要、provider usage、open network connections）。
- 通知：發出 Slack / Email alert（包含 reason、initiator、snapshot link、影響範圍）。
- 存儲：快照 + event metadata 存於持久 storage（object store 或 DB），snapshot link 寫入 audit entry。

六、API 草案（供 coding agent 實作）

- GET /api/admin/kill-switch/status
  - 回傳：{ active: boolean, initiated_by?, initiated_at?, mode?, scope?, ttl?, snapshot_url? }

- POST /api/admin/kill-switch
  - 欄位：
    - reason: string (required)
    - initiator: string (auto-filled by auth)
    - scope: enum['global','session','instance'] (default 'global')
    - mode: enum['hybrid','soft','hard'] (default 'hybrid')
    - soft_timeout_seconds: integer (default 30)
    - dry_run: boolean (default false)
  - 回傳：{ request_id, status: 'accepted'|'failed', snapshot_url }

- POST /api/admin/kill-switch/cancel
  - 用於解除暫停（需相同權限），body: { request_id? }

實作注意：

- 所有 endpoint 必須經過 RBAC 驗證並寫入 audit log
- 實作時採「先標記狀態再執行命令」模式，以確保可重放與可觀測
- 儲存狀態需支援 TTL 與 manual override

七、儲存與同步

- 建議使用 Redis / etcd 或 DB table + object store（snapshot）
- 狀態 key: `kill_switch:state`，value: JSON（initiator,reasons,mode,expires_at,request_id）
- 所有 agent startup & scheduler 在任務啟動點需先檢查該狀態 key

八、測試與驗收標準

- 單元測試：API 驗證、RBAC、MFA 流程
- 集成測試：模擬 soft-pause（確保不再接新任務）、超時後 hard-kill（確保被終止）、snapshot 生成與可取回
- E2E：Web/TUI 按鈕路徑、API service-account 觸發

九、回復與 Runbook 要點（概要）

- 解除步驟：執行 POST /api/admin/kill-switch/cancel 或管理頁面解除；確認後系統逐步允許新任務啟動
- 若狀態異常：使用 request_id 與 snapshot 調查，依流程進行資料一致性檢查與 postmortem

十、時程與分工（建議）

- 0.5d：建立 spec 與安全 review
- 1d：實作基礎 API + state store
- 1d：整合 RBAC/MFA 與 audit
- 1d：Web/TUI 前端按鈕與互動
- 0.5d：測試與 Runbook

附錄：審計 schema 範例

- audit entry: { request_id, initiator, timestamp, action: 'kill_switch.trigger'|'kill_switch.cancel', reason, mode, scope, snapshot_url }

Acceptance criteria

- 能由有權限者透過 Web/TUI/API 觸發 global kill-switch
- 觸發後系統立即停止接新任務且產生 snapshot 與審計紀錄
- 超時後可強制終止仍在執行的 tasks
