# OpenCode 專案開發指引

本檔案僅定義 opencode 專案特有的規範。通用規則由 Global `AGENTS.md` 提供。

---

## 第一條：禁止靜默 Fallback

寫程式時**嚴禁靜默 fallback**。當查找、解析、載入失敗時，必須明確報錯（log.warn / throw），不可悄悄退回備用路徑讓呼叫方以為成功。

- **禁止**：查不到 loader → 靜默走 default path → 新功能變 dead code 而不自知
- **禁止**：fetch 失敗 → 靜默回傳空值 → 上游以為功能不存在
- **正確做法**：查不到 → log.warn 明確記錄「為什麼查不到、用了什麼替代」→ 讓開發者能從 log 立即發現問題
- **唯一例外**：graceful degradation 是設計需求時（如 WebSocket → HTTP fallback），必須在 log 中記錄 fallback 原因

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

## SessionSnapshot Tags

When a turn produces a clear fact, conclusion, or decision, append one or more tag lines at the END of your response:

- `#fact <statement>` — a confirmed fact, observed problem, or symptom
- `#problem <statement>` — a problem or issue identified
- `#summary <statement>` — a conclusion or finding from discussion
- `#decision <statement>` — a decision made or direction confirmed
- `#rejected <statement>` — an option that was explicitly ruled out

Rules:
- Only emit tags when there is genuine new information (discovery, conclusion, decision)
- Do NOT emit tags for routine Q&A or work-in-progress turns
- One line per tag, at the end of the response
- Keep each tag line concise (one sentence)
