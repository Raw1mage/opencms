# Event: Integrate `web-dev` into `cms` (TUI + WebApp)

Date: 2026-03-01
Status: Done

## 1) Objective

- Integrate `raw1mage/web-dev` changes into `cms` so `cms` supports both TUI and WebApp capabilities.

## 2) Strategy

- Used **commit-by-commit cherry-pick** (17 commits) from `raw1mage/web-dev` onto `cms`.
- Resolved conflicts manually to preserve existing `cms` behavior while porting web functionality.
- Avoided direct merge commit to keep refactor-style traceability and easier rollback per commit.

## 3) Key Decisions

- Kept web-dev terminal popout architecture changes, while preserving `cms` output flush callback behavior.
- Resolved global-sync/bootstrap conflict by using `formatServerError` as single error-format source.
- Accepted incoming generated `models-snapshot.ts` during conflict to keep branch parity.
- Added small post-integration fix in `model-selector-state.ts`: active account is sorted to top (matches test intent).

## 4) Validation

- `bun run typecheck` ✅
- `bun test packages/app/src/components/model-selector-state.test.ts` ✅

## 5) Result

- `cms` is now ahead by 17 integrated web-dev commits (+ one follow-up local fix).
- Working tree is clean and integration is ready for review/push.
