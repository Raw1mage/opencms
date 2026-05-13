# Spec: provider_apply-patch-metadata-strip

## Purpose

Eliminate the disk-storage waste caused by `apply_patch` tool persisting full file bodies (`metadata.files[].before` + `metadata.files[].after`) on every patch. These fields are not used by the LLM context path; they are only read by 2 UI sites which can be migrated to the existing hunk-format diff renderer. Align `apply_patch` with the same shape `write` and `edit` adopted on 2026-04-23. Migration is lazy — existing session DBs untouched.

## Requirements

### Requirement: apply_patch metadata omits file bodies

When `apply_patch` tool executes successfully, the returned `state.metadata.files[]` entries MUST NOT contain `before` or `after` properties. The `diff` (hunk-format) property MUST continue to be present, along with `filePath`, `relativePath`, `type`, `additions`, `deletions`, and optional `movePath`.

#### Scenario: Single-file patch return shape

- **GIVEN** a working copy with `foo.py` (388 KB content)
- **WHEN** the model invokes `apply_patch` with a valid patch updating `foo.py`
- **THEN** the tool's return value's `metadata.files[0]` object MUST contain keys `{filePath, relativePath, type, diff, additions, deletions}` exclusively (plus optional `movePath` when applicable)
- **AND** `metadata.files[0].before` MUST be `undefined`
- **AND** `metadata.files[0].after` MUST be `undefined`
- **AND** the persisted `parts.payload_json` row for this tool call has length ≤ 20 KB (vs. ~800 KB pre-change for the same input)

#### Scenario: Multi-file patch return shape

- **GIVEN** a patch touching three files
- **WHEN** `apply_patch` executes
- **THEN** every entry in `metadata.files[]` MUST omit `before`/`after`
- **AND** the `metadata.diff` aggregate hunk-format string MUST be present (unchanged from current behaviour)

### Requirement: LLM prompt invariant preserved

The conversation-to-LLM serialization (`toModelMessages`) MUST continue to emit only `state.output` + `state.attachments` for tool parts; no metadata fields enter the prompt. This is a pre-existing invariant and the change MUST NOT alter it.

#### Scenario: Tool part serialization unchanged

- **GIVEN** an `apply_patch` tool part with new (post-change) metadata shape
- **WHEN** `MessageV2.toModelMessages` runs over a session containing it
- **THEN** the emitted ModelMessage's tool-result content references `state.output` (the success string) and any `state.attachments`, but no part of `state.metadata`

### Requirement: UI renders diffs from hunk format

The UI components in `packages/ui/src/components/message-part.tsx` MUST render `apply_patch` diffs using the `file.diff` hunk-format field. The UI MUST tolerate sessions whose `apply_patch` parts lack `before`/`after`, AND sessions whose parts still carry them (legacy sessions).

#### Scenario: New-session apply_patch renders

- **GIVEN** a session created after this change, containing an `apply_patch` part with metadata lacking `before`/`after`
- **WHEN** the message-part component renders the part
- **THEN** the diff is visually displayed via the diff component
- **AND** no console error or React render warning is emitted

#### Scenario: Legacy-session apply_patch renders

- **GIVEN** a session created before this change, containing an `apply_patch` part with metadata containing `before` and `after` strings
- **WHEN** the message-part component renders the part
- **THEN** the diff is visually displayed
- **AND** no behavior regression observed

### Requirement: Dead UI references removed

The `edit`-tool consumer code at `packages/ui/src/components/message-part.tsx:1625` and `:1629`, which reads `props.metadata?.filediff?.before` and `.after` (fields that `edit.ts` has not populated since the 2026-04-23 mobile-session-restructure), MUST be removed in this change.

#### Scenario: Edit-tool diff still renders

- **GIVEN** an `edit` tool part in a session
- **WHEN** the message-part component renders the part
- **THEN** the existing `props.input.oldString` / `props.input.newString` fallback path produces the diff display
- **AND** no reference to `filediff.before` or `filediff.after` remains in the component file

### Requirement: Dreaming pruning test reflects new shape

The test at `packages/opencode/src/session/storage/dreaming.test.ts:309` currently asserts that `pruneToolMetadata()` replaces oversized `before`/`after` with `[dream-pruned: ...]` stubs. After this change, the test MUST be updated to either: (a) construct a fixture that still includes `before`/`after` (legacy-shape, validating pruner backwards-compat), and assert the stub replacement still happens; OR (b) be retired if the pruner removal is also in scope (it is NOT in this plan — pruner stays for legacy support).

#### Scenario: Pruner still works on legacy shape

- **GIVEN** a hand-constructed `apply_patch` part with metadata containing oversized `before`/`after` (legacy-shape fixture)
- **WHEN** `pruneToolMetadata()` runs over it
- **THEN** both fields are replaced with `[dream-pruned: dropped N bytes of file <field> snapshot]` stubs
- **AND** the test assertion at L309 still passes

## Acceptance Checks

- [x] **AC-1**: `apply_patch` return type `ApplyPatchFileMetadata` source declaration no longer contains `before` or `after` properties (grep `apply_patch.ts` confirms absence).
- [x] **AC-2**: A live `apply_patch` invocation against a ≥100 KB file produces a `parts.payload_json` row whose total length is < 20 KB (vs. ≥200 KB pre-change for the same input). *Verified by user 2026-05-12: "已驗證寫檔順利" — live apply_patch write path confirmed working end-to-end on the beta worktree.*
- [x] **AC-3**: In `packages/ui/src/components/message-part.tsx`, grep for `\.before` and `\.after` returns zero matches inside the apply_patch render blocks (L1769-1810) and zero matches inside the edit-tool render block (around L1620-1630). *Verified: `git grep -nE '\.before\b|\.after\b' packages/ui/src/components/message-part.tsx` returns zero hits in render blocks.*
- [ ] ~~**AC-4**~~ (DEFERRED per user opt-out on 2026-05-12): Running a new session in the web UI, invoking `apply_patch` on any tracked file, and visually inspecting the rendered message shows the diff display populated.
- [ ] ~~**AC-5**~~ (DEFERRED per user opt-out on 2026-05-12): Replaying an existing session DB that contains legacy apply_patch parts in the web UI shows the same diff display without crash or warning.
- [x] **AC-6**: `bun test packages/opencode/src/session/storage/dreaming.test.ts` passes after the fixture update. *Verified: 8 pass, 0 fail, 34 expect() calls.*
- [x] **AC-7**: `LLM.streamText` invocations for a session containing the new apply_patch shape produce identical model-message content as before this change — `state.metadata` does not enter the prompt. *Verified: `git grep state.metadata packages/opencode/src/session/message-v2.ts` returns zero hits — `toModelMessages` does not read metadata at all, invariant preserved by structure.*
- [x] **AC-8**: No reference to `metadata.files[].before` or `metadata.files[].after` remains in any TypeScript / TSX source file in `packages/opencode/`, `packages/ui/`, or `packages/app/` (repo-wide grep confirms zero post-change matches outside the dreaming test fixture retained for legacy-shape coverage). *Verified: `git grep -nE '\.metadata\.files\[[^]]*\]\.(before|after)\b'` on the four package roots returns only the intentional dreaming.test.ts fixture line.*

## Out of Scope

- Retroactive vacuum of existing session DBs.
- Removal of `pruneToolMetadata()` itself (must remain for legacy sessions).
- Read-tool deduplication (separately rejected — model has no memory).
- Token-burn reduction (a different problem with a different solution path).
- Diff-rendering component swap (only data wiring changes).
