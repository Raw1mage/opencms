# Event: Promote codex websocket plan into specs

## Requirement

- 使用者明確確認 `plans/codex-websocket/` 已經完成。
- 使用者要求將其升格到 `specs`，並從 `plans/` 移除。

## Scope

### IN
- 將已完成的 `codex-websocket` plan 升格到 codex semantic spec root
- 從 `/plans/` 移除原目錄
- 同步更新 codex README、architecture 與相關 event 記錄

### OUT
- 重新驗證 websocket runtime 行為
- 重開已 shelved 的 prewarm Phase 4
- 變更 `personality-layer` 等其他未完成 codex plans 的狀態

## Decision

- Promotion target：`specs/codex/websocket/`
- 原 `plans/codex-websocket/` 目錄在 promotion 後移除
- `tasks.md` 在新 root 中保留為 completion ledger；Phase 1-3 視為完成，Phase 4 維持 shelved

## Files Moved

- `plans/codex-websocket/` -> `specs/codex/websocket/`

## Validation

- `specs/codex/README.md` 已納入 `websocket/` 子主題
- `specs/architecture.md` 已記錄 websocket promotion
- `specs/codex/websocket/tasks.md` 已從 execution checklist 正規化為 completed ledger
- `plans/` 下已不再保留 `codex-websocket/` 目錄

## Notes

- 本次是 promotion / taxonomy 更新，不重新聲稱執行期驗證已在本回合重跑。
- `specs/codex/provider_runtime/` 仍是上位 runtime contract；`specs/codex/websocket/` 是其下已完成的 transport-specific formal spec。
