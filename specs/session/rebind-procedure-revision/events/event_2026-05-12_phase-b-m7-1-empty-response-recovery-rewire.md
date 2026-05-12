---
date: 2026-05-12
summary: "Phase B M7-1 empty-response recovery rewire"
---

# Phase B M7-1 empty-response recovery rewire

`6d0c2693f` — prompt.ts:1451 empty-response recovery dispatched through `Continuation.run({ kind: "empty_response_recovery" })`. First call site rewire; smallest blast-radius pilot per handoff.md Phase B cut criterion. 5 → 4 remaining direct `invalidateContinuationFamily` callers.</body>
