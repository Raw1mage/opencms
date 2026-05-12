---
date: 2026-05-12
summary: "Token efficiency outcome ~300x improvement"
---

# Token efficiency outcome ~300x improvement

Unanticipated downstream outcome reported during live observation: token consumption rate dropped by approximately **two orders of magnitude** relative to pre-fix跳針 episodes.

**Pre-fix observation**: during a 跳針 read-loop (e.g. 11 consecutive `read` calls on the same file, each carrying full context replay because the chain was being re-invalidated without proper init), a single session could burn ~5 hours of quota allocation in ~10 minutes of wall-clock time. Normalized burn rate ≈ **30× nominal** (30 minutes of quota consumed per minute of clock time).

**Post-fix observation**: sustained multi-document refactor work (9 distinct chapter files, ~30 patches over ~15 minutes) over one hour of continuous work consumed only ~10% of the hourly quota allocation. Normalized burn rate ≈ **0.1× nominal**.

**Implied improvement**: ≈ **300× reduction in quota burn rate** when previously a跳針 episode would have started.

**Mechanism**: the dominant cost in a 跳針 episode is full-prompt replay per round (because chain reset forces no `previous_response_id`, so codex sees the whole conversation again). At 270k context budget, even a 10-round loop = ~2.7M tokens charged for zero forward progress. The chain-init-notice protocol prevents the loop entirely:
- The first chain-break dispatch costs ~700 chars (commitment digest body) added to one outbound prompt — once.
- The AI now sees an explicit "you already did X / Y / Z, don't redo" framing on its first turn post-break.
- Empirically (post-fix, sustained observation over 50+ rounds in ses_1e56ed3f9ffebv4AaWOlcPLz20), the AI proceeds with new work rather than re-verifying.

**Significance**: the chain-init protocol's nominal cost is sub-1KB per chain-break event. Its avoided cost is one full-prompt replay loop per跳針 incident. The break-even point is essentially the first prevented跳針 round (which alone costs ~30k+ tokens at the context volumes where the bug manifests).

**Caveat**: the 300× number is a single-session anecdotal observation, not a population statistic. A future fixture-based regression harness (F8) could quantify this across many session replays. But the order-of-magnitude claim is robust because the underlying mechanism is structural — preventing N≥10 full-context replays per chain-break vs paying ~1KB once.

**Paper relevance**: this is the strongest concrete user-visible outcome of the protocol. The signalling-layer abstraction (chain_init_notice + commitment digest) is "necessary but not sufficient" per theory.md §6, but on observed sessions where the AI does respond to the notice, the cost arithmetic shifts by two orders of magnitude.
