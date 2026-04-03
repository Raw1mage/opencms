# Reconstruction Map

## Purpose

- Translate the missing-commit appendix into latest-`HEAD` reconstruction subproblems.
- Make reconstruction order explicit so build work operates on feature slices, not raw SHAs.

## Status Legend

- `rebuild_confirmed`: should be rebuilt/reintroduced on latest `HEAD`
- `analysis_gate`: must pass supersession/dependency analysis before deciding final shape
- `dedup_gate`: mixed-bucket slice that must be split and deduplicated first
- `merged_into_newer_subproblem`: no standalone rebuild; absorbed into another newer or broader reconstruction slice
- `keep_deprecated_candidate`: may intentionally remain deprecated if latest `HEAD` is proven better
- `keep_deprecated`: intentionally not rebuilt because latest `HEAD` or a newer surviving path is better
- `already_present`: equivalent behavior already present on `main`
- `doc_final_state`: restore latest coherent document state, not old wording snapshots
- `skip_user_redone`: do not restore because user already rebuilt the area

## Commit To Reconstruction Subproblem Map

| commit      | subproblem             | status                         | notes                                                                                                                                                                                                                      |
| ----------- | ---------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0f3176973` | `R1.1`, `R1.2`         | `rebuild_confirmed`            | direct branding regression evidence on current shell                                                                                                                                                                       |
| `db1050f06` | `R1.3`, `R4.3`, `R4.4` | `merged_into_newer_subproblem` | Wave 0 split resolved: branding bits absorb into `R1.1/R1.2`; gateway/login/socket bootstrap folds into `R4.3`; marketplace/template catalog/toggle cleanup folds into `R4.4`                                              |
| `3fd1ef9b8` | `R2.1`                 | `already_present`              | Wave 2: current `compaction.ts` / `prompt.ts` on latest `HEAD` already persist checkpoint metadata and apply safe checkpoint injection; focused `compaction.test.ts` passes on beta with disposable `node_modules` linkage |
| `efc3b0dd9` | `R2.2`                 | `already_present`              | Wave 2: continuation invalidation / boundary-safe checkpoint application path is already present in current `HEAD`; no additional beta delta required                                                                      |
| `4a6e10f99` | `R2.3`                 | `already_present`              | Wave 2: current `compaction.ts` already includes small-context truncation safeguards and focused `compaction.test.ts` passes                                                                                               |
| `85691d6e3` | `R2.3`                 | `already_present`              | Wave 2: current `compaction.ts` already contains checkpoint cooldown behavior; no separate beta delta required                                                                                                             |
| `f041f0db8` | `R2.4`                 | `rebuild_confirmed`            | Wave 2: bounded beta delta in `prompt.ts` / `workflow-runner.ts` adds subagent nudge and stale in-flight cleanup to harden weak-model / stalled lifecycle cases                                                            |
| `f768f63a1` | `R2.6`                 | `rebuild_confirmed`            | Wave 2: bounded beta delta in `prompt.ts` adds compaction-loop breaker and nudge cadence guard                                                                                                                             |
| `3c60b613f` | `R2.5`                 | `rebuild_confirmed`            | Wave 0: current `message-v2.ts` still uses `image` + raw data URL path; no newer superseding media normalization evidence found                                                                                            |
| `7bd35fb27` | `R3.1`                 | `already_present`              | Wave 1: lazy tool loading / adaptive auto-load already exists on current `HEAD` via `tool-loader.ts`, `resolve-tools.ts`, and `config.ts`                                                                                  |
| `43d2ca35c` | `R3.2`                 | `already_present`              | Wave 1: `ALWAYS_PRESENT_TOOLS` already uses `todowrite` / `todoread`, so no rebuild delta remains                                                                                                                          |
| `a34d8027a` | `R3.3`                 | `already_present`              | Wave 1: current `resolve-tools.ts` already mutates `tool_loader` description in place instead of rebuilding the tool                                                                                                       |
| `eaced345d` | `R3.4`                 | `already_present`              | Wave 1: current `apply_patch.txt` / `edit.txt` already contain the stricter spacing guidance and read-first recovery rules                                                                                                 |
| `18793931b` | `R4.1`                 | `rebuild_confirmed`            | Wave 3: beta adds system-wide template discovery/install path via `/usr/local/share/opencode/templates` fallback and install-time sync                                                                                     |
| `5c18f28fe` | `R4.2`                 | `rebuild_confirmed`            | Wave 3: beta adds bounded auto user-init shell-profile injection in daemon-mode startup path                                                                                                                               |
| `197fc2bd7` | `R5.1`                 | `already_present`              | Wave 4: current `HEAD` already ships the native OAuth/shared-library baseline through `packages/opencode-claude-provider` plus `ClaudeNativeAuthPlugin` loader wiring                                                      |
| `9321ca7b1` | `R5.2`                 | `already_present`              | Wave 4: Bun FFI loading + `ClaudeNativeAuthPlugin` are already active on current `HEAD`; focused loader smoke returns `{hasFetch:true,isClaudeCode:true}`                                                                  |
| `809135c30` | `R5.3`                 | `already_present`              | Wave 4: the current chain already uses the newer native-plugin bridge shape rather than the older standalone anthropic fallback path                                                                                       |
| `267955d3a` | `R5.4`                 | `merged_into_newer_subproblem` | Wave 0: current `transport.c` is only a placeholder; heap-parser fix matters only when rebuilt native transport path lands under the newer Claude chain                                                                    |
| `4a4c69488` | `R5.5`                 | `already_present`              | Wave 4: focused fetch smoke shows current `claude-cli` path still routes through `anthropic.ts` with Claude Code headers/betas and `mcp_` tool transformation intact                                                       |
| `addb248b2` | `R5.6`                 | `already_present`              | equivalent provider registration already on main                                                                                                                                                                           |
| `e039b1cb8` | `R5.7`                 | `keep_deprecated`              | Wave 0: this local revert pivots back to the older Anthropic SDK/interceptor path; current `HEAD` already uses newer `ClaudeNativeAuthPlugin` bridge, so keep only overlapping protocol details via `R5.5/R5.6`            |
| `515a1ca7d` | `R5.8`                 | `merged_into_newer_subproblem` | Wave 0: merge commit mostly bundles `R5.3/R5.5/R5.6` plus provider-manager visibility fixes already skipped as user-redone; no standalone rebuild slice remains                                                            |
| `72ee7f4f1` | `R5.9`                 | `keep_deprecated`              | Wave 4: current `HEAD` uses newer `refs/claude-code` + `refs/openclaw` reference surfaces; adding separate historical `refs/claw-code` would duplicate/regress current ref strategy                                        |
| `a148c0e14` | `R5.9`                 | `keep_deprecated`              | Wave 0: current `HEAD` already points `refs/claw-code` to newer `9ade3a70...`; do not regress submodule back to `9a86aa6`                                                                                                  |
| `79e71cbde` | `R6.1`, `R6.2`         | `rebuild_confirmed`            | restore reasoning-capable variants                                                                                                                                                                                         |
| `3ab872842` | `R7.1`                 | `already_present`              | Wave 2: current `llm.ts` on latest `HEAD` already emits `llm.packet` outbound/inbound debug checkpoints; no extra beta delta required                                                                                      |
| `335639b3d` | `R8.1`                 | `doc_final_state`              | rebind/checkpoint planning docs                                                                                                                                                                                            |
| `74afa58e8` | `R8.1`                 | `doc_final_state`              | context-optimization docs state                                                                                                                                                                                            |
| `b4674e116` | `R8.2`                 | `doc_final_state`              | claude-provider planning docs                                                                                                                                                                                              |
| `ff2efd7d4` | `R8.2`                 | `doc_final_state`              | claude-provider architecture/spec evolution                                                                                                                                                                                |
| `ba48f82ce` | `R8.2`                 | `doc_final_state`              | claude-cli provider event state                                                                                                                                                                                            |
| `5f7d6f379` | `R8.2`                 | `doc_final_state`              | HTTP transport spec state                                                                                                                                                                                                  |
| `cdec6f0cb` | `R8.2`                 | `doc_final_state`              | auth model / OAuthTokenSet doc state                                                                                                                                                                                       |
| `78a0f5d79` | `R8.3`                 | `doc_final_state`              | user-init event/task docs                                                                                                                                                                                                  |
| `6e774cc2b` | `R8.4`                 | `doc_final_state`              | github-copilot event docs                                                                                                                                                                                                  |
| `4264f4133` | `provider-manager`     | `skip_user_redone`             | user rebuilt area                                                                                                                                                                                                          |
| `164930b23` | `provider-manager`     | `skip_user_redone`             | user rebuilt area                                                                                                                                                                                                          |
| `9870e4f53` | `provider-manager`     | `skip_user_redone`             | user rebuilt area                                                                                                                                                                                                          |
| `81f2dc933` | `provider-manager`     | `skip_user_redone`             | user rebuilt area                                                                                                                                                                                                          |
| `cd8238313` | `provider-manager`     | `skip_user_redone`             | user rebuilt area                                                                                                                                                                                                          |
| `dda9738d8` | `provider-manager`     | `skip_user_redone`             | user rebuilt area                                                                                                                                                                                                          |

## Reconstruction Order

### Wave 0 — Analysis Gates / Shared Setup

1. Build latest-`HEAD` diff baselines for R1-R8.
2. Resolve mixed-bucket split for `db1050f06` (`R1.3` vs `R4.3/R4.4`).
3. Resolve analysis-gate slices:
   - `R2.5` (`3c60b613f`) -> resolved as `rebuild_confirmed`
   - `R5.4` (`267955d3a`) -> resolved as `merged_into_newer_subproblem`
   - `R5.7` (`e039b1cb8`) -> resolved as `keep_deprecated`
   - `R5.8` (`515a1ca7d`) -> resolved as `merged_into_newer_subproblem`
   - `R5.9` latest-ref exact target (`a148c0e14`) -> resolved as `keep_deprecated`

## Wave 0 Conclusions

- `db1050f06` no longer blocks execution as a mixed bucket; its pieces are now assigned to `R1.1/R1.2`, `R4.3`, and `R4.4`.
- `R2.5` remains a real rebuild target because current `HEAD` still lacks the normalized `media` payload shape introduced by `3c60b613f`.
- `R5.4` is not a standalone branchable fix; it should be implemented only as part of the broader rebuilt Claude native transport path.
- `R5.7` is intentionally kept deprecated as a standalone path because current `HEAD` has already moved beyond the older Anthropic SDK fallback shape.
- `R5.8` is a packaging/merge artifact, not an independent reconstruction slice.
- `R5.9` should preserve the presence of `refs/claw-code`, but keep the newer current submodule target instead of restoring the older `a148c0e14` pointer.

## Wave 1 Conclusions

- `R1.1/R1.2` required real reconstruction on beta surface: shell title and favicon/app icon routing now point to `TheSmartAI` / `/logo.png`, and historical `packages/app/public/logo.png` has been restored into the beta worktree.
- `R3.1-R3.4` did not require code changes because current `HEAD` already contains the lazy-tool-loading, tool ID, in-place description mutation, and prompt ergonomics improvements from the old commits.
- `R6.1/R6.2` required a targeted delta: `gpt-5-mini` and `gpt-5.4-mini` now expose `reasoning: true` in the GitHub Copilot default model registry.
- Wave 1 validation is partly source-evidence based because the beta worktree currently cannot resolve runtime test dependencies (`zod` and related packages) when running focused `bun test` directly from the disposable surface.

## Wave 2 Conclusions

- `R2.1/R2.2` did not require fresh beta code changes: current `HEAD` already contains rebind checkpoint durability, `lastMessageId` persistence, safe checkpoint injection, and continuation-boundary protections. Focused `compaction.test.ts` passes once the disposable beta worktree is given a temporary `node_modules` symlink to the authoritative repo.
- `R2.3` is also already present on current `HEAD`: small-context truncation and checkpoint cooldown are already implemented in `compaction.ts`, with focused `compaction.test.ts` passing.
- `R2.4/R2.6` are satisfied by the bounded beta deltas in `prompt.ts` / `workflow-runner.ts`: subagent nudge behavior, compaction-loop breaking, and stale `resumeInFlight` timeout cleanup provide the missing runtime-hardening/cadence layer without reopening broader continuation architecture.
- `R2.5` required a real beta delta: `message-v2.ts` now normalizes tool-result attachments to the newer `media` shape, and `message-v2.test.ts` passes (`24 pass, 0 fail`).
- `R7.1` required no fresh beta delta because current `llm.ts` already emits `llm.packet` outbound/inbound checkpoints on latest `HEAD`.
- Wave 2 validation remains a mix of focused tests and source evidence. Disposable beta validation currently relies on a temporary `node_modules` symlink to `/home/pkcs12/projects/opencode/node_modules`; this does not touch the authoritative `mainWorktree`.

## Wave 3 Conclusions

- `R4.1` required a real beta delta: `packages/opencode/src/global/index.ts` now supports repo-independent template discovery with a system fallback at `/usr/local/share/opencode/templates`, and `script/install.ts` now syncs system templates during install when permissions allow.
- `R4.2` required a bounded beta delta: `packages/opencode/src/global/index.ts` now performs daemon-mode shell-profile injection using the existing `shell-profile.sh` template, without touching the authoritative `mainWorktree`.
- `R4.3` did not require a new beta delta because current `HEAD` already contains the newer unified onboarding/runtime surface: managed app runtime, OAuth connect/callback flows, and `/api/v2/mcp/market` card aggregation are present in `packages/opencode/src/server/routes/mcp.ts` and `packages/opencode/src/mcp/index.ts`.
- `R4.4` did not require a new beta delta because current `HEAD` already contains a newer app-market surface in `packages/app/src/components/dialog-app-market.tsx` plus current template defaults in `templates/opencode.json`; the old mixed-bucket UI/toggle shape is treated as absorbed by newer behavior rather than replayed verbatim.
- Wave 3 validation is source-evidence heavy: the bounded deltas live in startup/install paths, while the onboarding/marketplace residue is already present on current `HEAD` in a newer shape.

## Wave 4 Conclusions

- `R5.1/R5.2/R5.3` did not require fresh beta code changes: current `HEAD` already contains the native shared-library package, `ClaudeNativeAuthPlugin`, and the newer bridge-oriented Claude path. Native build succeeds from `packages/opencode-claude-provider`, and focused loader smoke returns `{hasFetch:true, hasApiKey:true, isClaudeCode:true}`.
- `R5.5/R5.6` are also already present on current `HEAD`: `claude-cli` provider visibility exists (`Provider.list()` exposes `claude-cli` with bundled models), and the focused fetch smoke proves the request path still runs through `anthropic.ts` with Claude Code headers/betas plus `mcp_` tool prefix / identity injection.
- `R5.4` remains correctly merged into the newer chain rather than rebuilt standalone; `transport.c` is still a placeholder, but that is acceptable because the active Claude path is the newer plugin/TS fetch route, not the abandoned standalone native transport path.
- `R5.7` remains intentionally deprecated and `R5.8` remains a packaging artifact, with no standalone rebuild delta on current `HEAD`.
- `R5.9` is resolved as keep-deprecated for the historical `refs/claw-code` submodule itself: current `HEAD` already uses newer `refs/claude-code` and `refs/openclaw` references, so re-adding `refs/claw-code` would regress/duplicate the current reference strategy.
- Wave 4 therefore completes as a validation-heavy wave: the newest workable Claude capability chain is already present in current `HEAD`, so this beta wave mainly hardens evidence and avoids unnecessary replay.

## Wave 5 Conclusions

- `R8.1-R8.4` were synchronized to the latest coherent document state through the event log and the current `restore_missing_commits` plan package; no additional historical doc replay was required beyond aligning conclusions from Waves 0-4.
- `R8.5` is complete: `implementation-spec.md`, `design.md`, `reconstruction-map.md`, `branch-strategy.md`, `tasks.md`, and `handoff.md` now reflect the same latest-HEAD reconstruction outcomes.
- The overall restore workflow stops at a documentation-complete / execution-complete gate, not at fetch-back/finalize.
- Remaining blocker before any next workflow step: authoritative `mainWorktree` is still dirty (`docs/events/event_20260401_cms_codex_recovery.md`, `plans/20260402_commits/`), so beta workflow cannot proceed to fetch-back/checktest/finalize yet.

### Wave 1 — High-Visibility / Low-Ambiguity Restores

1. `R1.1`, `R1.2` — branding shell identity
2. `R3.1`~`R3.4` — tool loading / schema ergonomics
3. `R6.1`, `R6.2` — Copilot reasoning variants

### Wave 2 — Runtime Stability Core

1. `R2.1`, `R2.2` — rebind checkpoint safety + continuation integrity
2. `R2.3`, `R2.4`, `R2.6` — compaction/cooldown/lifecycle/cadence
3. `R7.1` — llm packet debug checkpoints

### Wave 3 — Global Init / Onboarding Surface

1. `R4.1`, `R4.2` — repo-independent init / shell integration
2. `R4.3`, `R4.4` — onboarding / marketplace residue after dedup

### Wave 4 — Claude Capability Chain

1. `R5.9` — refs/submodule/document support baseline
2. `R5.1`, `R5.2` — native auth + FFI bridge baseline
3. `R5.3` — LanguageModelV2 / JSCallback upgraded path
4. `R5.5`, `R5.6` — cli path / registration / integration
5. `R5.4`, `R5.7`, `R5.8` — transport + residue + merge audit slices after analysis gates close

### Wave 5 — Documents Final State

1. `R8.1` session/rebind docs
2. `R8.2` claude-provider docs/spec/events
3. `R8.3` user-init docs
4. `R8.4` github-copilot docs
5. `R8.5` current plan coherence / final sync

## Stop / Analysis Gates

- Any subproblem marked `analysis_gate` must not enter build until its supersession review is written down.
- Any subproblem that appears better served by current `HEAD` may move to `keep_deprecated_candidate`, but only with explicit evidence.
- Provider-manager items remain outside reconstruction waves unless the user reopens them.
