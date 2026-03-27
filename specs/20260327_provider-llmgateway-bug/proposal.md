# Proposal

## Why

- provider list 目前沒有乾淨的 SSOT，而是把 `ModelsDev.get()`、`Provider.list()`、`Account.listAll()` 的觀測值直接 union 成 universe，造成 `llmgateway` 這類外部 provider key 洩漏到 UI。
- cms 需要一份產品明確維護的 provider registry，才能穩定回答「目前正式支援哪些 provider」。

## Original Requirement Wording (Baseline)

- "建一個ssot，列出目前cms真正支援的provider list。未來要擴充，可以用models.dev注入更新值。"

## Requirement Revision History

- 2026-03-27: 先完成 `llmgateway` RCA，確認問題本質是 provider universe 沒有單一 SSOT。
- 2026-03-27: 使用者決定 SSOT 邊界採「正式支援集」，而不是廣義 runtime 支援集。

## Effective Requirement Description

1. 在 repo 內建立 canonical provider registry，列出目前 cms 正式支援的 provider list。
2. `/provider` 與 UI provider list 必須以這份 registry 為唯一 universe 定義來源。
3. `models.dev` 可以為 registry 內的 provider 注入模型與 metadata 更新值，但不能單方面把未知 provider 納入產品清單。

## Scope

### IN

- 定義並落地 cms 正式支援 provider registry
- backend provider list authority boundary 修正
- web/TUI consuming path 對齊
- regression validation 與文件同步

### OUT

- 不改變 runtime 是否能讀取 custom provider config
- 不在本輪做全面 provider product strategy 重寫
- 不把 registry 自動開放成所有 models.dev provider 的鏡像

## Non-Goals

- 不將任何外部觀測 provider 自動升格為正式支援 provider
- 不處理 provider 連線/auth UX 大改版
- 不移除 provider runtime 的模型注入能力

## Constraints

- 禁止新增 silent fallback；未知 provider 應 fail closed 於 provider list universe 之外。
- SSOT 必須存在於 repo 內可審核的位置，而不是來自 user config / cache / remote fetch。
- 需與既有 canonical provider family 概念相容，避免再次回流 legacy `google`。

## What Changes

- 新增一份明確列舉正式支援 provider 的 canonical registry。
- `/provider` route 從「觀測值 union」改為「registry allowlist + state overlay」。
- app/TUI label 與 provider list 消費邏輯改從 registry 取產品名稱/可見性，而非零散 hardcode。

## Capabilities

### New Capabilities

- Canonical provider registry: repo 內可審核的正式支援 provider 清單與產品 metadata。
- Fail-closed provider universe: 未列入 registry 的 provider 不再自動出現在 provider list。

### Modified Capabilities

- `/provider` list assembly: 從觀測聚合改為 registry 主導、觀測值補充。
- `models.dev` integration: 從 universe 定義者降級為 registry enrichment source。

## Impact

- 影響 backend provider route、canonical family source、部分 UI label/provider selector consuming path。
- 降低 `llmgateway`、帳號名、legacy alias 等外部污染再度出現在 UI 的風險。
- 後續若要新增正式支援 provider，需要明確修改 registry，而不是依賴外部資料碰巧出現。
