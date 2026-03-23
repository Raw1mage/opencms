# Handoff

## Execution Contract
- Build agent must read implementation-spec.md first.
- Build agent must read design.md (DD-1 through DD-10) for all architectural decisions.
- Build agent must read proposal.md / spec.md / tasks.md before coding.
- Materialize tasks.md into runtime todos before coding.
- Preserve planner task naming in user-visible progress and runtime todo.
- Prefer delegation-first execution for bounded slices, but do not delegate documentation sync.
- Do not add fallback routing, default user selection, or silent attach fallback.
- **FIRST: Load skill "code-thinker" before starting any code work.**

## Required Reads
- implementation-spec.md
- design.md (especially DD-1 through DD-10)
- proposal.md
- spec.md (REQ-1 through REQ-11)
- tasks.md
- `daemon/opencode-gateway.c`
- `docs/events/event_20260319_daemonization.md`
- `specs/architecture.md`

## Current State
- **Gateway code is a prototype that only passes compilation.** Core data paths (HTTP proxy, SSE streaming, WebSocket upgrade) have never been runtime-verified.
- **Session 3 baseline is valid**: JWT claim validation (sub + exp + getpwnam → uid), identity routing (find_or_create_daemon + uid match), daemon lifecycle (adopt/spawn/wait-for-ready) are in the code and should be preserved.
- **Structural issues remain unaddressed** (new in this plan revision):
  - Event loop blocked by synchronous recv() and PAM auth
  - HTTP request assumed complete in single recv() call
  - epoll cannot distinguish client_fd vs daemon_fd (shared data.ptr)
  - Connection lifecycle: g_nconns only incremented, no EPOLL_CTL_DEL, use-after-close risk
  - JWT secret regenerated on every restart
  - No login rate limiting
  - WSL2 environment: /run/user/ may not exist
  - OPENCODE_BIN with spaces goes through sh -c after setuid

## Stop Gates In Force
1. **Thread-safety**: If PAM thread-per-auth model introduces uncontrollable thread-safety issues → re-evaluate, consider fork-per-auth
2. **HTTP buffering complexity**: If state machine complexity exceeds controllable scope → evaluate lightweight HTTP parser library
3. **WSL2 fallback path**: User must confirm DD-7 (restore /tmp fallback with explicit detection) before Phase 4 implementation
4. **Runtime verification environment**: If V4-V7 (SSE, WebSocket, multi-user, stress) cannot be completed due to environment constraints → record deferred evidence, do not fake completion
5. **Architecture boundary**: If any modification would alter core gateway/per-user daemon boundary → return to planning mode

## Phase Execution Order
1. **Phase 1** (Event Loop) — must be done first; all subsequent phases depend on non-blocking architecture
2. **Phase 2** (epoll + Connection) — depends on Phase 1 (PendingRequest and EpollCtx share design space)
3. **Phase 3** (Security) — independent of Phase 1-2 in terms of code, but should be done after to avoid rework
4. **Phase 4** (Environment) — STOP GATE for WSL2 fallback confirmation before coding
5. **Phase 5** (Verification) — after all code phases complete
6. **Phase 6** (Documentation) — after verification

## Build Entry Recommendation
- Start with Phase 1 tasks 1.1-1.3 (non-blocking accept + HTTP buffering). This is the foundation.
- Phase 1.4 (thread-per-auth) can be tackled after 1.1-1.3 since it adds pthread integration.
- Phase 2 should follow immediately as it shares the EpollCtx redesign.

## Execution-Ready Checklist
- [x] Proposal identifies all structural gaps
- [x] Spec covers all requirements (REQ-1 through REQ-11)
- [x] Design documents all decisions (DD-1 through DD-10)
- [x] Implementation spec defines phased execution with stop gates
- [x] Tasks are structured with phase/item numbering
- [x] IDEF0 has decomposition for all activities
- [x] GRAFCET models full request lifecycle with sub-grafcets
- [x] C4 correctly maps components and relationships
- [x] Sequence diagrams cover buffering, auth, splice, and cleanup flows
- [x] Handoff documents current state, stop gates, and execution order
