---
date: 2026-05-11
summary: "Correct drain section to v6 (no per-turn drain, FIFO cap 8)"
---

# Correct drain section to v6 (no per-turn drain, FIFO cap 8)

2026-05-11 release-prep audit caught stale narrative.

README L141-143 previously claimed: drain at `session/processor.ts`
`step-finish` clears `activeImageRefs` every turn; FIFO cap = 3.

Current code (verified 2026-05-11):
- v6 (2026-05-08) **removed** per-turn auto-drain entirely.
  `session/processor.ts` step-finish carries the v6 rationale
  comment (~L1213-1220); `session/llm.ts` post-preface also carries
  the rationale (~L804-825).
- FIFO cap is now `Tweaks.attachmentInline.activeSetMax`, **default 8**
  (tweaks.ts:431), enforced inside `addOnReread`
  (`tool/reread-attachment.ts:147`).
- Legacy `ACTIVE_IMAGE_REFS_DEFAULT_MAX = 3` in
  `active-image-refs.ts` is now test-fixture only.

Refactor lineage documented in README:
- v3: drain at processor step-finish → wiped same-turn vouchers
- v4: moved drain to llm.ts post-preface-emit → vouchers reached
  model once then evaporated, forcing reread per turn
- v6: no drain; FIFO eviction in addOnReread bounds growth

Cap bumped 3 → 8 to match the multi-turn persistence model.

Code anchors updated with `tool/reread-attachment.ts:147` FIFO call
site and `config/tweaks.ts:431` default value.
