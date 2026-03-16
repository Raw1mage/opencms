# Snapshot Orchestration

目的：定義在 trigger / cancel / incident 時生成系統快照的流程與內容，並上傳至 object store，將 snapshot_url 寫回 audit 與 state。

流程（建議）

1. 接到 trigger (global 或 per-task snapshot request) 後，orchestrator 立刻產生 request_id 並回應 accept。
2. orchestrator 發起 snapshot job 至 snapshot worker queue，並回傳 snapshot_job_id。
3. snapshot worker 收集：recent logs window、active sessions、outstanding tasks、provider usage sample、worker traces/pids。
4. snapshot worker 把資料打包並上傳到 object store (S3) 並回傳 snapshot_url。
5. orchestrator 更新 audit entry 與 state 以包含 snapshot_url 與完整 metadata。

內容與大小控制

- 預設限制：logs 最多 1000 行或 1MB，worker traces 取最近 1 minute sample，task list 完整列出 request_id 與 minimal meta。

錯誤處理

- snapshot job 失敗：記錄 snapshot_failure 到 audit 並繼續 kill 路徑（不要阻塞 kill）。

安全與存取

- snapshot_url 應是有短期有效性的 signed URL（例如 1 week），並將存取權限限制在 audit 與 incident 範圍內。
