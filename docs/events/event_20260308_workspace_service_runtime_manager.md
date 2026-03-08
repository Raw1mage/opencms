# Event: Workspace service runtime manager

Date: 2026-03-08
Status: Done

## 需求

- 在 runtime 側建立正式的 workspace service / manager。
- 讓後續模組透過單一 façade 存取 workspace resolve / registry，而不是自行拼裝 resolver + registry。
- 為後續 attachment 與 lifecycle 收編提供穩定入口。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/project/workspace/`
- `/home/pkcs12/projects/opencode-beta/packages/opencode/test/project/`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`

### OUT

- 不做 lifecycle/reset/delete policy
- 不接 server route / app 直接讀取 runtime service

## 任務清單

- [x] 定義 workspace service 最小 API
- [x] 實作 service 與預設 registry 持有方式
- [x] 導出 service 並補 focused tests
- [x] 更新 event / architecture sync / validation

## Debug Checkpoints

### Baseline

- 目前已有 `resolver.ts`、`registry.ts`、`resolveWorkspaceWithRegistry()`，但缺少正式 runtime façade。
- 後續若直接讓 consumer 各自碰 registry，會重新出現 integration 細節外洩問題。

### Execution

- 已新增 `packages/opencode/src/project/workspace/service.ts`，作為 runtime workspace façade。
- 第一版 `WorkspaceService` 提供：
  - `resolve({ directory })`
  - `register(workspace)`
  - `getByDirectory(directory)`
  - `getById(workspaceId)`
  - `listByProject(projectId)`
- 第二版延伸 attachment integration：
  - `attachSession(...)` / `detachSession(...)`
  - `attachPty(...)` / `detachPty(...)`
  - `initEventSubscriptions()`
- 第三步開始建立 API boundary：
  - runtime 新增 `WorkspaceService.listProjectWorkspaces(...)`
  - runtime 新增 `WorkspaceService.getProjectStatus(...)`
  - server 新增 `/workspace` / `/workspace/current` / `/workspace/status` / `/workspace/:workspaceID`
- 預設 service 內部持有 in-memory registry，並透過 `resolveWorkspaceWithRegistry()` 對外提供 normalized lookup + auto-upsert。
- 補上 `resolveWorkspaceViaService()`，讓後續 consumer 可先依賴 service seam，而不是直接碰 resolver/registry。
- `InstanceBootstrap()` 已開始初始化 workspace service event subscriptions，讓 session/pty 事件能把 attachment ownership 寫回 workspace registry。
- 新增 focused tests 驗證：
  - resolve 後 registry 可回讀
  - manual register / listByProject 正常
  - helper 可使用注入的 service
  - session attachment registration 正常
  - pty attachment registration 正常
  - project workspace listing 正常
  - project workspace status summary 正常

### Validation

- `bun test packages/opencode/test/project/workspace-resolver.test.ts packages/opencode/test/project/workspace-attachments.test.ts packages/opencode/test/project/workspace-service.test.ts` ✅
- `bun run --cwd packages/opencode typecheck` ✅
- Architecture Sync: Updated
  - 已同步 architecture file map，補入 `src/project/workspace/service.ts` 作為 runtime façade，並註記其開始承接 session/pty attachment registration。
  - 已同步 server route map，補入 `src/server/routes/workspace.ts` 作為第一版 workspace API boundary。
