import { test, expect } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * Regression guard for the 2026-04-17 hotfix.
 *
 * Symptom: the persisted rate-limit tracker state silently blocked user
 * requests even after the operator had explicitly pinned an account. The
 * pre-flight gate in session/processor.ts rotated away from the pinned
 * account based on stale tracker data, surfacing "All accounts are rate
 * limited" even though the user wanted to deliberately target that account.
 *
 * Contract: the pre-flight cooldown gate is flood-protection for AUTO
 * rotation only. When the operator pinned an account
 * (sessionPinnedAccountId truthy), pre-flight must NOT rotate; the request
 * fires and upstream surfaces a real 429 if the limit is still active.
 *
 * This test is a source-level trip-wire: the pre-flight gate in
 * processor.ts must keep the `&& !sessionPinnedAccountId` clause. An
 * E2E-style behavior test would require rebuilding the whole stream/session
 * harness; for a one-line guard a grep assertion is the proportional
 * protection against accidental removal in a future refactor.
 */
test("processor pre-flight rate-limit gate requires !sessionPinnedAccountId (manual pin bypasses cooldown)", () => {
  const processorPath = path.join(import.meta.dir, "../../src/session/processor.ts")
  const src = fs.readFileSync(processorPath, "utf-8")

  // The pre-flight gate must check isVectorRateLimited AND be guarded by
  // !sessionPinnedAccountId. If the guard is removed, manual user requests
  // get silently blocked by stale tracker state — exactly the bug this
  // hotfix addresses.
  expect(src).toMatch(/isVectorRateLimited\(vector\)\s*&&\s*!sessionPinnedAccountId/)
})
