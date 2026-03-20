# Proposal: Session Context Control + Compaction Strategy Spec

## Why

- 現有 session context 控制邏輯分散在 `prompt.ts`、`processor.ts`、`llm.ts`、`compaction.ts`、`message-v2.ts`、`provider/transform.ts`，缺少單一 spec 可描述整體資料流、token 路徑與 stop/compact 條件。
- 在沒有先建立現況 spec 前直接談優化，容易混淆「真正的 token 開銷來源」與「只是局部 symptom」，也不利於後續驗證優化是否安全。

## Original Requirement Wording (Baseline)

- "先創一個plan把現有session的context控制邏輯含compaction策略建立成spec，再來分析優化策略"
- "go on"

## Requirement Revision History

- 2026-03-20 / plan mode entry：使用者要求先進入 plan mode，將既有 session context-control 與 compaction strategy 沉澱成 `specs/20260320_llm` 規格包，再分析優化策略。
- 2026-03-20 / current planning slice：本輪先完成現況建模、planner artifacts 對齊、event ledger 與優化分析，不直接實作低層行為改動。
- 2026-03-20 / follow-up expansion：使用者要求把「文件制度優化」納入同一計畫，並繼續討論 session context 優化，包括節約冗餘 prompt 重複注入與類 compaction 的 prompt 節流策略。

## Effective Requirement Description

本 workstream 的有效需求如下：

1. 將現有 session context control 邏輯（message 組裝、system prompt 注入、message normalization、overflow 判定、compaction summary、prune 行為）建立成可執行 spec。
2. 在 spec 中明確標示 token / context window / compaction 的控制點、資料流與風險邊界。
3. 基於現況 spec，分析 context window usage、auto compaction 與 token overhead 的優化策略，並區分低風險 quick wins 與較深層 refactor 候選。
4. 把文件制度優化納入同一 workstream：將文件治理規範從日常 system prompt 中抽離，改由專用 skill/agent 負責，並評估文件 labeling 對 follow-up retrieval 的幫助。
5. 為了讓後續 builder 有足夠方向感，至少生成真正三階的階層式 IDEF0 / GRAFCET 圖式（例如 `A1 -> A11 -> A111`），而不是只做 A0 下的平面並列摘要。

## Scope

### IN

- 建立 `specs/20260320_llm/*` 對應的 proposal/spec/design/implementation-spec/tasks/handoff 內容。
- 釐清現有 runtime 中 session context 進入 LLM 前的主要控制流程。
- 釐清 compaction auto trigger、summary prompt、prune 策略、token headroom 計算與相關測試現況。
- 產出優化策略分析與後續實作切片建議。
- 規劃文件制度優化方向，包含 doc governance skill / doc agent 分工與 labeling 策略。
- 生成至少三階的 IDEF0 / GRAFCET，覆蓋 planning、telemetry、context throttling 與 sidebar evolution 主要切片。

### OUT

- 直接修改 `llm.ts`、`compaction.ts`、`processor.ts` 等 runtime 程式行為。
- 新增 fallback mechanism。
- 做產品層 UX redesign 或跨模組 unrelated refactor。

## Non-Goals

- 本輪不提交 production code 優化 patch。
- 本輪不處理 rotation/account fallback 問題本身，除非它直接影響 context-control 的 token/compaction 判讀。

## Constraints

- 必須先以現有程式與測試為單一真相來源，不得憑印象補寫流程。
- 必須保留 fail-fast 原則，不可把優化包裝成新的 silent fallback。
- 必須同步 event ledger，並在結束前記錄 architecture sync 結論。

## What Changes

- 將 `specs/20260320_llm` 從模板填充為本次 session context/compaction workstream 的正式規格包。
- 新增一份對應 event，記錄需求、邊界、發現與後續優化方向。

## Capabilities

### New Capabilities

- Session context-control spec：提供後續優化與驗證使用的現況架構基線。
- Optimization roadmap：將 token overhead / compaction / context window 問題拆成可實作切片。
- Documentation-governance roadmap：為文件制度從 core system prompt 抽離提供規劃基線。

### Modified Capabilities

- Planner artifacts：從通用模板提升為本 workstream 的 execution-ready contract。

## Impact

- 影響 `specs/20260320_llm/*` 規劃文件。
- 影響 `docs/events/` 中本次 llm/context-control 分析事件紀錄。
- 為後續 `packages/opencode/src/session/*` 與 `packages/opencode/src/provider/transform.ts` 的優化工作提供基準。
