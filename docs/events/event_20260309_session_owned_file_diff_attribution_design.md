# Event: Session-Owned File Diff Attribution Design

Date: 2026-03-09
Status: Done

## 需求

- 為 webapp 的 `檔案異動` / dirty bubble 定義比 app-side heuristic 更可靠的 runtime contract。
- 讓 session-owned file diff attribution 能依附既有 workspace abstraction layer，而不是在 UI 端重複推論。

## Current status

- 本文件原先是 runtime contract 設計 note。
- 截至本輪收尾，第一版 runtime-owned contract 已落地：`session.diff` 在 `messageID` 缺省時，會回傳 runtime 計算的 session-owned dirty diff。
- 但更完整的 end-state（例如正式持久化 mutation ledger、ownership transfer/conflict state）仍屬後續演進項目。

## 問題定義

目前 app 端能拿到兩種資料，但都不夠當 authoritative truth：

1. `client.file.status()` / current git dirty
   - 只知道 worktree 現況
   - 不知道 dirty 內容應歸屬哪個 session

2. `session.summary.diffs`
   - 只知道某個 turn / session 曾產生過哪些 diff snapshot
   - 可能受同 worktree 其他 session 的後續變更影響
   - 若直接在 app 端與 current dirty 做交集，很容易把其他 session 的異動誤算進來

因此目前 app 端的 touched-file / tool-input / diff-content heuristic 只能算 transitional workaround。

## 可重用的既有架構

### 1. Workspace aggregate

來源：`packages/opencode/src/project/workspace/types.ts`

- `workspaceId`
- `projectId`
- `directory`
- `kind`
- `lifecycleState`
- `attachments.sessionIds`
- `attachments.activeSessionId`

意義：runtime 已經有正式的 workspace affiliation model，可回答「哪些 session 屬於同一個 execution scope」。

### 2. Workspace service / registry / events

來源：`packages/opencode/src/project/workspace/service.ts`

已具備：
- `resolve()` / registry lookup
- `attachSession()` / `detachSession()`
- lifecycle transition
- `workspace.*` events publish

意義：runtime 已有 service seam，可以自然延伸 attribution API，而不是讓 app 直接湊資料。

### 3. App global-sync workspace consumption

來源：
- `packages/app/src/context/global-sync/bootstrap.ts`
- `packages/app/src/context/global-sync/event-reducer.ts`

已具備：
- `/workspace/current` bootstrap hydration
- `workspace.created/updated/lifecycle.changed/attachment.*` live updates

意義：app 已經有接 workspace truth 的管道；新增 runtime attribution 後，前端不需要再發明新的 ownership model。

## 建議的 authoritative contract

### Contract 名稱（建議）

可在 runtime 補其中一種：

1. `WorkspaceService.getSessionOwnedDirtyFiles({ workspaceID, sessionID })`
2. `Session.diffOwned({ sessionID })`
3. server route: `GET /session/:id/review-owned-diff`

本輪已採用的落點：
- runtime implementation 先以 `packages/opencode/src/project/workspace/owned-diff.ts` 落地
- API surface 暫時直接收斂到既有 `session.diff`
  - `messageID` 有值：message summary diff
  - `messageID` 缺省：runtime-owned session dirty diff

原因：
- caller 常常是 session UI
- 但 attribution truth 應依賴 workspace affiliation + runtime snapshots，而不是 session page 自己算

## Runtime attribution 演算法（建議）

### Inputs

- `sessionID`
- session 所屬 `workspaceId` / `directory`
- current dirty diff for the workspace directory
- 本 session 的 mutation ledger（需要新增/收斂）

### 必須新增的 runtime truth

需要正式持久化 / 暴露一份 **session mutation ledger**，至少記錄：

- `sessionID`
- `messageID` / turn id
- `file`
- mutation source（write/edit/apply_patch/filesystem_* 等）
- resulting snapshot hash 或 normalized `after` hash
- optional status (`added|modified|deleted`)
- timestamp / order

### Decision rule

某個 dirty file 只有在以下條件都成立時，才算屬於該 session：

1. 檔案曾被此 session mutation ledger 明確寫入過
2. 目前 dirty diff 仍與此 session 最後一次寫入後的 snapshot 對得上
3. 若同一檔案被後續其他 session 再寫入，則 ownership 應轉移或標記衝突，不應再算給舊 session

### Recommended output

```ts
{
  sessionID: string
  workspaceID: string
  files: Array<{
    file: string
    status: "added" | "modified" | "deleted"
    ownership: "owned" | "conflicted"
    sourceMessageID?: string
    sourceTool?: string
  }>
  count: number
}
```

## 為什麼不要長期放在 app 端算

1. **App 看不到完整 mutation truth**
   - UI 通常只能看到 message summary、tool parts、current dirty
   - 但 authoritative attribution 需要更穩定的 runtime ledger

2. **容易跨 session 汙染**
   - 同 worktree 並行 session 會互相覆寫 current dirty
   - app-side heuristic 很難正確處理後寫入者優先與 ownership transfer

3. **cache invalidation 複雜**
   - dirty bubble、review panel、sidebar list 都會各自持有 cache
   - 若沒有單一 runtime attribution source，容易出現數字不同步

## 建議 rollout

### Phase A

- 先保留現有 app workaround
- 但在 architecture 中明確標記它是 temporary compatibility layer

### Phase B

- runtime 寫入 mutation ledger
- 先提供 internal service API
- 目前狀態：已先以非持久化 runtime attribution helper 落地，作為 Phase B 過渡版本

### Phase C

- server route / SDK schema 暴露 session-owned diff attribution
- app 的 dirty bubble / review panel 改吃 runtime truth

### Phase D

- 刪除 app-side touched-file / tool-input heuristic
- event/reducer 只處理 runtime attribution payload

## 結論

- 目前最值得重用的既有設計是 **workspace aggregate + workspace attachment model + global-sync workspace API/event flow**。
- 本輪已先把 `檔案異動` / dirty bubble 收斂到 runtime-owned session diff contract，避免 app 端持續擴張 heuristic。
- 長期正解仍是補完整的 runtime-owned **session mutation ledger + attribution contract**，以支援 ownership transfer / conflict / persisted attribution。
