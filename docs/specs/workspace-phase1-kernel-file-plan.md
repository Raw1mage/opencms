# Workspace Phase 1 Kernel File Plan

Date: 2026-03-08
Status: Proposed
Owner: `new-workspace` rewrite stream

## 1. 目標

Phase 1 的任務不是把 workspace 功能做完，而是建立一個 **可被後續 phases 與 consumers 重用的最小 kernel**。

這個 kernel 必須回答三件事：

1. 什麼是 workspace
2. 如何從現有 project/directory/sandbox 真相解析出 workspace
3. attachment ownership 應如何被描述，而不是立刻全面實作

---

## 2. Phase 1 明確範圍

### In Scope

- workspace 基本型別與 schema
- workspace identity / locator / kind / origin / ownership enum
- directory → workspace resolution
- root workspace / sandbox workspace constructor
- in-memory 或 file-backed registry interface（先定義介面，可最小實作）
- attachment summary / ownership descriptor type

### Out of Scope

- reset / delete / archive lifecycle orchestration
- remote workspace / control-plane / WorkspaceContext
- DB schema / `workspace_id` persistence
- UI wiring
- full attachment migration

---

## 3. 建議檔案集

建議新增目錄：

```text
packages/opencode/src/project/workspace/
  index.ts
  types.ts
  registry.ts
  resolver.ts
  attachments.ts
```

> `lifecycle.ts` 暫不進 Phase 1。

理由：

- 第一刀先解 identity / resolution / attachment contract
- lifecycle 容易把 reset/delete/archive/busy policy 一起拉進來，會讓 Phase 1 失焦

---

## 4. 各檔案責任

### 4.1 `types.ts`

**責任**

- 定義 workspace domain 的基礎型別與 schema
- 作為整個 kernel 的語義中心

**應包含**

- `WorkspaceKind`
- `WorkspaceOrigin`
- `WorkspaceLifecycleState`（可先保留最小 enum）
- `WorkspaceAttachmentOwnership`
- `WorkspaceLocator`
- `WorkspaceIdentity`
- `WorkspaceAggregate`
- `WorkspaceAttachmentSummary`

**最小 API 草案**

```ts
export type WorkspaceKind = "root" | "sandbox" | "derived"
export type WorkspaceOrigin = "local" | "generated" | "imported"
export type WorkspaceLifecycleState = "active" | "archived" | "resetting" | "deleting" | "failed"

export type WorkspaceAttachmentOwnership = "workspace" | "session" | "session_with_workspace_default"

export type WorkspaceLocator = {
  directory: string
  projectId: string
  kind: WorkspaceKind
}

export type WorkspaceIdentity = WorkspaceLocator & {
  workspaceId: string
}

export type WorkspaceAttachmentSummary = {
  sessionIds: string[]
  activeSessionId?: string
  ptyIds: string[]
  previewIds: string[]
  workerIds: string[]
  draftKeys: string[]
  fileTabKeys: string[]
  commentKeys: string[]
}

export type WorkspaceAggregate = WorkspaceIdentity & {
  origin: WorkspaceOrigin
  lifecycleState: WorkspaceLifecycleState
  displayName?: string
  branch?: string
  attachments: WorkspaceAttachmentSummary
}
```

**備註**

- `WorkspaceCapabilityFlags` 可先不進第一版，避免型別過寬

---

### 4.2 `registry.ts`

**責任**

- 定義 workspace registry 的讀寫介面
- 提供第一版最小 in-memory implementation

**為何 Phase 1 就需要 registry**

- 因為後續 `globalSync.child(directory)` / terminal / API route 都需要同一個 lookup 入口
- 沒有 registry，resolver 很快就會在各 consumer 裡複製

**最小 API 草案**

```ts
export interface WorkspaceRegistry {
  getById(workspaceId: string): Promise<WorkspaceAggregate | undefined>
  getByDirectory(directory: string): Promise<WorkspaceAggregate | undefined>
  listByProject(projectId: string): Promise<WorkspaceAggregate[]>
  upsert(workspace: WorkspaceAggregate): Promise<WorkspaceAggregate>
}

export function createInMemoryWorkspaceRegistry(): WorkspaceRegistry
```

**Phase 1 實作建議**

- 先 memory-backed
- 若需要 persistence，再用單檔 storage adapter 包一層，但不要一開始綁 DB

---

### 4.3 `resolver.ts`

**責任**

- 把現有 `Project.fromDirectory()` / `Project.Info` / `directory` 解析成 workspace aggregate 或 locator
- 封裝 root vs sandbox 的推導邏輯

**它是 Phase 1 的核心**

因為現在最大的問題就是：

- 有 project/worktree/sandbox
- 但沒有正式 workspace parse/resolve API

**最小 API 草案**

```ts
export type ResolveWorkspaceInput = {
  directory: string
}

export async function resolveWorkspace(input: ResolveWorkspaceInput): Promise<WorkspaceAggregate>

export function buildRootWorkspace(args: {
  projectId: string
  directory: string
  displayName?: string
}): WorkspaceAggregate

export function buildSandboxWorkspace(args: {
  projectId: string
  directory: string
  displayName?: string
}): WorkspaceAggregate

export function createWorkspaceId(locator: WorkspaceLocator): string
```

**依賴來源**

- `Project.fromDirectory()`
- `Project.Info.worktree`
- `Project.Info.sandboxes[]`

**規則建議**

- 若 `directory === project.worktree` → `kind: "root"`
- 若 `directory` 出現在 `project.sandboxes[]` → `kind: "sandbox"`
- 否則先 fallback 為 `kind: "derived"` 或暫時 `sandbox`，但要明確記錄規則

---

### 4.4 `attachments.ts`

**責任**

- 只定義 attachment 類別、ownership 與 summary merge helpers
- 不在 Phase 1 直接去抓 terminal/prompt/comments 真實資料

**原因**

- 若一開始就接 consumer，Phase 1 會直接變成 migration phase
- 這個檔案應先提供 attachment contract，讓 Phase 2 再逐步收編

**最小 API 草案**

```ts
export type WorkspaceAttachmentType = "session" | "pty" | "preview" | "worker" | "draft" | "file_tab" | "comment"

export type WorkspaceAttachmentDescriptor = {
  type: WorkspaceAttachmentType
  ownership: WorkspaceAttachmentOwnership
  key: string
}

export function createEmptyWorkspaceAttachmentSummary(): WorkspaceAttachmentSummary

export function summarizeWorkspaceAttachments(descriptors: WorkspaceAttachmentDescriptor[]): WorkspaceAttachmentSummary
```

**價值**

- 讓 terminal 可以先接成 `ownership: "workspace"`
- 讓 prompt/comments/file-view 未來能接成 `session_with_workspace_default`
- comment attachments 因現況已存在 comments context，summary 第一版需保留 `commentKeys`

---

### 4.5 `index.ts`

**責任**

- 作為 workspace kernel 的公共出口
- 統一 export，避免 consumer 直接 import 深層檔案

**最小 API 草案**

```ts
export * from "./types"
export * from "./registry"
export * from "./resolver"
export * from "./attachments"
```

---

## 5. 與現有檔案的關係

### Phase 1 依賴但不修改的來源

- `packages/opencode/src/project/project.ts`
  - 提供 `Project.fromDirectory()` / `Project.Info`

- `packages/opencode/src/project/instance.ts`
  - 提供目前 runtime `directory/worktree` 真相

- `packages/opencode/src/project/state.ts`
  - 可作為未來 workspace-scoped state cache 的參考，但本 phase 先不耦合

- `packages/opencode/src/project/bootstrap.ts`
  - 本 phase 不接 bootstrap；避免先把 workspace kernel 強綁進 instance lifecycle

---

## 6. 第一次 implementation 的順序

建議真正寫碼時按這個順序：

1. `types.ts`
2. `attachments.ts`
3. `resolver.ts`
4. `registry.ts`
5. `index.ts`

原因：

- 先穩定語義
- 再寫 pure helpers
- 最後才補 stateful registry

---

## 7. 第一輪驗證門檻

Phase 1 實作完成時，至少要能驗證：

1. 給 root directory，可 resolve 成 `kind: root` 的 workspace aggregate
2. 給 sandbox directory，可 resolve 成 `kind: sandbox` 的 workspace aggregate
3. 同一 directory 每次 resolve 出來的 `workspaceId` 穩定一致
4. attachment descriptor 可正確表達三種 ownership：
   - `workspace`
   - `session`
   - `session_with_workspace_default`

---

## 8. 明確延後到下一階段的項目

以下不要偷渡進 Phase 1：

- workspace busy / locking
- reset/delete/archive rules
- preview cleanup policy
- terminal/prompt/comments/file-view 真正接線
- globalSync adapter implementation
- route / SSE / API exposure

這些都屬於 Phase 2+。

---

## 9. 下一步（implementation-ready）

這份 file plan 完成後，下一步就可以直接開工：

### 建議第一個實作 task

> 在 `packages/opencode/src/project/workspace/` 建立 Phase 1 kernel skeleton（`types.ts`, `attachments.ts`, `resolver.ts`, `registry.ts`, `index.ts`），並補最小單元測試。

### 建議第一個 consumer task

等 kernel 骨架穩定後：

> 讓 `globalSync.child(directory)` 或 terminal context 使用 resolver/registry，而不是自己把 directory 當隱含 workspace。

---

## 10. 一句話結論

Phase 1 kernel 最小可行集合是：

> **`types.ts` 定義語義、`resolver.ts` 建立 identity、`registry.ts` 提供查詢入口、`attachments.ts` 定義 ownership、`index.ts` 統一出口；其餘 lifecycle 與 consumer wiring 全部延後。**
