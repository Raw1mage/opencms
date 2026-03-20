# Implementation Spec

## Goal

- 建立現有 session context-control 與 compaction strategy 的 execution-ready spec，並基於真實程式邊界提出分層優化策略。

## Scope

### IN

- 盤點現有 session context payload 組裝與 normalization 流程。
- 盤點 compaction auto trigger / process / prune / tests / config。
- 維護 `specs/20260320_llm/*` 與 `docs/events/event_20260320_llm_context_control_spec.md`。
- 產出 prioritized optimization recommendations。

### OUT

- 直接修改 runtime production code。
- 提交 PR、push、deploy。
- 任何未被本 spec 表示的新 workstream 分支。

## Assumptions

- 現有 `packages/opencode/src/session/*` 與 `provider/transform.ts` 為 runtime 單一真相來源。
- `compaction.test.ts` 已覆蓋至少一個已知 headroom bug，可作為優化驗證入口。
- 本輪以規劃與分析為主，不要求完成 code patch。

## Stop Gates

- 若分析過程發現需要新增 fallback mechanism，必須停下來請求使用者批准。
- 若優化提案需要改動模組邊界或持久化 schema，需先回到 plan mode 更新 artifacts。
- 若需要直接開始實作，必須先把對應 implementation slice 補進 `tasks.md`。

## Critical Files

- `/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/processor.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/compaction.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/message-v2.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/provider/transform.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/config/config.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/test/session/compaction.test.ts`
- `/home/pkcs12/projects/opencode/docs/events/event_20260320_llm_context_control_spec.md`

## Structured Execution Phases

- **Phase 1 — Spec baseline**: 將 proposal/spec/design/implementation-spec/tasks/handoff 與 event 建成可用基線。
- **Phase 2 — Runtime mapping**: 對齊 prompt assembly、message conversion、provider transform、overflow detection、compaction summary、prune 路徑。
- **Phase 3 — Optimization analysis**: 依風險分級整理 quick wins / deeper refactors / validation plan。
- **Phase 4 — Implementation slice definition**: 把 doc governance 抽離與 session context throttling 轉成可實作 slices。

## Implementation Slices

### Slice A — Prompt Block Compaction / Throttling Design

**Objective**

- 定義可套用在 system/policy/doc/history prompt blocks 的分類、注入策略與 budget policy。

**Planned outputs**

- prompt block taxonomy：`always_on | conditional | summarizable | retrieve_only`
- block metadata：`kind / priority / repeatability / injectPolicy / compactionPolicy`
- budget-aware assembly 概念設計
- 與現有 message compaction 的關係與邊界

**Target areas**

- `/home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts`
- `/home/pkcs12/projects/opencode/specs/20260320_llm/design.md`

### Slice B — Low-risk Context Optimization Candidates

**Objective**

- 定義第一批低風險、可量測、可獨立驗證的 token/context 優化項。

**Planned candidates**

- prompt payload telemetry
- `isSubagentSession()` de-duplication
- enablement snapshot gating
- compaction prompt slimming

**Validation direction**

- 比較 system prompt 字元/估算 token 變化
- 確認行為契約（safety / identity / workflow）未被刪壞
- 若進入實作，再補 targeted tests / snapshots / runtime traces

### Slice C — Context Sidebar Evolution

**Objective**

- 將現有 context/status sidebar 演進為可收折的 context inspector，優先呈現「現在 prompt 裡有什麼」。

**Planned outputs**

- accordion card information architecture
- telemetry-to-UI data contract
- phase-1 cards：Active Context / Prompt Blocks / Compacted Context / Context Diffs
- phase-2 cards：Dormant Context / Retrieval Queue

**Validation direction**

- collapsed state 能顯示 token estimate / ratio / delta
- expanded state 能對應 backend telemetry 欄位
- UI 不回灌 prompt，不成為新 token 稅

### Slice D — Three-Level MIAT Diagram Package

**Objective**

- 產出至少三階、且符合階層式編號的 IDEF0 / GRAFCET（例如 `A1 -> A11 -> A111`），讓 builder 對 planning slice、控制邊界、驗證流與 UI 演化有足夠方向感。

**Planned outputs**

- A0：全局 workstream context
- A1：builder-first 主路徑分解（建議以 Validation Telemetry / Implementation Orientation 為主幹）
- A11：A1 的二階分解
- A111：A11 的三階分解
- 必要時再補 A12 / A13 等 sibling branches，但三階的最低門檻是明確存在 `A1 -> A11 -> A111`

**Validation direction**

- IDEF0/GRAFCET 至少覆蓋真正三階階層（不是平面列出 `A1/A2/A3`）
- GRAFCET `ModuleRef` 與 IDEF0 hierarchy 對齊
- 圖式內容能直接為 builder 提供 implementation orientation

## Build Entry Order

1. **Slice B / Telemetry first**
   - 先做 `A111` prompt block telemetry
   - 再做 `A112` round/session usage telemetry
2. **Validation before policy tightening**
   - 以 `A113` benchmark comparison 與 `A114` validation gates 建立 baseline/after evidence
3. **Then Slice A / Slice C**
   - 在 telemetry backbone 穩定後，再進入 prompt throttling 與 context inspector sidebar

## Build-Readiness Gate

- 規劃文件已定義 builder-first 主幹：`A1 -> A11 -> A111`
- telemetry / benchmark / validation gate 已有對應 slices 與 traceability matrix
- builder 應視 `A2/A3/A4` 為第一層 sibling responsibilities，視 `A11x` 為第一個優先落地主幹
- 進入 build 前，不必等待所有 sibling branch 完整分解，但不得跳過 `A111/A112/A113/A114` 的先後依賴

## Validation Plan

### Validation objectives

- 衡量 session context 優化是否真的減少固定 prompt 稅與 compaction 負擔。
- 避免只省 token 卻造成 continuity、identity 或 workflow contract 退化。
- 建立可重複比較的 baseline / after methodology，支援後續 slices 持續沿用。

### KPI groups

#### A. Direct cost metrics

- 每輪估算 `system prompt tokens`
- 每輪估算 `input tokens`
- compaction request 的估算 tokens
- 每個 session 的總 token / cost（若 usage metadata 可得）

#### B. Context utilization metrics

- 第一次 compaction 出現輪次
- 每 session compaction 次數
- overflow / near-overflow 次數
- usable headroom 估算值（若 instrumentation 可得）

#### C. Quality / continuity metrics

- 是否仍保留 current goal / todo / blocker awareness
- 是否增加重複詢問 / 重複分析
- 是否發生 safety / identity / workflow 規範缺漏

#### D. System behavior metrics

- prompt block 重複注入率
- enablement snapshot 命中率（真正需要 vs 白塞）
- compaction summary 長度趨勢

### Baseline methodology

- 挑三類 representative sessions：
  1. 短 session
  2. 中長 session
  3. 多工具 / 多輪 planning session
- 對每類 session 記錄至少：
  - 平均每輪 system prompt token estimate
  - 平均每輪 input token estimate
  - 第一次 compaction 輪次
  - compaction 次數
  - continuity / regression 觀察

### After methodology

- 套用同一組場景與相同量測點，做 baseline vs after 比較。
- 每個 Slice 至少要回答：
  - token 有沒有下降
  - compaction 有沒有延後或減少
  - 行為契約有沒有退化

### Implementation plan for measurement

#### Step 1 — Prompt block telemetry

- 在 `LLM.stream()` system prompt assembly 完成後，記錄各 block 的：
  - block 名稱
  - 字元長度
  - token estimate（以 `Token.estimate()` 為近似）
  - inject policy / 是否實際注入

#### Step 2 — Session-level summary telemetry

- 在每輪 step finish 或 compaction decision 附近，記錄：
  - round index
  - input/output/cache tokens
  - 是否觸發 compaction
  - compaction prompt estimate

#### Step 3 — Scenario replay / manual benchmark set

- 先選定 3 個代表性 session patterns 作為人工 benchmark。
- 每次 Slice B 修改後，至少重跑同一組 benchmark 做前後比較。

### Validation gates for Slice B implementation

- Gate 1: telemetry 能輸出 block-level prompt 組成，且不影響正常請求。
- Gate 2: 至少一個低風險候選能量測到 token 下降。
- Gate 3: safety / identity / workflow 必要 prompt blocks 仍完整存在。
- Gate 4: 不引入新 fallback、不改壞 compaction 正確性。

## Validation

- Planner artifacts 不得殘留模板 placeholder。
- 分析結果需能指出至少一個 low-risk、至少一個 medium-risk、至少一個 architecture-sensitive optimization candidate。
- Event ledger 必須記錄 architecture sync 結果；若無需更新 `specs/architecture.md`，明確寫 `Architecture Sync: Verified (No doc changes)`。
- 若進入 Slice B 實作，必須先完成 block-level telemetry 設計與 baseline methodology。
- 若圖式要作為 builder 契約，必須至少完成真正三階的階層式 IDEF0 / GRAFCET（如 `A1 -> A11 -> A111`）。

## Handoff

- Build/implementation agent must read this spec first.
- Build/implementation agent must read `tasks.md` and materialize runtime todo from it before coding.
- Conversation memory is supporting context only, not the execution source of truth.
- If scope changes or a new slice appears, update the same plan root unless a new plan is explicitly user-approved.
- At completion time, review implementation against the proposal's effective requirement description.
