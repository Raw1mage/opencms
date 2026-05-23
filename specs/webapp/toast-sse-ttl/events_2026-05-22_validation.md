# Validation — 2026-05-22

## Commands

- `bun test packages/opencode/src/cli/cmd/tui/event.test.ts` — PASS, 4 tests.
- `bun test --preload ./happydom.ts ./src/context/global-sync.toast.test.ts` from `packages/app` — PASS, 4 tests.
- `bun test --preload ./happydom.ts ./src/context/global-sync.test.ts` from `packages/app` — FAIL on pre-existing `loadRootSessionsWithFallback` expectations unrelated to toast TTL; new toast tests moved to isolated file and pass.
- `bun run typecheck` in `packages/opencode` and `packages/app` — BLOCKED by local `tsgo` resolution invoking the opencode CLI help path instead of TypeScript native preview.

## Checkpoints

- Backend schema requires `emittedAt`, `ttlMs`, and `scope` for serialized `tui.toast.show` payloads.
- `ToastShowInput` remains the unstamped input contract for `/tui/show-toast`; `publishToastTraced` stamps freshness metadata.
- Frontend `toastDisplayDecision` drops stale, missing-freshness, and invalid-scope toasts before `showToast`.
- Grep checkpoint found no remaining direct `type: "tui.toast.show"` emit sites outside the typed event helper.

## Architecture Sync

- `specs/architecture.md` needs a webapp/frontend data-flow note for scoped ephemeral toast TTL behavior during T6 consolidation.
