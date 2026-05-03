# Handoff: docx-upload-autodecompose

## Execution Contract

This document is the contract between the spec and whoever executes
it (a build agent or a human). Read this first. By accepting this
handoff, the executor commits to: reading every artifact under
"Required Reads" before starting; pausing at every "Stop Gates In
Force" item; using `tasks.md` as the canonical TodoWrite source per
plan-builder §16; running `plan-sync.ts` after every task tick.

## Required Reads

1. `proposal.md` — Why we are doing this; the conversation that led
   here; the user's verbatim requirement statements.
2. `design.md` — All ten Design Decisions. Do not deviate without
   running `amend` mode (see plan-builder §16.3).
3. `spec.md` — The behavioral contract. Every requirement here must
   pass its acceptance check before this spec promotes to `verified`.
4. `data-schema.json` — The manifest is a contract. Any field added,
   removed, or renamed is a breaking change requiring `extend` or
   `refactor` mode.
5. `idef0.json` + `diagrams/a1_idef0.json` + `diagrams/a2_idef0.json`
   — Functional decomposition; tells you which component owns what.
6. `c4.json` — Component-to-container mapping. Tells you which file
   to edit for each piece of work.
7. `sequence.json` — Six runtime scenarios. Use these to reason
   about edge cases when implementing.
8. `tasks.md` — The execution checklist. Treat it as a TodoWrite
   source per plan-builder §16.

## Pre-flight (Do These Before Starting Phase 1)

- Confirm the docxmcp container is up to date with the latest
  `~/projects/docxmcp/` HEAD (Phase 1 / 1b / 1c shipped in commits
  d155f90 + eeae97e; container was rebuilt + restarted on
  2026-05-03). docxmcp is NOT a git submodule — it is an
  independently-deployed Docker service. Cross-repo coordination
  is by `docker compose build && up -d`, not by submodule pointer.
- Confirm a small / medium / large reference .docx fixture set
  exists under `packages/opencode/test/fixtures/office/`. If not,
  collect at least: `small.docx` (≤ 100 KB), `medium.docx` (~1 MB),
  `large.docx` (~10 MB), `broken.docx` (corrupt zip), `legal.doc`
  (legacy .doc fixture). Capture this as task 0.0 before proceeding.
- Confirm the AGENTS.md no-silent-fallback rule is fresh in memory.
  This work has multiple failure surfaces; every one must be loud.

## Stop Gates In Force

1. **Phase 2 docxmcp container restart**: rebuilding + restarting
   the docxmcp container briefly interrupts any in-flight docx work
   on the host (shared infrastructure). Show the user the docxmcp
   commit hashes being deployed and ask for consent before running
   `docker compose build && up -d`. (Earlier draft of this gate
   said "submodule pointer bump" — that was wrong; docxmcp is a
   Docker service, not a submodule. See DD-10 rewrite.)

2. **Any change to the manifest schema during implementation**:
   `data-schema.json` is the contract. Even a small addition (e.g. a
   new `kind` value) requires an `extend` mode invocation, not a
   silent edit.

3. **Any decision to skip the legacy scanner rewrite (phase 5)**:
   the existing scanner produces noisy output that AI cannot reliably
   parse. Skipping means legacy .doc upload still token-burns the AI.
   If skipping is proposed, classify as `revise` mode and re-promote.

4. **Any deviation from DD-1 (synchronous decompose)**: if real-world
   p95 reveals decompose takes > 5 s, a background-decompose redesign
   may become necessary. That is a `refactor` mode change to the
   timing model, not an in-flight optimisation.

5. **Discovery that `extract_all` cannot be implemented as a thin
   orchestrator over existing extract_text / extract_outline /
   extract_chapter** (e.g. they have shared global state that
   prevents in-process composition): that is new evidence requiring
   a `revise` of design.md DD-4.

## Execution-Ready Checklist

Before starting phase 1:

- [ ] All seven artifacts above have been read end-to-end
- [ ] The fixture set exists or task 0.0 has been added
- [ ] You can run `bun test` cleanly on the current opencode HEAD
- [ ] You can invoke an existing docxmcp tool from the opencode
      CLI manually (e.g. `mcpapp-docxmcp_extract_outline`)
- [ ] Plan-sync is wired (see beta-workflow integration; if running
      outside beta-workflow, run `plan-sync.ts` manually after each
      task tick per plan-builder §16.3)
- [ ] You understand that phase boundaries are rhythmic, not pause
      gates (per plan-builder §16.5); silent advancement through
      phases is the default

## Out of Scope (Do Not Get Drawn Into)

- Building xlsx-mcp / pptx-mcp (placeholder unsupported.md is the
  contract; spec.md does not require a real implementation here).
- Adding an OLE2 structural parser (the printable-runs scanner
  stays; cleaner output is a future spec).
- Auto-eviction of historical sibling dirs (`incoming/<stem>-<ts>/`).
  User can `rm -rf` ad hoc; eviction is a future spec.
- Background / async decompose; progress UI; cancellation flows.
- Changes to image / PDF reader-subagent paths in attachment tool.
- Changes to non-Office binary attachment handling.

## Coordination Notes

- The dispatcher and message composer share manifest read/write
  logic. Lift it to `packages/opencode/src/incoming/manifest.ts`
  (per design.md "Critical Files") before either of them depends
  on it.
- The legacy OLE2 scanner is also moving from the AI-callable tool
  (attachment) to the dispatcher's incoming module (per task 5.1).
  Do not leave duplicate copies behind.
- The docxmcp `extract_all` entry must be available **before** the
  opencode dispatcher hook is wired. Phase order matters; do not
  invert it.

## Promotion Criteria (When This Spec Becomes `verified`)

All of the following must hold:

1. Every task in tasks.md is checked (or explicitly cancelled with
   reason).
2. All ten acceptance checks (AC-1 through AC-10) in spec.md pass.
3. The integration test (task 9.4) shows a real-world docx upload
   producing a populated `incoming/<stem>/` tree with a valid
   manifest, and the AI's view of the message contains the rendered
   routing hint.
4. `specs/architecture.md` upload section reflects the new SOP.
5. No regression in image / PDF / text / JSON attachment tests.
