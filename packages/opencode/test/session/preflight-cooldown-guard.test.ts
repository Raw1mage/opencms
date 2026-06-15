import { test, expect } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * Source-level guard for the pre-flight cooldown gate in session/processor.ts.
 *
 * Contract history:
 *   - 2026-04-17 hotfix added a `&& !sessionPinnedAccountId` clause so a
 *     manually pinned account would bypass pre-flight cooldown (the request
 *     fired and upstream was expected to surface a real 429).
 *   - That bypass was REVERSED: codex OAuth does not return 429 on a
 *     quota-exhausted account — it hangs the connection, producing a silent
 *     ~12-second black hole on every request. So pre-flight cooldown now
 *     protects EVERY round, pinned or not: trust the local tracker and
 *     rotate proactively. Worst case on a stale tracker is a one-round
 *     detour through the fallback chain.
 *
 * Current contract: the pre-flight gate is an unconditional
 * `if (isVectorRateLimited(vector))` — it must NOT be re-guarded by
 * `!sessionPinnedAccountId`. This source-level trip-wire protects against a
 * future refactor accidentally re-introducing the pin bypass (which would
 * bring back the codex hang).
 */
test("processor pre-flight rate-limit gate applies regardless of account pin (no pin bypass)", () => {
  const processorPath = path.join(import.meta.dir, "../../src/session/processor.ts")
  const src = fs.readFileSync(processorPath, "utf-8")

  // The pre-flight gate must exist and fire on rate-limited vectors.
  expect(src).toMatch(/if\s*\(isVectorRateLimited\(vector\)\)/)

  // The pin bypass must NOT be present — re-adding it brings back the
  // codex quota-hang black hole.
  expect(src).not.toMatch(/isVectorRateLimited\(vector\)\s*&&\s*!sessionPinnedAccountId/)
})
