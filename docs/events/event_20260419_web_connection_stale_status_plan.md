# Event: web connection stale status fix plan

Date: 2026-04-19
Status: Planning

## Requirement

- 使用者要求：先確認目前是否在 beta worktree，再把弱網路 / stale status / subagent footer / stale counter 問題整理成 fix plan。
- 額外限制：未收到明確指示前，不進入 build mode。

## Scope

### IN

- 規劃 web 連線狀態不佳時的 stale UI / fake running / fake elapsed 修復方向
- 建立 dated plan package

### OUT

- 不實作
- 不修改 production code
- 不進入 build mode

## Key Findings

- 目前畫面中的 subagent elapsed 主要來自 frontend monitor projection，而非 worker 真實 runtime duration。
- `reload web` 後 footer 消失，支持 stale projection / reconnect desync 假說。
- 弱網路下，frontend 需要 explicit authority rehydrate contract，而不是只靠本地計數器與舊 footer。

## Artifacts Created

- `plans/20260419_web-connection-stale-status-fix/proposal.md`
- `plans/20260419_web-connection-stale-status-fix/implementation-spec.md`
- `plans/20260419_web-connection-stale-status-fix/tasks.md`
- `plans/20260419_web-connection-stale-status-fix/idef0.json`
- `plans/20260419_web-connection-stale-status-fix/grafcet.json`

## Validation

- Planning only; no build/test executed.

## Architecture Sync

- Pending implementation outcome. No `specs/architecture.md` changes in planning-only session.
