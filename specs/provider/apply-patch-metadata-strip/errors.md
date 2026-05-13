# Errors: provider_apply-patch-metadata-strip

This change is a shape narrowing. It removes two optional-from-the-caller-perspective fields from a tool-return type. Error handling is essentially **subtractive** (fewer code paths can fail) rather than additive.

## Error Catalogue

| Code | Source | Severity | Surfaced as |
|---|---|---|---|
| F-1 | UI receives a part whose `metadata.files[].diff` is empty / missing | warn | empty diff panel (no crash); console warn |
| F-2 | Legacy session contains malformed `before`/`after` (e.g. truncated) | info | UI ignores; renders via `diff` field |
| F-3 | `apply_patch.ts` somehow still references stripped fields after edit | fail | typecheck failure at build time |
| F-4 | UI dead-code removal accidentally drops a still-live render branch | fail | manual visual check at M4-3 catches it |

## Failure modes handled

### F-1: UI receives a part whose `metadata.files[].diff` is empty or missing

- **Source**: tool implementation regression, corrupted persisted row, or model invocation that produced a no-op patch.
- **Handling**: UI MUST render a visible empty-diff state (e.g. "no changes" placeholder) rather than blank-on-blank. The current implementation already covers no-op rendering when `diff` is empty; ensure that remains the fallback after the migration. No new exception path needed.
- **Test**: TV-5 ensures non-empty diff is rendered; a manual spot-check for an empty-diff patch confirms placeholder behavior.

### F-2: Legacy session contains malformed `before`/`after`

- **Source**: existing session DBs that suffered partial dream-pruning, or a session migrated from an older opencode version.
- **Handling**: post-change UI reads only `file.diff`, so malformed `before`/`after` strings are irrelevant. No crash possible from accessing those fields after the migration.
- **Test**: TV-6 (legacy-shape fixture with present `before`/`after`); manual replay of `ses_1e738d1c8ffeen3y8zPoXjsQ02` confirms render.

### F-3: Source still references stripped fields after edit

- **Source**: incomplete edit — type narrowed but return-value construction still assigns `before`/`after`, or vice versa.
- **Handling**: TypeScript compilation MUST fail on type/value mismatch. Mitigation: M1-3 mandatory typecheck step before M2 starts. M1-4 grep also catches surviving references.

### F-4: Dead-code removal accidentally drops a live render branch

- **Source**: the M2-3 line at `message-part.tsx:1625, 1629` is part of a larger conditional in the edit-tool render block. Removing just those two lines could leave dangling braces or a no-longer-reachable fallback.
- **Handling**: M2-5 typecheck catches syntactic damage. M4 manual UI check on an `edit` tool part (not just `apply_patch`) confirms the edit-tool diff still renders. If the dead branch turns out to be the only branch (i.e. removing it strands the conditional), implementer MUST instead replace it with the `oldString`/`newString` path directly rather than just deleting.

## Error contracts NOT changed

- `apply_patch` continues to return `output: "Success. ..."` on success and surface tool errors via the existing error path (no change).
- LLM tool-result error semantics unchanged — `state.metadata` was never error-bearing anyway.
- Snapshot system errors (`Snapshot.track` failure) continue to flow through the existing `apply_patch.ts` error path.
- `Session.updatePart` failure semantics unchanged.

## What the change CANNOT cause

- A new error class. Removal of an optional return field is monotonically less surface area, not more.
- A migration error in existing session DBs. SQLite `payload_json` is a string blob; extra/missing JSON properties never break parsing.
- A regression in LLM prompt construction. `toModelMessages` was already not reading these fields (`message-v2.ts:1062-1069`).
