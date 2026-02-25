# Event: origin/dev refactor round36 (models provider optional fields)

Date: 2026-02-26
Status: In Progress

## 1) Goal

Port upstream schema relaxation allowing model provider metadata to omit npm/api details when unnecessary.

## 2) Candidate

- Upstream commit: `a115565054c9c905788b1684f9b64f0e6dc2dbb4`
- Subject: `core: allow model configurations without npm/api provider details`

## 3) Decision + rationale

- Decision: **Ported (rewrite-only)**
- Rationale:
  - Low-risk schema compatibility improvement.
  - Prevents overly strict validation when model-level provider objects are partially specified.
  - Aligns cms model schema with upstream flexibility while preserving runtime fallback behavior.

## 4) File scope

- `packages/opencode/src/provider/models.ts`
  - relaxed `Model.provider` schema to `npm?: string`, `api?: string`.

## 5) Validation

- `bun run typecheck` (packages/opencode) → only known baseline antigravity noise (non-blocking)
- `bun run packages/opencode/src/index.ts models list` ✅

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before execution.
- No architecture boundary change; no architecture doc update required.
