# Event: 20260316_port_killswitch

## 需求
將 `opencode-runner` 專案中的 `killswitch` 分支功能移植（Port）至 `opencode:cms` 分支。該功能提供了一套全域的中止開關（Kill Switch），允許管理者安全地暫停或終止自動代理系統。

## 範圍
### IN
- 移植 `kill-switch` 核心 API 與狀態管理服務。
- 移植 RBAC Middleware 與稽核（Audit）服務。
- 移植 Snapshot 服務與控制通道（Control Channel）存根。
- 移植 Worker 管理與展示 Handlers。
- 同步相關架構文檔與 Spec。

### OUT
- 直接 `git merge` 或 `cherry-pick`（因架構分歧，須採手動重構移植）。
- 前端 Web UI 的完整實作（本次優先完成後端與核心邏輯）。

## 任務清單
- [x] 1. 在 `opencode:cms` 中建立 `specs/20260316_kill-switch/` 並同步所有 Spec 檔案。
- [x] 2. 移植 `src/server/killswitch/service.ts` (狀態管理、MFA、稽核、Snapshot)。
- [x] 3. 實作 Hono API 路由與整合 RBAC。
- [x] 4. 在 agent 啟動與 scheduler path 加入 check（短路新任務）。
- [x] 5. 實作控制通道（Control Channel）與 Session 中止邏輯。
- [x] 6. 移植 `src/cli/cmd/killswitch.ts` (CLI 路由控制)。
- [ ] 7. 前端 Web UI (Admin Button/Modal)。
- [ ] 8. TUI 進階整合 (快捷鍵/面板)。
- [x] 9. 驗證移植後的代碼與測試 (13 tests passed)。
- [x] 10. 更新 `docs/ARCHITECTURE.md` 反映新模組。

## 對話重點摘要
- 使用者要求將 `opencode-runner` 的 `killswitch` branch merge 回 `opencode` 的 `cms` branch。
- 識別出 `cms` 分支嚴禁直接 merge，必須採用行為移植（Behavior Replication / `refactor-from-src`）。

## Debug Checkpoints
### Execution
- 核心邏輯移植完成於 `packages/opencode/src/server/killswitch/`。
- API 路由整合於 `packages/opencode/src/server/routes/killswitch.ts`。
- CLI 控制命令整合於 `packages/opencode/src/cli/cmd/killswitch.ts`。

## 關鍵決策
- 採手動移植而非 Merge，以保持 `cms` 的多帳號與 Rotation3D 架構一致性。
- 檔案路徑對齊 monorepo `packages/opencode` 結構。
- 預設使用 `local` transport 與 `local` snapshot backend，支援 env 擴充為 `redis`/`minio`。

## 驗證結果
- `bun test packages/opencode/src/server/killswitch/service.test.ts packages/opencode/src/server/routes/killswitch.test.ts` 通過 (13 pass)。
- `KillSwitchService.assertSchedulingAllowed` 已整合進 `packages/opencode/src/server/routes/session.ts`，確認生效。
- 透過 `opencode killswitch status` 驗證 CLI 與 Server 通訊正常。

**Architecture Sync: Verified**
- 已更新 `docs/ARCHITECTURE.md`，新增 `KillSwitch` 控制平面說明與檔案索引。
- 模組與資料流符合現狀。
