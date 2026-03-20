# Handoff

## Execution Contract

- Build/implementation agent must read `implementation-spec.md` first.
- Build/implementation agent must read `tasks.md` before coding.
- Runtime todo must be materialized from `tasks.md` before execution continues.
- Build/implementation agent must not resume from discussion memory alone when this plan package is available.
- User-visible progress and decision prompts must reuse the same planner-derived todo naming.

## Required Reads

- `proposal.md` (including original requirement wording, revision history, and effective requirement description)
- `spec.md`
- `design.md`
- `implementation-spec.md`
- `tasks.md`

## Stop Gates In Force

- Preserve approval, decision, and blocker gates from `implementation-spec.md`.
- Return to plan mode before coding if a new implementation slice is not represented in planner artifacts.
- Do not create a brand-new sibling plan unless the user explicitly requests it, or explicitly approves an assistant proposal to branch.

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in `tasks.md`

## Completion / Retrospective Contract

- Review implementation against the proposal's effective requirement description.
- Generate a validation checklist derived from `tasks.md`, runtime todo outcomes, implementation results, and executed validations.
- Report requirement coverage, partial fulfillment, deferred items, and remaining gaps as concise review output.
- Do not expose raw internal chain-of-thought; expose only auditable conclusions and evidence.

## Diagram Traceability Matrix

| Diagram Node | Builder Meaning               | Primary Slice / Area                | Primary Files / Contracts                                                  |
| ------------ | ----------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| `A1`         | validate optimization effects | Slice D / build entry backbone      | `implementation-spec.md`, `tasks.md`, `idef0.json`                         |
| `A11`        | measure telemetry effects     | Slice B + Validation Plan           | `implementation-spec.md` validation section, `20260320_llm_a11_idef0.json` |
| `A111`       | estimate prompt tokens        | Slice B / prompt-block telemetry    | `packages/opencode/src/session/llm.ts`, token estimate instrumentation     |
| `A112`       | record round usage            | Slice B / round-level telemetry     | `packages/opencode/src/session/processor.ts`, `compaction.ts`              |
| `A113`       | compare benchmark sessions    | Validation baseline/after method    | representative session set, benchmark procedure                            |
| `A114`       | check validation gates        | Validation gates / stop criteria    | `implementation-spec.md`, planner stop gates                               |
| `A12`        | govern prompt context         | Slice A / prompt block compaction   | `design.md`, prompt taxonomy, doc governance policy                        |
| `A13`        | surface context state         | Slice C / context sidebar evolution | telemetry-to-UI contract, accordion cards                                  |
| `A2`         | analyze runtime boundaries    | Runtime mapping                     | `prompt.ts`, `processor.ts`, `compaction.ts`, `message-v2.ts`              |
| `A3`         | govern optimization policy    | Policy framing                      | `design.md`, `proposal.md`                                                 |
| `A4`         | package execution slices      | Build handoff                       | `implementation-spec.md`, `tasks.md`, `handoff.md`                         |

### Traceability Notes

- `A1 -> A11 -> A111` is the primary builder-first path because telemetry must exist before optimization decisions are made.
- `A2/A3/A4` are first-level sibling responsibilities, not replacements for the `A1` main build path.
- `A12` and `A13` consume the telemetry backbone rather than replace it.
- Builder implementation order: `A111/A112` → `A113/A114` → `A12` → `A13`.

## Build Validation Checklist

- [x] Effective requirements mapped to slices
- [x] Builder-first path explicitly defined
- [x] True three-level hierarchy present (`A1 -> A11 -> A111`)
- [x] Validation plan mapped to diagram nodes
- [x] Traceability matrix covers top-level and decomposed nodes
- [x] Build entry order documented
