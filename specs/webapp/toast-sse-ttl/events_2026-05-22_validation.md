# Validation — 2026-05-22

## Commands

- `bun test packages/opencode/src/cli/cmd/tui/event.test.ts` — PASS, 4 tests.
- `bun test --preload ./happydom.ts ./src/context/global-sync.toast.test.ts` from `packages/app` — PASS, 4 tests.
- `bun test --preload ./happydom.ts ./src/context/global-sync.test.ts` from `packages/app` — FAIL on pre-existing `loadRootSessionsWithFallback` expectations unrelated to toast TTL; new toast tests moved to isolated file and pass.
- `bun run typecheck` — PASS after non-interactive Bun lifecycle/bin-resolution hardening; workspace runner builds SDK OpenAPI output and typechecks SDK/plugin/UI/opencode/app/util packages.

## Checkpoints

- Backend schema requires `emittedAt`, `ttlMs`, and `scope` for serialized `tui.toast.show` payloads.
- `ToastShowInput` remains the unstamped input contract for `/tui/show-toast`; `publishToastTraced` stamps freshness metadata.
- Frontend `toastDisplayDecision` drops stale, missing-freshness, and invalid-scope toasts before `showToast`.
- Grep checkpoint found no remaining direct `type: "tui.toast.show"` emit sites outside the typed event helper.
- Non-interactive typecheck root cause was Bun lifecycle PATH/shim resolution invoking the opencode CLI instead of workspace binaries; `scripts/typecheck-workspace.ts` now uses a clean PATH and explicit bin paths.

## Architecture Sync

- `specs/webapp/README.md` now documents ephemeral toast delivery, `ToastShowInput`, `publishToastTraced`, and `toastDisplayDecision` anchors.
- `specs/architecture.md` now records that `tui.toast.show` is ephemeral UI side-effect state, requiring `scope`, `emittedAt`, `ttlMs`, and frontend freshness/scope gating before `showToast`.
