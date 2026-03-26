# Event: Scheduled Tasks UI — Implementation Pass

**Date**: 2026-03-26
**Plan**: `/plans/20260325_scheduled-tasks-ui/`
**Branch**: `worktree-scheduled-tasks-ui` (beta worktree)

## Scope

Full implementation of Phases 1–6 from the scheduled-tasks-ui plan. The goal is to wire up the existing cron backend to actually execute AI turns, then build a system-level UI for managing scheduled tasks.

### IN
- Phase 1: Backend pipeline fix — `heartbeat.ts` executeJobRun() now calls CronSession.resolve() + SessionPrompt.prompt()
- Phase 1b: Virtual project isolation — `Instance.provide({ directory: TASKS_VIRTUAL_DIR })` wraps all cron execution
- Phase 1c: REST endpoint `GET /api/v2/cron/project` returns virtual tasks directory path
- Phase 2: `/system/tasks/:jobId?` route + ScheduledTasksTile in sidebar project rail
- Phase 3: task-sidebar.tsx — session-list style cron job browser
- Phase 4: task-detail.tsx — three-zone detail view (prompt editor, cron config, execution log)
- Phase 4b: Session conversation rendering in RunHistoryPanel — fetch messages via session API when run has sessionId
- Phase 5: task-tool-panel.tsx — right-side actions (test, edit, refresh, start/stop, delete)
- Phase 6: Integration — index.tsx rewritten to split layout, stale route refs removed

### OUT
- Context menu on sidebar items (deferred)
- GlobalSync-level reactive state (component-level signals used instead)
- Runtime integration testing (requires live server)

## Key Decisions

1. **SessionPrompt.prompt() over RunQueue.enqueue()**: RunQueue requires a pre-existing messageID. SessionPrompt.prompt() creates the message internally and executes synchronously. Since heartbeat interval is 30min, blocking is acceptable.

2. **`/system/tasks` route prefix**: Virtual system-level project, not directory-scoped. Route placed before `/:dir` catch-all to avoid pattern conflicts.

3. **ScheduledTasksTile as project rail entry**: Promoted from utility bar icon to a first-class tile at the top of the project rail, with active-state highlighting when on `/system/tasks`.

4. **Split layout over card list**: Replaced the original single-page card layout with sidebar + detail pane, matching the existing session browsing UX pattern.

5. **Virtual project isolation via Instance.provide()**: All cron execution wrapped in `Instance.provide({ directory: TASKS_VIRTUAL_DIR })` so sessions are scoped to a virtual project (`SHA1("nogit:" + path)`), isolated from user projects. `CronSession.resolve()` automatically inherits the virtual directory via `Instance.directory`.

6. **Session conversation in run history**: RunHistoryPanel fetches full message+parts from session API when expanding a run with `sessionId`, rendering user prompts and AI responses inline.

## Files Changed

### Backend (packages/opencode)
- `src/cron/virtual-project.ts` — **NEW**: Defines `TASKS_VIRTUAL_DIR` constant (`Global.Path.state + "/__tasks__"`)
- `src/cron/heartbeat.ts` — Rewrote executeJobRun() with CronSession.resolve() → SessionPrompt.prompt(); wrapped in `Instance.provide({ directory: TASKS_VIRTUAL_DIR })`; added `fs.mkdir()` at register time
- `src/server/routes/cron.ts` — Manual trigger wrapped in `Instance.provide()`; added `GET /project` endpoint

### Frontend (packages/app)
- `src/app.tsx` — Added `/system/tasks/:jobId?` route before `/:dir`
- `src/pages/layout.tsx` — Changed openTasks() to navigate to `/system/tasks`
- `src/pages/layout/sidebar-shell.tsx` — Added ScheduledTasksTile component, removed Tasks from utility bar
- `src/pages/task-list/api.ts` — Added `SessionMessage`, `SessionMessageWithParts` types; added `getSessionMessages()`, `getSessionMessage()` methods
- `src/pages/task-list/run-history.tsx` — Enhanced to fetch and render session conversation (user prompt + AI response) when expanding a run with sessionId
- `src/pages/task-list/task-card.tsx` — Updated local CronApi type to include session message methods
- `src/pages/task-list/index.tsx` — Rewritten: split layout composing TaskSidebar + TaskDetail
- `src/pages/task-list/task-sidebar.tsx` — **NEW**: Session-list style job browser
- `src/pages/task-list/task-detail.tsx` — **NEW**: Three-zone detail + tool panel integration

## Verification

- [x] Backend tsc: 0 new errors (7 pre-existing, all unrelated)
- [x] Frontend imports: all cross-file imports verified consistent
- [x] Route consistency: no stale `/:dir/tasks` references remain
- [x] Plan tasks.md: checkboxes synced with implementation status
- [~] Runtime verification: requires live server — marked as pending in tasks.md

## Architecture Sync

Architecture Sync: Verified (No doc changes required)

Rationale: This implementation wires up existing cron infrastructure (CronSession, CronStore, heartbeat) to existing session execution (SessionPrompt.prompt). No new modules, no new data flows, no state machine changes. The frontend is a new page within the existing SPA routing — no architectural boundary changes. The cron subsystem's module boundary and data flow are already documented in specs/architecture.md.

## Remaining

- Runtime integration test: verify cron trigger → session creation → AI execution → run log with sessionId
- Frontend smoke test: full navigation flow, edit dialog, execution log rendering
- Consider promoting `task-card.tsx` cleanup (unused after layout switch) in a follow-up
