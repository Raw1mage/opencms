# Workspace Rewrite Spec

Date: 2026-03-08
Status: Proposed
Owner: `new-workspace` rewrite stream

## 1. 目標

在最新 `cms` 基底上，重新建立一個 **workspace 抽象層**，讓 workspace 不再只是 sidebar 裡的 worktree/sandbox 顯示單位，而是能統一承接：

- session 歸屬
- PTY / runtime process 歸屬
- preview / port / worker 歸屬
- file context / tab / prompt draft 歸屬
- reset / archive / cleanup lifecycle

核心目標是解決目前「workspace 多重輸入 / 多重輸出沒有單一歸屬模型」的問題。

---

## 2. 問題定義

目前 beta/cms 已有兩種接近 workspace 的概念，但都不完整：

1. **Project / worktree 概念**
   - `project.worktree` 是主要目錄邊界。
   - app 側可以列出 sandboxes / child directories，並以 workspace 名義呈現。

2. **Session / terminal / UI state 概念**
   - 某些狀態已經用 directory 當 key 做 workspace-scoped persistence。
   - 但這仍是「以路徑湊合出來的作用域」，不是正式 domain model。

結果是：

- directory 是事實上的 key，但不是完整的 workspace identity
- session、PTY、preview、cleanup 等資源各自用不同方式掛靠
- UI 有 workspace 視覺概念，runtime 卻沒有對等的 workspace contract
- 一旦要引入更複雜的輸入/輸出流（多 session、多 worker、多 preview、多 cleanup policy），就容易漂移

因此本專題不是「補一條 workspace route」，而是先補 **workspace domain contract**。

---

## 3. 設計原則

1. **Rewrite, not salvage**
   - 舊 `new-workspace` 分支只提供需求/反例/概念，不直接搬 code。

2. **Latest cms only**
   - 一切設計必須貼合目前 cms 的 gateway + per-user daemon + XDG runtime ownership 架構。

3. **Workspace is an execution scope**
   - workspace 不是單純 UI label，也不是單純 git worktree。
   - 它是 runtime inputs/outputs 的歸屬容器。

4. **Directory remains important but is not enough**
   - directory 可作為 locator，但不能再單獨扮演完整 identity / lifecycle / policy contract。

5. **Local-first before remote/control-plane**
   - 先完成本地/單使用者 workspace abstraction。
   - remote workspace server、DB schema、control-plane SSE 放到後續 phase，而不是第一刀。

6. **SSOT before feature breadth**
   - 先定義單一 workspace state 與事件模型，再接 UI/API。

---

## 4. 名詞與角色

### 4.1 Project

- 代表 repository / local root 的產品或程式碼集合。
- 現有 `project.worktree`、VCS、project metadata 仍保留。

### 4.2 Workspace

- 代表某個 project 之下的一個 **execution scope**。
- 可以是：
  - root workspace（主 worktree）
  - child workspace（sandbox / derived worktree / branch workspace）

### 4.3 Workspace Identity

workspace 至少應有以下欄位：

- `workspaceId`：穩定識別子（未來可脫離純 directory）
- `projectId`
- `directory`
- `kind`: `root | sandbox | derived`
- `origin`: `local | generated | imported`
- `lifecycleState`: `active | archived | resetting | deleting | failed`

### 4.4 Workspace Attachment

掛在 workspace 底下的資源：

- sessions
- PTY tabs / runtime processes
- preview endpoints / ports
- file tabs / drafts / comments
- background workers
- cleanup / archive artifacts

這些 attachment 應共享同一個 workspace 歸屬模型，而不是各自用 directory 猜。

---

## 5. 問題拆解：Workspace 的多重輸入 / 輸出

### 5.1 Inputs

workspace 需要接住的輸入至少包括：

- user prompt / slash command
- selected files / file context
- git/worktree state
- PTY command stream
- provider/account/model execution choice
- worker-triggered events
- preview target selection

### 5.2 Outputs

workspace 需要產出的結果至少包括：

- session messages / artifacts
- file edits / diff / review state
- PTY logs / command status
- preview URL / port status
- workspace health / dirty status
- reset/archive/delete 結果
- cross-surface sync events（TUI / Web / Desktop）

### 5.3 核心缺口

現況最大的缺口不是「沒有 workspace UI」，而是：

> **缺少一個可同時描述 inputs、outputs、lifecycle、attachments 的正式 workspace domain。**

---

## 6. Domain Model（提案）

## 6.1 WorkspaceAggregate

workspace 應該由一個中心 aggregate 表示：

```ts
type WorkspaceAggregate = {
  workspaceId: string
  projectId: string
  directory: string
  kind: "root" | "sandbox" | "derived"
  origin: "local" | "generated" | "imported"
  lifecycleState: "active" | "archived" | "resetting" | "deleting" | "failed"
  displayName?: string
  branch?: string
  attachments: WorkspaceAttachmentSummary
  capabilities: WorkspaceCapabilityFlags
}
```

## 6.2 WorkspaceAttachmentSummary

```ts
type WorkspaceAttachmentSummary = {
  sessionIds: string[]
  activeSessionId?: string
  ptyIds: string[]
  previewIds: string[]
  workerIds: string[]
  draftKeys: string[]
  fileTabKeys: string[]
}
```

## 6.3 WorkspaceLifecyclePolicy

```ts
type WorkspaceLifecyclePolicy = {
  reset: "archive_then_reset" | "hard_reset" | "blocked"
  delete: "archive_then_delete" | "blocked"
  previewCleanup: "on_close" | "on_idle" | "manual"
  workerCleanup: "on_session_end" | "manual"
}
```

## 6.4 Workspace Event Model

至少需要統一以下事件：

- `workspace.created`
- `workspace.updated`
- `workspace.lifecycle.changed`
- `workspace.attachment.added`
- `workspace.attachment.removed`
- `workspace.preview.updated`
- `workspace.cleanup.completed`

Web/TUI/Desktop 之後應該優先消費這組事件，而不是各自從 session/PTY 側猜 workspace 狀態。

---

## 7. 與現有 cms/beta 架構的關係

### 7.1 可沿用部分

- `project.worktree` 仍可作為 root workspace locator
- app 既有 sidebar-workspace UI 可保留作為第一個 consumer
- `globalSync.child(directory)` 的 directory-scoped store 可視為過渡期 adapter
- terminal / prompt / comments / file contexts 中已存在的 workspace-scoped persistence 可逐步收編

### 7.2 不可直接沿用部分

- 不能把 directory 直接當最終 workspace identity
- 不能直接照搬 upstream control-plane/workspace server
- 不能先把 `workspace_id` 灌進所有 storage schema，再回頭想語義
- 不能讓每個 subsystem 自己定義 workspace lifecycle

### 7.3 架構結論

workspace rewrite 的第一步應是：

> **建立 workspace domain kernel + adapter boundary**

而不是先開 route / 先改 DB / 先重做 UI。

---

## 8. 分階段實作計畫

### Phase 0 — Spec Freeze / Naming Audit

目的：凍結術語、盤點所有現有 `workspace`/`worktree`/`sandbox` 用法。

Deliverables:

- 本 spec
- naming matrix（哪些地方是 UI workspace、哪些是 runtime workspace、哪些只是 directory alias）

### Phase 1 — Workspace Domain Kernel

目的：在 `packages/opencode` 建立不依賴 UI 的 workspace domain 模組。

最小內容：

- `WorkspaceAggregate` type / schema
- workspace resolver / registry interface
- root workspace + child workspace 的 identity constructor
- directory → workspace lookup adapter

限制：

- 本 phase 不碰 remote control-plane
- 可先用 file-backed / in-memory registry，避免先做大 schema

### Phase 2 — Attachment Unification

目的：把 session / PTY / preview / draft / file tabs 收編到同一個 workspace attachment model。

最小內容：

- session lookup 改成能回答「此 workspace 擁有哪些 session」
- PTY/preview 擁有明確 workspace owner
- prompt draft / terminal tab persistence 不再各自私有命名規則

### Phase 3 — Workspace Sync / API Boundary

目的：讓 workspace 成為明確的 sync 與 API domain。

最小內容：

- workspace list/read/status routes
- workspace event payloads
- app `globalSync` 加入 workspace-aware bootstrap/refresh path

### Phase 4 — Lifecycle / Cleanup / Reset

目的：把 reset/delete/archive/cleanup 從 UI action 升級成 workspace lifecycle contract。

最小內容：

- reset policy
- archive artifacts
- busy/locked workspace guards
- cleanup completion events

### Phase 5 — Optional Remote / Multi-Host Expansion

只有前四階段穩定後，才討論：

- remote workspace server
- request-scoped WorkspaceContext
- `workspace_id` persistence contract
- multi-host / DB-backed control-plane

這些不是第一波 rewrite 的前置條件。

---

## 9. 檔案/模組建議落點

建議新核心落點：

- `packages/opencode/src/project/workspace/`
  - `types.ts`
  - `registry.ts`
  - `resolver.ts`
  - `lifecycle.ts`
  - `attachments.ts`

第一波 consumer 候選：

- `packages/app/src/pages/layout/sidebar-workspace.tsx`
- `packages/app/src/context/terminal.tsx`
- `packages/app/src/context/prompt.tsx`
- `packages/app/src/context/file.tsx`
- `packages/app/src/context/comments.tsx`

注意：

- 先透過 adapter 接入，不要讓 app 直接吃半成品 runtime internals。

---

## 10. 非目標（本輪明確排除）

- 不直接複製 upstream workspace server / control-plane SSE
- 不先做 DB schema-first 的 `workspace_id` 普及化
- 不在本輪解完整 multi-user hosted workspace 方案
- 不把目前所有 directory-key persistence 一次性重寫
- 不追求第一版就涵蓋所有 remote workspace 能力

---

## 11. 驗收標準（Spec-level）

本 spec 成立的條件：

1. 明確區分 project / directory / workspace / attachment 四種角色。
2. 明確說清楚為何此任務是 rewrite，不是 merge salvage。
3. 提供能落地的 phase plan，而不是抽象口號。
4. 後續實作者可以依此先做 kernel，再做 attachment，再做 API/lifecycle。

後續進入 implementation 時，Done criteria 應至少包含：

1. root workspace 與 child workspace 有穩定 identity。
2. session / PTY / preview 至少三種 attachment 已有單一 owner model。
3. reset/delete 不再只是 UI 行為，而是 workspace lifecycle 行為。
4. Web/TUI 不再各自猜 workspace truth。

---

## 12. 風險與緩解

1. **風險：術語衝突**
   - `workspace` 在 app/console/upstream 已有不同語義。
   - 緩解：先做 naming audit，必要時把現有 UI-only 概念標成 `worktree workspace` / `directory workspace`。

2. **風險：過早資料庫化**
   - 太早導入 schema 會把錯的語義固化。
   - 緩解：先 kernel + adapter，schema 放到後段。

3. **風險：UI 先行導致再度雙軌**
   - 如果先改 sidebar，workspace 會再次淪為視覺名詞。
   - 緩解：先做 runtime domain，再讓 UI 成為 consumer。

4. **風險：direct merge 誘惑重現**
   - 舊 branch / upstream code 看起來能省時間，但會把錯誤前提一起帶進來。
   - 緩解：任何舊 code 只允許作為需求對照，不作為直接移植來源。

---

## 13. 建議下一步

下一個實際任務不應該是直接 coding feature，而是：

1. 做一份 **workspace naming / ownership matrix**
   - 列出目前所有 directory/workspace/worktree/sandbox key 的實際用途。

2. 產出 **Phase 1 kernel file plan**
   - 決定 `packages/opencode/src/project/workspace/` 的具體 API surface。

3. 選一個最小 consumer
   - 建議從 `sidebar-workspace` 或 `terminal workspace persistence` 二選一。

---

## 14. 一句話決策

`new-workspace` 的正確路線是：

> **在最新 cms 上先建立 workspace domain kernel，讓 workspace 成為 inputs/outputs/lifecycle 的正式 execution scope；舊分支與 upstream 只作參考，不作直接移植來源。**
