# Event: origin/dev refactor round49 (docs localization waves)

Date: 2026-02-26
Status: In Progress

## 1) Goal

Classify upstream multi-locale documentation localization waves for cms rewrite-only stream.

## 2) Candidate(s)

- `8eea53a41e92257d1a4ad6653d0d2930465bf34a` (`docs(ar): second-pass localization cleanup`)
- `aea68c386a4f64cf718c3eeee9dffec8409ee6b0` (`fix(docs): locale translations for nav elements and headings`)

## 3) Decision + rationale

- Decision: **Skipped** (both)
- Rationale:
  - Large docs-only translation updates do not affect opencode runtime behavior.
  - Current refactor stream prioritizes cms behavioral/runtime parity and reliability deltas.

## 4) File scope reviewed

- `packages/web/src/content/docs/**`
- `packages/web/src/content/i18n/**`

## 5) Validation plan / result

- Validation method: commit intent classification (docs localization only).
- Result: skipped.

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before decision.
- No architecture change applied.
