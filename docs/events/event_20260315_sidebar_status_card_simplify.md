# Event: Sidebar status card simplification and persistence

Date: 2026-03-15
Status: Completed

## 需求

- 移除 sidebar 中過於複雜且不直觀的 `Smart Runner history`
- 移除 `Latest narration` / `Latest result` / `Debug` 卡片
- 將 autonomous 與 task monitor 重構合併為單一「工作監控」卡
- 移除 sidebar 中的 `外掛程式 (plugins)` 與 `LSP` 卡
- 讓 sidebar 卡片支援拖曳排序
- 將卡片順序與展開/收折狀態以**全域**方式持久化記憶

## 範圍

### IN

- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/pages/session/session-status-sections.tsx`
- `packages/app/src/pages/session/helpers.ts`
- `packages/app/src/context/layout.tsx`
- 相關前端測試與驗證

### OUT

- 不改 backend runtime contract
- 不改 session autonomous queue/health API shape
- 不改 TUI status sidebar

## 任務清單

- [x] 簡化 status sidebar 卡片資訊架構
- [x] 合併 autonomous / task monitor 為單一卡片
- [x] 移除 Smart Runner history / Latest narration / Latest result / Debug / LSP / plugins
- [x] 加入卡片拖曳排序
- [x] 加入全域展開狀態與順序持久化
- [x] 驗證並完成 architecture sync 記錄

## 實作摘要

- `packages/app/src/context/layout.tsx`
  - 新增全域 `statusSidebar.order` 與 `statusSidebar.expanded` persisted state。
  - 提供 `setOrder` / `expanded` / `setExpanded` / `toggleExpanded` 供 session status surfaces 共用。
- `packages/app/src/pages/session/session-status-sections.tsx`
  - sidebar/status sections 精簡為 `工作監控`、`Todo`、`Servers`、`MCP` 四卡。
  - 移除舊的 `summary`、`LSP`、`plugins` sections。
  - 加入 `@thisbeyond/solid-dnd` sortable card reorder，並寫回全域 layout store。
  - expand/collapse 狀態改為使用全域 layout store，不再使用區域 state。
- `packages/app/src/pages/session/session-side-panel.tsx`
  - 將原 autonomous summary / queue control / process status 與 monitor list 合併進單一 `工作監控` 卡。
  - 停止渲染獨立 summary card。
- `packages/app/src/pages/session/tool-page.tsx`
  - 對齊桌面側欄的 `工作監控` 呈現，改用相同的 status summary + monitor content 組合。
  - Todo 卡可高亮 current todo。
- `packages/app/src/pages/session/helpers.ts`
  - 將 `SessionStatusSummary` contract 收斂為 `currentStep` / `methodChips` / `processLines`。
  - 移除已不再供 sidebar 使用的舊 Smart Runner summary/debug/history helper 邏輯。
- `packages/app/src/pages/session.tsx`
  - 修正 `sync.data.message[id]` 直接索引導致的 `TS2538` 型別錯誤。

## Debug / Checkpoints

### Baseline

- sidebar 仍保留 Smart Runner 歷史/敘事/結果等多張卡片，資訊密度過高且不符合最新 UX 目標。
- card 展開狀態與順序未做全域持久化。
- tool-page status view 與桌面側欄資訊結構已開始漂移。
- app typecheck 因 session page message index 與 status helper 測試遷移中斷而失敗。

### Instrumentation Plan

- 先讀 architecture 與既有 web sidebar events，確認這次是否只屬 UI aggregation/persistence，不動 backend contract。
- 以 `layout.tsx` 作為全域 persisted UI state SSOT。
- 以 targeted app typecheck / helper tests 當作收斂驗證，不做無關 full-repo 掃描。

### Execution

- 將狀態卡片收斂到單一 `工作監控` 主卡，保留 objective / method chips / process lines / queue controls / monitor rows。
- 將排序與展開狀態寫入 global layout persisted store。
- 對齊 tool-page 與 desktop sidebar 的 monitor rendering contract。
- 清除 helpers.ts 殘留的 Smart Runner sidebar summary dead code。
- 修正 session page 的訊息索引型別問題。
- 調整 DOM-only helper tests 為條件執行，避免在無 DOM test runtime 下誤失敗。

### Root Cause

- 主要問題不是 backend/state 不一致，而是前端 sidebar 經多輪 autonomous observability 疊加後，資訊架構未再收斂，造成 card 邊界與 summary contract 過度複雜。
- 同時，status summary helper 已局部重構，但舊 Smart Runner-oriented helper 邏輯仍殘留，讓測試與型別面維持不穩定。

## Validation

- `bun --filter @opencode-ai/app typecheck` ✅
- `bun test "/home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts" "/home/pkcs12/projects/opencode/packages/app/src/pages/session/monitor-helper.test.ts"` ✅
  - 結果：11 pass / 2 skip / 0 fail
  - skip 原因：`focusTerminalById` 測試需要 DOM，當前 bun 測試 runtime 無 document。

## Follow-up adjustments (same day)

- 移除 `review.toggle` 的 `Ctrl/Cmd+Shift+R` 綁定，避免異動檢視被快捷鍵強綁。
- 工作監控卡內取消全域 `Current objective / No current step` 區塊，避免把 runner/main agent 目標混成單一摘要。
- monitor 子卡改為以 badge + title + headline 呈現：
  - session / sub-session 顯示 `[S]` / `[SS]` + session title
  - agent / sub-agent 顯示 `[A]` / `[SA]` + agent 名稱
  - tool 顯示 `[T]` + tool 名稱
- headline 優先顯示該卡自己的 `todo.content`，否則才落到最新 narration 或 active tool，讓 runner/agent「正在忙什麼」出現在自己的卡內，而不是被全域 `No current step` 取代。

### Follow-up validation

- `bun --filter @opencode-ai/app typecheck` ✅
- `bun test "/home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts" "/home/pkcs12/projects/opencode/packages/app/src/pages/session/monitor-helper.test.ts"` ✅
  - 結果：11 pass / 2 skip / 0 fail

## Runner card integration

- 將 Runner 視為工作監控中的一個獨立工作單位，以**前端合成卡**方式固定呈現為 `[R]`。
- 資料流整合來源：
  - `session workflow`（workflow state / stop reason / supervisor）
  - `autonomous health`（summary / queue / anomalies）
  - `current todo/current step`
  - `session runtime status`
- `[R]` 卡永遠存在：
  - 若 Runner 已有 current step，標題顯示 current step
  - 否則退到 queue reason / health summary / runtime status
  - 若完全未啟動，明確顯示 `idle`
- monitor 列表中的其他卡片仍代表 session / agent / subagent / tool 等工作單位；Runner 不再依賴 monitor API 原生提供 `level: runner`，而是由前端將 orchestration 狀態聚合成一張穩定卡片。
- `[R]` 卡進一步升級為**執行動態卡**，不再只顯示粗粒度 workflow/runtime 狀態：
  - 會聚合 current task / current step
  - 會列出 active tools
  - 會列出 delegated subagents
  - 會從 tool input metadata 推斷 MCP / server 痕跡（如 `mcpName` / `serverName`）
  - 因此 `[R]` 現在用來表達真正的 Runner activity，而不是單純 `STATUS` 摘要
- Todo list 不再把低資訊價值的 `implement` 顯示為獨立泡泡；改為只顯示有意義的狀態後綴，並以 `·` 內嵌在同一行尾端（如 waiting / needs approval）。

### Runner validation

- `bun --filter @opencode-ai/app typecheck` ✅
- `bun test "/home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts" "/home/pkcs12/projects/opencode/packages/app/src/pages/session/monitor-helper.test.ts"` ✅
  - 結果：12 pass / 2 skip / 0 fail

## Controlled web restart flow

- 新增受控 Web restart control flow，而不是常駐 auto-refresh：
  - Web settings 新增 `Restart Web` 按鈕
  - 按下後呼叫 `POST /api/v2/global/web/restart`
  - backend 透過 runtime control script 觸發 `webctl.sh restart --graceful`
  - frontend 進入等待狀態並輪詢 `/api/v2/global/health`
  - server 恢復健康後自動 `window.location.reload()`
- restart control script 路徑改納入 runtime config contract：
  - `templates/system/opencode.cfg` 新增 `OPENCODE_WEBCTL_PATH="/etc/opencode/webctl.sh"`
  - `install.sh` 會安裝 repo `webctl.sh` 到 `/etc/opencode/webctl.sh`
  - backend route 預設優先使用 `OPENCODE_WEBCTL_PATH`（若有 env override 則可覆蓋）
- 設計目標：不是所有情況都自動 refresh，而是**只有使用者明確觸發 restart 時**，頁面才進入受控等待與 reload。
- 補充語義澄清（same-day follow-up）：`webctl.sh restart` 會**刻意延續原本活躍的 runtime mode**。
  - 若目前是 dev 啟動，就回到 dev restart / dev-refresh 語義。
  - 若未來是 production 啟動，就會回到 production restart 語義。
  - 因此 restart 成功的判準是「回到原 mode 並恢復健康」，不是強制切到某個固定 mode。

### Host validation follow-up

- `5.1` 驗證完成：`/etc/opencode/webctl.sh` 已存在。
- `5.2` 驗證完成：`/etc/opencode/opencode.cfg` 已補齊 `OPENCODE_WEBCTL_PATH="/etc/opencode/webctl.sh"`。
- `5.3` 本 session 未做完自動化驗證：
  - 已確認 `POST /api/v2/global/web/restart` 可接受 request 並回傳 controlled restart accepted payload。
  - 使用者後續明確說明 restart mode 延續語義，並表示 Web restart 已手動處理，不需繼續測試。
  - 因此本輪將 `5.3` 視為 **manual operator handling / automation waived in-session**，不再以錯誤的 mode 假設續測。

### Validation addendum

- Host check: `/etc/opencode/webctl.sh` exists ✅
- Host check: `/etc/opencode/opencode.cfg` contains `OPENCODE_WEBCTL_PATH="/etc/opencode/webctl.sh"` ✅
- Controlled restart API smoke check: `POST /api/v2/global/web/restart` returned accepted payload ✅
- End-to-end restart automation in this session: waived by user after manual handling
- Architecture Sync: Updated
- Rationale: 補記 controlled restart 的 mode-preservation contract，避免未來把 dev-refresh 誤判為 bug。

## Todo completion integrity fix

- RCA：Todo checkbox 未勾選的根因不是 UI，而是 `todowrite` 目前採**全量覆蓋**語義；當 agent 在同一 session 中斷後重建一份新 plan 時，會直接覆寫掉舊 todo list，導致先前已完成/進行中的項目被新的 `pending` 快照洗掉。
- 修正：`Todo.update()` 新增 progress-preserving merge policy。
  - 若新舊 todo list 沒有重疊，維持 replace semantics。
  - 若新舊 list 有重疊（以 `id` 或 normalized `content` 判定），保留既有進度：
    - `completed` 不會被洗回 `pending`
    - `cancelled` 不會被洗回 `pending`
    - `in_progress` 不會因新 plan skeleton 而退回 `pending`
- 目標：避免再次發生「事情其實做完了，但因為新 plan 覆蓋，checkbox 顯示未完成」的情況。

### Todo integrity validation

- `bun test "/home/pkcs12/projects/opencode/packages/opencode/src/session/todo.test.ts"` ✅
- `bun run typecheck` (cwd=`packages/opencode`) ✅

## Todo SSOT follow-up RCA

- 使用者回報 sidebar todo 仍會浮動，且 web restart 後只是重新顯示舊內容。
- RCA：
  - sidebar session todo API 原本只是回傳持久化 store (`Todo.get(sessionID)`)，不是 planner-aware projection
  - 因此 web restart / sidebar refresh 只會重新 fetch 舊 session todo，**不會自動重新對齊 planner tasks**
  - 當前 session (`ses_319c7349fffe2WUgHGiesxW78S`) 也被臨時 implementation checklist 汙染成 visible todo，因此畫面會顯示不屬於 planner tasks 的殘留項目
- 修正：
  - `Todo.update()` 正式分成 `status_update` / `plan_materialization` / `replan_adoption`
  - `status_update` 只能更新進度，不能改變 todo 結構
  - `plan_materialization` 會以 planner seed 重投影 todo 結構，保留 matching progress，但清掉不在 seed 內的 stale 項目
  - `/api/v2/session/:sessionID/todo` 在 session 具備 active mission 時，會用 `tasks.md` seed + 現有 progress overlay 做必要才執行的 reconcile，不走每次 render 現算
  - 當前污染 session 已人工清理，將殘留 checklist 項目全部標記為 `completed`
- 結果：
  - sidebar 現已可明確顯示該 session 的 todo 完成狀態
  - 後續仍應繼續把「非 planner checklist 不得進 visible todo」做更完整的長期治理

### Todo SSOT validation addendum

- `bun test "/home/pkcs12/projects/opencode/packages/opencode/src/session/todo.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/test/session/planner-reactivation.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts"` ✅
- `bun run typecheck` (cwd=`packages/opencode`) ✅
- web restarted after backend todo reconcile changes ✅
- current session todo store manually normalized to completed state ✅

## Architecture Sync

- Architecture Sync: Updated
- `docs/ARCHITECTURE.md` 已同步以下現況：
  - controlled Web restart contract（`POST /api/v2/global/web/restart` + `OPENCODE_WEBCTL_PATH` + health-recovery reload）
  - `plan/build` 新語義（discussion-first vs execution-first，不再只是 readonly vs writable）
  - todo 作為 spec/runtime projection、sidebar 作為 observability surface 的定位
  - autorunner compatibility baseline 與目前缺少 runner-level contract (`runner.txt` / equivalent) 的缺口

## Runner contract draft follow-up

- 新增 artifact：`specs/20260315_openspec-like-planner/runner-contract.md`
- 目的：先把 autorunner 升級為 explicit session governor 所缺的 runner-level contract 補成正式設計稿，再進入後續 `/plan` / `@planner` 收斂與 runtime 綁定。
- 本次定義的核心結論：
  - planner 擁有 planning truth（spec / decision / handoff）
  - runner 擁有 build-mode continuity（mission + todo + workflow gates）
  - runner 可做 bounded narration，但不是 freeform 第二助理
  - Smart Runner 仍是 advisory layer，不是 runner base contract 本身

### Runner draft checkpoints

#### Baseline

- `workflow-runner.ts` 已能根據 approved mission、todo readiness、approval/question gates、queue/resume state 進行 deterministic continuation。
- `smart-runner-governor.ts` 已有 bounded advisory / assist / adoption paths，但其定位仍偏 governor-side suggestion，而不是 base runner identity。
- 缺口不在「能不能續跑」，而在「誰正式擁有 build-mode continuity、何時可說話、何時必須退回 planner」。

#### Design decision

- `runner-contract.md` 將 runner 定位為 **build-mode execution governor**。
- runner authority 只涵蓋 execution continuity，不擁有 planning truth。
- runner 只可依 `session.mission` → mission artifacts → todo/runtime state 續跑，不可憑 chat memory 自行擴張 scope。
- 若 scope/materialized plan 已髒、handoff 失效、或需要真正 replan，runner 必須停並要求 planner re-entry。

#### Validation

- Validation type: doc/design sync only
- Compared against:
  - `specs/20260315_openspec-like-planner/plan-build-target-model.md`
  - `specs/20260315_openspec-like-planner/autorunner-compat-analysis.md`
  - `packages/opencode/src/session/workflow-runner.ts`
  - `packages/opencode/src/session/smart-runner-governor.ts`
- Result: runner contract draft is consistent with current runtime baseline and cleanly separates deterministic runner from advisory Smart Runner.
- Architecture Sync: Verified (No doc changes)
- Rationale: 本輪新增的是 runner design artifact，尚未把新的 runner contract 綁進 runtime prompt/phase ownership，因此 `docs/ARCHITECTURE.md` 目前不需再次改寫。

## `/plan` / `@planner` first-slice convergence

- 目標：不要再讓 `/plan` 與 `@planner` 分別落在「缺少 builtin command」與「planner-ish agent mention / subtask routing」兩條不一致路徑。

### Baseline

- `/plan` 先前不是穩定內建入口；只有使用者或專案自定義 command 時才會成立。
- `@planner` 在 prompt part pipeline 中屬於 agent mention，容易落到 subagent/task-style routing，而不是 canonical plan-mode transition。
- 真正權威的 planner phase transition 仍是 `plan_enter` / `plan_exit`。

### Design decision

- 新增 builtin `plan` command，讓 `/plan` 永遠存在且走 canonical planner entry path。
- app 端補上 `/plan` slash command，讓 command palette / slash surface 直接可見。
- `@planner` 在 request-part stage 正規化成 canonical `plan` agent 名稱。
- backend `user-message-parts` 對 `plan` / `planner` mention 改為注入 canonical planner-entry instruction：
  - 不再把它當成 planner-like subagent task
  - 改為要求走 `plan_enter` 或延續既有 plan mode

### Changed files

- `packages/opencode/src/command/index.ts`
- `packages/app/src/pages/session/use-session-commands.tsx`
- `packages/app/src/components/prompt-input/build-request-parts.ts`
- `packages/opencode/src/session/user-message-parts.ts`
- `packages/app/src/components/prompt-input/build-request-parts.test.ts`
- `packages/app/src/components/prompt-input/submit.test.ts`
- `packages/opencode/src/session/command-prompt-prep.test.ts`

### Validation

- `bun test "/home/pkcs12/projects/opencode/packages/app/src/components/prompt-input/build-request-parts.test.ts" "/home/pkcs12/projects/opencode/packages/app/src/components/prompt-input/submit.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/test/session/planner-reactivation.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/command-prompt-prep.test.ts"` ✅
- `bun run typecheck` (cwd=`packages/opencode`) ✅
- `bun --filter @opencode-ai/app typecheck` ✅

### Architecture Sync

- Architecture Sync: Verified (No doc changes)
- Rationale: 本輪是 planner entry/control-surface convergence 的第一階段，尚未新增新的 runtime boundary、mission schema、或 phase-state ownership。現有 `docs/ARCHITECTURE.md` 對 `plan_enter` / `plan_exit` 為權威 phase bridge 的描述仍成立。

## Planner package layout refactor

### Baseline

- planner runtime 之前將 plan root 固定落在 `specs/<change-slug>/`。
- change slug 由 `session.time.created + session.slug(adjective-noun)` 組成，對人與 AI 都不易閱讀。
- 多數 runtime/test/docs 都直接硬編碼 `specs/...`，使 planner 結構難以治理與重構。

### Design decision

- planner root 結構改為直接使用：`specs/<date>_<plan-title>/`
- 不再額外包一層 `changes/`
- planner root 名稱規則改為：
  - date prefix = `YYYYMMDD`
  - title segment = 優先使用 session title slug；若 title 仍是預設樣式，才回退到 session slug
- companion artifacts 保持不變：
  - `implementation-spec.md`
  - `proposal.md`
  - `spec.md`
  - `design.md`
  - `tasks.md`
  - `handoff.md`

### Changed files

- `packages/opencode/src/session/planner-layout.ts`
- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/test/session/planner-reactivation.test.ts`
- `packages/opencode/src/session/workflow-runner.test.ts`
- `packages/opencode/src/session/mission-consumption.test.ts`
- `packages/opencode/src/session/index.test.ts`
- `docs/specs/planner_spec_methodology.md`
- `docs/ARCHITECTURE.md`

### Validation

- `bun test "/home/pkcs12/projects/opencode/packages/opencode/test/session/planner-reactivation.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/mission-consumption.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/index.test.ts"` ✅
- `bun run typecheck` (cwd=`packages/opencode`) ✅
- `bun --filter @opencode-ai/app typecheck` ✅

### Architecture Sync

- Architecture Sync: Updated
- `docs/ARCHITECTURE.md` 現已同步 planner durable root 由 `specs/<change-slug>/` 改為 `specs/<date>_<plan-title>/`。

## Planner root reuse + tasks→todo lineage hardening

### Baseline

- 即使 planner root 改成 `specs/<date>_<plan-title>/`，若 session title 在第一次真實 user message 後被更新，planner 仍可能因 title-derived root 改變而再次新建 package。
- `tasks.md` → runtime todo 的關係原本主要靠 `materializePlanTodos()` 的隱式實作約定：
  - 只吃 unchecked checklist
  - 最多 8 項
  - 第一項 `in_progress/high`
  - 其餘 `pending/medium`
  - 線性 dependsOn
- mission consumption 又使用另一套 checklist parsing，造成 contract 不夠清楚。

### Design decision

- planner re-entry 現在優先重用既有 package，而不是只根據當前 title 重新計算 root：
  1. 先看 `session.mission.artifactPaths.root`
  2. 再看 title-derived root 是否已存在
  3. 再看 immutable slug-derived root 是否已存在
  4. 都沒有才新建
- `tasks.md` checklist parsing 抽成 shared parser：`packages/opencode/src/session/tasks-checklist.ts`
- contract 明確化：
  - planner handoff/materialization 只吃 unchecked checklist
  - mission consumption 可讀 checked + unchecked，用於 execution trace
  - handoff metadata 額外暴露 `todoMaterializationPolicy`

### Changed files

- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/session/tasks-checklist.ts`
- `packages/opencode/src/session/tasks-checklist.test.ts`
- `packages/opencode/test/session/planner-reactivation.test.ts`
- `packages/opencode/src/session/mission-consumption.ts`
- `packages/opencode/src/session/mission-consumption.test.ts`
- `docs/ARCHITECTURE.md`
- `docs/specs/planner_spec_methodology.md`

### Validation

- `bun test "/home/pkcs12/projects/opencode/packages/opencode/src/session/tasks-checklist.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/test/session/planner-reactivation.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/mission-consumption.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/index.test.ts"` ✅
- `bun run typecheck` (cwd=`packages/opencode`) ✅

### Architecture Sync

- Architecture Sync: Updated
- `docs/ARCHITECTURE.md` 已補充：
  - planner re-entry root reuse precedence
  - shared checklist parser contract
  - `todoMaterializationPolicy` 為顯式 handoff metadata

## Runner contract phase-1 runtime binding

### Baseline

- `runner-contract.md` 已定義 runner 權責，但 runtime 尚未有真實 `runner.txt` asset。
- autonomous build continuation 主要仍靠 `workflow-runner.ts` 內的 hardcoded continuation text。
- Smart Runner 是 advisory layer，不適合拿來當 base runner contract。

### Design decision

- 新增 `packages/opencode/src/session/prompt/runner.txt`
- phase-1 綁定策略採最小風險：
  - 不改 deterministic stop gates
  - 不改 Smart Runner adoption authority
  - 只把 base runner contract prepend 到 autonomous build-mode continuation text

### Changed files

- `packages/opencode/src/session/prompt/runner.txt`
- `packages/opencode/src/session/workflow-runner.ts`
- `packages/opencode/src/session/workflow-runner.test.ts`
- `specs/20260315_openspec-like-planner/runner-contract.md`
- `specs/20260315_openspec-like-planner/autorunner-compat-analysis.md`
- `docs/ARCHITECTURE.md`

### Validation

- `bun test "/home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/test/session/planner-reactivation.test.ts"` ✅
- `bun run typecheck` (cwd=`packages/opencode`) ✅

### Architecture Sync

- Architecture Sync: Updated
- `docs/ARCHITECTURE.md` 已補充 runner phase-1 binding 現況：
  - `runner.txt` 已存在
  - current binding point = `workflow-runner.ts`
  - deterministic gates / Smart Runner advisory boundary 仍維持原有分層

## Planner/runtime deeper convergence + runner stop boundary hardening

### Baseline

- mission approval 先前只有 artifact path，沒有完整性快照，因此 approved plan 在被改動後仍可能被 build/autonomous path 繼續消費。
- Smart Runner 的 host-adopted replan 先前偏向「調整 todo 後直接繼續」，而不是 fail-fast hand back 到 planner。

### Design decision

- `plan_exit` 現在同時持久化三份核心 artifact 的 integrity snapshot：
  - `implementation-spec.md`
  - `tasks.md`
  - `handoff.md`
- mission consumption 若發現 approved artifact 與 snapshot 不一致，回報 `spec_dirty`。
- autonomous workflow 對 `spec_dirty` 採 first-class stop reason。
- Smart Runner host-adopted replan 現在升級為 `replan_required` handback，而不是直接繼續 autonomous execution。

### Changed files

- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/session/mission-consumption.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/workflow-runner.ts`
- `packages/opencode/src/session/mission-consumption.test.ts`
- `packages/opencode/src/session/workflow-runner.test.ts`
- `packages/opencode/src/session/smart-runner-governor.test.ts`
- `specs/20260315_openspec-like-planner/runner-contract.md`
- `docs/ARCHITECTURE.md`

### Validation

- `bun test "/home/pkcs12/projects/opencode/packages/opencode/src/session/mission-consumption.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/smart-runner-governor.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/test/session/planner-reactivation.test.ts"` ✅
- `bun run typecheck` (cwd=`packages/opencode`) ✅

### Architecture Sync

- Architecture Sync: Updated
- `docs/ARCHITECTURE.md` 已補充：
  - `spec_dirty` boundary
  - `replan_required` boundary
  - approved mission artifact integrity snapshot contract

## Todo / plan naming alignment correction

- 使用者明確要求：往後回報與執行都必須**明確對齊 todolist 與 plan 文件**，不能口頭用另一套 phase 名稱造成追蹤困難。
- 因此已同步修正：
  - `specs/20260315_openspec-like-planner/tasks.md`
  - `specs/20260315_openspec-like-planner/handoff.md`
- 對齊規則：
  - runner 相關工作一律以 `tasks.md` section 4 與 `runner-contract.md` 的同名 phase 條目回報
  - 不再使用脫離任務檔的模糊「phase2 / phase3 已做一些」說法

## Planner hardcoded workflow update: todo alignment rule

- 使用者新增硬規則：若要求依 plan/todolist 做決策，則 planner/runtime/sidebar 顯示的 todo 必須與實際要求使用者做決策時引用的任務名稱一致。
- 已同步更新到以下硬編碼工作流程來源：
  - `docs/specs/planner_spec_methodology.md`
  - `packages/opencode/src/session/prompt/plan.txt`
  - `specs/20260315_openspec-like-planner/implementation-spec.md`
  - `specs/20260315_openspec-like-planner/handoff.md`
- 新規則摘要：
  - `tasks.md` 是 planner naming source
  - runtime todo materialize 後，sidebar/runtime todo 是 visible execution ledger
  - 回報、排序、決策請求必須對齊同一套 planner-derived todo 名稱
  - 不可再用 assistant 自己的 private checklist 取代 visible todo

## Planner todo model clarification

- 使用者進一步指出：真正要修正的不只是「命名對齊」，而是 `todowrite` 不應該變成一個隨對話即時漂移的 assistant scratchpad。
- 因此已將 todo 規則補成更完整的模型說明，寫入：
  - `docs/specs/planner_spec_methodology.md`
  - `docs/ARCHITECTURE.md`
- 新增重點：
  - todo = plan/tasks 的 runtime projection
  - 對話本身不是 todo 真相來源
  - assistant 臨時工作筆記不能覆蓋 visible todo
  - 只有 planner 改動 / explicit replan / status transition 才應改變 visible todo
