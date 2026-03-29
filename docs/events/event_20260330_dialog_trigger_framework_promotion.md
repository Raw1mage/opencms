# Event: Promote dialog_trigger_framework plan into specs

## Requirement

- 使用者要求將 `plans/20260327_plan-enter-plans-20260327-durable-cron-scheduler/` 升格為 `/specs/` 正式參考包。

## Scope

### IN
- 讀取現有 plan artifacts，確認其實際主題為 `dialog_trigger_framework`
- 建立 semantic spec root
- 同步 event / architecture promotion 記錄

### OUT
- 刪除原 plan 目錄
- 實作 downstream build slices
- 重新驗證 runtime 行為

## Key Findings

- 該 dated plan 雖然資料夾名稱帶有 `durable-cron-scheduler`，實際內容已完整重寫成 `dialog_trigger_framework` planning package。
- 核心主題是 planner/runtime 的 trigger taxonomy、detector/policy/action 分層、dirty-flag next-round rebuild，以及 `plan_enter` active-root naming repair 的第一版切片。
- `tasks.md` 已全勾，代表 planning package 已完成；但這不等於所有下游實作都已 shipping。

## Decision

- 新增 formal spec root：`specs/dialog_trigger_framework/`
- 此 root 作為 dialog-trigger / planner-trigger / approval-routing v1 的正式語意參考包。
- 原 dated plan 先保留為 historical execution package；刪除與否留待使用者後續決定。

## Files Added

- `specs/dialog_trigger_framework/proposal.md`
- `specs/dialog_trigger_framework/spec.md`
- `specs/dialog_trigger_framework/design.md`
- `specs/dialog_trigger_framework/handoff.md`

## Validation

- 已核對 proposal/design/implementation-spec/tasks/handoff，確認其實際主題一致指向 `dialog_trigger_framework`。
- 已確認 `specs/architecture.md` 既有 planner/runtime 章節已記載此主題的核心 runtime truth，可作為 companion SSOT。
- Architecture Sync: add promoted spec-root reference for `dialog_trigger_framework`.

## Notes

- 本次是知識與文件結構升格，不代表自動完成所有 downstream build slices。
- 該 plan 名稱仍帶有歷史錯誤 slug；升格後可避免繼續以錯誤 dated root 作為唯一語意入口。
