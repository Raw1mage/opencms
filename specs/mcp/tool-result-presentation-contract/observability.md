# Observability: tool-result presentation contract

## 核心訊號：presentationBackfill

每次 structuredContent 回填發生時，envelope 的 `metadata.presentationBackfill` 必被標記（DD-2，顯式可觀測，非 silent）。這是本契約的主要可觀測點。

| 訊號 | 位置 | 用途 |
|---|---|---|
| `metadata.presentationBackfill.reason` | 工具結果 metadata | 區分觸發原因（empty / whitespace_only / see_structured_placeholder / serialize_failed） |
| `metadata.presentationBackfill.bytes` | 工具結果 metadata | 回填了多少位元組，追蹤回填量級 |
| `metadata.truncated` + `outputPath` | 既有機制 | 回填後仍超預算的截斷追蹤 |

## Events

(日誌事件)

- `log.info("presentation: structuredContent backfilled", { tool, reason, bytes })` — 回填發生時。可聚合統計「哪些 server / 工具長期回空殼」，反向催 server 在 content 補可讀摘要。
- `log.warn("presentation: serialize failed, fell back to raw text", { tool, error })` — E-PRESENT-1 序列化失敗（fail-soft 但留證）。

## 行為層防護訊號（DD-6）

- `log.warn("paralysis-observe: semantic-equivalent shell retry", { tool, attempts })` — 同工具同回合語意等價重試且每次仍空殼，注入 nudge 前。

## Metrics

(指標，建議)

- `mcp_tool_backfill_total{tool, reason}` — 回填次數，按工具/原因分群。長期高值代表某 server 的 content channel 設計不良。
- `mcp_tool_shell_no_structured_total{tool}` — 空殼但無可回填資料（TV8），代表真正的資料缺失，需查 server。

## 監控用途

回填訊號的長期趨勢是「哪些 MCP server 把主體只放 structuredContent」的健康儀表板——理想狀態是訊號逐漸下降（server 端補上 content 可讀摘要），而非長期依賴 host 回填。
