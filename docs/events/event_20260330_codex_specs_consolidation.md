# Event: Consolidate codex specs under a single root

## Requirement

- 使用者要求已完成的 plan 應併入 `/specs/`。
- 使用者要求把 codex 相關 specs 集中在同一個資料夾下管理。

## Scope

### IN
- 建立單一 top-level Codex spec root
- 將既有 codex runtime / protocol spec 內容集中到同一語意根目錄
- 修正 repo 內相關文件與程式碼註解參照
- 同步更新 architecture 與 event 記錄

### OUT
- 重新定義未完成 codex plans 的完成狀態
- 刪除任何未完成的 `/plans/codex-*` 或 `plans/personality-layer/`
- 重新驗證執行期功能

## Decisions

- 新增統一根目錄：`specs/codex/`
- 將既有 formalized runtime spec 移到 `specs/codex/provider_runtime/`
- 將 protocol whitepaper 移到 `specs/codex/protocol/whitepaper.md`
- 保留 `provider_runtime` / `protocol` 為子主題，避免把不同性質文件混成單層平鋪

## Files Moved

- `specs/codex_provider_runtime/` -> `specs/codex/provider_runtime/`
- `specs/codex-protocol/` -> `specs/codex/protocol/`

## Files Added

- `specs/codex/README.md`

## Validation

- 已修正 codex runtime spec、protocol whitepaper、codex websocket plan、architecture、promotion event 等主要參照。
- `specs/codex/` 現為 codex 相關 specs 的單一 top-level root。
- 除了使用者後續確認已完成並另行升格的 `codex-websocket` 以外，未完成的 codex work 仍保留在 `/plans/`，符合 plans/specs lifecycle contract。

## Notes

- 本次整併當下並不代表 `plans/personality-layer/` 已完成；`codex-websocket` 之後依使用者確認另行升格。
- `plans/codex-efficiency/` 與 `plans/aisdk-refactor/` 的 formalized 結果仍由 `specs/codex/provider_runtime/` 承接。
