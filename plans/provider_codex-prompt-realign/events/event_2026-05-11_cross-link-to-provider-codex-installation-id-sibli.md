---
date: 2026-05-11
summary: "Cross-link to provider/codex-installation-id sibling spec (upstream alignment, NOT cache-4608 RCA)"
---

# Cross-link to provider/codex-installation-id sibling spec (upstream alignment, NOT cache-4608 RCA)

Added cross-link in design.md Context section pointing to `provider_codex-installation-id/`. That spec closes a long-standing gap (we never sent `client_metadata["x-codex-installation-id"]`; upstream always does). The gap was discovered by the byte-diff investigation that originally framed it as the cache-4608 root cause, but a time-ordering audit (installation_id missing since day one; cache regression only in the last 2 days) ruled that out. Real cache-4608 root cause stays as `openai/codex#20301` (server-side GPT-5.5 regression, no upstream fix, workaround = GPT-5.4) per this plan's earlier closing note (commit `458617657`).

The installation_id work is therefore filed as upstream-alignment / hygiene: small wire-shape divergence closed, future regression chases have one fewer confound.
