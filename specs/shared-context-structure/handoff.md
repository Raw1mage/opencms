# Handoff: Shared Context Structure

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding
- Materialize tasks.md into runtime todos before coding
- Phase 1 是基礎，Phase 2/3 都依賴它；建議先做 Phase 2（subagent 注入），效益最直觀

## Required Reads

- implementation-spec.md — 執行契約，含 pseudocode 與每個 phase 的詳細實作規格
- proposal.md — 問題定義、scope、constraints
- spec.md — R1-R8 行為需求與 GIVEN/WHEN/THEN 場景
- design.md — 架構圖、module design、data flow、edge cases
- tasks.md — execution checklist

## Current State

- 所有計畫文件已完成（proposal / spec / design / implementation-spec / tasks / handoff）
- Diagram artifacts 已生成（idef0 / grafcet / c4 / sequence）
- 尚未開始實作

## Stop Gates In Force

- Phase 1 完成前不得開始 Phase 2/3
- `part.state.input` 的結構需逐 tool 驗證（read 有 `file_path`，grep 有 `pattern` + `path`，bash 有 `command`）
- `Session.updateMessage()` + `Session.updatePart()` 注入 synthetic message 時，`model` / `agent` / `format` 欄位必須正確填充
- 原有 `process()` 的 `compacting` plugin hook 必須保留
- Config 停用時（`sharedContext = false`）必須完整 fallback 到現有 compaction agent 路徑

## Build Entry Recommendation

1. 從 Phase 1.1（建立 `shared-context.ts`）開始，先實作 Space model + Storage CRUD
2. 接著做 `processToolPart()` —— 需要逐一讀取 tool part 的 `state.input` 結構
3. Phase 1 完成後，先做 Phase 2（subagent 注入）—— 效益最直觀，手動驗證最容易

## Key Files（實作前必讀）

| 檔案 | 為什麼要讀 |
|------|-----------|
| `packages/opencode/src/session/compaction.ts` | 現有 compaction 完整邏輯，Phase 3 需修改 `process()` |
| `packages/opencode/src/tool/task.ts` | subagent dispatch 流程，Phase 2 的注入點在 ~L1046 |
| `packages/opencode/src/session/prompt.ts` | prompt loop，Phase 1 的 `updateFromTurn()` 觸發點 |
| `packages/opencode/src/session/message-v2.ts` | MessageV2.Part 型別定義、tool part 的 state 結構 |
| `packages/opencode/src/util/token.ts` | Token.estimate() — budget 管理用 |

## Gotchas

- `part.state.input` 的結構因 tool 而異——`read` 有 `file_path`，`grep` 有 `pattern` + `path`，`bash` 有 `command`。需要逐一處理。
- `Storage.write()` 是 async disk I/O，但單次寫入量很小（~幾 KB JSON），不會成為瓶頸。
- `Session.updateMessage()` + `Session.updatePart()` 在 task.ts 中注入 synthetic message 時，必須確保 message 的 `model` / `agent` / `format` 欄位正確填充，否則 worker 端的 prompt loop 會出錯。
- Compaction 整合時，原有 `process()` 的 `compacting` plugin hook 仍需保留——shared context 路徑跳過 LLM call，但 plugin hook 可能有其他用途。

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned (proposal / spec / design / tasks)
- [x] Validation plan is explicit (V1-V12 in tasks.md)
- [x] Runtime todo seed is present in tasks.md
- [x] IDEF0 / GRAFCET generated
- [x] C4 / Sequence diagrams generated
- [x] Cross-references consistent (scope / stop gates / tasks / validation)
