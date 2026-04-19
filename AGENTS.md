# OpenCode 專案開發指引

本檔案僅定義 opencode 專案特有的規範。通用規則由 Global `AGENTS.md` 提供。

---

## 第零條：新功能必須先有 Plan

除了 hotfix（緊急修復），**所有新功能實作必須先寫 plan**。

- **Plan 位置**：`plans/<feature-name>/plan.md`
- **Plan 內容**：目標、架構圖/資料流、涉及的檔案清單、關鍵設計決策、CRUD 或 API 端點規格
- **流程**：先寫 plan → 取得使用者確認 → 再動手實作
- **Hotfix 例外**：生產環境阻斷性 bug、安全漏洞等可先修再補 plan
- **違規判定**：如果一個 commit 新增了超過 3 個檔案且沒有對應 plan，視為違規

---

## 第一條：禁止靜默 Fallback

寫程式時**嚴禁靜默 fallback**。當查找、解析、載入失敗時，必須明確報錯（log.warn / throw），不可悄悄退回備用路徑讓呼叫方以為成功。

- **禁止**：查不到 loader → 靜默走 default path → 新功能變 dead code 而不自知
- **禁止**：fetch 失敗 → 靜默回傳空值 → 上游以為功能不存在
- **正確做法**：查不到 → log.warn 明確記錄「為什麼查不到、用了什麼替代」→ 讓開發者能從 log 立即發現問題
- **唯一例外**：graceful degradation 是設計需求時（如 WebSocket → HTTP fallback），必須在 log 中記錄 fallback 原因

---

## 第二條：執行 Plan 前必備份 XDG Config

**每次 plan 開跑前（或 beta-workflow admission 通過後、第一個程式碼編輯/測試指令前），必須完整備份 XDG config 目錄**。

- **備份範圍**：`~/.config/opencode/` 整個目錄（至少 `accounts.json`、`opencode.json`、`managed-apps.json`、`gauth.json`、`mcp.json`），以及 `~/.local/state/opencode/`、`~/.local/share/opencode/` 若該 plan 會觸及 state/data 層。
- **備份位置**：`~/.config/opencode.bak-<YYYYMMDD-HHMM>-<plan-slug>/`（timestamp + plan slug，方便事後追溯是哪個 plan 留下的快照）。
- **還原政策**：**備份 ≠ 還原目標**。使用者在 AI 工作期間也會主動更新 XDG（新增帳號、改 config 等），AI **絕不可**自行用舊備份覆蓋現行 XDG。
  - plan 結束（無論 success / abort）後，**列出備份目錄位置**給使用者，並明確說「這是 plan 起跑前的快照，僅供需要時手動還原」。
  - **只有在使用者明確要求「還原」時才執行 restore**；否則留著備份直到使用者說可以刪。
  - 除非使用者指示，不得主動 `cp` / `rsync` / `mv` 備份回 `~/.config/opencode/`。
- **Why**：beta 與 main 在同一 uid 下共用 `~/.config/opencode/`；任何 test / migration / Account.normalizeIdentities 路徑都可能透過 `Global.Path.user` 直寫真實檔案。2026-04-18 codex-rotation-hotfix 的測試跑過 `family-normalization.test.ts`，把 14 個 family 壓成 1 個，永久失去 5 個 codex 帳號 token（log 不記 refreshToken，rsync NAS 自 3/3 壞掉）。
- **唯一例外**：純 read-only inspection（`git log` / `grep` / `cat`）不動任何 state，可略過；但只要進入 plan 實作階段就**不可跳過**。
- **違規判定**：沒有 `opencode.bak-*` 快照存在的狀態下跑 `bun test` / `bun run ...` / 重啟 daemon，視為違規。

---

## 第三條：自主 Continuation 契約

當 Main Agent 工作在 plan-builder 管理的 spec 且 `.state.json.state === "implementing"` 時，runloop 靠「todolist 殘留」自主持續推進。AI 必須在每個 turn 結束**之前**判斷是否該補 pending todo 觸發下一輪；否則 runloop 會因 todolist 清空而停下。

### 觸發條件（**必須同時成立**才 append pending todo）

1. 當前 spec `.state.json.state === "implementing"`
2. `specs/<slug>/tasks.md` 仍有 `- [ ]` / `- [~]` 未完成項
3. TodoWrite 沒有 `in_progress` 項，或剛把當前 `in_progress` 標為 `completed`
4. 沒有使用者決定 / 批准 / 外部 blocker 擋住下一步（`- [!]` / `- [?]` 都沒卡）

### 停止條件（**任一成立**即結束 turn，**不要** append）

- `tasks.md` 全 `- [x]`（清單耗盡，準備 promote 到 `verified`）
- 有 `- [!] blocked` 或 `- [?] decision/approval` 未解除
- 使用者插話 / interrupt — 交由使用者主導下一步
- 偵測到 scope drift 需走 `extend` / `refactor` mode — 停下請求模式切換
- 非 plan-builder 管理的任務 — 只做使用者當輪明確要求的工作，不自動續跑

### 實踐方式（per-task ritual 同時發生）

每關閉一個 todo：

1. 標記當前 TodoWrite item = `completed`、tasks.md 對應 `- [x]`
2. 執行 `plan-sync.ts` 寫入 sync 歷史
3. **評估觸發條件**：
   - 四項全成立 → **同一個 `todowrite` 呼叫**內 append 下一項為 `pending`，並把其中一項設為新的 `in_progress`
   - 任一不成立 → 結束 turn，runloop 偵測 todolist 無 pending/in_progress → 自然停下

### 與 runloop 的關係

- runloop（`workflow-runner.ts planAutonomousNextAction`）只認 TodoWrite 殘留，不懂 spec 狀態，也不讀 tasks.md。
- 所以這條紀律**完全靠 AI 自律執行**：append 了 pending → runloop continue；沒 append → runloop stop。
- **不存在 runtime 閘在你判斷錯誤時救你**——runloop 刻意做成無知的純 todolist 引擎。

### Why

- runloop 的無知是刻意設計：continuation 判準必須能從 AI 可讀的介面表達（tasks.md + TodoWrite），不該藏在 runtime state machine 裡。
- AI 每輪能穩定讀到的文件只有 `SYSTEM.md` + `AGENTS.md` + runtime preloaded skills（見下方 Mandatory Skills 區塊）；這條紀律住在 AGENTS.md 是因為 runtime 每輪硬注入，不受 skill idle-decay 影響。
- 2026-04-19 `mandatory-skills-preload` spec 把這條契約從 `agent-workflow` skill 搬來——skill 層 30min idle 就會 unload，無法承載關鍵紀律。

---

## Mandatory Skills（runtime-preloaded）

本 repo 由 `packages/opencode/src/session/mandatory-skills.ts` 在 Main Agent 每輪 session prompt 組裝時自動 preload + pin 下列 skills，繞過 AI 自律呼叫 `skill()` 工具的環節：

<!-- opencode:mandatory-skills -->
- plan-builder
<!-- /opencode:mandatory-skills -->

### 規則

- 上面 sentinel 區塊內的 skill 名稱會每輪進入 system prompt 並標 `pinned=true`，不受 `SkillLayerRegistry.applyIdleDecay` 影響（不會被 10min summarize / 30min unload 掉）。
- 修改列表後下一輪（AGENTS.md mtime 變化 → `InstructionPrompt.systemCache` 失效）自動生效。
- 若某 skill 的 `SKILL.md` 在本機找不到，runtime 會 `log.warn` + 發 `skill.mandatory_missing` anomaly event，**session 不中斷**；AI 仍可用 `skill()` 工具手動載入作為 fallback（符合第一條 loud-warn 原則）。
- 使用者可在本檔 sentinel 區塊增減項目；**不要**手動修改 runtime code 或 skill-layer-registry 的 pin 行為。

### Coding subagent 的獨立清單

coding subagent 不讀 AGENTS.md（runtime 故意排除）。它的 mandatory 清單位於 `packages/opencode/src/agent/prompt/coding.txt` 內的同款 sentinel 區塊，runtime 使用同一 parser 處理。

---

## Autonomous Agent 核心紀律（原 agent-workflow 併入）

2026-04-20 把原本住在 `agent-workflow` skill 的 autonomous 通用紀律搬進 AGENTS.md，確保每輪 runtime 硬注入、不受 skill idle-decay 影響。

### 八項核心原則

1. **Autonomy 依賴計畫，不依賴靈感。**
2. **計畫不必完美，但必須可執行** — 至少要有 goal / 可執行 todo / `dependsOn` / stop gates。
3. **todo 是 mode-aware runtime contract** — plan mode = working ledger（自由寫）；build mode = execution ledger（嚴格對齊 `plan-builder` tasks.md）。細節見 `plan-builder` §16.2。
4. **一律對話中可觀測** — 重要進展、阻塞、replan 必須讓使用者能理解。
5. **可持續執行 ≠ 可靜默亂跑** — 遇到 approval / decision / blocker 必停。
6. **Debug 必須 system-first** — 複雜 bug 先看系統邊界、資料流、觀測訊號；詳細 checkpoint schema 見 `code-thinker` §3 Syslog-style Debug Contract。
7. **Single-thread by default** — 主代理預設直接執行，不因「能委派就一定要委派」而無謂切換 subagent。委派觸發條件由各 subagent driver 自身 description 宣告，本檔不重列。最常用的委派只有 `explore` 與 `coding`。
8. **Narration ≠ Pause；Completion = Silent** — 執行中必須 narrate 進度；所有 todo 收斂後 silent stop 才是正確信號，不需 wrap-up 總結。

### Narration 紀律（執行中可觀測）

autonomous run 必須在對話中明確敘述以下五類訊號：

- **Kickoff**：現在開始哪個步驟
- **Subagent milestone**：委派什麼 / 完成什麼 / 卡在哪
- **Pause / Block**：為什麼停 / 需要誰提供什麼
- **Complete**：哪個計畫段落完成
- **Replanning**：使用者插話導致重排的說明

> narration 是 side-channel visibility，**不是 pause boundary**。只有 stop gate 才真的暫停。

### Stop / Waiting 回報格式（結束 turn 前必出）

遇到以下情境必停：

- `needsApproval = true`
- `action.kind ∈ {push, destructive, architecture_change}` 且策略要求批准
- `waitingOn ∈ {approval, decision}`
- 真正 blocker（權限、外部依賴、不可恢復錯誤）

暫停時回報格式：

```
Paused: <原因>
Need:
  - <使用者批准 / 決策 / 外部資訊>
Next after reply:
  - <恢復後的第一步>
```

### Interrupt-safe Replanning（使用者插話時）

1. **承認中斷發生** — 明示舊 autonomous run 已暫停
2. **重評估既有 todo** — 保留 / 取消（明確標 `cancelled`）/ 延後 / 新增
3. **重新排序 `dependsOn`**，保留唯一 `in_progress`
4. **宣告下一步** — 讓使用者看到續跑路線

原則：不要把舊計畫整份丟掉除非已完全失效；優先保留仍然有效的已完成工作。

### 操作準則摘要（Ops digest）

- Search first, then read
- Read before write
- Absolute paths only
- 一次只有一個 `in_progress` todo
- 用結構化 todo metadata，不用模糊條列
- 執行中 narrate；最後一個 todo 完成後 silent stop
- Stop for approval / decision / blocker
- 使用者插話 → 明確 replan
- Finish only after validation + event log + architecture sync（若未動架構則註記 `Verified (No doc changes)`）

---

## 專案背景

本專案源自 `origin/dev` 分支，現已衍生為 `main` 分支作為主要產品線。

### main 分支主要特色

- **全域多帳號管理系統** - 支援多個 provider 帳號的統一管理
- **rotation3d 多模型輪替系統** - 動態模型切換與負載平衡
- **Admin Panel (`/admin`)** - 三合一管理界面
- **Provider 細分化** - `gemini-cli`、`google-api` 獨立 canonical providers

---

## 整合規範

### 從 origin/dev 引進更新

任何從 GitHub pull 的 `origin/dev` 新 commits，都必須經過分析後再到 `main` 中重構，**不可直接 merge**。

### 外部 Plugin 管理

引進的外部 plugin 都集中放在 `/refs` 目錄。若有更新，也必須逐一分析後再到 `main` 中重構，**不可直接 merge**。

### Pull Request 預設策略

- 本 repo 已作為獨立產品線維護，**預設不需要建立 PR**。
- 除非使用者明確要求，否則預設流程停在 local commit / branch push 即可。

---

## Enablement Registry（能力總表）

- Runtime 單一真相來源：`packages/opencode/src/session/prompt/enablement.json`
- Template 對應來源：`templates/prompts/enablement.json`
- 凡透過 `mcp-finder` 或 `skill-finder` 擴充能力後，必須同步更新兩處。

---

## 部署架構

預計安裝到使用者端的設定檔都集中在 `templates/` 目錄，以 XDG 架構部署。

### Web Runtime 單一啟動入口（Fail-Fast）

- **只允許**透過 `./webctl.sh dev-start`（或 `dev-refresh`）啟動。
- 禁止直接使用 `bun ... opencode ... web` / `opencode web` 手動啟動。
- 所有 server runtime 參數集中定義於 `/etc/opencode/opencode.cfg`。

---

## Prompt/Agent 維護邊界

當任務是「開發 opencode 本身」時：

- **Global**: `~/.config/opencode/AGENTS.md` — 通用規範主體
- **Project**: `<repo>/AGENTS.md` — 專案特有補充（本檔）
- **Template**: `<repo>/templates/AGENTS.md` — release 後供使用者初始化

### 維護原則

1. **Template 與 Runtime 需同步**：規範變更需同時更新 `templates/**` 與 runtime 對應檔案。
2. **避免僅改 Global**：`~/.config/opencode/*` 屬本機環境，不作為 repo 交付依據。
3. **變更留痕**：記錄於 `docs/events/`。
4. **Session 啟動必讀 Architecture**：`specs/architecture.md`。
5. **Beta/Test 分支用後即刪**：`beta/*`、`test/*` 分支與其 worktree 僅作一次性實作/驗證面。測試完成且 merge/fetch-back 回 `main` 後，必須立即刪除；禁止長留已完成任務的 beta/test 分支，避免 stale branch 在後續被誤認為主線或被 branch-pointer 操作拉回。
6. **停止時必須交代下一步**：若 agent 因使用者插話、approval gate、decision gate、blocker 或 round 結束而停下，回覆中必須明確說明停止原因，並附上可執行的後續建議或恢復後的第一步；禁止只停在狀態描述。

### Release 前檢查清單

- [ ] `templates/**` 與 `runtime` 已同步
- [ ] `templates/AGENTS.md` 與 `templates/prompts/SYSTEM.md` 一致
- [ ] `docs/events/` 已記錄
- [ ] `specs/architecture.md` 已同步

---

## 善用系統既有 Infrastructure（禁止重複造輪子）

### 所有 coding agent 開工前必讀 architecture.md

- 禁止在未讀架構文件的情況下撰寫跨模組的非同步協調邏輯。
- 若 `specs/architecture.md` 尚未記載某個模組，應先補文件，再動手實作。

### 禁止繞過 Bus messaging 自製非同步協調

- **禁止**：`setTimeout` / `setInterval` / polling loop 等待另一 component 狀態就緒
- **禁止**：隱式全域狀態傳遞跨模組訊號
- **禁止**：假設 async 操作順序——若有順序依賴，必須用 Bus event chain 明確表達
- **正確做法**：`Bus.publish()` / `Bus.subscribeGlobal()` / priority 控制 / `Instance.provide()`

### 已建立的 Infrastructure

| Infrastructure         | 位置                            | 用途                               |
| ---------------------- | ------------------------------- | ---------------------------------- |
| **Bus**                | `src/bus/`                      | 跨模組事件發佈/訂閱                |
| **rotation3d**         | `src/model/`                    | 多模型輪替、負載平衡、quota        |
| **SharedContext**      | `src/session/shared-context.ts` | Per-session 知識空間               |
| **SessionActiveChild** | `src/tool/task.ts`              | Subagent 生命週期狀態機            |
| **ProcessSupervisor**  | `src/process/supervisor.ts`     | Logical task process lifecycle     |
| **Instance**           | `src/project/instance.ts`       | Daemon per-request context         |
| **compaction**         | `src/session/compaction.ts`     | Context overflow + idle compaction |

### Race Condition 審查義務

- 涉及跨模組狀態讀寫時，**必須先審查 race window**。
- 已知 race 模式：Bus subscriber vs tool call 時機不同步、daemon 遺失 Instance context、fire-and-forget 下 status 判斷錯誤。
- 修復優先順序：**讀取方自清 > 改寫事件順序 > 引入新旗標**。

---
