# Architecture

## System Overview

OpenCode is a desktop/TUI/Webapp multi-interface platform for interacting with AI coding agents and various model providers (OpenAI, Anthropic, Gemini, etc.).

## Core Architecture

- **Multi-Interface**: TUI (`cli/cmd/tui`), Desktop App, Webapp (`packages/app`), and CLI.
- **Unified Backend**: All interfaces communicate with a shared Node/Bun backend via the `@opencode-ai/sdk` or direct function calls.
- **Provider Abstraction**: Model interactions are abstracted through the `Provider` module. Product-visible provider universe is now registry-first: a repo-owned supported provider registry defines which canonical providers cms officially supports and may show in `/provider` or UI lists, while runtime/config/accounts/models sources only enrich those supported providers with state and model metadata.

## Frontend Architecture

### Layered Structure

The frontend is built with Solid.js and uses a bottom-up dependency model:

- **Infrastructure layer**: API transport, EventSource/WebSocket listeners, and platform adapters.
- **Sync layer**: `GlobalSync` plus per-workspace stores act as the authoritative event-reduced state surface.
- **Control layer**: layout, permission, and command coordination for global UI behavior.
- **Feature layer**: prompt, file, and terminal domain logic.
- **UI layer**: pages and components that subscribe to reactive state and render only the required slices.

### Frontend Data Flow

- Backend events stream into the SDK, then into `GlobalSync`, where reducers update Solid stores.
- UI components consume fine-grained reactive state so updates stay localized.
- User actions flow through feature/control contexts into the SDK, with optimistic UI where required, then reconcile against server-driven events.

### Frontend State Rules

- Prefer local reactive primitives for local UI state.
- Use centralized stores only for shared or durable data.
- Maintain per-workspace child stores to isolate data and reduce unnecessary redraws.
- Use structured reconciliation for large collections so component identity and scroll position remain stable.

### Frontend Performance Rules

- Large file/message surfaces rely on virtual scrolling.
- Expensive derived views must stay memoized.
- Effects should use untracked access when reads are not meant to become dependencies.
- Page-level code paths should remain lazily loaded when possible.

### Frontend Source Map

- `packages/app/src/context/`: domain state and coordination.
- `packages/app/src/pages/session/`: session-page controller/hooks/components.
- `packages/app/src/hooks/`: reusable frontend logic.

## Planner / Spec Repository Lifecycle

- **Active plan/build workspace**: dated plan packages now live under `/plans/` inside the repo worktree.
- **Global architecture SSOT**: `specs/architecture.md` remains the long-lived architecture document and is not part of any dated plan package.
- **Formalized specs**: post-implementation, post-commit, post-merge formalized feature specs belong under semantic per-feature roots in `/specs/`.
- **Promotion rule**: `/plans/` artifacts do not automatically move into `/specs/`; promotion is manual and only happens after explicit user instruction.
- **Current promoted package**: the completed builder quiz-guard / build-mode refactoring package was promoted from `/plans/20260321_build-mode-refactoring/`, then merged into the existing canonical semantic root `/specs/builder_framework/` because both roots describe the same builder framework topic; future work should use `/specs/builder_framework/` as the formal reference package.
- **Legacy dated packages under `/specs/`**: these require explicit status-based triage; implemented packages belong in formalized spec roots, non-implemented packages belong in `/plans/`. Silent dual-root fallback is prohibited.

## Planner Runtime Surfaces

- `packages/opencode/src/session/planner-layout.ts` is the canonical planner-root constructor and now resolves active dated plan roots under `/plans/`.
- `packages/opencode/src/tool/plan.ts` owns `plan_enter` / `plan_exit`, planner template loading, artifact validation, and mission artifact path storage for active `/plans/` packages.
- Planner templates are loaded from `/etc/opencode/plans` or `templates/plans` for active plan packages.
- Mission artifact roots for active build execution must resolve under `/plans/`; non-`/plans/` active mission roots are treated as contract violations and fail fast.
- `plan_enter` must inspect existing planner roots before writing templates: empty/template-only roots may be repaired, but partial or curated non-template roots are treated as integrity violations and must not be overwritten.
- Planner document storage is mainline-only: `/plans/`, `/specs/`, and `docs/events/` must be created/updated in the authoritative main repo/worktree, even if planning is triggered while the current execution surface is a beta worktree.
- `plan_exit` may attach beta mission context (`mission.beta`) derived from approved plan artifacts and, for beta-enabled plans, bootstrap the builder-owned beta branch/worktree/runtime context before entering build mode.
- `mission.beta` is now the durable handoff boundary for builder beta execution state: branch name, base branch, repo/main worktree paths, beta worktree path, validation/finalize posture, and runtime policy all persist on the session mission contract.
- `plan_exit` now owns the authoritative beta admission gate for beta-enabled build entry: before build execution starts, it asks a structured quiz against mission-backed authority fields (`mainRepo`, `mainWorktree`, `baseBranch`, `implementationRepo`, `implementationWorktree`, `implementationBranch`, `docsWriteRepo`), allows exactly one reflection retry, persists `mission.admission.betaQuiz`, and fails fast with `product_decision_needed` when the second attempt still mismatches.
- `packages/opencode/src/session/mission-consumption.ts` is the deterministic authority/evaluator surface for beta admission: it resolves mission-backed expected values and returns machine-checkable mismatch evidence `{ field, expected, actual }` without fallback sources.

## Builder-Native Beta Workflow Surfaces

- `packages/opencode/src/session/beta-bootstrap.ts` is the builder-native integration layer for beta bootstrap, validation syncback, routine git execution, drift remediation, and finalize behavior.
- It reuses deterministic git/worktree/runtime primitives from `packages/mcp/branch-cicd/src/project-policy.ts` and project-context resolution from `packages/mcp/branch-cicd/src/context.ts` rather than duplicating branch-cicd logic inside the builder runtime.
- `packages/opencode/src/tool/plan.ts` owns beta bootstrap during `plan_exit`; it resolves and persists the builder beta context only for plans that opt into the beta workflow.
- `packages/opencode/src/session/workflow-runner.ts` owns validation-stage behavior during autonomous build execution: it prepares syncback metadata for testing continuations and, when runtime policy is non-manual, performs builder-owned syncback checkout plus runtime command execution before the validation slice continues.
- The workflow-runner still injects a beta-oriented execution contract for beta-enabled missions, but that text is advisory only after admission succeeds; enforcement now lives in the runtime admission gate plus continuation checks, not in prompt prose.
- Planner mode transition tools (`plan_enter`, `plan_exit`) are now exposed on web runtime as well as app/cli/desktop; the actual product surface runs as per-user daemon + webapp, so planner-to-build workflow cannot be gated away from `web` by client label alone.
- The same workflow-runner owns finalize-stage behavior during autonomous build execution: it prepares merge target / branch / cleanup-default metadata for finalize-oriented continuations, surfaces branch-drift remediation preflight when the base branch advanced, and preserves explicit approval gates before destructive actions.
- Builder routine git defaults are now builder-native across local and remote steps: checkout/commit/pull/push automation can run from approved mission/delegation metadata, but push still remains approval-gated where policy requires it and remote operations fail fast when origin/upstream state is not explicit.
- Builder design treats branch drift as a first-class runtime state: when the stored base/main branch has advanced after beta bootstrap, the runtime prepares remediation/rebase preflight and stops for approval; once explicit destructive-gate remediation approval is present, builder-native remediation executes in the beta worktree and still returns control to finalize as a separate step.
- Manual runtime policy remains an explicit operator boundary: builder may prepare syncback metadata, but it must not invent or auto-run runtime commands.
- Destructive finalize execution now has a builder-native execute path, but it is still explicit-approval-only and cleanup remains conservative by default.
- Drift remediation execute is implemented only for explicit approval-confirmed rebase flow and fails fast on dirty beta state or rebase conflicts; no silent history rewrite or implicit conflict recovery is allowed.
- `packages/mcp/branch-cicd/src/beta-tool.ts` and the `beta-workflow` skill remain advisory/migration assets only: they may help operators or continuations understand the beta surface, but they are not build-admission authorities and must not be treated as enforcement boundaries.

## Account Management (3-Tier Architecture)

- **Tier 1 (Storage)**: `packages/opencode/src/account/index.ts`. A pure repository interacting with `accounts.json`. Enforces unique IDs strictly (throws on collision).
- **Tier 2 (Unified Identity Service)**: `packages/opencode/src/auth/index.ts`. The central gateway for deduplicating identities (OAuth/API), resolving collisions, generating unique IDs, and orchestrating async background disposal (`Provider.dispose()`).
- **Tier 3 (Presentation)**: CLI (`accounts.tsx`), Admin TUI (`dialog-admin.tsx`), Webapp (`packages/app/src/components/settings-accounts.tsx`). Thin clients that _must_ route all account additions/deletions through Tier 2.

## Gateway Google Login Binding Boundary

- The per-user daemon gateway remains Linux-PAM-first: Linux authentication continues to resolve the target uid and daemon authority.
- Google login may exist only as a compatibility path when a Google identity is already bound to a Linux user.
- Shared Google OAuth token storage (`~/.config/opencode/gauth.json`) is for managed app token persistence (e.g. Gmail / Calendar) and is not the binding authority for Linux↔Google identity routing.
- Unbound Google identities must fail fast at the gateway; no silent fallback, auto-match, or first-available-user rescue is allowed.
- The gateway exposes a Google compatibility login endpoint at `POST /auth/login/google` that accepts `google_email` and resolves it through the binding registry.
- Binding data, if added, must be separable from shared token storage and queryable by the gateway as an explicit lookup contract.
- The binding registry is modeled as a global module deployed under `/etc/opencode/` (default path `/etc/opencode/google-bindings.json` with optional `OPENCODE_GOOGLE_BINDINGS_PATH` override); it is distinct from user-scoped OAuth token storage and is the gateway's authoritative lookup surface for Linux↔Google identity routing.

## Key Modules

- **`src/account`**: Disk persistence (`accounts.json`), ID generation, basic CRUD.
- **`src/auth`**: Identity resolution, OAuth token parsing, high-level API key addition, collision avoidance.
- **`src/provider`**: Manages active connections to model providers and their runtime instances.
- **`src/provider/supported-provider-registry.ts`**: Repo-owned canonical supported provider registry; the single source of truth for the cms official provider universe and product labels.
- **`src/provider/canonical-family-source.ts`**: Canonical provider row builder and runtime-provider resolver. Canonical rows are registry-first; accounts, connected providers, disabled state, and models.dev only overlay state onto supported providers.
- **`src/server/routes/provider.ts`**: `/provider` API assembly surface. Returns canonical provider rows keyed by supported provider registry, not raw observed provider IDs.

## Provider Universe Authority

- The cms official provider universe is defined by the repo-owned supported provider registry, not by observed runtime/config/models/account provider IDs.
- Initial supported provider set is: `openai`, `claude-cli`, `google-api`, `gemini-cli`, `github-copilot`, `gmicloud`, `openrouter`, `vercel`, `gitlab`, `opencode`.
- `models.dev` is an enrichment source only: it may update models and metadata for supported providers, but it must not introduce new product-visible providers by itself.
- Runtime custom providers and config-injected providers may still exist for execution, but unsupported keys must fail closed at the provider-list boundary and must not appear in `/provider` or primary UI provider lists unless explicitly added to the registry.

## Managed App Registry (MCP Apps)

### Overview

The Managed App Registry (`packages/opencode/src/mcp/app-registry.ts`) provides a lifecycle state machine for built-in MCP apps that run under opencode runtime ownership. Apps are registered in `BUILTIN_CATALOG` and exposed as AI-callable tools through the MCP tool router.

### State Machine

```
available → installed → pending_config → pending_auth → ready
                     → disabled
                     → error
```

### Registered Apps

| App ID            | Name            | Scope                             | Tools                                                                                                                                               |
| ----------------- | --------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `google-calendar` | Google Calendar | `calendar`, `calendar.events`     | 7 (list-calendars, list-events, get-event, create-event, update-event, delete-event, freebusy)                                                      |
| `gmail`           | Gmail           | `https://mail.google.com/` (full) | 10 (list-labels, list-messages, get-message, send-message, reply-message, forward-message, modify-labels, trash-message, list-drafts, create-draft) |

### Shared Google OAuth

Both Google apps share a single OAuth token stored at `~/.config/opencode/gauth.json`. The OAuth connect flow (`/api/v2/mcp/apps/:appId/oauth/connect`) merges scopes from all installed Google apps before redirecting to Google's consent screen. After successful callback, all installed Google apps are marked configured and enabled.

### Key Files

- `packages/opencode/src/mcp/app-registry.ts` — BUILTIN_CATALOG, state machine, persistence (`managed-apps.json`)
- `packages/opencode/src/mcp/index.ts` — Tool conversion (`convertManagedAppTool`), executor routing (`managedAppExecutors`)
- `packages/opencode/src/mcp/apps/google-calendar/` — Calendar client + executors
- `packages/opencode/src/mcp/apps/gmail/` — Gmail client + executors
- `packages/opencode/src/server/routes/mcp.ts` — OAuth connect/callback routes, app lifecycle API
- `~/.config/opencode/gauth.json` — Shared Google OAuth token storage
- `~/.config/opencode/managed-apps.json` — App install/config state persistence

## Account Bus Events

- **Event Types**: `account.added`, `account.removed`, `account.activated` — defined in `src/bus/index.ts`.
- **Sanitization**: `sanitizeInfo()` strips secrets (apiKey, refreshToken) before inclusion in bus event payloads.
- **Mutation Mutex**: All account mutations (`add`, `remove`, `setActive`, `update`) are serialized via an in-process Promise-chain mutex (`withMutex`) in `src/account/index.ts`, preventing concurrent race conditions on `accounts.json`.

## Data Flow (Account Deletion)

1. **User Request**: Triggered from TUI/Webapp.
2. **Optimistic UI**: Component removes account from local state immediately.
3. **Service Layer**: `Auth.remove()` calls `Account.remove()` (sync disk deletion).
4. **Background Cleanup**: `Auth.remove()` initiates a non-blocking promise to call `Provider.dispose()` and final disk save.
5. **Bus Event**: `Account.remove()` publishes `account.removed` via GlobalBus → SSE → all connected clients.

## Workspace Change Surfaces

- **Session-owned diff**: `GET /session/:sessionID/diff` returns the authoritative session-owned dirty diff for the current workspace. It is computed from session-owned candidate files intersected with current git-uncommitted state.
- **Workspace git status**: `GET /file/status` returns the whole workdir/project git status for the resolved directory.
- **UI boundary**:
  - Web/TUI session review flows may consume `session.diff` when the UX is explicitly about session-owned changes.
  - TUI sidebar `Changes` and webapp changes sidebar use workspace-level git status (`file.status`) when the UX is explicitly about current workdir uncommitted files.
- These two sources must not be silently conflated; session attribution and workdir cleanliness are separate contracts.

## beta-tool MCP Architecture

- `packages/mcp/branch-cicd` adds a standalone stdio MCP server published as capability `beta-tool`.
- Public tools are exactly `newbeta`, `syncback`, and `merge`.
- The package resolves project context before mutating git state: canonical repo root, authoritative base branch, deterministic beta worktree root, and runtime policy.
- The package is project-aware rather than `cms`-hard-coded: this repo resolves a `webctl.sh` runtime adapter, while non-matching repos must provide explicit runtime policy or complete a bounded clarification step.
- Ambiguity and destructive confirmation are surfaced as structured orchestrator-question contracts rather than silent fallback: repo root, branch name, runtime policy, merge target, and merge confirmation all stop until explicit selection is supplied.
- Loop metadata is persisted under XDG state so repeated beta edit → syncback → runtime validation cycles can reuse the same branch/worktree mapping across sessions.
- `merge` remains approval-gated and re-checks dirty state before merge, worktree removal, or branch deletion.

## Session Monitor / Telemetry Architecture

### Current State

- Runtime emits telemetry-related events from session processing, and supported telemetry events are persisted by `packages/opencode/src/bus/subscribers/telemetry-runtime.ts` into `RuntimeEventService`.
- `packages/opencode/src/session/monitor.ts` currently constructs telemetry-bearing monitor rows, and `GET /session/top` returns those rows as snapshots.
- App currently refreshes `session.top` through `packages/app/src/pages/session/use-status-monitor.ts` and hydrates `session_telemetry` through `packages/app/src/context/sync.tsx` plus `packages/app/src/pages/session/monitor-helper.ts`.
- This means current steady-state behavior is still influenced by hydration-first / monitor-first / page-hook-first paths.

### Target State

- Telemetry is bus-messaging-first / DDS-aligned.
- Runtime emits telemetry events as source facts.
- A server-side telemetry projector owns the authoritative telemetry read model.
- App global-sync reducer owns the canonical telemetry slice.
- UI surfaces are pure consumers of reducer-owned telemetry state.
- `session.top` is bootstrap / catch-up / degraded snapshot transport only.

### Builder Execution Path

1. Freeze current-state baseline and label every wrong authority path.
2. Define the runtime telemetry event contract before downstream design.
3. Define projector aggregate ownership and projector read-model boundaries.
4. Cut steady-state app ownership over to the reducer-owned `session_telemetry` slice.
5. Demote `session.top` and all snapshot/hydration/page-hook paths to bootstrap/recovery-only behavior.
6. Remove conflicting legacy glue and validate that no duplicate authority remains.

### Ownership Rules

- Runtime owns telemetry fact emission, not app hydration.
- Server projector is the only telemetry read-model authority.
- Monitor rows and snapshot routes are downstream projector consumers, not telemetry authorities.
- App page hooks, hydration helpers, and local fallback must not hold steady-state telemetry authority.
- UI components may render telemetry but must not synthesize or persist telemetry truth.

### Minimum Authority Shapes

- Runtime event contract must at minimum distinguish prompt telemetry, round telemetry, compaction telemetry, and session-summary-relevant facts.
- Projector aggregate must at minimum distinguish prompt summary, round summary, compaction summary, session cumulative summary, freshness metadata, and degraded/catch-up metadata.
- App reducer slice must remain session-scoped and canonical, with enough structure for UI consumption but without reintroducing helper-side truth synthesis.

### Context Sidebar Card Surface

- `packages/app/src/components/session/session-context-tab.tsx` is the context-sidebar composition surface for session context metrics plus telemetry cards.
- Legacy context information is grouped into three cards: `Summary`, `Breakdown`, and `Prompt`.
- Context sidebar card order is persisted in app layout state via `packages/app/src/context/layout.tsx` under `contextSidebar.order`.
- The sortable interaction pattern intentionally follows the same UI family as the status sidebar card ordering, but remains a separate persisted order key.
- This is a presentation-layer layout contract only; it does not change telemetry authority boundaries or backend data ownership.

### Migration Warnings

- Hydration-first steady-state is architecturally wrong and must be removed or demoted.
- Monitor-first steady-state is architecturally wrong and must be removed or demoted.
- Page-hook-first steady-state is architecturally wrong and must be removed or demoted.
- Any implementation that leaves `session.top`, monitor hydration, or local fallback as a steady-state telemetry writer is architecture drift.
- Partial migration that introduces projector/reducer while preserving legacy steady-state writers is invalid.

## Daemon Architecture (Multi-User Web Runtime)

### Overview

The web runtime supports a multi-user deployment model with process-level isolation:

```
Internet → [C Gateway :1080] → Unix Socket → [Per-User Daemon (uid=user)]
                                             → [Per-User Daemon (uid=user2)]
```

### Components

#### C Root Gateway (`daemon/opencode-gateway.c`)

- Runs as root, listens on TCP port (default :1080)
- **Non-blocking Event Loop**: Single-threaded `epoll_wait` loop; no blocking I/O in main loop. All sockets set `O_NONBLOCK` at accept time
- **Tagged epoll Context** (`EpollCtx`): Discriminated union (`ECTX_LISTEN | ECTX_PENDING | ECTX_SPLICE_CLIENT | ECTX_SPLICE_DAEMON | ECTX_AUTH_NOTIFY`) attached to each epoll fd so events dispatch by type and direction
- **HTTP Request Accumulation** (`PendingRequest`): Per-connection 8KB read buffer. TCP segments accumulated via EPOLLIN until `\r\n\r\n` detected, timeout (30s), or oversize (400/408). No assumption of single-recv completeness
- **Thread-per-auth PAM**: Login requests spawn `pthread` for `pam_authenticate`; result notified to main loop via `eventfd`. Main loop never blocked by PAM
- **Rate Limiting**: Per-IP hash table (mod 256), sliding window 5 failures / 60s → 429. Successful login clears counter
- **JWT Sessions**: HMAC-SHA256 with **file-backed persistent secret** (`/run/opencode-gateway/jwt.key`, configurable via `OPENCODE_JWT_KEY_PATH`). Validates `sub` + `exp` claims; `sub` → `getpwnam()` → uid
- **Per-User Daemon Spawning**: `fork() → initgroups() → setgid() → setuid() → execvp()` with pre-parsed argv array (no `sh -c` after setuid)
- **splice() Proxy**: Zero-copy bidirectional forwarding (TCP ↔ pipe ↔ Unix socket). Directional: each epoll event splices one direction only based on `EpollCtx.type`
- **Connection Lifecycle**: `EPOLL_CTL_DEL` before `close()` on all fds; `closed` flag guards against in-flight epoll events on same connection; `g_nconns` counter tracks active splice connections
- **Runtime Path Detection** (WSL2-safe): `resolve_runtime_dir()` probes `/run/user/<uid>` → `$XDG_RUNTIME_DIR` → `/tmp/opencode-<uid>/` (mkdir 700) with logging at each fallback
- **PAM Availability Probe**: Startup-time `pam_start("login", ...)` check; fails fast with guidance if PAM is unconfigured
- **Registry**: In-memory UID → (pid, socket_path, state) mapping; SIGCHLD handler cleans up crashed daemons
- **Login Page**: Serves static HTML login form for unauthenticated requests

#### Per-User Daemon (`opencode serve --unix-socket`)

- Runs as the authenticated user's UID
- Listens on Unix socket at `$XDG_RUNTIME_DIR/opencode/daemon.sock`
- Full opencode server (API + SSE + WebSocket) available over Unix socket
- **Discovery File**: `$XDG_RUNTIME_DIR/opencode/daemon.json` — contains `{ socketPath, pid, startedAt, version }`
- **PID File**: `$XDG_RUNTIME_DIR/opencode/daemon.pid` — single-instance guard
- **Cleanup**: Removes discovery + PID files on SIGTERM/SIGINT/process exit; stale files detected and cleaned by `readDiscovery()`
- **Idle Timeout**: 120s TCP/Unix socket idle timeout via `Bun.serve({ idleTimeout: 120 })`

#### TUI Attach Mode (`opencode --attach`)

- Connects to an already-running per-user daemon via Unix socket
- **Auto-Spawn**: If no daemon is discovered, `Daemon.spawn()` launches a detached `opencode serve --unix-socket` child process, polls for `daemon.json` readiness (timeout 10s), then attaches
- **Discovery**: Reads `daemon.json`, validates PID alive (`kill -0`)
- **Custom Fetch**: `createUnixFetch(socketPath)` — routes HTTP requests over Unix socket
- **Custom SSE**: `createUnixEventSource(socketPath, baseUrl)` — streaming SSE client with manual line parsing over Unix socket fetch
- **Graceful Disconnect**: Ctrl+C closes SSE (AbortController) without affecting daemon

#### Daemon Coordination (Discovery-First)

- **Discovery file is truth, in-memory registry is cache**: Both TUI and C gateway use `daemon.json` as the canonical coordination point
- **TUI auto-spawn**: `--attach` → no daemon → `Daemon.spawn()` → daemon writes `daemon.json` → TUI attaches; this is the explicit attach contract and replaces prior fail-fast drift in older docs
- **Gateway adopt**: On web login, C gateway checks `daemon.json` (path resolved via `resolve_runtime_dir()`) before spawning a new daemon. If PID alive and socket connect succeeds → adopt into registry → splice proxy. Stale discovery/socket state is explicitly cleaned instead of silently reused. Covers daemons pre-spawned by TUI `--attach`
- **Gateway JWT validation**: Gateway base64url-decodes payload, validates `sub` + `exp` claims, derives uid via `getpwnam(sub)`, routes by verified identity. JWT secret is file-backed and survives gateway restarts
- **Race safety**: `daemon.pid` acts as single-instance guard; whoever creates the daemon first wins, latecomers discover and adopt

### SSE Event ID + Catch-up (Phase ζ)

- **Global Counter**: Monotonically increasing `_sseCounter` in `src/server/routes/global.ts`
- **Ring Buffer**: Array of `{ id, event }` entries (MAX_SIZE = 1000)
- **Reconnect**: Client sends `Last-Event-ID` header → server replays missed events from buffer
- **Buffer Overflow**: If `lastId` is older than buffer range → server sends `sync.required` event → client does full bootstrap refresh

### Security Migration (Phase δ)

- **Removed**: `LinuxUserExec`, `buildSudoInvocation`, `opencode-run-as-user.sh`, all sudo wrapper logic
- **Rationale**: Per-user daemon already runs as the correct UID; shell/PTY commands spawn directly without privilege escalation
- **Preserved**: Utility functions `sanitizeUsername`, `resolveLinuxUserHome`, `resolveLinuxUserUID` in `src/system/linux-user-exec.ts`

### Subagent IO Visibility

子代理（subagent）透過 `task()` tool 委派工作時，主 session UI 即時顯示子代理活動。

**資料流**:

1. Task tool 建立子 session 後立即呼叫 `ctx.metadata({ sessionId })` → tool part 的 `state.metadata.sessionId` 在 running 狀態即可用
2. Worker process 的子 session events 透過 `__OPENCODE_BRIDGE_EVENT__` stdout protocol → 主 process `publishBridgedEvent()` → Bus → SSE → frontend sync store
3. `SubagentActivityCard` 組件（`packages/app/src/pages/session/components/message-tool-invocation.tsx`）讀取 `sync.data.message[childSessionId]` 顯示子代理的 tool calls 和文字輸出

**組件結構**:

- `tool === "task"` 的 ToolPart 渲染為 `SubagentActivityCard`（取代通用 MCP card）
- Header: agent type + description + elapsed timer
- Body（collapsible）: tool call 列表（status icon + tool name + subtitle）+ text output
- 狀態: running（spinner, auto-open）/ completed（final output）/ error（error banner + partial activity）

### Shared Context Structure

Per-session structured knowledge space that tracks files, actions, discoveries, and goals across turns. Serves three consumers: subagent injection, idle compaction, and overflow compaction.

**Module**: `packages/opencode/src/session/shared-context.ts`

**Data Model**:

```typescript
Space {
  sessionID, version, updatedAt, budget,
  goal: string,
  files: FileEntry[],      // path, operation, lines, summary
  discoveries: string[],   // key findings extracted from assistant text
  actions: ActionEntry[],  // tool calls summarized per turn
  currentState: string,    // last paragraph of assistant text
}
```

**Storage**: `["shared_context", sessionID]` — per-session, separate namespace from messages. Both parent and child sessions persist their own Space.

**Update Trigger**: After every assistant turn in `prompt.ts` turn boundary loop (both parent and child sessions). Heuristic extraction: tool parts → files/actions; assistant text → goal/discoveries/currentState.

**Three Consumers**:

1. **Subagent Injection** (`task.ts` dispatch):
   - At `task()` call, snapshot parent's Space → format as `<shared_context>` XML → prepend to subagent's first user message
   - Records `injectedSharedContextVersion` in task part metadata for differential relay
   - Skipped for `session_id` continuation dispatches

2. **Idle Compaction** (`prompt.ts` turn boundary, parent sessions only):
   - After turn containing task dispatch, evaluate context utilization
   - If utilization ≥ `opportunisticThreshold` (default 0.6): use Space snapshot as compaction summary (no LLM call)
   - Falls back to LLM compaction agent if Space is empty

3. **Overflow Compaction** (`prompt.ts` overflow path, parent sessions only):
   - When context overflows: if Space has content, use as summary instead of calling LLM compaction agent
   - Falls back to standard LLM compaction agent

**Child→Parent Feedback** (`task-worker-continuation.ts` on subagent completion):

1. `SharedContext.snapshotDiff(childSessionID, injectedSharedContextVersion)` — only new knowledge since dispatch, avoiding re-relay of what parent already knows. Falls back to full snapshot if version not recorded.
2. Diff prepended to synthetic continuation message — parent LLM receives actual evidence to follow through with
3. `SharedContext.mergeFrom(parent ← child)` — child's files/actions merged into parent Space for future subagent dispatches

**Config** (`config.compaction`):

- `sharedContext: boolean` (default true) — disable entirely
- `sharedContextBudget: number` (default 8192 tokens) — Space size cap with consolidation
- `opportunisticThreshold: number 0-1` (default 0.6) — idle compaction trigger

### Continuous Orchestration Control Surface

- Dispatch-first continuous orchestration does **not** mean the session becomes globally idle once `task()` returns. If exactly one background subagent is still active, the parent session remains in an operator-controllable active-child state.
- This active-child state is a session-global control-plane concept distinct from foreground parent streaming state.
- **Single-child invariant** remains authoritative: one parent Orchestrator session may have at most one active background subagent at a time.
- **Stop contract** is staged:
  1. first stop interrupts foreground Orchestrator streaming;
  2. second consecutive stop, if the same child remains active, escalates to child termination.
- **Pinned status surface**: while the active-child state exists, Web and TUI should render a bottom-pinned subagent status surface showing child identity, task title, latest progress/step evidence, and a child-session entry affordance.
- **Presentation strategy**: first implementation should prefer extending the existing thinking / elapsed bottom-status UI family, so active-child state appears as the same class of runtime activity indicator rather than a separate widget system.
- **Child-session entry differs by surface**:
  - Web may expose a route URL / clickable child-session link.
  - TUI must use its own session-tree jump/navigation mechanism instead of URL rendering.
- The pinned status surface must remain mounted until authoritative runtime evidence shows either:
  - the parent continuation has taken over and active-child state is cleared; or
  - the child failed / was terminated and active-child state is cleared.
- The transcript-local `SubagentActivityCard` remains a detail surface, but it is no longer sufficient as the only operator-visible child-activity surface once continuous orchestration is active.
- Continuation cleanup order is authoritative: when `TaskWorkerEvent.Done/Failed` arrives, the parent continuation path clears `active-child` before persistence / resume work proceeds, so the parent control plane does not keep advertising a stale wait state.

**Dispatch 規則**:

- SYSTEM.md §2.3: 一次只派出一個 subagent（sequential execution）
- Prompt-level soft enforcement（無 runtime 強制阻擋）

### Subagent Worker Lifecycle

- **Spawn**: `Bun.spawn([bun, run, index.ts, session, worker])` — independent OS process, no shared memory with daemon
- **IPC**: Bidirectional stdin/stdout JSON-line protocol: `{type:"run"|"ready"|"heartbeat"|"done"|"bridge_event"|"error"}`
- **No timeout**: Workers are waited on unconditionally. The only termination trigger is subprocess death (process exit detected by stdout reader loop). No inactivity timeout exists; long-running LLM calls are expected.
- **Liveness**: `worker.proc.exitCode` checked after unexpected stdout close to distinguish crash from clean exit
- **Instance context**: `spawnWorker()` captures `Instance.directory` at spawn time and passes it as Bus event context to all `TaskWorkerEvent.Done/Failed` publishes, so the continuation subscriber can re-establish `Instance.provide()` scope after the originating HTTP request scope has ended.
- **Bridge events**: Worker stdout `__OPENCODE_BRIDGE_EVENT__` lines forwarded to parent via `Bus.publish` for SSE/UI visibility

### Performance Hardening (Phase θ)

- **SDK LRU Cache**: `sdkSet()` in `src/provider/provider.ts` — Map-based FIFO eviction (MAX_SIZE = 50)
- **Server Idle Timeout**: 120s for both TCP and Unix socket modes

### Deployment (webctl.sh)

- `compile-gateway`: Compiles `daemon/opencode-gateway.c` via gcc
- `gateway-start`: Compiles + starts gateway daemon (nohup, PID file tracked)
- `gateway-stop`: Graceful SIGTERM → wait → SIGKILL fallback
- `reload`: Auto-detects dev/prod mode. Dev: kills per-user daemons (bun re-reads source on next request). Prod: builds binary + atomic install + kill daemons.
- `restart`: Runs `reload` then recompiles and restarts gateway if source changed.
- `install.sh --system-init`: Installs `opencode-gateway.service` + `opencode-user@.service` systemd units + gateway binary + login page

### systemd Units

- `opencode-gateway.service`: Root-level gateway daemon (`/usr/local/bin/opencode-gateway`)
- `opencode-user@.service`: Per-user daemon template (`/usr/local/bin/opencode serve --unix-socket ...`)
