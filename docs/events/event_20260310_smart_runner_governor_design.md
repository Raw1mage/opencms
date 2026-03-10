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
- 本輪已以 runtime config 形式落地：只改寫 synthetic continue wording 與 narration，不直接改 todo graph 或 stop state。

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
  - `experimental.smart_runner.assist=true` 時，僅允許 Smart Runner 調整 low-risk continuation text / narration
  - 不改變 enqueue / pause / complete / approval gating 的既有控制流
- runtime config 來源：`~/.config/opencode/opencode.json`（user layer）或 `/etc/opencode/opencode.json`（managed layer）
- UI / inspect visibility：
  - session status panel `Debug` 區塊現在會顯示 governor status / decision / next action / timestamp
  - same trace 也會隨 `Session.Info.workflow.supervisor` 出現在 session API payload
  - session status panel 現在另有 `Smart Runner history` 區塊，顯示最近幾筆 trace（time / status / decision / confidence / next / assessment）
  - 最新一輪也會顯示 `Smart Runner assist: applied|noop`，history 內會標出 assist outcome
- runtime switch source：
  - 使用 `~/.config/opencode/opencode.json` 的 `experimental.smart_runner.{enabled,assist}`
  - 本機目前已設為 `enabled=true`, `assist=true`
- 驗證：
  - `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts` ✅
  - `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts` ⚠️ `helpers.test.ts` 仍含既存 DOM-less 測試失敗（`document is not defined`），但本輪新增的 workflow/governor assertions 通過
  - `bunx tsc --noEmit -p /home/pkcs12/projects/opencode/tsconfig.json` ⚠️ repo 仍有大量既存 typecheck 噪音（infra / template 等），本輪未新增可見於輸出的 Smart Runner 相關錯誤
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 experimental Smart Runner dry-run + bounded-assist 現況

### Next Phase Plan

- [x] 將 runtime switch 收斂到 `experimental.smart_runner.{enabled,assist}`
- [x] 將 Smart Runner trace 從 single last-trace 擴充為 bounded history（先保留最近數筆）
- [x] 在 session status / inspect surface 顯示 trace history，而不只是一組 last trace
- [ ] 在真實 autonomous 任務中觀察 history：判斷是否過度插手、是否常誤判為 docs/debug preflight
- [ ] 待 history evidence 足夠後，再決定是否放大 assist 權限到真正的 preflight insertion

### Current Slice (in-session test)

需求：既然這一輪要在 Smart Runner 開啟狀態下繼續開發，就需要讓 trace 本身能回答「這次 assist 到底有沒有真的被採用」。

範圍：

- IN
  - 在 runtime trace 中補記 assist outcome（enabled / applied / mode）
  - 在 session status 顯示 assist 是否生效，方便本輪開發直接觀察
  - 保持 deterministic guardrail authority 不變
- OUT
  - 不新增真正的 preflight insertion
  - 不放大 ask_user / replan / stop 權限

任務清單：

- [x] 為 Smart Runner trace 增加 assist outcome metadata
- [x] 在 prompt loop 中以 assist 實際採用結果回寫 trace
- [x] 在 session status / history 顯示 assist applied vs noop
- [x] 跑 targeted validation，確認本輪可用於真實觀察

Validation（current slice）:

- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts`
  - Smart Runner 新增 assertions 通過
  - `helpers.test.ts` 仍有既存 DOM-less 失敗（`document is not defined`），與本輪 assist outcome 修改無關
- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts` ✅

### Next Stage Unlock

需求：使用者要求不要只觀測 Smart Runner，而是開始逐步解放能力。因此本輪選擇最安全的解鎖方式：讓 `docs_sync_first` 與 `debug_preflight_first` 不只是 wording 微調，而是變成**明確的 preflight continuation contract**。

範圍：

- IN
  - Smart Runner 在 low-risk continue path 上可插入明確 preflight 指令
  - docs/debug preflight 文字改為結構化 step contract
  - guardrail authority 仍由 deterministic runner 持有
- OUT
  - 不開放 ask_user / replan / pause takeover
  - 不直接修改 todo graph
  - 不新增 tool-call autonomy

任務清單：

- [x] 將 docs sync assist 升級為明確 preflight continuation
- [x] 將 debug preflight assist 升級為明確 preflight continuation
- [x] 驗證仍只影響 low-risk continue path，不影響 stop gates

Validation（next stage unlock）:

- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts` ✅
- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts` ✅
- 結果：Smart Runner 現在已能在 bounded-assist 範圍內，把 docs/debug 模式從「語氣提示」提升為「結構化 preflight contract」，但仍不接管 stop/approval/replan authority。

### Current Slice (replan suggestion)

需求：依照後續建議，下一個最有價值但仍安全的解鎖點是 `replan suggestion`。這一輪先讓 Smart Runner 可以把「目前計畫可能失真」明確顯示在 trace / UI 裡，但仍不直接改 todo graph。

範圍：

- IN
  - 將 Smart Runner 的 `replan` decision 顯示為明確 suggestion
  - 在 session status / history 裡看得出為何建議 replan
  - 保持 deterministic runner 與 todo graph 完全不變
- OUT
  - 不實作自動 replan
  - 不改寫 todos
  - 不接管 ask_user / stop / pause

任務清單：

- [x] 在 Smart Runner trace 中標示 replan suggestion metadata
- [x] 在 session status / history 中顯示 replan suggestion 與原因
- [x] 驗證 replan suggestion 只增加可觀測性，不改變控制流

Validation（replan suggestion）:

- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts`
  - Smart Runner / workflow assertions 通過
  - `helpers.test.ts` 仍有既存 DOM-less 失敗（`document is not defined`），與本輪 replan suggestion 修改無關
- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- 結果：Smart Runner 現在可在 trace / history 中明確標示 `replan` suggestion 與原因，但 deterministic runner 與 todo graph 仍完全不變。

### Current Slice (ask-user suggestion)

需求：延續 `replan suggestion` 的做法，讓 Smart Runner 也能把「現在應該問人」明確顯示在 trace / UI 中，但仍不 takeover 問答控制流。

範圍：

- IN
  - 將 Smart Runner 的 `ask_user` decision 顯示為明確 suggestion
  - 在 session status / history 顯示建議提問的理由與 action
  - 保持 deterministic runner、question flow 與 todo graph 不變
- OUT
  - 不自動發問
  - 不中止目前控制流
  - 不接管 stop / pause / approval

任務清單：

- [x] 在 Smart Runner trace 中標示 ask-user suggestion metadata
- [x] 在 session status / history 中顯示 ask-user suggestion 與原因
- [x] 驗證 ask-user suggestion 只增加可觀測性，不改變控制流

Validation（ask-user suggestion）:

- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts`
  - Smart Runner / workflow assertions 通過
  - `helpers.test.ts` 仍有既存 DOM-less 失敗（`document is not defined`），與本輪 ask-user suggestion 修改無關
- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts` ✅
- 結果：Smart Runner 現在可在 trace / history 中明確標示 `ask_user` suggestion 與原因，但 deterministic runner、question flow 與 todo graph 仍完全不變。

### Current Slice (trace summary / counters)

需求：既然 Smart Runner 已經有 assist、replan、ask-user 與 history，下一步需要一個總覽層，讓人不用逐筆讀 trace 也能快速判斷最近行為趨勢。

範圍：

- IN
  - 統計 assist applied / noop 次數
  - 統計 docs/debug assist mode 次數
  - 統計 replan / ask-user suggestion 次數
  - 顯示最近 decision trend
- OUT
  - 不改變 runtime 控制流
  - 不新增 todo mutation
  - 不新增新的 suggestion/assist 類型

任務清單：

- [x] 在 session status summary 中加入 Smart Runner counters
- [x] 在 UI 顯示 Smart Runner summary / trend
- [x] 驗證 summary 只增加可觀測性，不影響既有控制流

Validation（trace summary / counters）:

- `bun test /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts`
  - Smart Runner summary/trend assertions 通過
  - `helpers.test.ts` 仍有既存 DOM-less 失敗（`document is not defined`），與本輪 summary/counter 修改無關
- `bun x eslint /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- 結果：現在可以不逐筆閱讀 history，就快速看到 Smart Runner 最近的 assist/suggestion 統計與 decision trend；此變更只增加可觀測性，不影響 runtime 控制流。

### Current Slice (bounded ask-user draft)

需求：既然 `ask_user` suggestion 已經能指出「該問」，下一步要讓它同時草擬建議問題，讓主持者可以直接評估這個問題是否合理，但仍不自動送出。

範圍：

- IN
  - 為 `ask_user` suggestion 增加 draft question metadata
  - 在 session status / history 顯示 draft question
  - 保持 deterministic question flow 不變
- OUT
  - 不自動發問
  - 不中止目前控制流
  - 不直接建立 question queue

任務清單：

- [x] 在 Smart Runner trace suggestion 中增加 ask-user draft question
- [x] 在 session status / history 顯示 ask-user draft
- [x] 驗證 ask-user draft 只增加可觀測性，不改變控制流

Validation（bounded ask-user draft）:

- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts`
  - Smart Runner ask-user draft assertions 通過
  - `helpers.test.ts` 仍有既存 DOM-less 失敗（`document is not defined`），與本輪 ask-user draft 修改無關
- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- 結果：Smart Runner 現在能在 `ask_user` suggestion 上附帶 draft question，供人檢視與採納，但 deterministic question flow 仍完全不變。

### Current Slice (bounded replan request)

需求：下一步要讓 `replan suggestion` 再更具體一些，不只說「應該重排」，而是產生一個可審核的 request 結構，讓主持者知道它想怎麼重排，但仍不自動改 todo graph。

範圍：

- IN
  - 為 `replan` suggestion 增加 bounded replan request metadata
  - 在 session status / history 顯示 replan request
  - 保持 deterministic runner 與 todo graph 不變
- OUT
  - 不直接改 todos
  - 不自動採納 request
  - 不接管 ask-user / stop / approval

任務清單：

- [x] 在 Smart Runner trace suggestion 中增加 bounded replan request
- [x] 在 session status / history 顯示 replan request
- [x] 驗證 replan request 只增加可觀測性，不改變控制流

Validation（bounded replan request）:

- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts`
  - Smart Runner bounded replan request assertions 通過
  - `helpers.test.ts` 仍有既存 DOM-less 失敗（`document is not defined`），與本輪 replan request 修改無關
- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- 結果：Smart Runner 現在能在 `replan` suggestion 上附帶 bounded replan request，供人檢視與採納，但 deterministic runner 與 todo graph 仍完全不變。

### Current Slice (AI prefix for Smart Runner loop text)

需求：為了讓 Smart Runner 在 autonomous loop 中插入的內容更容易辨識，本輪要在其主動發話的文字前加上固定前綴，例如 `[AI]`。

範圍：

- IN
  - 為 Smart Runner 改寫後的 synthetic continue text 加上 `[AI]` 前綴
  - 為 Smart Runner 覆寫的 narration 加上 `[AI]` 前綴
  - 保持非 Smart Runner assistant 輸出不變
- OUT
  - 不改變一般 assistant 回覆
  - 不改變 runtime 控制流
  - 不改變 trace decision schema

任務清單：

- [x] 在 Smart Runner loop-authored text 路徑加上 `[AI]` 前綴
- [x] 驗證只有 Smart Runner 插入文字被標記

Validation（AI prefix for Smart Runner loop text）:

- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts` ✅
- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts` ✅
- 結果：只有 Smart Runner 實際改寫的 autonomous loop 文字（continue text / narration override）會加上 `[AI]` 標籤；一般 assistant 輸出與非 Smart Runner 路徑保持不變。

### Current Slice (bounded ask-user handoff)

需求：下一步讓 `ask_user` 不只停留在 suggestion + draft question，而是產生可審核的 handoff 結構，讓主持者知道「為什麼現在要問、缺的是哪個決策、若不問會卡在哪」。

範圍：

- IN
  - 為 `ask_user` suggestion 增加 bounded handoff metadata
  - 在 session status / history 顯示 ask-user handoff
  - 保持 deterministic question flow 不變
- OUT
  - 不自動發問
  - 不建立 question queue
  - 不改變 runtime stop / pause / approval

任務清單：

- [x] 在 Smart Runner trace suggestion 中增加 ask-user handoff
- [x] 在 session status / history 顯示 ask-user handoff
- [x] 驗證 handoff 只增加可觀測性，不改變控制流

Validation（bounded ask-user handoff）:

- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts`
  - Smart Runner ask-user handoff assertions 通過
  - `helpers.test.ts` 仍有既存 DOM-less 失敗（`document is not defined`），與本輪 handoff 修改無關
- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- 結果：Smart Runner 現在能在 `ask_user` suggestion 上附帶 bounded handoff metadata，供主持者評估是否要真正向人提問，但 deterministic question flow 仍完全不變。

### Current Slice (bounded ask-user adoption proposal)

需求：在 handoff 之上再前進一步，讓 Smart Runner 產生一個可採納的 ask-user proposal，供 deterministic layer / host 明確決定是否轉成真正的 question flow。

範圍：

- IN
  - 為 `ask_user` suggestion 增加 bounded adoption proposal metadata
  - 在 session status / history 顯示 ask-user adoption proposal
  - 保持 deterministic question flow 不變
- OUT
  - 不自動發問
  - 不建立真正 question queue
  - 不自動 pause / stop session

任務清單：

- [x] 在 Smart Runner trace suggestion 中增加 ask-user adoption proposal
- [x] 在 session status / history 顯示 adoption proposal
- [x] 驗證 proposal 只增加可觀測性，不改變控制流

Validation（bounded ask-user adoption proposal）:

- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts`
  - Smart Runner ask-user adoption proposal assertions 通過
  - `helpers.test.ts` 仍有既存 DOM-less 失敗（`document is not defined`），與本輪 adoption proposal 修改無關
- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- 結果：Smart Runner 現在能在 `ask_user` suggestion 上附帶 bounded adoption proposal，供 host/runtime 未來決定是否採納成真正的 question flow，但 deterministic question flow 仍完全不變。

### Current Slice (bounded replan adoption proposal)

需求：與 ask-user adoption proposal 對稱，讓 `replan` 也能從 request 再前進一步，產生可採納的 proposal，供 host/runtime 未來決定是否採納成真正的 todo replan。

範圍：

- IN
  - 為 `replan` suggestion 增加 bounded adoption proposal metadata
  - 在 session status / history 顯示 replan adoption proposal
  - 保持 deterministic runner 與 todo graph 不變
- OUT
  - 不自動改 todos
  - 不自動採納 proposal
  - 不改變 runtime stop / approval / question flow

任務清單：

- [x] 在 Smart Runner trace suggestion 中增加 replan adoption proposal
- [x] 在 session status / history 顯示 adoption proposal
- [x] 驗證 proposal 只增加可觀測性，不改變控制流

Validation（bounded replan adoption proposal）:

- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts`
  - Smart Runner replan adoption proposal assertions 通過
  - `helpers.test.ts` 仍有既存 DOM-less 失敗（`document is not defined`），與本輪 adoption proposal 修改無關
- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- 結果：Smart Runner 現在能在 `replan` suggestion 上附帶 bounded adoption proposal，供 host/runtime 未來決定是否採納成真正的 todo replan，但 deterministic runner 與 todo graph 仍完全不變。

### Current Slice (adoption policy / trust model)

需求：既然 ask-user / replan 兩側都已有 adoption proposal，下一步要把「哪些 proposal 屬於哪種信任等級、需要什麼核准」明確結構化，作為未來 adoption path 的政策底盤。

範圍：

- IN
  - 為 adoption proposal 增加 policy metadata
  - 在 session status / history 顯示 policy / trust / confirm requirement
  - 保持所有 proposal 仍為 advisory only
- OUT
  - 不實作真正 auto-adopt
  - 不改變 runtime control flow
  - 不讓 Smart Runner 直接接管 question / todo mutation

任務清單：

- [x] 在 Smart Runner proposal 中增加 adoption policy metadata
- [x] 在 session status / history 顯示 policy / trust model
- [x] 驗證 policy 只增加可觀測性，不改變控制流

Validation（adoption policy / trust model）:

- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts`
  - Smart Runner adoption policy assertions 通過
  - `helpers.test.ts` 仍有既存 DOM-less 失敗（`document is not defined`），與本輪 adoption policy 修改無關
- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- 結果：Smart Runner 現在會在 ask-user / replan adoption proposal 上附帶 bounded policy metadata，session status / history 也會顯示 policy 與 trust model；所有 proposal 仍維持 advisory only，不改變 runtime control flow。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 adoption proposal policy contract（ask-user / replan）

### Current Slice (deterministic host adoption for replan)

需求：既然 `replan` proposal 已有 `host_adoptable` policy，下一步要讓 deterministic host 真正能在安全前提下採納 proposal，把它轉成受控的 todo reprioritization，而不是永遠停留在 advisory trace。

範圍：

- IN
  - 為 `replanAdoption` 增加 deterministic host adoption path
  - 僅允許 `host_adoptable` 且不需 user confirm 的 proposal 被採納
  - 將 adoption 結果回寫到 trace / session status history
- OUT
  - 不讓 Smart Runner 直接改 todo
  - 不開放 ask-user auto adoption
  - 不繞過 approval / wait / dependency gates

任務清單：

- [x] 為 host-adoptable replan proposal 增加 deterministic adoption helper
- [x] 在 prompt loop 中接上 adoption path，並於採納後重新計算下一步 continue decision
- [x] 在 trace / session status 顯示 replan proposal 是否已被 host 採納
- [x] 驗證 adoption 只作用於安全條件下，不改變 Smart Runner 無直接 mutation 權限的邊界

Validation（deterministic host adoption for replan）:

- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/todo.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts`
  - `todo.test.ts` / `smart-runner-governor.test.ts` 新增 adoption assertions 通過
  - `helpers.test.ts` 仍有既存 DOM-less 失敗（`document is not defined`），與本輪 adoption path 修改無關
- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/todo.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/todo.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts` ✅
- 結果：`replanAdoption.policy.adoptionMode = host_adoptable` 的 proposal 現在可在 deterministic host 審核下被採納；採納條件仍受「無 active in-progress todo / dependency-ready / 不可 bypass approval 或 waiting gate」限制。Smart Runner 仍只提供 proposal，實際 todo mutation 由 host path 執行，並以 `hostAdopted=true` 回寫到 trace / session history。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 deterministic host adoption for replan contract

### Current Slice (adoption observability)

需求：既然 `replan` proposal 已可被 deterministic host 採納，下一步需要讓 trace / UI 能分辨「已採納」與「未採納」的具體原因，避免 host policy 行為變成黑盒。

範圍：

- IN
  - 為 `replanAdoption` 補上 host adoption reason
  - 在 session debug / history 顯示 adopted vs not adopted outcome
  - 保持原有 adoption gate 與 deterministic authority 不變
- OUT
  - 不改 ask-user adoption contract
  - 不新增新的 auto-adopt 類型
  - 不修改 `focusTerminalById` 既存 DOM-less 測試問題

任務清單：

- [x] 在 deterministic host adoption helper 回傳明確 reason code
- [x] 在 Smart Runner trace 補記 `hostAdoptionReason`
- [x] 在 session debug / history 顯示 adoption outcome
- [x] 驗證 adopted / not adopted 都能被觀測，且不改變既有 guardrails

Validation（adoption observability）:

- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/todo.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts`
  - adoption observability assertions 通過
  - `helpers.test.ts` 仍有既存 DOM-less 失敗（`document is not defined`），與本輪 observability 修改無關
- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/todo.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/todo.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- 結果：session trace / debug / history 現在不只會顯示 `hostAdopted`，也會顯示 `hostAdoptionReason`，例如 `adopted`、`active_todo_in_progress`、`approval_gate`。因此 host policy 行為對人類可解釋，但 Smart Runner 仍沒有直接 mutation 權限。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 `hostAdoptionReason` observability contract

### Current Slice (deterministic host adoption for ask-user)

需求：既然 `ask_user` proposal 已具備 `user_confirm_required` policy，下一步要讓 deterministic host 能在受控條件下真正採納 proposal，將它轉成實際 question flow，而不是永遠停留在 advisory trace。

範圍：

- IN
  - 為 `askUserAdoption` 增加 deterministic host adoption path
  - 僅允許 `user_confirm_required` 且仍需 host review 的 proposal 被採納
  - 將 adoption 結果與 rejection outcome 回寫到 trace / session status history
- OUT
  - 不讓 Smart Runner 直接建立問題或繞過 host review
  - 不繞過既有 workflow stop / approval gates
  - 不處理 `helpers.test.ts` 既存 DOM-less 測試基礎設施問題

任務清單：

- [x] 在 prompt loop 中接上 ask-user host adoption path，採用 `Question.ask(...)` 實際提出問題
- [x] 在回答後以 synthetic user turn 將答案送回主 loop 並繼續
- [x] 在拒答/dismiss 時將 workflow 切到 `waiting_user` / `product_decision_needed`
- [x] 在 trace / session status 顯示 ask-user proposal 是否被採納與原因
- [x] 補齊 ask-user adoption observability tests / helper coverage

Validation（deterministic host adoption for ask-user）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts`
  - Smart Runner ask-user adoption / observability assertions 通過
  - `helpers.test.ts` 仍有既存 DOM-less 失敗（`document is not defined`），集中在 `focusTerminalById`，與本輪 ask-user adoption 修改無關
- 結果：`askUserAdoption.policy.adoptionMode = user_confirm_required` 的 proposal 現在可在 deterministic host 審核下被採納；runtime 會用 `Question.ask(...)` 發出真實問題、在回答後以 synthetic user message 恢復主 loop，並在拒答時停在 `waiting_user` / `product_decision_needed`。Smart Runner 仍只提供 proposal，本身沒有直接 question-flow authority。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 deterministic host adoption for ask-user contract

### Current Slice (session-scoped Changes contract fix)

需求：sidebar / session `Changes` 必須盤點 current session 的 uncommitted files，而不是從 whole-workspace dirty files 起算後再把結果誤用成 session count。

範圍：

- IN
  - 將 session-owned dirty diff 的語義明確收斂為：先算 session-owned candidate files，再只查這批檔案的 uncommitted 狀態
  - 保留 `session.diff(messageID)` 的 message-level review semantics
  - 保留 `file.status` 作為 workspace-wide primitive
- OUT
  - 不改 message summary diff schema
  - 不改 plain workspace diagnostics / raw git status API 的用途

任務清單：

- [x] 釐清 `Changes` 顯示路徑與 `session.diff` / `file.status` 邊界
- [x] 修正 session-owned dirty diff 的來源，避免先掃 whole workspace 再拿來當 session count base
- [x] 補 session-owned candidate files 與 scoped file status tests

Validation（session-scoped Changes contract fix）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/file/index.ts /home/pkcs12/projects/opencode/packages/opencode/src/project/workspace/owned-diff.ts /home/pkcs12/projects/opencode/packages/opencode/src/project/workspace/owned-diff.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/project/workspace/owned-diff.test.ts` ✅
  - 驗證 `collectOwnedSessionCandidateFiles(...)` 只保留同時存在於 tool-touch 與 latest summary diff 的 session-owned files
  - 驗證 `File.status({ paths })` 只回傳指定 candidate files 的 uncommitted 狀態，不再把同 repo 其他 dirty files 混入 session count base
- 結果：`session.diff` 現在改成先從 session-owned candidate files 出發，再對這些檔案查 git dirty state；因此 sidebar / session `Changes` 的 count contract 重新對齊為 current session uncommitted files。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 canonical per-session `Changes` source 的兩階段 contract

### Current Slice (prompt-side Smart Runner question helper coverage)

需求：在補 full prompt-loop integration 前，先為 `prompt.ts` 內 Smart Runner 問答組裝 helper 補一層穩定測試，避免 ask-user host adoption 的 prompt-side contract 再次退化。

範圍：

- IN
  - 驗證 `buildSmartRunnerQuestion(...)` 的實際 question payload
  - 驗證空白 question text 的 fail-closed 行為
  - 驗證 synthetic user answer 文本格式
- OUT
  - 不模擬完整 prompt runLoop
  - 不新增新的 host adoption policy

任務清單：

- [x] 新增 `/home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts`
- [x] 覆蓋 ask-user question payload / empty question / answer formatting
- [x] 跑 Smart Runner governor + prompt helper targeted tests

Validation（prompt-side Smart Runner question helper coverage）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts` ✅
- 結果：Smart Runner ask-user host adoption 現在至少有一層 prompt-side helper coverage，可穩定約束 question payload 與 synthetic answer 文本 contract。
- Architecture Sync: Verified (No doc changes)
  - 比對依據：此輪只補 prompt helper tests，未改 runtime flow / policy / data-path contract

### Current Slice (ask-user orchestration helper extraction)

需求：直接對 `prompt.ts` 靜態 import 路徑做 full loop integration mock 成本偏高，因此先把 ask-user host adoption 的 orchestration 抽成可注入依賴的 helper，讓 rejection/answer side effect 可以被穩定測試。

範圍：

- IN
  - 將 ask-user adopted path 的 persist / ask / synthetic user answer / waiting_user stop-state 流程抽成 helper
  - 補 rejection path 測試
- OUT
  - 不改 Smart Runner policy
  - 不新增新的 adoption 類型
  - 不改整體 prompt loop contract

任務清單：

- [x] 在 `prompt.ts` 新增 `handleSmartRunnerAskUserAdoption(...)`
- [x] 讓 prompt loop 改用此 helper 執行 ask-user adopted path
- [x] 補測 rejection path 會回寫 trace 並切到 `waiting_user/product_decision_needed`

Validation（ask-user orchestration helper extraction）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts` ✅
- 結果：ask-user host adoption 的 side-effect orchestration 現在可在不依賴 brittle module mocks 的情況下被穩定測試，並覆蓋 rejection → `waiting_user` 的核心分支。
- Architecture Sync: Verified (No doc changes)
  - 比對依據：此輪只做 prompt-side orchestration helper extraction，未改 Smart Runner policy、資料流或 UI/runtime contract

### Current Slice (replan orchestration helper extraction)

需求：延續 ask-user 路線，把 host-adopted replan 的 prompt-side orchestration 也抽成 helper，讓 todo update + continuation re-evaluation 可被穩定測試，而不必依賴 brittle full-loop mocks。

範圍：

- IN
  - 將 host-adopted replan 的 todo update / decision refresh 流程抽成 helper
  - 補 adopted path 測試
- OUT
  - 不改 Smart Runner replan policy
  - 不改 bounded assist contract
  - 不新增新的 adoption 類型

任務清單：

- [x] 在 `prompt.ts` 新增 `handleSmartRunnerReplanAdoption(...)`
- [x] 讓 prompt loop 改用此 helper 執行 replan adopted path
- [x] 補 adopted path 會更新 todos 並重新評估 continuation 的測試

Validation（replan orchestration helper extraction）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts` ✅
- 結果：replan adopted path 現在也有 prompt-side orchestration helper coverage，可穩定驗證 todo graph 被 host 採納後，continuation 決策會被重新計算。
- Architecture Sync: Verified (No doc changes)
  - 比對依據：此輪只做 prompt-side replan helper extraction，未改 Smart Runner policy、資料流或 UI/runtime contract

### Current Slice (ask-user answered-path coverage)

需求：既然 ask-user rejection path 已有 coverage，下一步補齊 answered path，確認 host-adopted question 在有答案時會正確產生 synthetic user continuation message。

範圍：

- IN
  - 補 ask-user answered path 測試
  - 驗證 synthetic text part 內容
- OUT
  - 不改 Smart Runner policy
  - 不改 prompt loop contract

任務清單：

- [x] 在 `smart-runner-prompt.test.ts` 補 ask-user answered path
- [x] 驗證 answered path 不會誤切到 `waiting_user`

Validation（ask-user answered-path coverage）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts` ✅
- 結果：ask-user host adoption 的 answered / rejected 兩條 prompt-side orchestration 分支現在都有測試覆蓋。
- Architecture Sync: Verified (No doc changes)
  - 比對依據：此輪只補 answered path tests，未改 runtime flow / policy / data-path contract

### Current Slice (question event-flow integration regression)

需求：在已有 helper-level coverage 基礎上，再補一層更高的 integration regression，確認 ask-user host adoption 不只在 stubbed ask 函式下成立，也能和真實 `Question.ask/reject` event flow 正常配合。

範圍：

- IN
  - 使用真實 `Question.ask` / `Question.list` / `Question.reject`
  - 驗證 helper 與 question pending/reject lifecycle 的整合
- OUT
  - 不模擬整個 prompt runLoop
  - 不改 Smart Runner policy

任務清單：

- [x] 在 `smart-runner-prompt.test.ts` 新增 real Question reject integration test
- [x] 驗證 pending question 被 reject 後，仍會切到 `waiting_user/product_decision_needed`

Validation（question event-flow integration regression）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- 結果：ask-user host adoption 現在除了 helper stub coverage 外，還有一層真實 `Question` event flow regression，可驗證 pending → reject → waiting_user 的整合行為。
- Architecture Sync: Verified (No doc changes)
  - 比對依據：此輪只補 question integration regression，未改 runtime flow / policy / data-path contract

### Current Slice (question reply/reject integration pair)

需求：在已有真實 `Question.reject` regression 後，補齊對稱的 `Question.reply` integration，讓 ask-user host adoption 的 event-flow coverage 在 answered / rejected 兩邊都不只依賴 stub。

範圍：

- IN
  - 使用真實 `Question.reply`
  - 驗證 synthetic continuation text part 內容
- OUT
  - 不改 Smart Runner policy
  - 不模擬整個 prompt runLoop

任務清單：

- [x] 在 `smart-runner-prompt.test.ts` 新增 real Question reply integration test
- [x] 驗證 answered path 透過真實 question lifecycle 仍會生成 synthetic user continuation message

Validation（question reply/reject integration pair）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- 結果：ask-user host adoption 的 answered / rejected 兩條 event-flow integration 都已有真實 `Question` lifecycle coverage。
- Architecture Sync: Verified (No doc changes)
  - 比對依據：此輪只補 question reply integration regression，未改 runtime flow / policy / data-path contract

### Current Slice (continuation side-effects helper extraction)

需求：在 ask-user / replan orchestration 都可測之後，剩下最接近 runLoop 的高風險區是 continue branch 的 side effects：narration emission、autonomous continue enqueue、round count 推進。為了往 runLoop regression 再前進一步，先把這段抽成 helper。

範圍：

- IN
  - 將 continue branch 的 narration + enqueue + roundCount 推進抽成 helper
  - 補 helper-level regression
- OUT
  - 不改 Smart Runner policy
  - 不直接模擬整個 runLoop

任務清單：

- [x] 在 `prompt.ts` 新增 `handleSmartRunnerContinuationSideEffects(...)`
- [x] 讓 prompt loop 改用該 helper 處理 continue branch
- [x] 補 continuation side-effects helper regression

Validation（continuation side-effects helper extraction）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts` ✅
- 結果：continue branch 的最主要 side effects 現在也被抽成可測 helper，Smart Runner prompt-side regressions 已經更接近真實 runLoop 行為。
- Architecture Sync: Verified (No doc changes)
  - 比對依據：此輪只做 continuation side-effects helper extraction，未改 runtime flow / policy / data-path contract

### Current Slice (high-level stop-decision helper extraction)

需求：直接 mock 整個 runLoop/module cache 不穩，因此將 `result === "stop" && decision.continue` 這段 Smart Runner 核心協調流程再抽高一層，形成可測的 stop-decision helper，覆蓋 ask-user adoption 與 replan+assist continue 兩條主幹。

範圍：

- IN
  - 將 Smart Runner stop-decision 主幹抽成高層 helper
  - 補 ask-user / continue path regression
- OUT
  - 不改 Smart Runner policy
  - 不直接模擬整個 runLoop module cache 行為

任務清單：

- [x] 在 `prompt.ts` 新增 `handleSmartRunnerStopDecision(...)`
- [x] 讓 prompt loop 改用該 helper 收斂 Smart Runner stop branch
- [x] 補 ask-user adoption / replan+assist continue 兩條高層 regression

Validation（high-level stop-decision helper extraction）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts` ✅
- 結果：Smart Runner 在 `stop -> continue-decision` 這段的高層 orchestration 現在也已可測，已比單純 helper 更接近 runLoop 真實決策路徑。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 Smart Runner 的正式分層模型、proposal/adoption contract、目前 implemented flows 與 testability layering

### Current Slice (request_approval proposal and host handling)

需求：Smart Runner 不能只會 `ask_user` 或 `replan`；若下一步明顯落在高風險或 approval-sensitive 範圍，應能主動提出 `request_approval` proposal，讓 deterministic host 安全地把 workflow 切到 `waiting_user / approval_needed`。

範圍：

- IN
  - governor decision schema 新增 `request_approval`
  - suggestion/adoption metadata 新增 approval request path
  - prompt host handling 新增 approval request adoption helper
  - high-level stop-decision helper 接上 request_approval branch
- OUT
  - 不實作新的 approval UI
  - 不改 workflow-runner 原本 deterministic approval gate

任務清單：

- [x] 在 governor schema / suggestion annotation 新增 `request_approval`
- [x] 在 prompt 新增 `handleSmartRunnerApprovalRequest(...)`
- [x] 讓 `handleSmartRunnerStopDecision(...)` 能處理 request_approval adopted path
- [x] 補 governor + prompt tests

Validation（request_approval proposal and host handling）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- 結果：Smart Runner 現在除了 `ask_user` / `replan` 外，也能產生並由 host 採納 `request_approval` proposal；採納後 workflow 會安全切到 `waiting_user / approval_needed`。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 `request_approval` adopted path 與 proposal surface

### Current Slice (pause_for_risk proposal and host handling)

需求：在 `request_approval` 之外，再補一種較柔性的治理停點：當下一步雖未必是正式 approval gate，但風險高到值得刻意停下來做人類 review 時，Smart Runner 應能提出 `pause_for_risk` proposal，並由 deterministic host 採納為 `waiting_user / risk_review_needed`。

範圍：

- IN
  - governor decision schema 新增 `pause_for_risk`
  - suggestion/adoption metadata 新增 risk pause request path
  - prompt host handling 新增 risk pause adoption helper
  - high-level stop-decision helper 接上 `pause_for_risk` branch
- OUT
  - 不新增新的風險審核 UI
  - 不改 workflow-runner 既有 deterministic approval gate
  - 不把一般 `pause` advisory 直接升級為 adopted host stop path

任務清單：

- [x] 在 governor schema / suggestion annotation 新增 `pause_for_risk`
- [x] 在 prompt 新增 `handleSmartRunnerRiskPause(...)`
- [x] 讓 `handleSmartRunnerStopDecision(...)` 能處理 `pause_for_risk` adopted path
- [x] 補 governor + prompt tests

Validation（pause_for_risk proposal and host handling）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- 結果：Smart Runner 現在除了 `request_approval` 外，也能由 host 採納 `pause_for_risk` proposal；採納後 workflow 會安全切到 `waiting_user / risk_review_needed`，且不影響既有 deterministic approval gate。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 `pause_for_risk` adopted path 與 proposal surface

### Current Slice (adopted stop-path narration)

需求：`request_approval` 與 `pause_for_risk` 已能被 host 採納成真正的 workflow pause，但若只改 workflow state 而不寫入 transcript，使用者仍可能只看到 loop 停住、卻不知道 Smart Runner 為何暫停。因此要補一層 transcript-visible narration。

範圍：

- IN
  - 為 host-adopted `request_approval` / `pause_for_risk` stop path 補 transcript-visible pause narration
  - 保持 `[AI]` 前綴規則一致
  - 不改 ask-user question flow
- OUT
  - 不改 deterministic workflow-runner stop narration
  - 不新增新的 pause policy 類型

任務清單：

- [x] 新增 adopted stop-path narration helper
- [x] 在 request_approval / pause_for_risk break 前發出 pause narration
- [x] 補 prompt-side helper regression

Validation（adopted stop-path narration）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- 結果：host-adopted `request_approval` / `pause_for_risk` 現在都會在真正停下前寫入 transcript-visible pause narration，且沿用 `[AI]` 前綴，不再只依賴 workflow/debug state 才看得出為何暫停。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 adopted stop-path transcript narration contract

### Current Slice (complete-path adoption)

需求：Smart Runner 目前已能提議 replan / ask-user / request_approval / pause_for_risk，但仍缺少安全收尾能力。若 governor 判斷目前 slice 已完成，應能提出 bounded `complete` proposal；不過 host 只能在重新驗證後確定 workflow 真正 terminal 時才採納，不能讓 governor 單方面結案。

範圍：

- IN
  - governor suggestion/adoption metadata 新增 `complete` path
  - todo 層新增 host-adopted completion helper
  - prompt host handling 新增 complete adoption helper
  - stop-decision orchestration 接上 `complete` branch
- OUT
  - 不讓 Smart Runner 直接 mutate todo 或直接宣告完成
  - 不允許仍有後續 actionable todo 時提前結案

任務清單：

- [x] 在 governor schema / suggestion annotation 新增 `complete`
- [x] 在 todo 層新增 `applyHostAdoptedCompletion(...)`
- [x] 在 prompt 新增 `handleSmartRunnerCompletionAdoption(...)`
- [x] 讓 `handleSmartRunnerStopDecision(...)` 能處理 complete adopted path
- [x] 補 governor / todo / prompt tests

Validation（complete-path adoption）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/todo.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/todo.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/todo.test.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- 結果：Smart Runner 現在可提出 bounded `complete` proposal，但 host 只會在標記目標 todo 完成後重新驗證確定 workflow 進入 `todo_complete` 時才採納；若仍有後續 actionable todo，則拒絕 adoption 並留下 `not_terminal_after_completion` observability 原因。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 conservative complete-path adoption contract

### Current Slice (Smart Runner adoption observability parity)

需求：session side panel 先前對 Smart Runner 的觀測較偏向 `ask_user / replan`，但新的 `request_approval / pause_for_risk / complete` 已成為正式 adopted path。若摘要/歷史不對稱，使用者會看到 governor 有新能力，卻無法快速盤點採納結果。

範圍：

- IN
  - 更新 session helper summary，將 `request_approval / pause_for_risk / complete` 納入計數
  - 在 debug/history 補 proposal / policy / adoptionOutcome 顯示
  - 更新 side panel 顯示欄位
- OUT
  - 不改 Smart Runner runtime 決策邏輯
  - 不改 trace persistence schema

任務清單：

- [x] 擴充 `helpers.ts` 的 Smart Runner summary/history 映射
- [x] 擴充 `helpers.test.ts` 覆蓋新 suggestion kinds
- [x] 更新 `session-side-panel.tsx` 顯示新摘要欄位與 proposal 行

Validation（Smart Runner adoption observability parity）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- `bun test /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts --test-name-pattern "getSessionStatusSummary"` ✅
- 補充：整檔 `helpers.test.ts` 目前仍有兩個既有 DOM 環境失敗（`focusTerminalById` 的 `document is not defined`），與本次 Smart Runner observability 變更無關，因此本輪以 `getSessionStatusSummary` 子集作為直接驗證面。
- 結果：session side panel 現在能對稱顯示 `request_approval / pause_for_risk / complete` 的 proposal、policy 與 adoptionOutcome，摘要也能統計 adopted / not adopted 數量。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 session-side Smart Runner observability parity

### Current Slice (non-adopted approval/risk trace persistence)

需求：`ask_user / replan / complete` 在 proposal 未被 host 採納時，都已能把拒絕原因留在後續 trace / summary；但 `request_approval / pause_for_risk` 先前只有 adopted path 會穩定寫回 trace。這會讓後續 assist/debug/history 無法對稱看見「為何沒有採納」。

範圍：

- IN
  - 將 approval/risk 的 host adoption policy 判斷抽成 helper
  - 在未採納時也把 annotated trace 帶入後續 persist 路徑
  - 補 governor / prompt tests 覆蓋 non-adopted policy reasons
- OUT
  - 不改 approval/risk 的 adopted path 行為
  - 不改 suggestion schema

任務清單：

- [x] 新增可重用的 host-adoptable policy evaluation helper
- [x] 讓 request_approval / pause_for_risk 的 non-adopted reason 進入 `traceForAssist`
- [x] 補 prompt regression 測試，確認 persist trace 會留下 non-adopted reason

Validation（non-adopted approval/risk trace persistence）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- 結果：`request_approval / pause_for_risk` 即使未被 host 採納，也會把 `policy_not_host_adoptable` 等原因保留進後續 trace；後續 Smart Runner summary/history 因而能與其他 suggestion kinds 保持對稱。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 non-adopted approval/risk trace persistence contract

### Current Slice (advisory pause suggestion surfacing)

需求：Smart Runner schema 早已有 `decision: pause`，但它先前不會像其他 intervention 類型一樣被轉成正式 suggestion surface，因此 trace/history 難以區分「governor 建議暫停」與單純沒有 intervention。需要把 plain `pause` 補成 advisory-only suggestion，但不把它升級成 host-adoptable contract。

範圍：

- IN
  - suggestion schema 新增 `pause`
  - 為 `pause` decision 補 advisory-only metadata surface
  - 補 governor tests 與 prompt wording
- OUT
  - 不新增 host adoption path
  - 不改 workflow stop contract

任務清單：

- [x] 在 trace suggestion schema 新增 `pause`
- [x] 為 `pause` 補 `pauseRequest` advisory metadata
- [x] 補 governor test，確認 pause 不會建立 host adoption contract

Validation（advisory pause suggestion surfacing）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt/smart-runner-governor.txt` ✅
  - 補充：prompt `.txt` 檔在 ESLint 中被視為 ignored file warning，無實際 lint error。
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts` ✅
- 結果：Smart Runner 的 plain `pause` 現在也會被轉成 advisory-only suggestion surface，能進入 trace/history，但不會誤生成新的 host-adoptable stop contract。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 advisory-only `pause` suggestion contract

### Current Slice (advisory pause observability parity)

需求：runtime 已把 plain `pause` 補成 advisory-only suggestion，但 app side panel 的 summary/debug/history 尚未把它視為 first-class suggestion。若不補齊，使用者仍會在 UI 端漏看 governor 的一般暫停建議。

範圍：

- IN
  - app session helper summary 加上 `pause` counter
  - debug/history 顯示 `pauseScope` 與 advisory-only policy
  - side panel 顯示 `Pause` 摘要與 history 行
- OUT
  - 不新增 adoption outcome（因為 plain `pause` 無 host-adoption contract）
  - 不改 runtime decision logic

任務清單：

- [x] 擴充 `helpers.ts` summary/debug/history 映射以納入 `pause`
- [x] 擴充 `helpers.test.ts` 覆蓋 advisory pause surface
- [x] 更新 `session-side-panel.tsx` 顯示 `pause` 摘要與 history 行

Validation（advisory pause observability parity）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- `bun test /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts --test-name-pattern "getSessionStatusSummary"` ✅
- 結果：session side panel 現在也能顯示 advisory `pause` 的摘要數量、pause scope 與 advisory-only policy，且不會誤顯示 adoptionOutcome。

### Current Slice (advisory pause bounded assist)

需求：plain `pause` 已能進入 trace/history，但若 runtime 只是照原 deterministic continue text 往下跑，這個建議仍然太容易被忽略。需要一個 bounded assist path：不真正改成 host stop contract，但至少把下一輪 continue 指令收斂成「先停、先重評估、再決定是否繼續」。

範圍：

- IN
  - 在 `applySmartRunnerBoundedAssist(...)` 新增 `pause` assist mode
  - 補 governor / prompt tests，確認 stop-decision 會帶出 pause-check text 與 narration override
- OUT
  - 不把 plain `pause` 升級成 adopted stop contract
  - 不改 workflow state

任務清單：

- [x] 新增 advisory pause assist text builder
- [x] 讓 bounded assist 支援 `decision: pause`
- [x] 補 prompt-side regression，確認 pause advice 會改寫 continue text

Validation（advisory pause bounded assist）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/smart-runner-prompt.test.ts` ✅
- 結果：當 Smart Runner 給出 advisory `pause` 時，runtime 現在會在 assist mode 下把下一輪 continue text 收斂成 pause-check/preflight 指令，而不是直接忽略這個建議；同時仍不會建立新的 adopted stop contract。

### Current Slice (pause assist summary parity)

需求：既然 app 端已能顯示 advisory `pause` suggestion，本輪又新增了 `pause` assist mode，side panel summary 應進一步把這種 assist 行為單獨計數，不然使用者無法分辨「有看到 pause 建議」和「pause 建議真的改寫了下一輪 continue text」。

範圍：

- IN
  - app Smart Runner summary 新增 `pauseAssist` counter
  - side panel 顯示 `Pause assist`
  - 補 helper tests 驗證 assist summary 與 history
- OUT
  - 不改 runtime assist 行為
  - 不改 trace schema

任務清單：

- [x] 擴充 `helpers.ts` summary counter 以納入 `assist.mode === pause`
- [x] 更新 side panel 顯示 `Pause assist`
- [x] 補 helper regression 測試

Validation（pause assist summary parity）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- `bun test /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts --test-name-pattern "getSessionStatusSummary"` ✅
- 結果：session side panel 現在會把 `assist.mode === pause` 單獨計成 `Pause assist`，因此可區分「只看到 pause 建議」與「pause 建議真的改寫了下一輪 continue text」。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 pause assist summary parity
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 advisory pause bounded assist contract
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 advisory pause observability parity

### Current Slice (unified adoption policy evaluator)

需求：隨著 `ask_user / request_approval / pause_for_risk / complete` 的 adoption path 逐步增加，policy 判斷開始分散：`ask_user` 有自己的一套 user-confirm 檢查，host-adoptable 類型又有另一套。若之後再擴充 suggestion kinds，會持續重複。需要把共用 policy 骨架收斂成單一 evaluator。

範圍：

- IN
  - 新增共用 adoption policy evaluator
  - 讓 `evaluateSmartRunnerAskUserAdoption(...)` 改走共用 policy 骨架再疊加 ask-user 專屬 gates
  - 讓 `evaluateSmartRunnerHostAdoptionPolicy(...)` 改以共用 evaluator 映射結果
  - 補 governor tests 覆蓋 generic policy 結果
- OUT
  - 不改 trace schema
  - 不改既有 adoption reason 文案對外語意

任務清單：

- [x] 新增 `evaluateSmartRunnerAdoptionPolicy(...)`
- [x] 將 ask-user / host-adoptable evaluator 改為共用骨架
- [x] 補 governor regression tests

Validation（unified adoption policy evaluator）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts` ✅
- 結果：`ask_user` 與 host-adoptable 類型現在共用同一組 policy-mode / user-confirm / host-review 判斷骨架；`ask_user` 只額外保留 question text 與 pending question 等專屬 gate，後續擴充新的 suggestion kind 時不必再複製整套 policy 邏輯。

### Current Slice (non-adopted reason aggregate statistics)

需求：目前 side panel 已能在 history row 看見單筆 adoptionOutcome，但若想快速知道近期最常見的「不採納原因」，仍得手動掃描多列 trace。需要把 non-adopted reasons 聚合成 summary 層級統計。

範圍：

- IN
  - Smart Runner summary 新增 `nonAdoptedReasons`
  - side panel 顯示 aggregated non-adopted reason chips
  - 補 helper tests 覆蓋 repeated non-adopted reasons
- OUT
  - 不改 trace schema
  - 不改單筆 history row 的 adoptionOutcome 文案

任務清單：

- [x] 擴充 `helpers.ts` 聚合 non-adopted reason counts
- [x] 更新 side panel 顯示 non-adopted reason chips
- [x] 補 helper regression 測試

Validation（non-adopted reason aggregate statistics）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- `bun test /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts --test-name-pattern "getSessionStatusSummary"` ✅
- 結果：side panel summary 現在會聚合近期 Smart Runner 的 non-adopted reasons，能直接看出像 `policy_not_host_adoptable`、`question_already_pending`、`not_terminal_after_completion` 等拒絕模式，而不必逐列掃描 history。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 non-adopted reason aggregate statistics
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 unified adoption policy evaluator contract

### Current Slice (replan / complete observability detail refinement)

需求：目前 replan / complete 在 side panel 已有 proposal 與 adoption outcome，但細節仍偏粗：不容易直接看出 replan 到底針對哪個 todo、想做什麼動作，或 complete 實際想完成的範圍。需要把這些 payload 細節直接浮到 debug/history。

範圍：

- IN
  - debug lines 顯示 `replan target / action`
  - debug lines 顯示 `complete scope`
  - history row 顯示 `replanTarget` 與 `completionScope`
  - 補 helper tests 驗證新細節欄位
- OUT
  - 不改 runtime schema
  - 不改 adoption decision logic

任務清單：

- [x] 擴充 `helpers.ts` 映射出 replan/complete 細節欄位
- [x] 更新 side panel 顯示新欄位
- [x] 補 helper regression 測試

Validation（replan / complete observability detail refinement）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- `bun test /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts --test-name-pattern "getSessionStatusSummary"` ✅
- 結果：side panel 現在能直接顯示 replan 的 target/action 與 complete 的 scope，因此不必打開原始 trace JSON 也能看出 Smart Runner 想重排或完成哪個 slice。

### Current Slice (meeting-model pre-observability layer)

需求：使用者長期方向是走向 `user + Main Agent + Smart Runner` 的 meeting model，但目前還不宜直接升級成雙代理對話架構。可先補一層前置觀測：把 `[AI]` narration 作為獨立 conversation layer 統計出來，讓 Smart Runner 的「對話介入痕跡」先變得可見。

範圍：

- IN
  - session summary 新增 `smartRunnerConversation`
  - 統計 `[AI]` autonomous narration 的總數 / pause / complete 次數
  - 顯示最新 AI narration 的 kind 與文本
  - 補 helper tests 驗證 conversation-layer 摘要
- OUT
  - 不改 message schema
  - 不改 Main Agent / Smart Runner 的實際 speaker model

任務清單：

- [x] 在 `helpers.ts` 新增 Smart Runner conversation-layer summary
- [x] 在 side panel 顯示 AI narration 統計與最新文本
- [x] 補 helper regression 測試

Validation（meeting-model pre-observability layer）:

- `bun x eslint /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts /home/pkcs12/projects/opencode/packages/app/src/pages/session/session-side-panel.tsx` ✅
- `bun test /home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts --test-name-pattern "getSessionStatusSummary"` ✅
- 結果：session side panel 現在會把 `[AI]` autonomous narration 當成獨立 conversation layer 做摘要，能看到 AI narration 的總數、pause/complete 次數，以及最新 AI 文本，作為 meeting model 的前置觀測層。
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 meeting-model pre-observability layer
- Architecture Sync: Updated
  - 已於 `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` 補記 replan / complete observability detail refinement
