# Observability: specbase_internal-toolcall-dual-track

## Events

- `specbase.native.tool.invoked` — native specbase 工具被呼叫（fields: tool id, repo, duration, ok/err）。用於確認流量已走 native 路徑。
- `specbase.native.handler.error` — handler 拋錯（fields: tool id, error message）。對應 errors.md E-TOOL-HANDLER / E-SCOPE-UNRESOLVED。
- `mcp.specbase.child.spawned`（負向哨兵）— 若 opencode daemon 仍 spawn 任何 specbase 子行程即記錄；穩態應為 0（驗證 DD-7 生效）。
- 既有 `local MCP source changed … reconnecting`（stale-child fix 76cae876c）對 specbase 應**不再觸發**（已無子行程），可作為遷移完成的旁證。

## Metrics

- `specbase_native_tool_calls_total{tool, status}` — native 工具呼叫數，依工具與成敗分。
- `specbase_daemon_child_count`（gauge）— opencode daemon 下 specbase 子行程數；目標穩態 = 0（取代「per-Instance N 份」舊狀態）。
- `specbase_native_handler_latency_ms`（histogram）— 行程內呼叫延遲；預期顯著低於原 MCP stdio 往返。
- parity check（CI gate，非 runtime metric）：native id 集合 ⊇ 依賴集合，布林通過/失敗。

## 驗證對應

- acceptance「daemon 下無 specbase 子行程」← `specbase_daemon_child_count == 0` + `mcp.specbase.child.spawned` 無事件。
- acceptance「流量走 native」← `specbase.native.tool.invoked` 有事件、對應工具 latency 下降。
- acceptance「外部 host 不變」← 不在 opencode 可觀測範圍，由 G3 對外 listTools 比對與外部 host 實測覆蓋。
