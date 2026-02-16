# Event: Deep Framework Decoupling & Protocol Sanitization

Date: 2026-02-08
Status: Execution
Topic: Data Integrity & Protocol Mimicry

## 1. 證據分析 (Evidence Analysis)

從 `15:55:03` 的探針日誌中發現以下干擾：

- **Body 污染**: `cache_control: { type: "ephemeral" }` 被框架自動注入到每條 message part 中。官方 CLI 的 Sessions API 嚴禁此欄位。
- **Header 污染**: `x-opencode-account-id` 被框架層級強制附加。
- **流程中斷**: `/v1/sessions` 初始化失敗，導致無法切換至 `/events` 端點。

## 2. 執行計畫 (Execution Plan)

- [x] **Step 1: 隔離轉換層** - 修改 `src/provider/transform.ts`，對 `anthropic` 且含有 `subscription` 的請求強制禁用快取注入。
- [ ] **Step 2: 標頭終極洗滌** - 修改 `src/plugin/anthropic.ts`，主動刪除所有 `x-opencode-*` 標頭。
- [ ] **Step 3: 遞迴負載清理** - 在發送至 `/events` 之前，遍歷 `message.content` 並徹底移除 `cache_control` 與 `providerOptions`。
- [ ] **Step 4: 修正 Session 建立** - 檢查環境 ID 與 Body 欄位是否與 `cli.js` 完完全全相同（特別是 `events: []` 必須存在）。

## 3. 預期結果

- 發出的最後封包不再包含 `cache_control`。
- 成功進入 `/v1/sessions` 流程。
