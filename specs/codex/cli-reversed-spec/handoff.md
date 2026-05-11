# Handoff — codex-cli reversed spec

## Execution Contract
This spec is a **reference document**, not an implementation task. There is no code to ship; "execution" here means using the chapters as the source of truth before any codex-provider work that touches cache, wire shape, or transport.

## Required Reads
- `proposal.md` — why this reference exists
- `design.md` — chapter taxonomy and audit discipline
- `idef0.json` — root A0 → A1..A12 decomposition
- The chapter(s) relevant to your task under `chapters/`

## Stop Gates In Force
- Do not modify chapters without re-anchoring on the upstream SHA they reference.
- Do not delete chapters; if obsolete, supersede with an event under `events/`.
- Do not promote a hypothesis to a chapter claim without a path:line anchor.

## Execution-Ready Checklist
- [ ] You know which chapter(s) cover the surface you're about to touch
- [ ] You've checked whether the pinned SHA still matches upstream for that surface
- [ ] You've recorded any divergence found as an event before acting on it

## How to use the spec
- Before any cache / protocol / wire-shape work on the codex provider, read the relevant chapter(s) first.
- Each chapter's claims carry path:line anchors; verify against the pinned SHA, not against arbitrary upstream HEAD.
- Cross-chapter traceability is encoded in root `idef0.json` (A0 → A1..A12).

## Stale-detection
If upstream codex-cli changes shape (new endpoint, new field, restructured client), the pinned SHA in chapter files goes stale. Re-audit by diffing the affected file range against the new HEAD; record findings as events under `events/`.

## Open backend questions
Tracked at the bottom of Ch11 (cache/prefix model). These are not source-derivable — they require backend cooperation or controlled experiments.
