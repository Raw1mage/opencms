# Workspace Naming / Ownership Matrix

Date: 2026-03-08
Status: Proposed baseline
Owner: `new-workspace` rewrite stream

## 1. 目的

本文件用來回答一個實際問題：

> beta/cms 現在提到的 `workspace`，到底是在指哪一層東西？

若不先拆清楚，後續 Phase 1 workspace kernel 會把目前混雜的命名直接固化進新架構。

---

## 2. 結論先講

目前 beta repo 至少有四種不同但彼此混用的語義：

1. **Project Root**
   - canonical repo/root boundary
   - 來源：`Project.Info.worktree`

2. **Sandbox / Child Directory**
   - project 底下的 child worktree / sandbox
   - 來源：`Project.Info.sandboxes[]`

3. **UI Workspace**
   - sidebar 中顯示的 root/sandbox 節點
   - 以 directory 為 key，主要提供列表、展開、rename、reset、delete、新 session 等 UX

4. **Persistence Scope**
   - terminal/prompt/comments/file-view/global-sync 等局部狀態持久化範圍
   - 有些用 `directory`，有些用 `directory + sessionId`，有些則有 workspace fallback sentinel

這四種語義尚未收斂為同一個正式的 workspace domain。

---

## 3. Matrix

| 名稱/概念                                       | 目前實際 key                                                              | 主要檔案                                                                        | 現在代表什麼                                      | Ownership 類型                | 問題/備註                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `Project.Info.worktree`                         | absolute directory                                                        | `packages/opencode/src/project/project.ts`                                      | project root / repo root                          | runtime boundary              | 是目前最接近 canonical root 的概念，但不是完整 workspace           |
| `Project.Info.sandboxes[]`                      | absolute directory[]                                                      | `packages/opencode/src/project/project.ts`                                      | child worktree / sandbox list                     | runtime/project metadata      | 只是 root 之下的子目錄清單，沒有 lifecycle aggregate               |
| `sandbox` return from `Project.fromDirectory()` | absolute directory                                                        | `packages/opencode/src/project/project.ts`                                      | 當前 directory 所屬 sandbox/worktree              | runtime locator               | 名稱容易與未來 workspace 混淆                                      |
| `Instance.directory`                            | absolute directory                                                        | `packages/opencode/src/project/instance.ts`                                     | 當前執行目錄                                      | runtime execution context     | 是目前最直接的 execution cwd                                       |
| `Instance.worktree`                             | absolute directory                                                        | `packages/opencode/src/project/instance.ts`                                     | project boundary for permission/VCS               | runtime boundary              | 目前是安全/權限邊界，不是 workspace aggregate                      |
| layout `workspaceKey(directory)`                | normalized directory string                                               | `packages/app/src/pages/layout/helpers.ts`                                      | 去尾斜線後的 UI key                               | UI helper key                 | 只做 normalization，不能視為正式 identity                          |
| layout `workspaceOrder[root]`                   | root directory → directory[]                                              | `packages/app/src/pages/layout.tsx`                                             | root project 下 workspace 排序                    | UI-only state                 | 顯示順序，不表達 ownership                                         |
| layout `workspaceExpanded[directory]`           | directory                                                                 | `packages/app/src/pages/layout.tsx`                                             | sidebar item 展開狀態                             | UI-only state                 | 預設 root=true；child 依互動變化                                   |
| layout `workspaceName` / `workspaceBranchName`  | normalized directory / projectId+branch                                   | `packages/app/src/pages/layout.tsx`                                             | workspace 顯示名稱覆寫                            | UI-only metadata              | rename 目前只影響 UI 標籤                                          |
| sidebar workspace item                          | directory                                                                 | `packages/app/src/pages/layout/sidebar-workspace.tsx`                           | root/sandbox 的統一 UI 節點                       | UI composition                | 把 root 與 sandbox 都視為 workspace，但 runtime 尚未對等           |
| `globalSync.child(directory)`                   | directory                                                                 | `packages/app/src/context/global-sync/child-store.ts`                           | directory-scoped reactive data store              | persistence + sync scope      | 已接近 workspace store，但名稱仍是 child/directory                 |
| child-store persisted `vcs/project/icon`        | `Persist.workspace(directory, ...)`                                       | `packages/app/src/context/global-sync/child-store.ts`                           | directory 層級的本地快取                          | workspace-like persistence    | 已是 workspace-scoped persisted state，但無正式 workspace registry |
| terminal cache/session                          | directory + `__workspace__` sentinel                                      | `packages/app/src/context/terminal.tsx`                                         | whole-directory terminal tabs                     | workspace-scoped persistence  | 明確採 directory workspace scope，切 session 不切 terminal         |
| prompt session                                  | `dir + sessionId`, fallback `dir + __workspace__`                         | `packages/app/src/context/prompt.tsx`                                           | prompt draft + file context                       | mixed: session-first          | 比 terminal 更偏 session，但保留 workspace fallback                |
| comments session                                | `dir + sessionId`, fallback `dir + __workspace__`                         | `packages/app/src/context/comments.tsx`                                         | line comments / focus / active comment            | mixed: session-first          | 也是 session-first with workspace fallback                         |
| file view cache                                 | `dir + sessionId`, fallback `dir + __workspace__`                         | `packages/app/src/context/file/view-cache.ts`                                   | scroll / selection per file view                  | mixed: session-first          | 不是全域 workspace view，也不是純 session-independent              |
| layout tabs/view persistence                    | sessionKey decided by caller; may use `Persist.workspace` when no session | `packages/app/src/context/layout.tsx`                                           | tabs / review / prompt / terminal/file-view prune | mixed abstraction             | 顯示目前系統其實已有 session/workspace dual-scope 規則             |
| current visible sessions under workspace mode   | normalized directory match                                                | `packages/app/src/pages/layout/helpers.ts`, `packages/app/src/pages/layout.tsx` | directory group of root sessions                  | UI grouping rule              | 用 directory 當 workspace group identity                           |
| worktree reset/delete actions                   | root + directory                                                          | `packages/app/src/pages/layout.tsx`                                             | sandbox lifecycle action                          | UI-triggered runtime mutation | 還不是正式 workspace lifecycle contract                            |

---

## 4. 詳細觀察

### 4.1 Runtime 層：真正存在的是 project/worktree/sandbox，不是 workspace aggregate

關鍵檔案：

- `packages/opencode/src/project/project.ts`
- `packages/opencode/src/project/instance.ts`

目前 runtime 的 canonical 語義是：

- `project.worktree` = project root
- `sandbox` = 目前 directory 所屬的 child worktree / current resolved directory
- `Instance.directory` = 真正執行 cwd
- `Instance.worktree` = 權限/VCS 邊界

也就是說：

> runtime 現在有 **directory** 與 **worktree boundary**，但還沒有正式的 **workspace entity**。

### 4.2 App 層：workspace 主要是 UI packaging

關鍵檔案：

- `packages/app/src/pages/layout.tsx`
- `packages/app/src/pages/layout/sidebar-workspace.tsx`

在 app 裡：

- root project 與 sandboxes 被一起渲染成 workspace list
- 有 workspace rename / expand / reset / delete / new session 等互動
- `workspaceKey()` 只是正規化 path，避免 `/tmp/x///` 這種 key 漂移

這代表：

> 現在的 workspace 更像「sidebar 節點模型」，不是 execution model。

### 4.3 Persistence 層：其實已經有多種 workspace-scope，但不一致

#### A. Terminal

關鍵檔案：

- `packages/app/src/context/terminal.tsx`

現況：

- terminal 明確以 `directory` 為 workspace scope
- 註解直接寫明：切換同一 directory 下不同 session 時 terminal tabs 應保留

結論：

- terminal 是目前最明確的 **workspace-scoped attachment**

#### B. Prompt / Comments / File View

關鍵檔案：

- `packages/app/src/context/prompt.tsx`
- `packages/app/src/context/comments.tsx`
- `packages/app/src/context/file/view-cache.ts`

現況：

- 這幾者都是 `dir + sessionId`
- 若沒有 sessionId，則退回 `__workspace__` sentinel

結論：

- 這些不是純 workspace-scoped，也不是純 session-scoped
- 它們其實是 **session-first with workspace fallback**

這是未來 kernel 設計最需要保留的真實需求之一。

#### C. Global Sync Child Store

關鍵檔案：

- `packages/app/src/context/global-sync/child-store.ts`

現況：

- `globalSync.child(directory)` 會建立以 directory 為 key 的 store
- 並持久化 `vcs/project/icon` 到 `Persist.workspace(directory, ...)`

結論：

- 這其實已經是「準 workspace store」
- 只是語義名稱仍停留在 child/directory，而非正式 workspace registry

---

## 5. Ownership 分類

### 5.1 UI-owned only

以下狀態目前只屬於 UI：

- `workspaceExpanded`
- `workspaceOrder`
- `workspaceName`
- `workspaceBranchName`
- workspace enable/disable toggle in sidebar

這些不應該直接升格成 runtime truth。

### 5.2 Directory-owned persistence

以下目前屬於 directory/workspace-like scope：

- terminal tabs
- global sync child caches (`vcs/project/icon`)
- session grouping in sidebar workspace mode

這些最適合作為未來 workspace aggregate 的第一批 consumer。

### 5.3 Session-owned with workspace fallback

以下屬於混合型 attachment：

- prompt draft
- prompt context items
- line comments
- file view scroll/selection

這說明未來 workspace model 不能只有「全部 directory-scoped」一種規則，必須支援：

- workspace-owned attachment
- session-owned attachment
- session-with-workspace-default attachment

### 5.4 Runtime/project-owned

以下是目前 runtime 真正穩定的 boundary：

- `Project.Info.worktree`
- `Project.Info.sandboxes[]`
- `Instance.directory`
- `Instance.worktree`

未來 workspace kernel 必須建立在這些既有真相之上，而不是取代它們的語義。

---

## 6. 目前最大的命名衝突

### 衝突 A：`workspace` 同時代表 UI 節點與 persistence scope

- sidebar 裡的 workspace 是一個視覺節點
- terminal 裡的 workspace 是 directory-scoped state container

這兩者相關，但不是同一層。

### 衝突 B：`worktree` 與 `workspace` 邊界模糊

- runtime/Project 主要用 `worktree`
- app/sidebar 主要對使用者說 `workspace`

結果會讓人誤以為 worktree = workspace entity，但目前其實不是。

### 衝突 C：`directory` 事實上是 identity，但名義上不是

- 幾乎所有 scope 最後都回到 absolute directory
- 但系統沒有正式說「directory 只是 locator，workspace 才是 aggregate」

這正是 rewrite 要修掉的核心。

---

## 7. 對 Phase 1 kernel 的直接影響

Phase 1 不應該直接重命名全部現有欄位；應先引入一層新的語義：

### 建議最小語義

- `WorkspaceLocator`
  - `directory`
  - `projectId`
  - `kind`

- `WorkspaceIdentity`
  - `workspaceId`
  - `directory`
  - `projectId`

- `WorkspaceAttachmentOwnership`
  - `workspace`
  - `session`
  - `session_with_workspace_default`

這樣才能把現在三種 scope 行為收斂進同一個框架。

---

## 8. 建議命名策略

### 現況保留名詞

- `worktree`：保留給 project/runtime boundary
- `sandbox`：保留給 root 下 child worktree/directory 類型

### 新增正式名詞

- `workspace`：保留給新 execution-scope aggregate
- `workspace locator`：目前由 directory 提供
- `workspace attachment`：session/pty/preview/draft/fileview/comments 等掛件

### 過渡期規則

在實作完成前，文件與註解可暫時這樣表達：

- `UI workspace item`
- `directory-scoped workspace persistence`
- `project worktree boundary`

避免再把不同層的東西都直接叫 workspace。

---

## 9. 建議下一步

基於這份 matrix，下一步最合理的是：

1. 先寫 **Phase 1 kernel file plan**
   - 列出 `types.ts / registry.ts / resolver.ts / attachments.ts` 的最小 API

2. 選第一個 consumer
   - **推薦順序**：
     1. `globalSync.child(directory)` → workspace registry adapter
     2. `terminal.tsx` → 第一個真正 workspace-owned attachment
     3. `prompt/comments/file-view` → 再處理 mixed ownership

3. 暫時不要先動 sidebar rename/reset/delete UX
   - 因為那些是 UI-owned，不是最底層 SSOT

---

## 10. 一句話結論

目前 beta 的 `workspace` 不是單一概念，而是 **UI 節點 + directory persistence scope + session fallback scope + project/worktree boundary 的混合語言**；Phase 1 rewrite 必須先把這些 ownership 拆開，才能建立真正的 workspace kernel。
