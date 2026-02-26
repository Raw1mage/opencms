# Event: Batch-1 Phase C rewrite-port (auth / robustness)

Date: 2026-02-26
Status: Done

## Scope

- Phase C candidate set:
  - `81ca2df6a` guard randomUUID in insecure contexts
  - `a82ca8600` defensive code component
  - `ff3b174c4` normalize oauth error messages
  - `dec304a27` emoji as avatar
  - `460a87f35` stack overflow in filetree

## Decision summary

- Integrated/no-op on current `cms` (already present):
  - `81ca2df6a`
  - `a82ca8600`
  - `ff3b174c4`
  - `dec304a27`
- Ported in this phase:
  - `460a87f35`

## Changes

- Updated `packages/app/src/components/file-tree.tsx`
  - Added depth guard (`MAX_DEPTH = 128`) to prevent runaway recursion.
  - Added path-chain cycle guard (`_chain`) using normalized path keys.
  - Reworked deep-level computation from recursive DFS to iterative stack traversal with `seen` set to avoid recursive overflow on pathological trees.
  - Added safe fallback UI (`...`) when recursion is cut by depth/cycle guard.

## Validation

- `bun test packages/app/src/components/file-tree.test.ts` ⚠️ local test-runtime noise (`@opentui/solid/jsx-runtime.d.ts` export `Fragment`)
- `bun turbo typecheck --filter=@opencode-ai/app` ✅

## Notes

- Rewrite-only policy respected (no merge/cherry-pick).
- This phase applied only the missing robustness delta.
