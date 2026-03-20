# Event: LLM Session Context Control + Compaction Spec

**Date**: 2026-03-20
**Branch**: cms
**Scope**: session context-control / auto compaction / token overhead planning

## Requirement

- 先把現有 session 的 context 控制邏輯與 compaction 策略建立成 spec。
- 再基於 spec 分析 context window、auto compaction、token overhead 的優化策略。

## Scope (IN / OUT)

### IN

- `specs/20260320_llm/*` planner artifact 對齊
- 現有 runtime context pipeline 與 compaction strategy 盤點
- 優化策略分析

### OUT

- 直接實作 runtime 優化 patch
- 引入新 fallback mechanism
- 無關模組變更

## Task List

- 建立/對齊 proposal/spec/design/implementation-spec/tasks/handoff
- 盤點 `prompt.ts`、`processor.ts`、`llm.ts`、`compaction.ts`、`message-v2.ts`、`provider/transform.ts`
- 盤點 config schema 與 compaction tests
- 產出 prioritized optimization roadmap
- 定義 implementation slices：Prompt Block Compaction / Throttling、Low-risk Context Optimization
- 定義 context inspector sidebar 方向與其 telemetry 依賴
- 定義驗證計畫：KPI、baseline/after 方法、telemetry 實作方向
- 新增 builder-oriented 要求：至少生成真正三階的階層式 IDEF0 / GRAFCET（如 `A1 -> A11 -> A111`）

## Conversation Highlights

- 使用者要求先進 plan mode，不直接改 code。
- 本輪核心是把「現況」建模清楚，再談優化，不做盲改。
- 使用者新增方向：文件制度優化應抽離成專用 agent/skill，不該混在日常 system prompt。
- 使用者希望進一步討論 session context 優化，包含冗餘 prompt 注入節流與類 compaction 策略。
- 使用者明確澄清：三階的意思是階層式子分解 `A1 -> A11 -> A111`，不是平面並列 `A1/A2/A3`。

## Debug / Analysis Checkpoints

### Baseline

- `LLM.stream()` 會額外注入大型 system prompt 組合，包括 provider prompt、agent prompt、dynamic system、enablement snapshot、system boundary、identity reinforcement。
- `SessionCompaction.isOverflow()` 使用 assistant usage token 統計與 model limits 來判斷是否 overflow。
- `SessionCompaction.process()` 以 compaction agent 對完整歷史再做一次 summary generation。

### Instrumentation / Evidence Plan

- 以 code-path tracing 為主：確認 prompt 組裝、message 轉換、provider normalization、overflow 觸發點、summary prompt、prune 規則。
- 以 `compaction.test.ts` 驗證現有 headroom 行為與已知 regression 註解。

### Execution Evidence

- 已讀：`specs/architecture.md`
- 已讀：
  - `packages/opencode/src/session/prompt.ts`
  - `packages/opencode/src/session/processor.ts`
  - `packages/opencode/src/session/llm.ts`
  - `packages/opencode/src/session/compaction.ts`
  - `packages/opencode/src/session/message-v2.ts`
  - `packages/opencode/src/provider/transform.ts`
  - `packages/opencode/src/config/config.ts`
  - `packages/opencode/test/session/compaction.test.ts`
  - `specs/20260320_llm/idef0.json`
  - `specs/20260320_llm/grafcet.json`
  - `specs/20260320_llm/20260320_llm_a1_idef0.json`
  - `specs/20260320_llm/20260320_llm_a11_idef0.json`
  - `specs/20260320_llm/20260320_llm_a0_grafcet.json`
  - `specs/20260320_llm/20260320_llm_a1_grafcet.json`
  - `specs/20260320_llm/20260320_llm_a11_grafcet.json`

### Current Findings

- Prompt payload token overhead 主要集中在 `llm.ts` 的 systemParts assembly。
- Enablement snapshot 每次請求固定注入，屬高頻 prompt 負擔來源。
- `isSubagentSession()` 在 `llm.ts` 內同一路徑被重複 async 解析。
- Message history 在 `MessageV2.toModelMessages()`、`LLM.normalizeMessages()`、`ProviderTransform.message()` 間存在多層轉換/清洗。
- `compaction.test.ts` 已明示 `limit.input` headroom bug regression case。
- Compaction summary prompt 偏詳細，可能讓 compaction request 本身與後續 summary message 都偏貴。
- 真正三階 builder-first MIAT 主幹已改成 `A1 -> A11 -> A111`，其中主幹鎖定在 validation telemetry backbone。
- diagram hierarchy 與 implementation slices 的 traceability 已在 `handoff.md` 固化，builder 可直接依 node-to-slice 對照執行。
- 經 review 後，MIAT 圖式已修正為較合規的動詞片語命名，並修正了 A0 IDEF0 中的 arrow type 問題。

## Optimization Roadmap

### Low-risk quick wins

- **快取 `isSubagentSession()` 結果**：`llm.ts` 同一路徑重複查 session 3 次，屬純 overhead，可先合併成單次解析再重用。
- **Enablement snapshot 改為條件式注入**：目前每輪固定注入；可改成僅在工具/技能路由相關任務、或首輪/plan-like turn 才注入，預期直接減少每輪 system prompt tokens。
- **加入 prompt payload telemetry**：在 `LLM.stream()` 前記錄 system prompt 字元/估算 token 分佈，先讓後續優化有 evidence baseline。
- **縮短 compaction default prompt 模板**：保留 Goal / Instructions / Discoveries / Relevant files 結構，但減少冗詞，降低 compaction request 成本。

### Medium-risk refactors

- **修正 `limit.input` headroom 邏輯**：目前 `isOverflow()` 對有 `limit.input` 的模型保留 headroom 不一致；應統一成保留 reserved/output 空間。這是高價值修正，但需小心不同 provider usage semantics。
- **整理 message normalization 疊層**：`MessageV2.toModelMessages()` → `LLM.normalizeMessages()` → `ProviderTransform.message()` 有部分責任重疊，可減少重複轉換與中間 allocations。
- **將 heavy system blocks 分層固定化**：例如把 rarely-changing registry / policy 區塊移向 provider instructions 或 cache-friendlier message position，但需驗證不影響現有 policy/identity 行為。

### Architecture-sensitive changes

- **分離 compaction summary 與 execution handoff summary**：目前 compaction summary 同時承擔 continuation memory 與操作 handoff，可能過長；若拆成短 summary + structured state，需改變長期 session memory contract。
- **建立 token-budget-aware context assembler**：在 prompt 組裝前先做 budget allocation（system / recent turns / tool traces / summary），會牽動 `prompt.ts`、`llm.ts`、`message-v2.ts` 的模組邊界。
- **以 structured memory 取代部分原始歷史重放**：屬架構級變更，需先明確定義可丟棄/可保留資訊與驗證策略。

### Documentation-governance optimization track

- **把文件制度從 core prompt 抽離**：保留最小 completion gate 在 `agent-workflow` / core system，將 event/spec/architecture 維護細則移到專用 doc governance skill。
- **導入文件 labeling schema**：以 `kind/purpose/freshness/retrieval_value/reuse_mode` 支援 follow-up retrieval，降低每次重爬全文的成本。
- **區分 audit memory 與 handoff memory**：避免 event/spec/summary 全部回灌活躍 context。

### Session context throttling hypothesis

- 可把高重複 prompt blocks 視為「可 compact 的靜態上下文」：
  1. **Always-on**：安全邊界、身份約束、最小 workflow contract。
  2. **Conditional**：enablement snapshot、doc governance policy、部分 environment / repo policy。
  3. **Retrieved / summarized**：歷史 event/spec/handoff 內容。
- 目標不是刪 prompt，而是建立 prompt block lifecycle：常駐 / 條件注入 / 摘要化 / retrieval-only。

### Proposed implementation slices

- **Slice A — Prompt Block Compaction / Throttling Design**
  - 目標：把 prompt blocks 視為可治理資源，建立分類、注入、摘要與驅逐策略。
  - 重點：taxonomy、budget policy、與現有 history compaction 的邊界。
- **Slice B — Low-risk Context Optimization Candidates**
  - 目標：先做低風險、可量測的 prompt/token 減重候選。
  - 重點：telemetry、`isSubagentSession` 去重、enablement gating、compaction prompt slimming。
- **Slice C — Context Sidebar Evolution**
  - 目標：把現有 context sidebar 演進為可收折的 context inspector。
  - 重點：Active Context、Prompt Blocks、Compacted Context、Context Diffs，後續再補 Dormant/Queue。

### Validation plan draft

- **Direct cost metrics**：system prompt tokens、input tokens、compaction prompt tokens、session total cost。
- **Context utilization metrics**：第一次 compaction 輪次、compaction 次數、overflow/near-overflow、headroom estimate。
- **Quality metrics**：goal/todo continuity、是否增加重複詢問/重複分析、policy/identity regression。
- **System behavior metrics**：prompt block 重複注入率、enablement 命中率、compaction summary 長度趨勢。

### Telemetry implementation idea

- 在 `LLM.stream()` 加 block-level prompt telemetry。
- 在 step finish / compaction decision 加 round-level usage summary。
- 用同一組代表性 session patterns 做 baseline vs after 人工 benchmark。

### Validation-oriented sequencing

1. 先做 telemetry + `isSubagentSession` 去重 + enablement snapshot gating。
2. 再修 `isOverflow()` headroom，直接以 `compaction.test.ts` 擴充回歸驗證。
3. 最後再評估 message pipeline 去重與 compaction contract 重設。

## Key Decisions

- 先把 spec 工件補成 execution-ready，再輸出 optimization roadmap。
- 本輪 architecture 文件若無新增長期框架知識，暫不改寫 `specs/architecture.md`，只在 validation 註記核對結果。

## Validation

- Planner artifact placeholders removed: yes
- Runtime boundary tracing completed: yes
- Compaction tests/config reviewed: yes
- True three-level MIAT hierarchy established: partial yes
- Planning review and build-readiness correction: yes
  - Fixes applied: MIAT naming cleanup, top-level node meaning clarification, build-entry order, IDEF0 arrow-type correction, traceability + validation checklist hardening
  - Update: builder-first hierarchy and slice traceability are now explicitly mapped in `handoff.md`
  - Evidence: `A1 -> A11 -> A111` via `20260320_llm_a1_idef0.json` and `20260320_llm_a11_idef0.json`
- Architecture Sync: Verified (No doc changes)
  - Basis: 本輪沉澱的是特定 workstream 的 session context-control/compaction 分析，尚未改變 repo 長期模組邊界或資料流；長期知識先保留在本 event 與 plan package。

## Remaining

- 依使用者決策決定是否進入第一個 implementation slice
- 若進入實作，先把對應 slice 補進 `tasks.md` 再動 code
- 需把 doc governance 抽離與 prompt-block throttling 進一步整理成 implementation slices
- 需選定 Slice A / Slice B 的先做順序與 entry criteria
- 需完成 diagram hierarchy 與 implementation slices 的 traceability matrix
