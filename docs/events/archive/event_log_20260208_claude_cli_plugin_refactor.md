# Event: Claude-CLI Protocol Plugin Refactor

Date: 2026-02-08
Status: Planning
Topic: Protocol Encapsulation & Mimicry

## 1. 任務目標 (Objective)

將原本分散在 `anthropic.ts` 與框架各處的偽裝邏輯，重新包裝成一個獨立的 OpenCode Plugin。該插件將為 CMS 分支提供底層的 Claude-CLI 協議支援，解決 OpenCode 框架層級的封包干擾問題。

## 2. 關鍵架構決策 (Key Decisions)

- **身分別名**: 使用 `claude-cli` 作為 Provider ID，避開框架對 `anthropic` 名稱的自動優化（如 `cache_control` 注入）。
- **協議導向**: 強制攔截 `/v1/messages` 並轉向官方訂閱用戶專用的 `/v1/sessions/{id}/events`。
- **動態指紋**: 插件內建官方 `Attribution Hash` 計算與 `oauth-2025-04-20` Beta 標頭管理。
- **深層洗滌**: 在插件 `fetch` 攔截器中執行最終 Body 洗滌，確保 100% 官方格式。

## 3. 執行步驟 (Steps)

1. **[ ] 建立新插件**: `src/plugin/anthropic-cli.ts` (從 `anthropic.ts` 遷移並優化)。
2. **[ ] 註冊 Provider**: 在 `src/provider/provider.ts` 加入 `claude-cli` 及其對應的 `loader`。
3. **[ ] 隔離轉換器**: 確保 `src/provider/transform.ts` 不會干擾 ID 為 `claude-cli` 的模型。
4. **[ ] 驗證**: 使用探針觀察日誌，確保封包純淨度。

## 4. 預期結果

- 訂閱用戶能穩定使用 Opus/Sonnet。
- 封包特徵與官方 CLI 一致，徹底解決 "Credential only authorized..." 錯誤。
