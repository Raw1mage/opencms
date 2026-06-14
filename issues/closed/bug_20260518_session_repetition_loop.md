# Bug: Main agent repeated itself and burned tokens/time during an interrupted Grafcet debugging session

Status: Resolved (closed 2026-05-29; prompt.ts paralysis detector)

## Summary

During a `drawmiat` Grafcet renderer debugging session, the main agent entered a repetition loop after the user redirected the investigation and later asked `還在嗎`. The agent repeatedly emitted nearly identical preambles, re-read the same files, and rewrote similar todos instead of advancing the requested investigation. Each loop consumed significant tokens and wall-clock time.

## Impact

- User-visible latency increased because the agent kept restarting the same local context-gathering step.
- Token usage increased from repeated `read`, `grep`, `glob`, and `todowrite` calls with equivalent intent.
- The actual requested work was not advanced: the user wanted investigation of L3 routing line overlap, especially `S0O1G1I1` and `S1O1G2I1`.
- The user had to explicitly stop the run with `停`.

## Session Context

- Date: 2026-05-18 Asia/Taipei.
- Active repo: `/home/pkcs12/projects/drawmiat`.
- Target code area: Grafcet renderer/canonicalizer.
- Mandatory contract involved: `drawmiat/specs/grafcet-renderer-contract.md`.
- Main files touched earlier in the session:
  - `drawmiat/webapp/service.py`
  - `drawmiat/webapp/grafcet_renderer.py`
  - `drawmiat/docs/events/event_20260517_grafcet_json_revalidate.md`
- Generated output directory: `drawmiat/output/grafcet-unpooled-cisopro-asset-inventory/`.

## What Had Happened Before The Loop

1. The user asked to inspect an unpooled Grafcet JSON and generate SVG/debug SVG output.
2. The sample used was `drawmiat/samples/grafcet/cisopro/plans_20260416_cisopro-asset-inventory_grafcet.json`.
3. The agent found several renderer/canonicalizer issues:
   - `G7` was split between a strict declared gate and a legacy transition-derived gate.
   - `G7O1S3I1` looked disconnected because the same canonical gate had two visual authorities.
   - `S7O1G8I2` initially violated box-output drop behavior after L3c detour.
4. The agent made WIP edits:
   - In `service.py`, legacy-to-canonical conversion was adjusted to retain original source metadata for convergence inputs.
   - In `grafcet_renderer.py`, strict declared gates were promoted as L2 authority and some legacy generic gate behavior was demoted.
   - In `grafcet_renderer.py`, step-bottom-output to gate-input routes were adjusted to preserve initial drop.
5. Regression pool status after these WIP changes was not clean: `passed=6 changed=5 failed=0`; changed baselines were intentionally not accepted.

## User Correction That Triggered The Relevant Investigation

The user clarified that the remaining issue was not about treating L3d condition stubs as obstacles:

> 每個routing的結尾階段，應該是L3d吧。會放stubs。那個階段放的是合法的stub. 不是障礙。目前的主要問題是線段重疊。你專心查為什麼routing會去走重疊的線段，例如S0IO1G1I1和S1O1G2I1的重疊

Expected behavior after this correction:

- Stop pursuing the `stub-as-obstacle` hypothesis.
- Remove or isolate the WIP `retry_horizontal_lanes_after_stub_resolution` experiment.
- Inspect actual final route points for `S0O1G1I1` / `S1O1G2I1`.
- Find why L3 lane allocation allows overlapping same-axis segments.

Actual behavior:

- The agent repeatedly said it would refocus on line overlap.
- It repeatedly re-read the Grafcet contract and nearby `grafcet_renderer.py` sections.
- It repeatedly created/recreated near-identical todo lists.
- It did not reach a new RCA or patch for the overlap issue before the user stopped it.

## Repetition Pattern Observed

The repeated visible messages included variants of:

- `我會先把焦點收回 L3 線段重疊...`
- `我先重新對齊 renderer contract...`
- `還在。我會先撤掉剛才錯誤的 stub/障礙方向...`
- `我會先撤掉剛才那個錯誤的 stub/障礙方向，改查 L3 為什麼允許線段重疊。`

Repeated tool patterns included:

- Multiple reads of `drawmiat/specs/grafcet-renderer-contract.md`.
- Multiple reads of nearby `drawmiat/webapp/grafcet_renderer.py` offsets around L3 routing.
- Multiple greps for similar patterns such as `retry_horizontal_lanes_after_stub_resolution`, `allocated_vertical_lanes`, `_detour_around_obstacles`, and overlap-related terms.
- Multiple `todowrite` calls with semantically equivalent plans, such as confirming L3 state, extracting S0/S1 route overlap evidence, removing stub-as-obstacle experiment, fixing L3 overlap avoidance, and regenerating debug SVG.

## Suspected Failure Mode

This looked like a continuation/replanning loop in the main agent orchestration layer:

- After user interruption/correction, the agent acknowledged the new direction but did not commit to a single next concrete action.
- The visible todo ledger was rewritten several times instead of being used as a stable execution ledger.
- The agent repeatedly restarted “read contract / inspect L3” rather than using already available context or recalling prior reads.
- A later `還在嗎` user prompt caused another repetition of the same acknowledgement + context-gathering pattern.
- The final stop prompt (`停`) was needed to break the loop.

## Useful Debug Signals To Inspect

- Main-agent handling of mid-run user messages and system reminders.
- Duplicate or near-duplicate `todowrite` suppression: exact byte-equivalent calls may be detected, but semantically equivalent rewritten todo lists still caused churn.
- Whether preamble-only progress messages plus repeated read/search calls satisfy autonomous continuation heuristics even when no real progress is made.
- Whether post-compaction/amnesia state caused the agent to distrust narrative context and repeatedly re-read the same contract/source files.
- Whether the orchestrator should detect repeated `read`/`grep` sequences against the same files/patterns within one user turn and warn or force a concrete action.

## Expected Guardrails

- After a user correction, require one stable replan and then a concrete next action.
- Avoid repeated reads of the same contract/source files when the working cache or prior tool index already has the content.
- Treat repeated semantic todo rewrites without code/data progress as potential loop behavior.
- When the user asks `還在嗎`, answer status once and continue with the next concrete action, not another full restart of the investigation.
- Consider a loop detector over recent tool-call intent, not only exact duplicate arguments.

## Current WIP Risk From The Session

At the time the user stopped the session, the `drawmiat` repo likely still had WIP changes, including a questionable `stub-as-obstacle` retry experiment in `webapp/grafcet_renderer.py`. That experiment should be reviewed or reverted before continuing the Grafcet work, because the user explicitly rejected that direction.

## Reproduction Sketch

1. Start a complex code-debugging session with a plan/todo ledger.
2. Accumulate several rounds of file reads, WIP patches, generated outputs, and validation commands.
3. Have the user correct the root-cause direction mid-run.
4. Observe whether the agent repeatedly re-reads the same contract/source files and rewrites semantically similar todos instead of advancing to a concrete diagnostic or patch.
5. Ask `還在嗎` while it is looping.
6. Observe whether the agent repeats the same “I will refocus” message and repeats similar tool calls.

## Suggested Priority

High. The behavior is not a correctness bug in user code, but it directly wastes model quota, user time, and can prevent long-running debugging sessions from converging.
