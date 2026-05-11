---
date: 2026-05-11
summary: "Reframe — spec is upstream-alignment hygiene, NOT cache-4608 RCA"
---

# Reframe — spec is upstream-alignment hygiene, NOT cache-4608 RCA

## Trigger

User asked: "installation id 缺失，是我們從一開始就存在的問題嗎？因為 cache 壞掉是這兩天的事"

The reframe is correct. Time-ordering audit:

- `accounts.json` schema has never had an `installationId` slot. No commit has ever added or removed one.
- `codex-auth.ts:315` has been passing `credentials?.installationId` (always undefined) since the file existed.
- Cache regression appeared only in the last 2 days.
- Therefore installation_id cannot be the regression's root cause.

## Actual cache-4608 root cause (already on record)

Commit `458617657` (May 11 03:44, `provider_codex-prompt-realign/`):

> Cache 4608 floor confirmed as server-side GPT-5.5 model regression tracked in `openai/codex#20301` (open, no assignee, no fix). Switching default model to GPT-5.4 restores cache. All wire-realign work in this plan is independently load-bearing.

The prior (SSH-dropped) session's byte-diff finding was a long-standing wire-shape divergence, not a new break. I anchored on the diff without time-checking the prior baseline; user caught the reasoning error.

## What this spec is now

Upstream-alignment / hygiene. Justified on its own terms:

- Wire-shape divergence makes every future regression chase noisier.
- ≈100 LoC + one file — cheap to land.
- Risk-low — we mirror upstream resolver semantics 1:1.
- Future-proof — if `openai/codex#20301` is fixed but cache still misbehaves on our path, this is one less suspect.

## Edits applied

- `proposal.md` Why — added "Honest framing (post-reframe)" subsection.
- `design.md` Context — replaced "Without this field, backend treats every turn as fresh anonymous client. Prefix-cache lineage cannot be maintained..." with "Why this matters even though it isn't the cache-4608 root cause".
- No code change. Spec / artifacts otherwise unchanged.

## Status

Implementation work (M1+M2+M3+M4 unit+M6) already landed. Spec text now matches the honest framing. Continue toward `verified` then await user-triggered `plan_graduate`.
