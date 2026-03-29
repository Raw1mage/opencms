# Event: Promote codex plans into specs

## Requirement

- 使用者確認 `plans/codex-efficiency/` 與 `plans/aisdk-refactor/` 已經完成並 merge。
- 使用者要求把這兩個 plan 合併並轉成 `/specs/` 正式參考包。

## Scope

### IN
- 盤點兩個已完成 plan 的 artifact 與重疊範圍
- 建立一個合併後的語意化 `specs` root
- 在 event / architecture 中記錄 promotion 結果

### OUT
- 刪除原 plan 目錄
- 重新驗證已 merge 程式行為
- 任何新功能實作

## Key Findings

- `plans/codex-efficiency/` 偏重行為需求、效能目標與 phased rollout。
- `plans/aisdk-refactor/` 偏重 AI SDK pipeline 分析、providerOptions / fetch-interceptor 分層、dead code cleanup 與 extension seam 定位。
- 兩者描述的是同一條 codex provider runtime 主線，正式沉澱後應以單一 semantic root 提供查閱入口。

## Decision

- 新增 formalized spec root：`specs/codex_provider_runtime/`
- 用途：作為 codex provider runtime 的正式參考包，承接 merged intent、architecture decisions、runtime requirements 與 maintenance handoff。
- 原 `plans/codex-efficiency/` 與 `plans/aisdk-refactor/` 暫時保留為 historical execution packages；是否刪除/封存，留待後續明確指示。

## Files Added

- `specs/codex_provider_runtime/proposal.md`
- `specs/codex_provider_runtime/spec.md`
- `specs/codex_provider_runtime/design.md`
- `specs/codex_provider_runtime/handoff.md`

## Validation

- 已確認兩個來源 plan 的 proposal/design/implementation/handoff 內容可合理合併為單一 codex runtime 主題。
- 已確認 `specs/codex-protocol/whitepaper.md` 可作為此新 root 的 protocol-observation companion reference。
- Architecture Sync: updated `specs/architecture.md` planner lifecycle section to record the new promoted codex runtime spec root.

## Notes

- 本次是文件與知識結構 promotion，不是新一輪 build；因此未重新執行 code/test validation。
- promotion 依據是使用者明確確認兩個計畫皆已實作並 merge。
