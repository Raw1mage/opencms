# Handoff: tool-result presentation contract

## Execution Contract

執行者承接本包時，先讀本檔 + design.md（DD-1~7）+ spec.md（Requirements/Scenarios），再依 tasks.md 分階段實作。核心治本是 Phase 1（presentation contract 純函式 + wrapper 改接）；Phase 2 守 INV-0；Phase 3 行為防護；Phase 4 文件落差；Phase 5 驗證收尾。

## Required Reads

- `proposal.md` — Why / Scope / RCA 升維論述
- `design.md` — DD-1~7、Risks/Trade-offs、Critical Files
- `spec.md` — Requirements + Scenarios（驗收依據）
- `data-schema.json` — McpToolResult / PresentationEnvelope / PresentationBackfill 契約
- `test-vectors.json` — 具體 input/output 對（Phase 1.2 測試種子）
- `errors.md` — 錯誤碼與恢復策略
- `observability.md` — 回填觀測訊號
- 真因參照：`issues/issue_20260622_orchestrator_structuredcontent_unreadable_dup_call_loop.md`
- 源碼：`packages/opencode/src/session/resolve-tools.ts`（66-108, 317-428）、`packages/opencode/src/tool/tool.ts`（230-260）、`packages/opencode/src/session/prompt.ts`（~2603 paralysis）

## Stop Gates In Force

- **架構變更需確認**：若實作發現 presentation contract 需改 `McpToolResult` 型別（resolve-tools.ts:46-51）或波及原生 ToolInvoker 路徑，停下回報（可能升級為 refactor）。
- **天條**：不得新增 silent fallback。空殼回填必須顯式 `presentationBackfill` 標記。若實作中出現「不確定就先回填掩蓋」的衝動，停。
- **INV-0 紅線**：原生工具呈現路徑行為若被改動，停（DD-5 違反）。
- **部署 gate**：本 plan 涉及 daemon 行為，部署走 `restart_self`，不自行 spawn/kill。

## Execution-Ready Checklist

- [ ] design.md DD-1~7 已讀
- [ ] test-vectors.json 案例已理解
- [ ] critical files 已定位（read-before-write）
- [ ] 每完成 task 立即勾 tasks.md + plan-sync
- [ ] 每 phase 邊界寫 slice summary
- [ ] 收尾：全測試綠 + 手動複現驗證 + architecture sync + event log + issue 移 observing/
