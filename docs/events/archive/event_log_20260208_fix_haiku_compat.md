# Event: Revert Strict Headers for Haiku Compatibility

Date: 2026-02-08
Status: Adjusted
Topic: Protocol Mimicry

## 1. 調整原因

- 用戶回報 Haiku 系列原本可用，需避免過度激進的 Header 偽裝導致 Haiku 也被阻擋 (Regression)。
- `anthropic-client` 與 `User-Agent: anthropic-claude-code/...` 極可能觸發針對官方 Binary 的 TLS 指紋 (JA3) 驗證。

## 2. 修正內容

- **User-Agent**: 回退至 `claude-cli/2.1.37 (external, cli)`。
  - `(external, cli)` 標記通常用於第三方整合，可能享有較寬鬆的指紋檢查。
- **anthropic-client**: **移除/註解** 此 Header。
  - 這是最可能觸發 "Credential only authorized..." 的元兇。
- **Body Injection**: 保持移除狀態 (解決 400 Extra inputs)。

## 3. 預期行為

- **Haiku**: 應能繼續正常運作 (使用 OAuth Token，但不強制指紋)。
- **Opus/Sonnet**:
  - 若依賴 `session_id` Header 與 Session Init -> **有機會成功**。
  - 若強制要求 `anthropic-client` Header + 正確指紋 -> **仍會失敗** (但這是必要的權衡，以保住 Haiku)。
