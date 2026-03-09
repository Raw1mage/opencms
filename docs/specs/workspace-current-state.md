# Workspace Current State

Date: 2026-03-09
Status: Active

## 1. One-line Summary

`workspace` 已不再只是 UI label 或 directory 推論，而是 `cms` 中一個正式的 **runtime-owned execution scope**。

目前 `cms` 已完成：

- workspace kernel / identity / registry / service / lifecycle
- runtime workspace API
- workspace aggregate bus events
- session / PTY / worker attachment tracking
- app global-sync 對 runtime workspace aggregate 的消費
- reset / delete runtime-owned operations

---

## 2. What Is Finished

### Runtime / Domain

- `packages/opencode/src/project/workspace/*` 已形成 Phase 1 kernel
- workspace identity 已在 app/runtime 間共享
- runtime 能解析 `directory -> workspace aggregate`
- runtime 能管理 lifecycle state：
  - `active`
  - `resetting`
  - `deleting`
  - `archived`
  - `failed`

### Attachments

已接入：

- session
- PTY
- worker

### Runtime API

已存在：

- `GET /workspace`
- `GET /workspace/current`
- `GET /workspace/status`
- `GET /workspace/:workspaceID`
- lifecycle transition endpoints
- runtime operations:
  - `POST /workspace/:workspaceID/reset-run`
  - `POST /workspace/:workspaceID/delete-run`

### Events

runtime 會發出：

- `workspace.created`
- `workspace.updated`
- `workspace.lifecycle.changed`
- `workspace.attachment.added`
- `workspace.attachment.removed`

### App Consumption

app 已完成：

- bootstrap 從 runtime workspace API 取得 aggregate
- child store 保留 runtime workspace lifecycle state
- reducer 吃 live `workspace.*` events
- layout busy gating 已開始消費 runtime lifecycle state

### Runtime-Owned Operations

reset / delete 已從 layout orchestration 收回 runtime：

- archive active sessions
- dispose instance state
- run worktree mutation
- finalize lifecycle state

app 現在只保留 UI/local side effects，例如：

- toast
- navigation
- local terminal cleanup

---

## 3. What Is Deferred

### Preview Runtime Domain

`previewIds` 目前仍是 reserved field。

原因不是忘記做，而是 **故意延後**：

- repo 目前沒有真實 preview runtime SSOT
- 沒有 preview registry
- 沒有 preview events
- 沒有 preview API boundary

因此現在如果硬做 preview attachment，只會變成猜測式設計。

---

## 4. Current Source of Truth

### Runtime Truth

以下應視為 workspace 真相來源：

- `packages/opencode/src/project/workspace/*`
- `packages/opencode/src/server/routes/workspace.ts`
- runtime bus events (`workspace.*`)

### App Role

app 不再是 workspace 真相來源，而是：

- runtime aggregate 的 consumer
- UI-local state 的 owner
- workspace runtime operation 的 caller

---

## 5. Why This Matters

舊模型裡，workspace 容易變成：

- directory 推論
- sidebar item
- session fallback 邏輯
- layout 內的散裝 orchestration

新模型裡，workspace 變成：

- 可解析的 runtime domain
- 有 lifecycle / attachments / events
- 可被 app / runtime 一致消費
- 可承載未來 preview / timeline / policy / metadata 擴充

---

## 6. What To Build Next

### P1

1. Preview runtime domain（前提是先定義真實 preview SSOT）
2. workspace integration / E2E tests
3. app consumer audit，確認剩餘哪些 state 應留在 UI，哪些該進 runtime

### P2

4. workspace observability / debug tooling
5. 更完整的 operation contract / metadata flows
6. install / runtime bootstrap productization 持續完善

---

## 7. Operator Guidance

若現在要繼續沿著 workspace 系統開發：

1. 先把 `workspace-current-state.md` + `workspace-phase-completion-checklist.md` 當作入口
2. 只要不是 preview domain，就應以既有 workspace kernel/API/event 為基底擴充
3. 若要碰 preview，必須先定義 preview runtime/process/event model，不要直接從 `previewIds` 開始硬接

---

## 8. Milestone Judgment

目前可以把這個狀態視為：

> **Workspace 核心主線已合併完成，系統已正式進入新 workspace 時代。**

之後的工作不再是「把 workspace 做出來」，而是：

- 補完 preview
- 強化測試與可觀測性
- 持續產品化
