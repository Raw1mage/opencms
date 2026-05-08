# Design: autonomous-opt-in

## Context

The runloop currently pumps autonomous continuations on every turn-end regardless of session context. The "Continuation Gate" prompt layer (see `packages/opencode/src/session/prompt/runner.txt`) recently softened the wording via an if/else self-check, but the pump itself is still unconditional — one full LLM round of latency per turn, even in chat.

This design lifts the arm/disarm decision out of the LLM and into a runtime flag keyed off plan-builder artifact state. The LLM stops being a gatekeeper and becomes purely an executor when autorun is armed. Arm/disarm is driven by two explicit signals (verbal trigger phrase, question tool answer) — no AI-inferred intent, no hidden heuristics.

## Goals / Non-Goals

### Goals

- Collapse L1-L3 compensating layers into a single, auditable runtime gate
- Make autonomous execution opt-in, with plan-builder artifact state as the canonical pre-condition
- Eliminate the ~30s gate-check round in chat-only turns
- Keep the semantics of armed execution unchanged so existing behavior (within implementing flow) is preserved byte-for-byte

### Non-Goals

- Provide a "run without plan" escape hatch (intentional coupling per user requirement)
- Infer intent from AI output (runtime reads user input and explicit question answers only)
- Change plan-builder's state machine (the `.state.json` lifecycle is untouched; we only add reader + a write hook for R6)
- Visualize armed state in TUI / webapp (follow-up spec)

## Decisions

- **DD-1** Arm state is ephemeral Storage, not `.state.json`. `[autorun_armed, sessionID] = {armed: bool, reason: string, at: timestamp}` lives under `Global.Path.user/storage/...`. Reason: `.state.json` is a durable plan artifact; arm state is a volatile session flag. Mixing them would force state mutations on every user interjection, flooding history with noise.
- **DD-2** Session-spec binding is a separate Storage key `[session_active_spec, sessionID] = slug`. Written by plan-builder scripts (`plan-promote.ts` on `--session` invocation), read by runtime. Single-direction ownership: scripts write, runtime reads. Unbinding happens on session close or explicit `plan-archive.ts`.
- **DD-3** Verbal trigger phrases live in `/etc/opencode/tweaks.cfg` under key `autorun.trigger_phrases` with a default seed array. Loaded through the existing `TweaksConfig` reader. Matching is whole-phrase, case-insensitive, anywhere in the user message (not limited to sentence start). Rationale: users shouldn't have to remember exact punctuation or position.
- **DD-4** Plan-edit demotion (R6) is implemented as a **hook in plan-builder write scripts** (primary), with optional file-watcher (secondary). Primary path: every `plan-*.ts` that mutates artifacts checks `state === "implementing"` at entry and, if so, demotes BEFORE applying its mode. Secondary path: a watcher on `specs/<active-slug>/*.{md,json}` fires the same demotion for raw-editor edits. OQ-1: ship with primary only in Phase 1; add watcher in Phase 2 if users bypass.
- **DD-5** Arming question (R3b) fires at **both** `--to planned` and `--to implementing` transitions. Rationale: some users promote to `planned` and want to immediately start; others stage `planned → review → implementing`. Letting the user answer "No" at either gate keeps autorun quiet without forcing two different promotion paths.
- **DD-6** Disarm is an atomic flag flip (`autorun_armed.armed = false`) + Bus event `autorun.disarmed`. Consumers (UI, telemetry) subscribe to the event for display. No cascade of cleanup is required because "disarmed" means the runloop simply doesn't pump again; in-flight work completes naturally.
- **DD-7** R6 demotion preserves in-flight work. Code changes already made in the current implementing phase stay. The demotion records a history entry `{mode: "revise", from: "implementing", to: "planned", reason: "plan artifact edit during implementing"}`. Re-promoting to `implementing` after the plan is re-reviewed resumes execution naturally.
- **DD-8** `/etc/opencode/tweaks.cfg` gains two keys with fallback defaults:
  - `autorun.trigger_phrases` (array of string) — default seed: `["start building", "go building", "start implementation", "開始實作", "執行計畫", "execute the plan"]`
  - `autorun.demote_on_disarm` (bool) — default `false` (per Q4 decision); opt-in for users who want strict re-arm flow
- **DD-9** The existing `runner.txt` Continuation Gate prompt is retained for armed sessions. The gate now serves its original intent (tell the AI "if you have work, do it; else silence") within the correct scope, rather than firing on every turn.
- **DD-10** Dead slash commands `/plan`, `/auto-yes-enabled`, `/auto-yes-disabled` in `use-session-commands.tsx` are deleted outright, not gated behind a migration flag. They were never wired correctly (the `/plan` handler re-types `/plan` into the input; auto-yes handlers are unused). Keeping them would mislead users.

## Risks / Trade-offs

- **R-1 Binding drift**: session is bound to a spec that gets renamed / archived out from under it. Mitigation: runtime reads `.state.json` each pump; if missing, `log.warn` and auto-disarm.
- **R-2 Trigger phrase false positive**: user says "I want to start building this feature later" — matches `start building`. Mitigation: Phase 1 ships with exact whole-phrase match (no fuzzy); users tune their phrase list; Phase 2 may add lookbehind for negative context.
- **R-3 Question tool MCP dependency**: plan-builder promote script requires the MCP question tool to be registered in the session. Mitigation: script prints a clear error + fallback instruction ("MCP question tool not available; arm by typing a trigger phrase instead") if the tool is absent.
- **R-4 File-watcher races** (OQ-1 Phase 2): watcher could fire during a plan-builder script's own atomic write. Mitigation: scripts acquire a short file-lock; watcher ignores writes inside the lock window.
- **R-5 Phase-rollover mis-parse of tasks.md**: `## N.` heading detection relies on consistent markdown structure. Mitigation: `plan-validate.ts` already checks tasks.md structure at `planned` promotion; invalid structure blocks the promote, so runtime never sees a malformed `tasks.md` in `planned+` states.
- **R-6 Intentional coupling surprises new users**: users not familiar with plan-builder may be confused why their session "doesn't run anything autonomously". Mitigation: first-time-per-session inform message when the runloop would have pumped but isn't armed — `log.info "autorun disabled by default; run plan-promote to arm, or type a trigger phrase"`.

## Critical Files

- `packages/opencode/src/session/workflow-runner.ts` — core runloop decision; all three "always-on" sites plus `enqueueAutonomousContinue` get the arm gate
- `packages/opencode/src/session/prompt.ts` — `handleContinuationSideEffects` (line ~390) must check arm state before calling `enqueueContinue`
- `packages/opencode/src/storage/**` — new `session_active_spec` and `autorun_armed` key namespaces
- `packages/opencode/src/config/tweaks.ts` — (or similar) extend the `TweaksConfig` reader with the two new keys
- `packages/app/src/pages/session/use-session-commands.tsx` — remove three dead commands
- `/home/pkcs12/.claude/skills/plan-builder/scripts/plan-promote.ts` — accept `--session`, invoke MCP question tool, write binding
- `/home/pkcs12/.claude/skills/plan-builder/scripts/plan-amend.ts` / `plan-revise.ts` / `plan-extend.ts` / `plan-refactor.ts` / `plan-sync.ts` — all get the R6 pre-check hook (ideally in a shared `scripts/lib/r6-demote.ts` helper)
- `/etc/opencode/tweaks.cfg` — add two new keys with seed defaults
- `specs/architecture.md` — update runloop section to describe arm-gated pumping

## Dependencies

- plan-builder `.state.json` schema (already stable)
- MCP `question` tool registration in the user's session (already configured in default skill layer)
- Storage API (already used by `SharedContext`, `RunQueue`, etc.)
- `TweaksConfig` reader (per feedback_tweaks_cfg)

## Rollout Strategy

Phase 1 (this spec's scope):
- Runtime arm gate at four call sites
- Storage keys + helpers
- plan-builder script hooks (R6) — primary detection path only
- tweaks.cfg keys with seed defaults
- Delete dead slash commands
- Tests for R0-R6

Phase 2 (follow-up, separate spec):
- File-watcher for R6 secondary path
- TUI/webapp badge showing armed state
- Telemetry on arm/disarm reasons for tuning the trigger phrase list

## Observability

- Bus events: `autorun.armed`, `autorun.disarmed`, `autorun.refill`, `autorun.refill_exhausted`, `autorun.demoted_by_edit`
- Log lines (all prefixed `[autorun]`): arm refused reasons, successful arms, disarm reasons, R6 demotions
- Metrics (future): arm count per session, average armed duration, disarm reason distribution
