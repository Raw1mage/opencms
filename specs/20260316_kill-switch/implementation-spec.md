## Goal

建立一套可由 coding agent 直接執行的 kill-switch 實作規範，能讓有權限的操作者透過 Web/TUI/API 以受控、安全、可觀測的方式暫停或終止自動代理系統（global scope）。

Parent plan: specs/20260315_openclaw_reproduction/ (this kill-switch workstream is a continuation of the OpenClaw plan and should align with its authority and artifacts)

## Scope

- Primary: Global kill-switch 實作，支援可選 scope (global | session | instance)。
- Secondary: Web Admin + TUI trigger 與受控 API；RBAC 與 MFA 驗證；snapshot 與 audit 寫入。
- Out of scope: provider-side連帶自動重啟（須另案處理）、跨集群 multi-region replication（視部署而定）。

## Assumptions

- 系統已有身份驗證與角色管理機制可擴展 RBAC。
- 系統 agent 與 scheduler 皆在啟動/派發任務前可檢查全域狀態（能讀取 Redis/etcd/DB）。
- 有一個可寫入的持久 storage（DB 或 object store）與通知通道（Slack/Email/Webhook）。

## Stop Gates

- 不可繼續：任何實作在未通過安全審查（task `security-review`）前不得啟用公開 API。
- 實作完成度必須通過：API 單元測試、RBAC 驗證測試、E2E Web 路徑測試。
- 任何變更必須先於 `specs/*` 與 `tasks.md` 註記並且得到一位 owner 批准。

## Critical Files

- specs/20260316_kill-switch/implementation-spec.md (this file)
- specs/20260316_kill-switch/spec.md
- specs/20260316_kill-switch/design.md
- specs/20260316_kill-switch/tasks.md
- specs/20260316_kill-switch/control-protocol.md
- specs/20260316_kill-switch/rbac-hooks.md
- specs/20260316_kill-switch/snapshot-orchestration.md
- src/server/routes/admin/kill_switch.\* (controller + router)
- src/server/services/kill_switch_state.\* (state management, TTL, persistence)
- src/agents/launcher (check kill-switch state before launching agents)
- webapp/src/admin/KillSwitchButton.\* (frontend)
- tui/src/commands/kill_switch.\* (TUI integration)

## Structured Execution Phases

Phase A — Spec & Security (planner)

- Deliverables: implementation-spec.md, design.md, security checklist.
- Owner: planner / security.

Phase B — Core API & State (coding)

- Implement state store, API endpoints (status, trigger, cancel), audit writes, snapshot orchestration.
- Ensure endpoints are idempotent and return request_id.

Phase C — Integration (coding)

- Integrate check into agent startup / scheduler path (read state key, short-circuit new task start).
- Implement soft-pause semantics: mark state -> prevent new tasks -> notify running tasks to begin graceful shutdown (via signal or control channel).

Phase D — Enforce & Observability (coding)

- Implement forced-kill after timeout: iterate tasks still running -> terminate worker processes -> write final audit.
- Implement snapshot generation and upload, then link in audit.

Phase E — UI & TUI (frontend)

- Web Admin: button, confirmation modal, reason field, snapshot toggle, display state/status
- TUI: hotkey + confirmation flow

Phase F — Tests & Runbook

- Unit tests, integration tests, E2E tests, runbook + postmortem template.

## Validation

- Acceptance criteria (explicit):
  1. Authorized user can POST /api/admin/kill-switch with reason -> returns accepted + request_id and snapshot_url.
  2. After trigger, new task launches are rejected; existing tasks enter graceful window; system-wide state readable via GET /api/admin/kill-switch/status.
  3. After soft_timeout, remaining tasks are forcefully terminated and audit contains final state + snapshot.
  4. Audit entries recorded for trigger/cancel with required fields.

- Tests to write:
  - API unit tests for auth + payload validation.
  - Integration test simulating scheduler + agent respecting state.
  - Timeout E2E verifying hard-kill path.

## Handoff

- Provide `request_id` for each trigger for traceability.
- Keep `tasks.md` as the canonical task list; build agent should run `tasks.md` items sequentially.
- After build readiness, call `plan_exit` to switch to build mode.
