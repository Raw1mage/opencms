# Handoff

## Execution Contract
- Build agent must read implementation-spec.md first
- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding
- Materialize tasks.md into runtime todos before coding

## Required Reads
- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md

## Current State
- The system currently operates on a leaky abstraction where `Account.add` (the storage repository) handles both persistence and implicit collision overrides (silent overwrite).
- A previous patch attempted to fix `gemini-cli` overwrites by moving collision suffix logic into `Account.add`, but this still leaves the storage layer too "smart" and bypasses a unified identity service.
- The TUI freezes on account deletion due to synchronous background operations like `Provider.dispose()`.
- The new 3-Tier Architecture plan is fully documented and ready for implementation.

## Stop Gates In Force
- Evaluate if throwing an error in `Account.add` breaks a significant number of unrelated tests that rely on its previous silent-overwrite behavior. If so, a massive test refactor might be needed or a transitional `Account.upsert()` method.

## Build Entry Recommendation
- Start with Tier 1 (`packages/opencode/src/account/index.ts`). Modify `Account.add` to be strict (throw on duplicate IDs). Immediately follow up with Tier 2 (`packages/opencode/src/auth/index.ts`) to handle the collision logic before calling `Account.add`.

## Execution-Ready Checklist
- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
