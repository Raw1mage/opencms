---
date: 2026-05-12
summary: "Phase D chainBreakClass payload extension"
---

# Phase D chainBreakClass payload extension

`861f2a3a4` — closed the last documented data-schema gap. `BumpEpochInput` gained optional `chainBreakClass?: ChainBreakClass`; `Continuation.run` threads `decision.chainBreakClass` through to `RebindEpoch.bumpEpoch`. session.rebind event payload now matches data-schema.json. Direct callers (server/routes/session.ts admin PATCH, daemon-start bump) can omit the field; payload then carries `chainBreakClass: null` — explicit "unclassified by this caller" marker.

M6-5 (cache-key inclusion via rebind epoch) was the other Phase D bullet; on inspection it turned out to be **already-achieved-by-composition** — when chain_init_notice / amnesia_notice appear in bundle_user, the fragmentIds list changes, the bundle's name field changes, the prompt's `Bun.hash` over `promptTelemetryBlocks` differs, and codex backend cache misses naturally. No explicit epoch field in the hash is needed; the fragment composition mechanism does the work. Documented as resolved-by-composition.
