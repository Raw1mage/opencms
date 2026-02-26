# Event: origin/dev refactor round74 (session max-count + clojure highlight)

Date: 2026-02-26
Status: In Progress

## 1) Goal

Port two low-risk opencode-core fixes with clear user impact:

- honor `session list --max-count` correctly for root sessions
- fix Clojure syntax highlighting parser source

## 2) Candidate(s)

- `d27dbfe062b18f832acf958357e175ed18ab98d9`
- `e96f6385c20ddd7d2101f59bdd77a1ac58b1bd52`

## 3) Decision + rationale

- Decision: **Ported (rewrite-only)**
- Rationale:
  - Both are localized, low-regression behavior improvements on core user flows.
  - No architecture boundary changes required.

## 4) File scope

- `packages/opencode/src/cli/cmd/session.ts`
  - switched `session list` to iterate `Session.listGlobal({ roots: true, limit: args.maxCount })`
  - fixes max-count undercount caused by filtering roots after implicit global limit.
- `packages/opencode/src/cli/cmd/tui/parsers-config.ts`
  - updated Clojure parser wasm source to anomalyco fork endpoint used by upstream fix.

## 5) Validation

- `bun run typecheck` (packages/opencode) → known baseline antigravity noise only (non-blocking)
- `bun run packages/opencode/src/index.ts session list --help` ✅
- `bun run packages/opencode/src/index.ts admin --help` ✅

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before execution.
- No architecture boundary/semantic change; no architecture doc update required.
