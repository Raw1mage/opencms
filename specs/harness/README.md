# harness

> Wiki entry. Source of truth = current code under
> `packages/opencode/src/agent/`, `packages/opencode/src/session/` (runloop,
> autorun, workflow-runner, mandatory-skills), `packages/opencode/src/tool/`
> (`task.ts`, `question.ts`), `packages/opencode/src/question/`,
> `packages/opencode/src/scheduler/`, and `packages/opencode/src/cron/`.
> Replaces the legacy spec packages `agent_framework`,
> `responsive-orchestrator`, `subagent-quota-safety-gate`,
> `mandatory-skills-preload`, `scheduler-channels`, `question-tool-abort-fix`,
> and `question-tool-input-normalization`. The
> [autonomous-opt-in/](./autonomous-opt-in/) sub-package remains
> in-flight (R1/R2/R3 unfinished) and is preserved as a child here.
>
> Renamed from `specs/agent-runtime/` 2026-05-09 to a
> harness-scoped name covering the broader agent loop / runloop
> coordination that the package code already encompasses.

## Status

partially shipped, with two diverged areas.

| Source folder                          | State in code                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `agent_framework`                      | legacy taxonomy folder, no `.state.json`. The agent registry it points at is live (`agent/agent.ts`); its slices are reference reading only. |
| `autonomous-opt-in`                    | partial. Verbal arm/disarm detector + `workflow.autonomous.enabled` gate are live. R1/R2/R3 (spec-binding + question-based arm) **not** in code. |
| `responsive-orchestrator`              | shipped. `task` tool dispatches async, `PendingSubagentNotice` + `task.completed` bus event + proc-scan watchdog all live. |
| `subagent-quota-safety-gate`           | partial. Subagent has a soft "wrap-up next turn" path keyed on `subagent_quota_low_red_line_percent`. The hard "cancel mid-turn" gate from the spec is **not** in code. |
| `mandatory-skills-preload`             | shipped. `mandatory-skills.ts` + `loadAndPinAll` driven from `capability-layer-loader.ts`. AGENTS.md + `coding.txt` sentinels both honored. |
| `scheduler-channels`                   | scheduler-baseline shipped (cron `heartbeat.ts` boot-recovery + skip-to-next + retry backoff). Channel isolation / channel-scoped kill-switch **not** built — kill-switch is workspace-scoped, not channel-scoped. |
| `question-tool-abort-fix`              | shipped. `Question.ask` honors `AbortSignal`; webapp QuestionDock has FNV-1a cache key. |
| `question-tool-input-normalization`    | shipped. `Tool.define` runs `parameters.parse` and forwards parsed args; `processor.ts` re-normalizes on persist (DD-3). |

`scheduler-channels` and `agent_framework` are pre-plan-builder legacy folders; treat them as historical proposals where they describe behavior absent from the codebase.

## Current behavior

### Agent loop & autonomy

#### Agent registry

`Agent.list()` enumerates agent definitions assembled from built-in prompt files (`agent/prompt/<name>.txt` — `coding`, `planner`, `explore`, `review`, `summary`, `title`, `vision`, `pdf-reader`, `compaction`, `cron`, `docs`, `testing`) merged with user / project config. Each agent has `mode ∈ {primary, subagent, all}`, a permission ruleset, and an optional model pin. `Agent.defaultAgent()` honors `cfg.default_agent`, otherwise picks the first non-subagent visible agent.

Note that **inline agent switch** is shelved (see `MEMORY.md → project_inline_agent_switch.md`); switching agents mid-session still requires a new session.

#### Autonomous continuation gate

The runloop's continuation engine is `planAutonomousNextAction` in `session/workflow-runner.ts:568`. On each turn boundary it returns `{type: "continue", text, todo}` or `{type: "stop", reason}`. Stop reasons currently in use: `subagent_session`, `not_armed`, plus the natural `todo_complete` paths.

Two structural rules in `planAutonomousNextAction`:

- **Subagent never auto-continues.** If `session.parentID` is set, return `{type: "stop", reason: "subagent_session"}`. Subagents are driven entirely by their parent's task tool.
- **`workflow.autonomous.enabled === false` → not_armed.** Sessions begin with this flag in whatever shape `Session.defaultWorkflow()` returns.

The verbal arm/disarm intent detector (`session/autorun/detector.ts`) is the **only** path that flips `workflow.autonomous.enabled` at runtime. On every user message, `prompt.ts` extracts the user-typed text (synthetic parts excluded) and matches against `Tweaks.autorunSync().triggerPhrases` / `disarmPhrases` (case-insensitive substring). A match calls `Session.updateAutonomous` and logs `autorun arm via verbal trigger` / `autorun disarm via verbal trigger`.

The continuation text injected for both `pending` and `in-progress` todos is the constant `AUTONOMOUS_RESUME_TEXT = "Continue with the current work based on the existing session context."` (workflow-runner.ts:28). The runloop renders this as a synthetic user message on the next turn.

#### Divergence from `autonomous-opt-in` spec

- **R1 (spec-binding required to arm)** is not enforced. There is no `session_active_spec` Storage key; arming requires only a phrase match.
- **R2 (non-empty todolist required to arm)** is not enforced at the arm site. The runloop will idle out naturally if `nextActionableTodo` returns `null`, but arm itself succeeds.
- **R3b (question-based arm from `plan-promote`)** is not implemented. Only R3a (verbal trigger) is.

The "Autonomous Methodology Gate" (`MEMORY.md → feedback_autonomous_methodology.md`) lives outside code: it is a behavioral expectation on the LLM that during the action phase it goes spec → tasks.md → todowrite, not as a runtime check.

The "Stage 5: Drain-on-Stop" subsystem is **deleted** — see `MEMORY.md → project_stage5_drain_model.md`. There is no governor, no drain mode. Stopping is silent (`feedback_silent_stop_continuation.md`).

### Subagent dispatch & quota

#### Async dispatch (responsive-orchestrator R1)

`task` tool (`tool/task.ts`) returns immediately after queueing the subagent. The tool result carries `metadata.dispatched: true` and a stub output; the parent assistant turn finishes without awaiting subagent completion. Multi-subagent dispatch in one turn is supported up to lane concurrency.

#### Wake-only result delivery (R2)

When a subagent worker writes a terminal `finish` to its session, or its process exits, the parent's proc-scan watchdog (`task.ts:2239-2469`) fires `TaskCompletedEvent` (`tool/task.ts:274`). The subscriber appends a `PendingSubagentNotice` entry to the parent session's `info.json#pendingSubagentNotices`. On the parent's next prompt assemble, the assembler renders the notice as a system-prompt addendum and pops it from the array. **No message is appended to the parent session's `messages/` stream** — the user's chat surface stays clean human↔assistant.

`TaskCompletedEvent.status` ∈ `{success, error, canceled, rate_limited, quota_low, worker_dead, silent_kill}`. Each carries `jobId`, `parentSessionID`, `childSessionID`, `finish`, `elapsedMs`, optional `errorDetail`, `rotateHint`, `cancelReason`, and the subagent's `result` payload.

#### Proc-scan watchdog (unified)

The single `setInterval` poll at `task.ts:2346` replaces three earlier watchdogs (livenessTimer + disk-watchdog + no-progress watchdog). Each tick checks: (a) disk-terminal finish past grace → `disk_terminal`; (b) worker process state terminal (Z/X) → `worker_dead`; (c) worker process exited → `worker_dead`; (d) silent past threshold → `silent_kill`. Whichever fires first, the parent-side completion handler emits `TaskCompletedEvent` and the bridge work detaches.

This is the locus of the "Subagent hang" pattern (`MEMORY.md → project_subagent_hang_pattern.md`): if the worker process is alive but mid-tool-call hung, none of the four conditions fire, so the parent waits for `silent_kill` threshold. The "bridge silence" dimension proposed in MEMORY is not yet wired.

#### Subagent rate-limit escalation

Subagents do **not** self-rotate accounts. When a child session's stream returns rate-limit, `processor.ts` sets `isChildSession = true`, increments `cumulativeEscalationCount` (capped `MAX_CUMULATIVE_ESCALATIONS = 5`), and emits `TaskRateLimitEscalationEvent` to the parent. The parent decides the new model; child re-dispatches with parent's choice.

#### Subagent proactive quota wrap-up (R6, the only quota gate present)

Inside `processor.ts:1357-1399`, after each successful subagent stream:

1. If `isChildSession && quotaLowRedLinePercent > 0` and provider is `codex` / `openai`, probe `getOpenAIQuota(accountId, {waitFresh: false})`.
2. If `quota.hourlyRemaining < quotaLowRedLinePercent`, set `quotaLowExitRequested = true` and snapshot account + remaining percent.
3. On the next top-of-loop check, the runloop injects a wrap-up system directive and dispatches one final turn. Post-turn handler writes `finish: "quota_low"` and breaks.

Threshold is `Tweaks.subagent().quotaLowRedLinePercent` (knob `subagent_quota_low_red_line_percent`, range 0-50, default off when 0). The `PendingSubagentNotice.rotateHint` populated from `quotaLowSnapshot` carries `directive: "rotate-before-redispatch"`.

#### Divergence from `subagent-quota-safety-gate` spec

The spec called for a **hard runtime gate** that cancels the subagent runloop with `CancelReason = "quota-gate-trip"` *before* the LLM sees the next request. Current code only has a **soft wrap-up gate** that lets the model finish one more turn. There is no `subagent.quota_gate_enabled` knob, no `triggerWindow` field, no `tripped` field on the result. The spec also called for differentiating subagent vs main vs mcp-handover via `session.source`; that field is not present.

The `cancel_task` tool (`tool/cancel-task.ts`, called via `cancelByJobId` at `task.ts:814`) does provide an out-of-band cancel path that delivers as a `PendingSubagentNotice` with `cancelReason`, but it is invoked by the orchestrator, not by an autonomous quota gate.

### Skill preload

#### Sentinel grammar

`session/mandatory-skills.ts` parses markdown blocks bounded by `<!-- opencode:mandatory-skills -->` … `<!-- /opencode:mandatory-skills -->`. Inside, lines matching `^\s*-\s+(.*)$` are bullets; `#` starts a trailing comment; empty bullets are skipped. Multiple blocks per file are concatenated then deduped, preserving first-seen order. Unclosed blocks log `[mandatory-skills] unclosed sentinel block` and are dropped.

#### Source resolution

`resolveMandatoryList(input)` reads three sources, in this priority for dedup:

1. `<project-root>/AGENTS.md` (`agents_md_project`)
2. `~/.config/opencode/AGENTS.md` (`agents_md_global`)
3. `packages/opencode/src/agent/prompt/coding.txt` (`coding_txt`) — only when `agent.name === "coding"`

Project sources win on ordering; global supplies what project doesn't list; coding.txt only for coding subagents. Other subagent kinds (e.g. `planner`, `vision`) **only** read their own agent prompt's sentinel block, never coding.txt.

#### Preload + pin

`preloadMandatorySkills` walks the resolved list, calls `Skill` discovery for each name, and on hit calls `SkillLayerRegistry.recordLoaded` + `.pin` with `keepRule: "mandatory:agents_md"` or `"mandatory:coding_txt"`. Pinned skills are exempt from idle-decay. `loadAndPinAll` is the combined "resolve + reconcile + preload" entry point invoked by `capability-layer-loader.ts:52`.

#### Failure mode

If a skill is in the mandatory list but its SKILL.md doesn't exist on disk:

- `log.warn("[mandatory-skills] skill file missing", {skillName, searchedPaths, source, sessionID})`
- Append a runtime event `skill.mandatory_missing` with the same context
- **Do not throw.** Prompt assembly continues with the remaining skills.

The agent prompt's coding.txt explicitly documents this: "If the SKILL.md is missing on disk (runtime will log a `skill.mandatory_missing` anomaly event), you may call `skill({name: "code-thinker"})` yourself as a fallback — but under normal circumstances runtime preload handles it."

The legacy `agent-workflow` skill is retired; its rules either moved into `code-thinker` (Syslog Debug Contract) or into AGENTS.md sentinels.

### Tool surface (question, etc.)

#### Tool input normalization (Tool.define)

`tool/tool.ts:63-104` is the canonical wrapper. On invocation:

```
parsed = toolInfo.parameters.parse(args)   // line 75
result = await execute(parsed, ctx)         // line 85
```

Any `z.preprocess` / `z.transform` / `z.default` at the parameter schema layer therefore actually rewrites the args the tool sees. On `ZodError`, if the tool defines `formatValidationError`, the wrapper throws `Error(formatted, {cause: ZodError})`; otherwise a generic message. `execute()` is never called with raw args.

#### Question tool

`tool/question.ts` uses `z.preprocess(Question.normalize, z.object({questions: z.array(...)}))`. The normalizer (`question/index.ts`, `Question.normalize` → `normalizeQuestionInput`) handles two LLM-noncompliant shapes:

- **Flat single-question input** `{question, options, multiple}` → wrapped into `{questions: [{question, header: question.slice(0,30), options, multiple}]}`.
- **String options** `["A", "B"]` → `[{label: "A", description: "A"}, {label: "B", description: "B"}]`.

Canonical-shape inputs pass through unchanged. Failed normalize keeps raw and lets the `formatValidationError` (`SCHEMA_HINT`) help the LLM retry — this is the "lazy loader schema-miss" pattern (`MEMORY.md → feedback_lazy_loader_schema_miss.md`).

#### Question abort

`Question.ask({sessionID, questions, tool, abort})` (`question/index.ts:122-200`) wires the pending entry to the caller's `AbortSignal`:

- **Pre-aborted signal:** short-circuit with `RejectedError("pre-aborted: <reason>")`. No `question.asked` published, no pending entry written.
- **Late abort while pending:** `pending[id]` deleted, `Bus.publish(Event.Rejected, {sessionID, requestID})` once, promise rejects with `RejectedError("aborted: <reason>")`. Reason taken from `signal.reason` (or `"unknown"`).
- **Manual reply wins late abort:** if reply already resolved and deleted `pending[id]`, the abort handler is a no-op (no double publish).

`SessionPrompt.cancel(sessionID, reason)` propagates a labeled reason (`"manual-stop"`, `"rate-limit-fallback"`, watchdog labels, etc.) into `controller.abort(reason)`. Downstream Question handlers receive the label via `signal.reason`.

#### QuestionDock cache (webapp)

`packages/app/src/components/question-cache-key.ts` builds an FNV-1a 32-bit hex hash over a canonical-JSON of the question content. The cache is per-session, keyed by `(sessionID, contentHash)`, so:

- AI re-asks the same question after abort → hash matches → in-progress text / selections / tab restored.
- Different question content → hash miss → fresh empty store.
- Different session with same question → no leak across sessions.

FNV-1a was chosen over `SubtleCrypto.subtle.digest("SHA-1")` because the cache restoration must be sync at component mount — async hashing introduced a race where user typing overwrote restored input before the hash resolved.

#### Tool result persistence (DD-3)

`session/processor.ts:935-967` calls `ToolRegistry.getParameters(match.tool)` and re-runs `safeParse(rawInput)` before persisting. On success, `state.input` stores the **normalized** shape; on parse miss (e.g. registry lookup failure for an unknown tool), state.input stays raw with a debug log. `tool-error` (status `error`) preserves raw for debugging evidence.

This guarantees session replay and UI renderers see coerced shapes for `completed` calls.

### Scheduler & cron (channels not built)

#### Generic scheduler

`scheduler/index.ts` is a tiny `Map<id, Task>` + `Map<id, Timer>` per Instance. `Scheduler.register({id, interval, run, scope})` schedules a `setInterval`. Used by internal periodics (idle-MCP-unload, telemetry roll-ups). It is **not** the cron job runner.

#### Cron job runner

`cron/heartbeat.ts` is the durable scheduler. On daemon boot:

1. Load all enabled jobs from `CronStore`.
2. For each job, inspect `state.nextRunAtMs`:
   - Future → preserve (clean boot).
   - Past + within `STALE_THRESHOLD_MS = 5min` → fire normally.
   - Past + beyond stale threshold → `Schedule.computeNextRunAtMs(job.schedule, now)` for skip-to-next; one-shots whose `at` is past get `enabled = false, reason = "expired_on_boot"`.
   - Stale recurring with `consecutiveErrors > 0` → `nextRunAtMs = max(skip-to-next, now + backoffMs(consecutiveErrors))`.
3. Heartbeat ticks at minute cadence and dispatches due jobs through `cron/delivery.ts`.

`cron/retry.ts` owns the consecutiveErrors → backoff math for recurring jobs.

#### Channels: not implemented

The `scheduler-channels` spec's "channel isolation" + "channel-scoped kill-switch" + "per-channel health" sections describe an **architecture that was never built**. The current kill-switch (`server/killswitch/service.ts`) is **workspace-scoped** (`workspaceId: z.string().optional()`), not channel-scoped:

- Global kill-switch (no `workspaceId`) blocks all sessions everywhere.
- Workspace-scoped kill-switch only blocks sessions in that workspace.
- There is no `lanePolicy` per channel; lane concurrency is global.

Treat the channels portion of `scheduler-channels/spec.md` as planned-not-shipped. The durable-scheduler portion is shipped (see `cron/heartbeat.ts` and `slices/20260327_plan-enter-plans-20260327-durable-cron-scheduler/`).

## Code anchors

Agent registry & autonomy:
- `packages/opencode/src/agent/agent.ts` — `Agent.Info` schema (L20), `list` (L297), `defaultAgent` (L306).
- `packages/opencode/src/agent/prompt/*.txt` — built-in agent prompt files (`coding.txt`, `planner.txt`, `vision.txt`, etc.).
- `packages/opencode/src/session/autorun/detector.ts` — `detectAutorunIntent`, `extractUserText` (verbal arm/disarm).
- `packages/opencode/src/session/autorun/observer.ts` — autorun observability hooks.
- `packages/opencode/src/session/workflow-runner.ts` — `planAutonomousNextAction` (L568), `evaluateAutonomousContinuation` (L550), `AUTONOMOUS_RESUME_TEXT` (L28).
- `packages/opencode/src/session/prompt.ts` — runloop entry; verbal trigger ingest at L693-720; continuation dispatch at L2262-2302.
- `packages/opencode/src/config/tweaks.ts` — `autorun_*_phrases`, `subagent_quota_low_red_line_percent` (L468).

Subagent dispatch:
- `packages/opencode/src/tool/task.ts` — `TaskCompletedEvent` (L274), `TaskRateLimitEscalationEvent` (L307), `cancelByJobId` (L814), proc-scan watchdog (L2239-2469).
- `packages/opencode/src/tool/cancel-task.ts` — out-of-band cancel tool.
- `packages/opencode/src/session/subagent-workflow.ts` — subagent runloop wiring.
- `packages/opencode/src/session/processor.ts` — `isChildSession` rate-limit escalation + R6 quota wrap-up (L1357-1399).
- `packages/opencode/src/session/message-v2.ts` — `PendingSubagentNotice` schema.

Skill preload:
- `packages/opencode/src/session/mandatory-skills.ts` — sentinel parser, resolver, preload, reconcile (L51-400).
- `packages/opencode/src/session/skill-layer-registry.ts` — `recordLoaded`, `pin`, `keepRule`.
- `packages/opencode/src/session/capability-layer-loader.ts` — `loadAndPinAll` invocation (L52).
- `packages/opencode/src/agent/prompt/coding.txt` — coding subagent's `<!-- opencode:mandatory-skills -->` block (L11-13).

Tool surface:
- `packages/opencode/src/tool/tool.ts` — `Tool.define` wrapper (L63-104), `parameters.parse` at L75.
- `packages/opencode/src/tool/question.ts` — `QuestionTool` with `z.preprocess(Question.normalize, ...)` (L25-57), `SCHEMA_HINT` (L6-23).
- `packages/opencode/src/question/index.ts` — `Question.ask` abort wiring (L122-200), `Question.normalize`, `RejectedError` (L243).
- `packages/opencode/src/question/normalize.test.ts` — normalization regression coverage.
- `packages/opencode/src/session/processor.ts` — DD-3 normalize-on-persist (L935-967).
- `packages/app/src/components/question-cache-key.ts` — `canonicalJson`, `fnv1a32`.
- `packages/app/src/components/question-dock.tsx` — webapp dialog.

Scheduler & cron:
- `packages/opencode/src/scheduler/index.ts` — Instance-scoped task scheduler.
- `packages/opencode/src/cron/heartbeat.ts` — boot recovery (L86-155), stale handling.
- `packages/opencode/src/cron/retry.ts` — backoff (L113-172).
- `packages/opencode/src/cron/store.ts`, `delivery.ts`, `schedule.ts` — store + dispatch + cron-expression math.
- `packages/opencode/src/server/killswitch/service.ts` — workspace-scoped kill-switch (L73-385).

## Notes

### Caveats from operational memory

- **Subagent hang pattern** — proc-scan watchdog only catches process-level death + disk-terminal + silent-past-threshold. A worker that is mid-tool-call but stuck (e.g. an MCP call that never returns) survives all four conditions until the silent-past-threshold fires. The "bridge silence" watchdog dimension noted in `MEMORY.md → project_subagent_hang_pattern.md` is unbuilt.
- **Stage 5: Drain-on-Stop deleted** — the drain governor and pending-todo drain mode were ripped out (infinite-loop bug). No code path drains the todo list on stop. Re-enable would require autonomous gate + pending-todo-only + repetition guard. See `MEMORY.md → project_stage5_drain_model.md`.
- **Inline agent switch shelved** — agent switching mid-session is not supported; multi-process is the chosen model. See `MEMORY.md → project_inline_agent_switch.md`.
- **Autonomous methodology gate is behavioral, not runtime** — the "spec → tasks.md → todowrite" pipeline expectation lives in skill prompts (`code-thinker`, `plan-builder`), not in `planAutonomousNextAction`. See `MEMORY.md → feedback_autonomous_methodology.md`.
- **Apply-patch retry slow** — when `apply_patch` fails, the agent self-recovers but the UI freezes on the retry path. Pre-existing, not addressed by any of the eight source folders here.

### Divergences worth flagging in any future plan-builder revisit

1. **`autonomous-opt-in` R1/R2/R3b are unimplemented.** If R1 (spec-binding required) matters, it needs a `session_active_spec` Storage field, a `Todo.nextActionableTodo`-aware arm check, and a question-tool callback from `plan-promote`.
2. **`subagent-quota-safety-gate` hard-cancel gate is unimplemented.** Only the soft wrap-up exists. Hard-cancel would need a pre-stream check in `processor.ts` keyed on a separate `subagent.quota_gate_enabled` + `threshold` knob, with `session.source` taxonomy (`task-tool` / `user-initiated` / `mcp-handover`) added to the session schema.
3. **`scheduler-channels` channel isolation is unimplemented.** Kill-switch is workspace-scoped. Channels would need a new dimension on `Session.Info` and a refactor of `assertSchedulingAllowed`.
4. **`agent_framework` is a legacy taxonomy folder, not a runtime spec.** Its `slices/` and `sources/` are reading material; the live agent registry lives in `agent/agent.ts` and is not driven by anything under `specs/_archive/agent_framework/`.

## Sub-packages

- [autonomous-opt-in/](./autonomous-opt-in/) — **in-flight**. Verbal
  arm/disarm detector + `workflow.autonomous.enabled` gate are live;
  R1 (spec-binding required), R2 (validated-plan precondition), R3
  (question-based arm) are not yet in code. Lifecycle artifacts
  (proposal / design / tasks / handoff) are preserved in this
  sub-folder until R1–R3 land.

### Related entries

- [compaction/](../compaction/README.md) — subagent path through compaction (`deriveObservedCondition` does not skip subagents); rebind-checkpoint semantics that interact with task-tool re-dispatch.
- [session/](../session/README.md) — runloop, identity, capability layer, workflow shape (`workflow.autonomous.enabled`).
- [mcp/](../mcp/README.md) — `skill-finder` / `mcp-finder` MCPs that surface skills to the registry that `mandatory-skills.ts` then pins.
- [meta/](../meta/README.md) — `plan-builder` skill lifecycle that
  governs how legacy folders like `agent_framework` and
  `scheduler-channels` are superseded.
