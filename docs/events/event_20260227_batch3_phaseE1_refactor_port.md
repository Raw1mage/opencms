# Event: Batch-3 Phase E1 rewrite-port (app/ui low-risk follow-up)

Date: 2026-02-27
Status: Done (2 ported, 6 integrated/skipped)

## Scope

- `7e681b0bc` large text paste lock in prompt input
- `9c5bbba6e` patch tool renders like edit tool
- `0ce61c817` keep pinned auto-scroll with todos/questions/perms
- `46361cf35` session review over re-rendering
- `1de12604c` preserve URL slashes for root workspace
- `7e1051af0` show full turn duration in assistant meta
- `8e9644796` todo list chevron direction
- `3b5b21a91` duplicate markdown (followed by `8f2d8dd47`)

## Decision summary

- Integrated/no-op on current `cms`:
  - `7e681b0bc` (core runtime fix already present; only missing test coverage)
  - `9c5bbba6e` (single-file apply_patch already uses edit-like rendering path)
  - `0ce61c817` (auto-scroll pin logic already present in `session.tsx`)
  - `46361cf35` (session-review diff mapping/memoization already integrated)
  - `1de12604c` (`/` and `\\` root-directory guard already present in `message-part.tsx`)
- Skipped in this round:
  - `7e1051af0` (assistant-meta duration model diverges in cms UI; current duration is already turn-level in session header)
  - `8e9644796` (upstream target file path does not exist in current cms session composer layout)
- Ported in this phase:
  - `3b5b21a91` + `8f2d8dd47` (duplicate markdown wrapper/copy-button/link decoration hardening)
  - test parity for large multiline fragment behavior from `7e681b0bc`

## Changes

- `packages/ui/src/components/markdown.tsx`
  - unified markdown decoration flow (`decorate`) before morphdom and setup.
  - ensure idempotent code wrapper/copy button setup (`ensureCodeWrapper`).
  - prevent duplicate copy buttons and duplicate markdown wrapper churn.
  - keep code-link normalization in one reusable pass.
- `packages/app/src/components/prompt-input/editor-dom.test.ts`
  - added large multiline regression tests to lock anti-break-node-explosion behavior and trailing-break fallback.

## Validation

- `bun test packages/app/src/components/prompt-input/editor-dom.test.ts` ⚠️ no DOM runtime in current CLI test environment (`document is not defined`)
- `bun turbo typecheck --filter=@opencode-ai/app --filter=@opencode-ai/ui` ✅

## Notes

- Rewrite-only policy respected (no merge/cherry-pick).
