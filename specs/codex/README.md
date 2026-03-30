# Codex Specs

這個目錄是所有 Codex 相關正式 specs 的統一 semantic root。

## Structure

- `provider_runtime/` — opencode 內部對 Codex provider runtime 的正式實作策略、需求、設計與 handoff。
- `websocket/` — 已完成的 Codex WebSocket transport adapter formal spec，承接原 `plans/codex-websocket/`。
- `protocol/` — 來自 `refs/codex/` 的 source-derived protocol / interoperability notes。

## Promotion Rule

- 已完成且已 merge 的 Codex 實作 plan，若要正式沉澱，應優先合併到這個 root 下的對應子主題。
- 活躍中的未完成 Codex 工作仍留在 `/plans/`；只有已完成且經使用者確認的 Codex plan 會升格到這個 root。
