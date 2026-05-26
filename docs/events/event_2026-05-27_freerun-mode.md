# event 2026-05-27 — harness/freerun-mode v1

## What changed

Introduced **freerun mode** — a stateless iteration runloop targeting local-GPU weak models. Each iteration:

1. Picks the next ContextNode from a persisted tree (BFS-plan-to-depth-N then DFS preorder)
2. Synthesizes a fresh prompt (navigation band + node detail block) — **no dialog history**
3. Calls the LLM (planning → schema-enforced JSON, execution → Option D Claude-style tools)
4. Writes the outcome back to the node's markdown file
5. Consolidates if the subtree settled

The mode is opt-in per provider via `opencode.json`:
```json
"provider": {
  "custom-provider-work": {
    "mode": "freerun",
    "options": { "baseURL": "http://127.0.0.1:7731/v1" },
    "models": { "qwen3.6-35b-a3b-q4_k_m": { /* ... */ } }
  }
}
```

## Why

Existing turn-based runloop accumulates dialog context until the context window forces compaction. With local LLMs (no API cost) the design constraint is **GPU time, not token count** — stateless iteration with structured state-handover trades cache thrash for unbounded session length. Plan structure + state payload becomes the load-bearing artifact, not message history.

Product positioning: 智慧家電核心引擎 (smart appliance core engine) for 24×7 task-oriented operation. Long-term aspiration: work-replicant via emergent skill accumulation (Voyager-flavored).

## Architecture

```
packages/opencode/src/freerun/
├── types.ts                   Zod schemas (single source of truth)
├── storage/
│   ├── node-fs.ts             atomic per-node markdown writes
│   └── tree.ts                tree ops + pickNext core
├── render/
│   ├── navigation-band.ts     always-present global header (4 policies)
│   ├── node-detail.ts         current node renderer
│   ├── prompt-template.ts     planning/execution + JSON schema via z.toJSONSchema()
│   └── tool-filter.ts         DD-19 dynamic tool catalog filtering
├── policy/
│   └── pick-next.ts           thin DD-3b wrapper
├── runtime/
│   ├── iterate.ts             DD-3d single iteration primitive
│   ├── consolidate.ts         DD-3c subtree consolidation + archive
│   └── engine.ts              full-session loop driver
├── observability/
│   └── bus.ts                 24 typed Bus events + safe emit helpers
├── provider/
│   └── llm-client.ts          OpenAI-compatible HTTP client + agent loop
└── trigger/
    ├── goal.ts                idempotent root-seed + drive
    ├── cron.ts                JSON task-file loader for OS cron
    └── watchdog.ts            event-driven (fs-watch in v1, others stubbed)

packages/opencode/src/session/
├── freerun-bridge.ts          detect / hasActiveRoot / seedRoot / drive
├── workflow-runner.ts         freerun_iterate routing in decideAutonomousContinuation
├── compaction.ts              isOverflow + shouldCacheAwareCompact bypass for freerun
└── llm.ts                     x-opencode-mode=freerun + x-opencode-session-id headers
```

CLI surface:
- `opencode freerun-goal --provider <p> --model <m> --goal "<text>"`
- `opencode freerun-smoke ...` (debug-oriented variant)
- `opencode freerun-cron <taskFile.json>`
- `opencode freerun-status [<sessionID>]`
- `opencode freerun-tree <sessionID>`

## Validation

- **78 unit tests** across 8 files all green (storage, render, policy, runtime, trigger, privacy invariant)
- **End-to-end smoke** against rawbase `custom-provider-work` Qwen3.6-35B-A3B succeeded twice:
  - 1-iter session: planning emitted 3 children, root flipped to decomposed
  - 4-iter cap, completed in 2 iters: planning + execution + consolidation; root.md persisted with consolidated_summary
- **DD-11 privacy invariant** enforced by static-analysis test: only `provider/llm-client.ts` may make network calls; every other freerun module is pure local computation
- **Compaction bypass** wired in `session/compaction.ts` (isOverflow + shouldCacheAwareCompact short-circuit for freerun providers)
- **Sidecar correlation** via `x-opencode-mode=freerun` header injection

## Telemetry contract

24 Bus events under the `freerun.*` namespace (`session.started/paused/resumed/terminated/refused`, `iteration.*`, `llm.*`, `decision/children/observation`, `tool.*`, `skill.*`, `node.stateTransition`, `blocker.*`, `replan/consolidation`). aisecurity sidecar correlates by `x-opencode-session-id` + `x-opencode-iteration` + `x-opencode-node-id` headers.

## Known limitations (v1)

- `freerun-pause` / `freerun-resume` CLIs not shipped — engine doesn't run as a long-lived daemon yet; resume of an interrupted goal trigger is just re-running `freerun-goal --session <existing-id>` (auto-resumes on existing root).
- `decideAutonomousContinuation` returns `{continue:true, reason:"freerun_iterate"}` for freerun sessions, but the synthetic-message dispatcher in `session/prompt.ts` doesn't yet route this to `FreerunBridge.drive(...)`. Engine-via-autonomous-opt-in is therefore still manual. Production goal triggers (via the CLI) are fully functional.
- watchdog trigger v1 only implements the `fs-watch` source kind; `http-webhook` / `dbus` / `bus-event` schemas are declared but `attach()` throws for those.
- The pre-existing `~/.local/bin/opencode` shim on PATH points at a stale binary; smoke runs must invoke `/usr/local/bin/opencode` until the user updates their shell alias.

## Plan / spec

Full design + spec + observability + test vectors live under `plans/harness_freerun-mode/` (gitignored per `feedback_plans_are_private`). When the plan graduates from `implementing` → `verified`, contents will migrate to `specs/`.

## Branches

- Engine library: 8 commits on `beta/freerun-mode` (worktree `/home/pkcs12/projects/opencode-beta`)
- Integration + CLIs: 5 commits on `test/freerun-mode` (main repo `/home/pkcs12/projects/opencode`)

Both branches are part of the same plan; `test/freerun-mode` already merged `beta/freerun-mode` and added the session-machinery wiring + CLI surface. Branches will be deleted post-merge to main per `beta/*` / `test/*` conventions.
