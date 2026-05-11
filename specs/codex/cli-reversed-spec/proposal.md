# Proposal: codex/cli-reversed-spec

## Why

Every time OpenCode's codex provider drifts from upstream codex-cli behaviour, we re-scan the same Rust files: `core/src/client.rs`, `core/src/session/`, `core/src/installation_id.rs`, `codex-api/src/endpoint/responses.rs`, `login/src/default_client.rs`, `core/src/context/environment_context.rs`. Each scan eats context, risks anchor errors (the cache-4608 misroute on May 11 was exactly this: byte-diff found a long-standing gap, story conflated it with a 2-day regression, time-ordering audit later revealed the wrong cause).

This spec ends the re-scan loop by producing one **rigorously-audited reverse-engineering reference** of how upstream codex-cli operates, scoped to everything that **shapes outbound wire requests and reads inbound responses**. Once graduated to `/specs/codex/cli-reversed-spec/`, every downstream OpenCode codex-provider work (current `provider_codex-prompt-realign/`, deferred `provider_codex-bundle-slow-first-refinement/`, future drift remediation) cites this spec rather than re-deriving from greps.

## Original Requirement Wording (Baseline)

- "我覺得你必須把codex-cli原廠運作的拆解文件先建完整驗通過嚴謹稽核，免得老是在兜圈子重新掃碼。這個文件應該要納入/specs的管理" (2026-05-11)
- "拆分章節批次處理，用idef0方法論解析每一個subfunction的workflow"

## Requirement Revision History

- 2026-05-11: initial draft. Chapter-batched, IDEF0-per-subsystem, audit-before-promote discipline.

## Effective Requirement Description

1. Produce a **chapter-structured reverse-engineering reference document** covering the upstream codex-cli runtime — every subsystem that influences outbound HTTP / WebSocket wire shape or interprets inbound responses.
2. Each chapter MUST decompose its subsystem using IDEF0 ICOM (Inputs, Controls, Outputs, Mechanisms) — not merely prose. Sub-functions get their own A_N child diagrams.
3. Every factual claim about upstream behaviour MUST carry a `spec_add_code_anchor` to `refs/codex/codex-rs/...:N` (file + line + symbol). Claims without anchors are inadmissible.
4. Each chapter passes a **dedicated audit pass** (independent re-read of every code anchor; mismatch = chapter goes back to draft) before the spec promotes the next chapter.
5. Each chapter ends with an **OpenCode delta map** section: what OpenCode currently does for the same subsystem, what's aligned, what's drifted, link to the controlling local spec.
6. Drift guard via `wiki_validate drift_code_anchors` — when `refs/codex` submodule bumps, drift surfaces automatically; chapter affected enters re-audit before any new code change downstream cites it.

## Scope

### IN
- Wire-affecting subsystems: entry-point bootstrap, auth & identity, session/turn lifecycle, context fragment assembly, tools/MCP wiring, Responses API request build, HTTP SSE transport, WebSocket transport, compact sub-endpoint, subagent variants, cache architecture (server-side observed dimensions), rollout/telemetry surfaces.
- IDEF0 ICOM diagrams (json + auto-rendered SVG via miatdiagram) for every chapter and sub-function.
- GRAFCET diagram for the typical "user types message → assistant streams reply → tools fire → assistant resumes" runtime loop.
- Code anchors to `refs/codex/codex-rs/...:N` for every factual claim.
- OpenCode delta map per chapter.
- Audit checklist + audit-pass evidence for each chapter (recorded in events log).

### OUT
- Internal subsystems that don't touch wire shape: `apply-patch`, `bwrap`, `linux-sandbox`, `windows-sandbox-rs`, `process-hardening`, `network-proxy`, `terminal-detection`, `tui` rendering, `ansi-escape`. Listed under "Out-of-scope crates" in design.md for completeness.
- Implementation of OpenCode fixes — those belong in dedicated sibling specs that cite this reference.
- Anthropic / Google / other-provider analogue subsystems.
- Performance / cost analysis — pure behavioural reference.

## Non-Goals

- Re-implementing upstream features in OpenCode.
- Predicting what upstream will do next; this is a snapshot reference at the current submodule pointer.
- Comprehensive end-user documentation; the audience is OpenCode codex-provider maintainers + future RCA work.

## Constraints

- **Every claim cited or it doesn't ship.** No unsupported "upstream does X" statements.
- **Snapshot pinning.** Each audit pass records the `refs/codex` submodule SHA at audit time. Future drift detection compares against that SHA.
- **Chapter-batched.** One chapter at a time: draft → audit → promote → move to next. No cross-chapter forward references that aren't already audited.
- **IDEF0 every subsystem.** Prose-only chapters fail the design gate.
- **AGENTS.md rule 1.** If a claim cannot be code-verified, the chapter must record the gap explicitly (an "open question" entry), not paper over it.

## What Changes

- New package `plans/codex_cli-reversed-spec/` (drafting), graduates to `specs/codex/cli-reversed-spec/`.
- Chapter content files (e.g. `chapters/01-entry-points.md`, `chapters/02-auth-identity.md`, ...) authored progressively.
- `provider_codex-prompt-realign/design.md` Context layer map updated to cite this reference once the relevant chapter graduates.
- `provider_codex-bundle-slow-first-refinement/` resumes from this reference (currently shelved, see its event log).

## Capabilities

### New Capabilities
- Single source of truth for upstream codex-cli wire behaviour, citeable from any future spec.
- Drift detection (`wiki_validate`) over every cited code anchor — submodule bumps surface as warnings before they cause silent regressions.
- Auditable claim trail — every behavioural assertion has a file:line; an auditor can independently reproduce the read.

### Modified Capabilities
- Downstream codex specs cite chapters instead of re-deriving from `refs/codex` greps.
- RCA work consults the reference's chapter delta-map before opening new hypotheses.

## Impact

- Affected code: none directly. The reference is documentation that downstream specs cite.
- Affected runtime: none.
- Affected specs: future codex-provider specs cite chapters; `provider_codex-prompt-realign/`, `provider_codex-installation-id/`, `provider_codex-bundle-slow-first-refinement/` get cross-links once relevant chapters graduate.
- Affected operators: none.

## Audit protocol (load-bearing)

For each chapter promotion (draft → audited):

1. **Claim extraction**: list every factual statement made in the chapter as a numbered claim C1, C2, ...
2. **Anchor verification**: for each Cn, the recorded code anchor's file exists, the line exists, the symbol exists, and the cited content actually supports Cn.
3. **Cross-check**: at least one cited anchor per chapter must be a TEST or a TYPE definition — not only prose comments — so the claim is rooted in compiled / executed code, not stale documentation.
4. **Submodule pin**: record `refs/codex` HEAD SHA at audit time in the chapter's audit-pass event.
5. **Open questions**: any claim that could not be verified is moved to the chapter's "Open questions" section, NOT silently dropped.
6. **Sign-off**: audit-pass event recorded via `spec_record_event` with claim/anchor count + SHA + open-questions count.

A chapter fails audit if any of: (a) a claim has no anchor, (b) an anchor doesn't actually support the claim, (c) zero tests/types cited (only comments). Failed chapters return to draft.
