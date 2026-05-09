# Implementation Spec

> **2026-05-09 audit rewrite.** This file previously described a "minimal upload feature" that no longer matches the agreed scope. The authoritative implementation contract is now distributed across the package files below; this file exists to point at them and to record the contract invariants that must hold across every phase.

## Where the contract lives

- `proposal.md` — why and what changes.
- `spec.md` — observable behaviour and acceptance checks.
- `design.md` — architecture, decisions, phasing, critical files, gap list.
- `frontend-design.md` — UI brief, layout map, component inventory, interaction map.
- `tasks.md` — phased task list with audit-reset progress as of 2026-05-09.
- `errors.md` — error catalogue with active/pending status per code.
- `data-schema.json` — wire shapes mirrored from the implemented zod validators.
- `test-vectors.json` — request/response/error vectors keyed by endpoint.
- `observability.md` — Bus events and metrics expected once Phase 2.6 wires them.
- `idef0.json` / `grafcet.json` / `c4.json` / `sequence.json` — companion structural artifacts.

## Cross-phase invariants

These invariants must hold no matter which phase is in progress. Any change that violates them is out of scope for this plan.

1. **Server-authoritative path resolution.** The UI may propose a target; the server resolves and validates it. No route accepts a pre-resolved absolute path from the client without re-running `assertOperationWithinProject` (or, for the explicit external paste flow, `destinationPreflight` followed by a route that re-validates the canonical path before mutating bytes).
2. **No silent fallback.** No route may auto-rename, auto-overwrite, silently switch destination on conflict, or downgrade an external paste to an active-project paste. Every conflict surfaces a stable `OperationCode`.
3. **Basename-only naming.** Names supplied by the client (rename target, create name, upload basename) are run through `validateBasename`. Embedded `/`, `\`, `\0`, `.`, `..` are rejected with `FILE_OP_INVALID_NAME`.
4. **Confirmed destruction.** Delete requires `confirmed: true`. Recyclebin is the only delete path in Phase 1; permanent unlink is not part of this plan.
5. **Normalized result shape.** Every mutation returns `OperationResult` with `operation`, optional `source`, optional `destination`, optional `node`, and `affectedDirectories`. The frontend consumes `affectedDirectories` for targeted refresh and `source`/`destination` for tab reconcile.
6. **Disposable beta surface.** Implementation lives on `beta/web-file-upload`; the docs in `plans/20260509_web-file-upload/` and `docs/events/event_20260509_web-file-upload.md` live on `main`. See beta-workflow §1, §5, §8.

## What this file is not

- Not a user-facing summary — that's `proposal.md`.
- Not the test plan — that's `tasks.md` Phase 2.4 and Phase 6 plus `test-vectors.json`.
- Not the API reference — the zod validators in `packages/opencode/src/server/routes/file.ts` are authoritative; `data-schema.json` mirrors them for review.
