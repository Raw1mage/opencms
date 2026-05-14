# Handoff: claude-provider-beta-fingerprint-realign

## Execution Contract

This is a **pure-refactor** plan — no new product capability is shipped to users. Behavioral parity with upstream `claude-code@2.1.112` is the success criterion. The build agent is expected to:

- Treat `refs/claude-code-npm/cli.js` as read-only ground truth. Cite line offsets in code comments, never copy code.
- Make minimal source-level changes; do not refactor adjacent code that is not on the critical-files list.
- Preserve every existing public export of `protocol.ts` other than `MINIMUM_BETAS` (which is removed deliberately per DD-1).
- Run `bun test` after each phase, not only at the end.
- Do not bump the `refs/claude-code-npm/` pin (already at 2.1.112 — last JS-source release).
- Do not enable `structured-outputs-2025-12-15` or `web-search-2025-03-05`; reserved-only.
- Do not introduce a non-OAuth code path; opencode is OAuth-only by deployment design (DD-16).

## Required Reads

Before touching any file, the build agent MUST read in this order:

1. `specs/_archive/claude-provider-beta-fingerprint-realign/proposal.md` — context, scope, constraints (esp. OAuth-only, daemon-mode constraints)
2. `specs/_archive/claude-provider-beta-fingerprint-realign/spec.md` — the seven Requirements with Scenarios; the canonical push-order ladder
3. `specs/_archive/claude-provider-beta-fingerprint-realign/design.md` — DD-1 through DD-17, Risks R-1 through R-6, and Research Outcomes (closed gaps)
4. `specs/_archive/claude-provider-beta-fingerprint-realign/data-schema.json` — `AssembleBetasOptions` field-by-field contract
5. `specs/_archive/claude-provider-beta-fingerprint-realign/test-vectors.json` — the matrix to satisfy
6. `packages/provider-claude/src/protocol.ts` — the file being rewritten (current state)
7. `refs/claude-code-npm/cli.js` — the upstream truth at function `ZR1` (offset ~3482150) and constants block (~2439173)
8. `AGENTS.md` (project root) — XDG backup rule applies before first `bun test` run

## Stop Gates In Force

The agent MUST pause and ask the user when:

- **STOP-1** Manual end-to-end diff evidence (Task 4.8) shows a divergence the matrix didn't catch. Do NOT silently fix; surface to user with the captured header bytes.
- **STOP-2** Removing `MINIMUM_BETAS` (Task 2.2) reveals an external consumer outside `packages/provider-claude/` (R-2). Stop before deleting; report the call site.
- **STOP-3** Any test asserts a different push order than spec.md Requirement 4. Stop, re-read spec, do not "fix" the test.
- **STOP-4** Discovery during implementation that an additional upstream gate exists (e.g. another helper function our greps missed) for any of the 9 flags. Stop, re-grep cli.js, update spec via `amend` mode before proceeding.
- **STOP-5** XDG backup not present (`opencode.bak-*-claude-provider-beta-fingerprint-realign/accounts.json` does not exist) before the first `bun test`. AGENTS.md compliance.
- **STOP-6** Need to re-pull `refs/claude-code-npm/` to a different version. The 2.1.112 pin is intentional (see refs/claude-code-npm/REFS.md).

## Execution-Ready Checklist

- [ ] All Required Reads completed
- [ ] XDG backup taken to `~/.config/opencode.bak-<YYYYMMDD-HHMM>-claude-provider-beta-fingerprint-realign/`
- [ ] `git status` clean enough that diffs from this plan are isolatable (existing unstaged edits documented or stashed)
- [ ] `bun test packages/provider-claude/` baseline run captured (currently no test file exists; baseline is "no tests")
- [ ] Branch / commit strategy decided: this plan does NOT need a beta worktree (changes are confined to `@opencode-ai/provider-claude` package, no daemon restart required for verification — the package is consumed at next opencode runtime start). Commit directly on `main`.
- [ ] Daemon restart deferred until user explicitly approves (per memory: restart requires user consent)

## Phase Discipline

Per plan-builder §16 Execution Contract:

- One TodoWrite materialization per phase boundary; one `[~]` (in_progress) at any moment
- After each `- [x]`: run `plan-sync.ts specs/_archive/claude-provider-beta-fingerprint-realign/` and act on warnings per design.md decision tree
- Phase summary into `docs/events/event_<YYYYMMDD>_claude-provider-beta-realign.md` at each phase boundary
- No batch-checking at end; checkboxes flip immediately on actual completion
- State promotion happens automatically: first `- [x]` triggers `planned → implementing`; all-checked + Task 4.8 evidence captured triggers `implementing → verified`
