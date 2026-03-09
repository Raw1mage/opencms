# Event: smart runner governor design

Date: 2026-03-10
Status: In Progress

## 需求

- 將現有 `workflow-runner` 從規則型 continuation controller，升級為可協助主持 session 的 **Smart Runner**。
- 目標不是多職能 subagent 分工，而是讓 Main Agent 在單一上下文中，配合 Smart Runner + skills + tools 持續完成開發、測試、除錯、驗證。
- Smart Runner 必須比現行 runner 更有智慧，但仍要保留可審計、可約束、可停損的治理能力。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt/*`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/*`
- `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260310_smart_runner_governor_design.md`

### OUT

- 本輪先做架構規劃，不直接提交 Smart Runner 程式碼實作
- 不以多職能 subagent 作為主設計方向

## 任務清單

- [x] 釐清現有 workflow-runner 的性質與限制
- [x] 確認新方向以 Smart Runner + 單 Main Agent 為主軸
- [x] 定義 Smart Runner 的職責邊界與決策 schema
- [x] 定義與現行 deterministic runner 的雙層整合模式
- [x] 定義 rollout phases 與風險控制

## Debug Checkpoints

### Baseline

- 現有 `workflow-runner` 主要是規則型 orchestration layer：
  - 讀 workflow state
  - 讀 todos / dependencies / approvals / blockers
  - 讀 retry / budget / pending continuation
  - 決定 continue / stop / resume
- 它不是一個會重新理解局勢、調整策略、主持 session 的智慧治理者。
- 若繼續走多職能 subagent 路線，patch 既有程式碼會承受高額 context handoff 成本。
- 因此新方向改為：
  - 單 Main Agent 維持完整上下文
  - Smart Runner 負責高層主持 / route / replan / stop-gate judgment
  - skills 提供專業方法論
  - tools 負責執行

### Instrumentation Plan

- 在真正實作前，先界定以下觀測點：
  1. Smart Runner 的輸入上下文集合（workflow/todo/messages/docs/status）
  2. Smart Runner 的決策輸出 schema
  3. Deterministic guardrail layer 與 LLM governor layer 的責任切分
  4. Narration / trace / audit log 應如何保留
  5. 哪些 stop gates 仍必須由硬規則把關

### Execution

#### 架構主張

採 **雙層 runner**：

1. **Layer A — Deterministic Guardrail Runner（保留/精簡現有 `workflow-runner`）**
   - 硬規則：
     - approval / decision / blocker
     - budget / retry / rate limit
     - pending continuation
     - max rounds
     - wait_subagent / wait_external
   - 目標：安全、可預測、可審計

2. **Layer B — Smart Runner Governor（新 LLM-assisted layer）**
   - 在 Layer A 允許的前提下，判讀局勢並決定：
     - continue current slice
     - replan todo graph
     - switch skill emphasis
     - request docs-first read / framework sync
     - ask user
     - complete current objective
   - 目標：像真人一樣主持 session，而不是只是按 yes/no

#### Smart Runner 不是第二個 Main Agent

它的職責應受限，不直接做任務內容，不自由 tool-call；而是輸出結構化決策，由 Main Agent 在同一上下文中執行。

#### 建議決策 schema

```json
{
  "situation": "execution_stalled | context_gap | ready_to_continue | plan_invalid | waiting_for_human | completed",
  "assessment": "brief grounded explanation",
  "decision": "continue | replan | ask_user | pause | complete | docs_sync_first | debug_preflight_first",
  "reason": "why this decision is best now",
  "nextAction": {
    "kind": "continue_current | start_next_todo | update_todos | request_docs_sync | request_user_input",
    "todoID": "optional",
    "skillHints": ["agent-workflow", "code-thinker", "doc-coauthoring"],
    "notes": "operator-facing narration"
  },
  "needsUserInput": false,
  "confidence": "low | medium | high"
}
```

#### Smart Runner 最適合接手的決策

- 目前卡住是 execution 問題還是 planning 問題
- 現在應該繼續做、先 replan、還是先補文件
- debug 任務是否應先做 preflight / instrumentation plan
- 當前 todo graph 是否已失真，應否重新排序
- 何時該輸出主持式 narration 向使用者解釋現況

#### Layer 分工定稿

**Layer A: Deterministic Guardrail Runner（現有 `workflow-runner` 延伸）**

- 仍維持同步、純函式優先、可測試的 planner / gate evaluator。
- 只負責下列硬規則判斷：
  - autonomous 是否啟用
  - 是否為 root session
  - workflow.state 是否為 blocked / completed
  - approval / question / wait_subagent / budget / retry / lease / max rounds
  - destructive / push / architecture_change 等 requireApprovalFor
- 輸出應維持 deterministic、可 snapshot test。

**Layer B: Smart Runner Governor（新增 LLM-assisted decision helper）**

- 僅在 Layer A 判定「允許繼續評估」時執行。
- 不直接 tool-call、不寫檔、不改 todo；只回傳結構化建議。
- 主要用途：
  - 判斷目前是 execution stall 還是 planning drift
  - 建議 `continue_current` / `start_next_todo` / `replan_todos`
  - 建議 `docs_sync_first` / `debug_preflight_first`
  - 決定是否應該改成 ask-user，而不是盲目 continue

#### 整合模式定稿

建議將現有 runner 分成三段：

1. **guardrail evaluation**
   - 輸出 `allowed | blocked | completed | waiting` 類型結果。
2. **governor evaluation**
   - 只有在 guardrail = `allowed` 時才組 context pack 並呼叫 governor。
3. **execution translation**
   - 將 governor decision 轉成現有 runtime 可執行的動作：
     - enqueue synthetic continue
     - emit narration
     - pause and wait
     - mark workflow state
     - request todo replan path（由 Main Agent 下回合執行）

換句話說，`workflow-runner` 不被替換，而是被重構為：

- `evaluateAutonomousGuardrails(...)`
- `evaluateSmartRunnerGovernor(...)`
- `translateGovernorDecision(...)`

#### Governor context pack 定稿

Governor 不吃完整 transcript，而只吃主持層壓縮上下文：

```json
{
  "goal": "current user-visible objective",
  "workflow": {
    "state": "running|waiting_user|blocked|completed",
    "autonomous": true,
    "roundCount": 2,
    "stopReason": null
  },
  "todos": {
    "inProgress": [{ "id": "t1", "content": "..." }],
    "actionable": [{ "id": "t2", "content": "..." }],
    "blocked": [{ "id": "t3", "waitingOn": "approval" }]
  },
  "recentProgress": {
    "lastNarration": "...",
    "latestAssistantSummary": "...",
    "latestToolResults": ["..."]
  },
  "docs": {
    "architectureSlice": "only relevant section summary",
    "eventSlice": "only current task checkpoint summary"
  },
  "health": {
    "pendingApprovals": 0,
    "pendingQuestions": 0,
    "activeSubtasks": 0,
    "budget": "healthy|limited|blocked"
  }
}
```

Context pack 原則：

- 不直接塞原始 message stream。
- 先用 deterministic summarizer 壓成主持資訊，再送 governor。
- docs slice 以 relevant-only 為主，避免把整份 `ARCHITECTURE.md` 灌進 prompt。

#### Governor output schema 定稿（v1）

```json
{
  "situation": "ready_to_continue|execution_stalled|plan_invalid|context_gap|waiting_for_human|completed",
  "assessment": "brief grounded explanation",
  "decision": "continue|replan|ask_user|pause|complete|docs_sync_first|debug_preflight_first",
  "reason": "why this is the best next move now",
  "nextAction": {
    "kind": "continue_current|start_next_todo|replan_todos|request_docs_sync|request_debug_preflight|request_user_input",
    "todoID": "optional",
    "skillHints": ["agent-workflow", "code-thinker", "doc-coauthoring"],
    "narration": "short operator-facing line"
  },
  "needsUserInput": false,
  "confidence": "low|medium|high"
}
```

補充限制：

- 若 decision = `replan`，只回傳 **replan intent**，不可在 governor 內直接修改 todos。
- 若 decision = `ask_user`，必須同時提供 `reason` 與 `nextAction.narration`。
- 若 confidence = `low`，translation layer 應偏向 `ask_user` 或 `pause`，不可硬續跑。

#### Prompt / module placement 建議

- Prompt 資產建議新增於：
  - `/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt/smart-runner-governor.txt`
- 新模組建議：
  - `/home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts`
- `prompt.ts` 仍是主 loop owner；governor 只作為 loop 末端 decision helper 被呼叫。

#### Rollout phases

**Phase 0 — design only（本輪）**

- 完成 schema / context pack / guardrail split。
- 不修改 production runtime 行為。

**Phase 1 — dry-run governor trace**

- runtime 仍以 deterministic runner 為唯一決策來源。
- governor 僅產生 trace，不參與真實控制流。
- 目標：比較 governor 建議是否與現有 runner 相符，觀察誤判模式。

**Phase 2 — bounded assist mode**

- 只開放 governor 影響低風險決策：
  - continue_current
  - start_next_todo
  - docs_sync_first
  - debug_preflight_first
- `ask_user` / `pause` / hard stop 仍由 deterministic layer 最終裁決。
- 本輪已以 feature flag 形式落地：只改寫 synthetic continue wording 與 narration，不直接改 todo graph 或 stop state。

**Phase 3 — hosted-session mode**

- governor 可建議 replan / ask_user / completion narration。
- 但 destructive / push / approval gates 仍不可交給 governor。

#### 主要風險與控制

1. **Governance drift**
   - 風險：governor 開始像第二個 Main Agent，產生過度自由決策。
   - 控制：禁止 tool-call / write / todo mutation，只允許 structured output。

2. **Token overuse**
   - 風險：每輪都送大量 transcript 給 governor，成本過高。
   - 控制：context pack 必須先壓縮，docs 只送 slice。

3. **False replanning**
   - 風險：governor 太常判斷「要 replan」，導致 session 震盪。
   - 控制：bounded assist mode 先只 advisory；低 confidence 不得直接切換路線。

4. **Opaque decisions**
   - 風險：使用者與開發者看不懂 runner 為何轉向。
   - 控制：保留 structured decision trace + concise narration。

#### 不應交給 Smart Runner 的決策

- hard approval gate 放行
- destructive / push / architecture-breaking 動作授權
- retry/budget 底線判斷
- 寫檔/改碼/跑工具本身

#### Context strategy

為避免 token 浪費與治理漂移，Smart Runner 的輸入不應是整個 session raw dump，而應是壓縮後的主持上下文：

- current goal
- active / actionable todos
- workflow state
- latest narration
- latest task results
- relevant `docs/ARCHITECTURE.md` slice
- relevant `docs/events/` slice
- stop/budget/retry summary

#### Observability / Audit

Smart Runner 的每次決策應可被觀測：

- decision trace（結構化）
- user-visible narration（精簡）
- event log checkpoint（必要時）

### Root Cause

- 目前無法讓 Main Agent 像真人主持 session 的根因，不是 LLM 不夠聰明，而是 orchestration layer 只有 deterministic continuation，沒有一個受約束的高層治理回路去做：
  - 局勢判讀
  - 路線修正
  - docs-first/context-first 決策
  - 可審計的 session 主持

### Validation

- Phase 1 dry-run 已落地，但仍維持 deterministic runner 為唯一真實控制流
- Phase 2 bounded-assist 亦已落地，但只限 low-risk continue path wording / narration 調整
- 新增檔案：
  - `/home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts`
  - `/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt/smart-runner-governor.txt`
  - `/home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts`
- 整合點：
  - `prompt.ts` 在 deterministic `decision.continue` 時執行 governor dry-run
  - trace 僅寫入 `workflow.supervisor.lastGovernorTrace*`
  - `OPENCODE_EXPERIMENTAL_SMART_RUNNER_GOVERNOR_ASSIST=1` 時，僅允許 governor 調整 low-risk continuation text / narration
  - 不改變 enqueue / pause / complete / approval gating 的既有控制流
- UI / inspect visibility：
  - session status panel `Debug` 區塊現在會顯示 governor status / decision / next action / timestamp
  - same trace 也會隨 `Session.Info.workflow.supervisor` 出現在 session API payload
- 驗證：
  - `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts` ✅
  - `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts` ⚠️ `helpers.test.ts` 仍含既存 DOM-less 測試失敗（`document is not defined`），但本輪新增的 workflow/governor assertions 通過
  - `bunx tsc --noEmit -p /home/pkcs12/projects/opencode/tsconfig.json` ⚠️ repo 仍有大量既存 typecheck 噪音（infra / template 等），本輪未新增可見於輸出的 Smart Runner 相關錯誤
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 experimental Smart Runner dry-run + bounded-assist 現況
