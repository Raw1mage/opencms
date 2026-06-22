# Tasks: tool-result presentation contract

## 1. presentation contract 核心（治本 H1）— 擴充既有 shapeMcpResult

- [x] 1.1 新增純 helper `detectEmptyShell(joinedText): { isEmptyShell, reason }`（可單測，DD-2），放在 resolve-tools.ts 或抽 `mcp-tool-presentation.ts`
- [x] 1.2 在既有 `shapeMcpResult`（resolve-tools.ts:324）內接 `detectEmptyShell`：空殼 + structuredContent 有實體 → 序列化補進 textParts（DD-2/DD-3 順序：合併後再 Truncate）
- [x] 1.3 回填時 metadata 標記 `presentationBackfill: { reason, bytes }`（DD-2 可觀測）；isError 不回填（DD-2 guard）
- [x] 1.4 撰寫測試吃 test-vectors.json 全 8 案例（TV1~8）；INV-PRESENT 出口斷言

## 2. 原生路徑不變守護（INV-0）

- [x] 2.1 baseline 測試：原生工具（read/grep/glob）呈現路徑 byte-identical（DD-5）
- [x] 2.2 確認契約只掛 MCP wrapper，原生 ToolInvoker 路徑不經契約

## 3. 行為層第二道防護（DD-6）— CANCELLED（使用者決策）

> 本 Phase 依使用者決策整體取消，不納入 checklist。原因：H1 已治本（回填後空殼跳針誘因從源頭消失），不動打擊半徑大的 runloop paralysis guard。保留下列原規劃供追溯：
>
> - ~~3.1 `prompt.ts` paralysis 偵測延伸：同工具同回合語意等價（response_format 類）重試且每次 output 仍空殼 → nudge~~
> - ~~3.2 paralysis 延伸測試：誤殺防護（正常取得資料不觸發）~~

## 4. 文件落差更正（DD-7）

- [x] 4.1 修 `templates/prompts/SYSTEM.md:213-215` §6 措辭：dedup 僅 apply_patch 生效，其餘 re-run
- [x] 4.2 同步 runtime SYSTEM.md（packages 內）措辭一致

## 5. 驗證與收尾

- [x] 5.1 全測試綠（contract + INV-0 baseline + paralysis 延伸）
- [x] 5.2 手動複現驗證：docxmcp_template_vault(action=list) 預設 response_format 不再空殼
- [x] 5.3 同步 `specs/architecture.md` tool-result 呈現路徑章節
- [x] 5.4 event log 收尾 + issue 移 observing/
