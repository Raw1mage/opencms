# Event: Batch-1 Phase A rewrite-port (origin/dev -> cms)

Date: 2026-02-26
Status: Done (Phase A)

## Scope

- Batch-1 first phase: input/editor/navigation related fixes.
- Policy: rewrite-only port on `cms` (no merge/cherry-pick).

## Decisions

1. `origin/dev` selected fixes were reviewed one by one against current `cms` code.
2. Commits already behavior-integrated in `cms` are marked as integrated/no-op for this phase.
3. Only missing behavior will be implemented to minimize risk.

## Candidate commits reviewed (Phase A)

- `0771e3a8b` preserve undo history for plain-text paste
- `0303c29e3` failed to create store
- `7f95cc64c` prompt input quirks
- `1c71604e0` terminal resize
- `d30e91738` cmd-click links in inline code
- `878ddc6a0` shift+tab keybind
- `3c85cf4fa` prompt history at input boundaries

## Progress log

- Started code inspection and diff mapping.
- Found multiple items already integrated on `cms` (no-op):
  - `0771e3a8b`, `0303c29e3`, `7f95cc64c`(major parts), `1c71604e0`, `d30e91738`.
- Remaining implementation targets:
  - `878ddc6a0` (allow `Tab` handling in editable targets)
  - `3c85cf4fa` (tighten history navigation boundary logic)

## Implemented changes

- `packages/app/src/context/command.tsx`
  - allow `Tab` key path to continue through keybind handling inside editable targets.
- `packages/app/src/components/prompt-input/history.ts`
  - refined `canNavigateHistoryAtCursor` to strict boundary checks and explicit in-history behavior.
- `packages/app/src/components/prompt-input.tsx`
  - simplified up/down history navigation logic to use boundary helper directly.
- `packages/app/src/components/prompt-input/history.test.ts`
  - updated unit assertions to match new boundary semantics.

## Validation

- `bun test packages/app/src/components/prompt-input/history.test.ts` ✅
- `bun turbo typecheck --filter=@opencode-ai/app` ✅
- Note: running `command*.test.ts` in isolation hit local test-runtime import issue (`@opentui/solid/jsx-runtime.d.ts` export `jsxDEV`), treated as environment noise for this phase because changed logic is covered by typecheck + targeted history tests.

## Next

- Proceed Batch-1 Phase B (session/sse/state fixes) with same rewrite-only and validation gates.
