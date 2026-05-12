---
date: 2026-05-12
summary: "Phase A foundations landed"
---

# Phase A foundations landed

Phase A (M0–M6) committed in two parts on `beta/session-rebind-procedure-revision-phase-a`:
- `f65b555b0` — foundations: chain-semantics registry, ContinuationEvent + classifier matrix, commitment-digest, PendingInjectionStore, Continuation.run executor, chain-init-notice fragment
- `9a81357c1` — M5 amnesia-notice body extension + M6 fragment policy taxonomy split

Stats: 12 files, 2801 insertions, 168 new tests, tsgo clean. No call sites rewired — Continuation.run callable but unused in production paths (additive only).

Key Phase A design choices (documented inline in design.md DD-1..DD-12):
- DD-1 sibling fragments rather than unified
- DD-2 mutation-class only in digest
- DD-8 digest capture before invalidate
- DD-11 static provider chain-semantics registry (no duck-typing)
