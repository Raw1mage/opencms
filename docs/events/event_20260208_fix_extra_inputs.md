# Event: Revert Body Injection & Header Tweak

Date: 2026-02-08
Status: Implementation Complete
Topic: Protocol Mimicry

## 1. 錯誤處理 (Failure Handling)

- **錯誤訊息**: `session_id: Extra inputs are not permitted` (附圖證明)
- **原因**: 嘗試將 `session_id`, `user_type`, `client_type` 注入 `/v1/messages` 的 Body 時，觸發了 Schema 驗證錯誤。這證明即使是 Claude Code Credential，也不允許在該端點 Body 中包含這些欄位。

## 2. 修正措施 (Corrective Actions)

- **Body 修正**: **移除** 所有非標準的 Body 欄位注入 (`session_id` 等)。
- **Header 調整**:
  - **User-Agent**: 改為 `anthropic-claude-code/2.1.37` (更接近官方 binary 格式)。
  - **anthropic-client**: 新增此 header，值為 `claude-code/2.1.37`。
  - **session_id**: **停止刪除** 原始 header 中的 `session_id`，確保它被透傳。
- **Session Init**: 保留 `POST /v1/sessions` 的初始化邏輯 (此部分為正確方向)。

## 3. 預期結果

- `Extra inputs` 錯誤應立即解決。
- 若 `User-Agent` 與 Header 組合正確，應能通過 "Credential only authorized..." 的檢查。
- 若仍失敗，將指向 TLS 指紋 (JA3) 為最後的阻擋層。
