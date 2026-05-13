---
date: 2026-05-12
summary: "user-confirmed apply_patch write path live on beta worktree"
---

# user-confirmed apply_patch write path live on beta worktree

User confirmed 2026-05-12 ("已驗證寫檔順利") that apply_patch tool's write path works end-to-end on the beta worktree (branch `beta/apply-patch-metadata-strip`, commit `2b08cf242` after rebase onto main). This upgrades AC-2 from analytical-only to live-confirmed.

AC-4 / AC-5 (visual diff rendering) remain deferred per earlier user opt-out — those are separate from write-path correctness.

Fetch-back to `test/apply-patch-metadata-strip` @ `680e45011` completed: typecheck green, dreaming.test.ts 8/8 pass, broader tool sweep 57/58 (single failure in hardening.test.ts DR-5 pre-existed on main, unrelated to this change).

Ready for finalize gate pending user authorization.

