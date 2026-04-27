# Architecture

## System Overview

OpenCode is a desktop/TUI/Webapp multi-interface platform for interacting with AI coding agents and various model providers (OpenAI, Anthropic, Gemini, etc.).

## Core Architecture

- **Multi-Interface**: TUI (`cli/cmd/tui`), Desktop App, Webapp (`packages/app`), and CLI.
- **Unified Backend**: All interfaces communicate with a shared Node/Bun backend via the `@opencode-ai/sdk` or direct function calls.
- **Provider Abstraction**: Model interactions are abstracted through the `Provider` module. Product-visible provider universe is now registry-first: a repo-owned supported provider registry defines which canonical providers cms officially supports and may show in `/provider` or UI lists, while runtime/config/accounts/models sources only enrich those supported providers with state and model metadata.

Architecture Sync (2026-04-08, webapp voice input MVP): Verified (No doc changes). 依據：變更僅限 `packages/app/src/components/prompt-input.tsx` 既有前端互動接線，未新增或改寫模組邊界、跨層資料流、server/API contract 或 runtime state authority。

## Frontend Architecture

### Layered Structure

The frontend is built with Solid.js and uses a bottom-up dependency model:

- **Infrastructure layer**: API transport, EventSource/WebSocket listeners, and platform adapters.
- **Sync layer**: `GlobalSync` plus per-workspace stores act as the authoritative event-reduced state surface.
- **Control layer**: layout, permission, and command coordination for global UI behavior.
- **Feature layer**: prompt, file, and terminal domain logic.
- **UI layer**: pages and components that subscribe to reactive state and render only the required slices.

### Frontend Data Flow

- Backend events stream into the SDK, then into `GlobalSync`, where reducers update Solid stores.
- UI components consume fine-grained reactive state so updates stay localized.
- User actions flow through feature/control contexts into the SDK, with optimistic UI where required, then reconcile against server-driven events.

### Frontend State Rules

- Prefer local reactive primitives for local UI state.
- Use centralized stores only for shared or durable data.
- Maintain per-workspace child stores to isolate data and reduce unnecessary redraws.
- Use structured reconciliation for large collections so component identity and scroll position remain stable.

### Frontend File / Rich Content Surfaces

- `packages/app/src/pages/session/components/message-content.tsx` is the assistant text entry point and routes assistant markdown through the session rich-content stack.
- `packages/app/src/pages/session/file-tabs.tsx` is the file-tab authority surface; binary/image/SVG/markdown/text branches are resolved here before content is displayed.
- `packages/app/src/pages/session.tsx` is also part of the file-tab control surface: file-open flows are expected to both append/open the tab and set the newly opened file tab active immediately so the visible file view matches the most recent file-list selection.
- Markdown file preview is no longer conceptually equivalent to generic source rendering: `.md` tabs may render through a preview-oriented rich markdown surface while retaining a source-mode fallback.
- Shared markdown rendering behavior for chat and markdown file preview is being centralized under session-page rich markdown helpers/components so safety/fallback policy stays consistent.
- Existing SVG file-viewer behavior remains the authority for rich SVG inspection; markdown/chat flows should route to that safe viewer path rather than injecting arbitrary inline SVG.

### Frontend Performance Rules

- Large file/message surfaces rely on virtual scrolling.
- Expensive derived views must stay memoized.
- Effects should use untracked access when reads are not meant to become dependencies.
- Page-level code paths should remain lazily loaded when possible.

### Frontend Source Map

- `packages/app/src/context/`: domain state and coordination.
- `packages/app/src/pages/session/`: session-page controller/hooks/components. This surface now also owns the emerging shared rich-markdown rendering path used by assistant message content and markdown file preview in file tabs.
- `packages/app/src/hooks/`: reusable frontend logic.

## Planner / Spec Repository Lifecycle

> **Transition in progress (2026-04-18)**: the legacy `/plans/` vs `/specs/` split is being superseded by the `plan-builder` skill (see `## plan-builder Skill Lifecycle` below). New plans go straight into `/specs/<slug>/` and carry a `.state.json` lifecycle file. Legacy `/plans/<slug>/` packages remain functional and are migrated on-touch — see the plan-builder launch event for details.

- **Active plan/build workspace**: dated plan packages now live under `/plans/` inside the repo worktree.
- **Global architecture SSOT**: `specs/architecture.md` remains the long-lived architecture document and is not part of any dated plan package.
- **Formalized specs**: post-implementation, post-commit, post-merge formalized feature specs belong under semantic per-feature roots in `/specs/`.
- **Promotion rule**: `/plans/` artifacts remain the active planning/build contract during execution. Outside beta finalize they do not automatically move into `/specs/`; however, the beta workflow now requires a post-merge closeout step: after the final `test/*` branch merge into `baseBranch`, the completed plan must be consolidated into the related semantic `/specs/` family in the authoritative docs repo/worktree.
- **Beta closeout fail-fast**: if the target semantic `/specs/` family for that post-merge consolidation is ambiguous or absent, workflow must stop and request explicit user direction; silent fallback creation of isolated spec roots is prohibited.
- **Current promoted package**: the completed builder quiz-guard / build-mode refactoring package was promoted from `/plans/20260321_build-mode-refactoring/`, then merged into the existing canonical semantic root `/specs/builder_framework/` because both roots describe the same builder framework topic; future work should use `/specs/builder_framework/` as the formal reference package.
- **Promoted codex runtime package**: the completed `plans/codex-efficiency/` and `plans/aisdk-refactor/` tracks were later promoted and merged into `/specs/codex/provider_runtime/`.
- **Promoted codex websocket package**: after user confirmation of completion, `plans/codex-websocket/` was promoted into `/specs/codex/websocket/` and removed from `/plans/`.
- **Unified codex semantic root**: Codex protocol-observation material lives under `/specs/codex/protocol/`; `specs/codex/` is now the unified semantic root for codex-related specs.
- **Legacy dated packages under `/specs/`**: these require explicit status-based triage; implemented packages belong in formalized spec roots, non-implemented packages belong in `/plans/`. Silent dual-root fallback is prohibited.

## plan-builder Skill Lifecycle

Launched 2026-04-18 to supersede the legacy `planner` skill (see `docs/events/event_2026-04-18_plan-builder_launch.md`).

- **Skill location**: `~/projects/skills/plan-builder/` (symlinked to `~/.claude/skills/plan-builder/`).
- **Single-folder model**: per-feature specs live at `/specs/<slug>/` from day 0 through archive. There is no separate `/plans/<slug>/` location under the new model. `/specs/architecture.md` continues to be the repo-wide architecture SSOT and is not per-feature.
- **State machine (`.state.json`)**: each spec folder carries a `.state.json` file whose `state` is one of `proposed`, `designed`, `planned`, `implementing`, `verified`, `living`, `archived`. The file also holds a `history` array recording every transition, sync checkpoint, migration, refactor snapshot, and rollback. Schema: `~/projects/skills/plan-builder/schemas/state.schema.json`.
- **Seven change modes**: `new`, `amend`, `revise`, `extend`, `refactor`, `sync`, `archive` (plus internal `promote`, `migration`, `refactor-rollback`). Mode selection is objective — based on which artifact layer a change touches — rather than subjective small/medium/large judgment.
- **State-aware validation**: `plan-validate.ts` only checks artifacts required for the current state. `plan-promote.ts` validates against the target state before a transition commits.
- **Mandatory sync checkpoint**: `beta-workflow` is the single automatic trigger for `plan-sync.ts`, invoked after every `tasks.md` checkbox toggle during build execution. Drift warns but does not block commits. Every sync run — clean or warned — is recorded in `.state.json.history`, giving auditor-grade change-management evidence (SOC 2 CC8.1).
- **Peaceful on-touch migration**: any plan-builder script operating on a legacy `plans/<slug>/` path auto-promotes the folder to `specs/<slug>/`. State is inferred from artifact combination per deterministic rules; failure to infer throws `StateInferenceError` rather than defaulting (AGENTS.md rule 1 compliance). `git mv` is used when files are tracked; plain `mv` when the source is untracked (with explicit log rationale). Snapshot of pre-migration content is preserved under `specs/<slug>/.archive/pre-migration-YYYYMMDD/`.
- **Three-layer history**: (1) inline delta markers (strikethrough / version prefix) for amend/revise/extend in Markdown artifacts, (2) section-level `[SUPERSEDED by DD-N]` tags for design decisions and requirements, (3) full artifact snapshot to `.history/refactor-YYYY-MM-DD/` for `refactor` mode, reversible via `plan-rollback-refactor.ts`.
- **Code-independence gap analysis**: `plan-gaps.ts` scores a spec's readiness for mechanical codegen across five dimensions — data schema typing, test vector coverage, error catalogue completeness, observability declaration, invariant enforcement points. Output is a numerical score (target ≥90% for high-confidence codegen) plus an explicit gap list.
- **Optional SSDLC profile**: enabled by setting `.state.json.profile` to `["ssdlc"]`. Activates three additional artifact requirements: `threat-model.md` (STRIDE anchored on C4 components), `data-classification.md` (PII flow traced to Sequence diagram messages), `compliance-map.md` (bidirectional Requirement ↔ external-control mapping for SOC 2 / ISO 27001 / GDPR / HIPAA / PCI-DSS).
- **Prompt + script architecture**: all state lives in repo files, all operations are stateless transforms. The skill is deliberately not promoted to an MCP server because there is no in-memory state to share across agents and no cross-session coordination need. Scripts live in `~/projects/skills/plan-builder/scripts/`; shared libraries in `scripts/lib/`.
- **Deprecation contract**: the legacy `planner` skill remains loaded with a deprecation banner for backward compatibility. Any legacy `plans/<slug>/` package remains usable until it is touched by plan-builder, at which point it is peacefully migrated. There is no bulk migration pass; migration is strictly on-touch.
- **Dog-food reference**: the plan that produced this skill — `specs/plan-builder/` — was itself migrated from `plans/plan-builder/` by the freshly-built `plan-migrate.ts`, making it the first real migration test vector.
- **Future HLS layer (planned, not yet implemented)**: a separate skill (likely `hls-synthesizer`) will sit between plan-builder's `designed` state and `beta-workflow`'s build execution. It will produce pseudo-code artifacts (signature, pre/post conditions, step sequence, exception paths) that bridge the gap between architecture diagrams and target-language code. Will be added via plan-builder's own `extend` mode, serving as the first production demonstration of that mode.

## Tool Surface Runtime

- Beta worktree execution currently assumes dependency parity with the main worktree. In practice, focused test execution may require a local `node_modules` symlink or equivalent environment preparation inside the beta worktree before build-slice verification can run.
- Current runtime already behaves as **per-round tool resolve/inject**, not in-flight tool hot swap.
- `packages/opencode/src/session/prompt.ts` resolves tools inside the run loop before each `processor.process(...)` call.
- `packages/opencode/src/session/resolve-tools.ts` is the aggregation boundary for registry tools, MCP tools, managed-app tools, and session/agent/model-aware permission filtering.
- `packages/opencode/src/mcp/index.ts` maintains a dirty-capable tools cache and emits `mcp.tools.changed`, but the new capability surface becomes effective on the next tools resolution cycle rather than through same-round mutation.
- Autonomous continuation pumping is now **workflow-policy gated**, not always-on: `packages/opencode/src/session/workflow-runner.ts` stops with `not_armed` when `session.workflow.autonomous.enabled !== true`, and `packages/opencode/src/session/prompt.ts` no longer force-enables autorun on ordinary turns.
- The `packages/opencode/src/server/routes/session.ts` `/session/:sessionID/autonomous` route is the explicit runtime switch for this policy surface: it respects `body.enabled`, clears queued continuations when disabling, and only enqueues synthetic continuation messages when autorun is enabled.
- **Verbal arm / disarm** (specs/autonomous-opt-in/ Phase 4-6, 2026-04-23): `packages/opencode/src/session/autorun/detector.ts` scans each ingested user message for configured trigger / disarm phrases (loaded from `/etc/opencode/tweaks.cfg` keys `autorun_trigger_phrases` / `autorun_disarm_phrases`, pipe-separated). A match flips `workflow.autonomous.enabled` via `Session.updateAutonomous`. `packages/opencode/src/session/autorun/observer.ts` subscribes to `KillSwitchChanged` and sweeps every armed root session to disarmed on activation. `packages/opencode/src/session/autorun/refill.ts` materializes the next phase of a session's active `specs/<slug>/tasks.md` (state=implementing, discovered under `Instance.directory/specs/*`) when an armed session drains its todolist; if no refill candidate, the session disarms with `stopReason: plan_drained`. The UI toggle removed in 2026-03-21 is not reintroduced — verbal trigger is the sole user-driven arm path.
- Autonomous continuation no longer depends on `packages/opencode/src/session/prompt/runner.txt` or a completion-verify prompt contract. Armed sessions now enqueue only a minimal resume signal, and `packages/opencode/src/session/workflow-runner.ts` stops immediately when no actionable todo exists instead of hardcoding an "update the todolist" prompt.

## Builder-Native Beta Workflow Surfaces

- `packages/opencode/src/session/beta-bootstrap.ts` is the builder-native integration layer for beta bootstrap, validation syncback, routine git execution, drift remediation, and finalize behavior.
- It reuses deterministic git/worktree/runtime primitives from `packages/mcp/branch-cicd/src/project-policy.ts` and project-context resolution from `packages/mcp/branch-cicd/src/context.ts` rather than duplicating branch-cicd logic inside the builder runtime.
- Beta context is resolved and persisted at admission time for plans that opt into the beta workflow; planning itself is performed via the `plan-builder` skill, not via runtime tools.
- `packages/opencode/src/session/workflow-runner.ts` owns validation-stage behavior during autonomous build execution: it prepares syncback metadata for testing continuations and, when runtime policy is non-manual, performs builder-owned syncback checkout plus runtime command execution before the validation slice continues.
- The workflow-runner still injects a beta-oriented execution contract for beta-enabled missions, but that text is advisory only after admission succeeds; enforcement now lives in the runtime admission gate plus continuation checks, not in prompt prose.
- The same workflow-runner owns finalize-stage behavior during autonomous build execution: it prepares merge target / branch / cleanup-default metadata for finalize-oriented continuations, surfaces branch-drift remediation preflight when the base branch advanced, and preserves explicit approval gates before destructive actions.
- `checktest` is a distinct workflow state, not a shortcut: when mission policy or user instruction requires fetch-back into a `test/*` branch/worktree for human verification, that fetch-back step must complete and stop for human validation before any later merge to `baseBranch` is attempted.
- Operator-facing `checktest` must preserve direct checkout ergonomics on the authoritative repo: the fetched-back `test/*` branch should remain directly checkout-able from `mainWorktree`, rather than being implicitly occupied by a separate test worktree unless the operator explicitly asked for that shape.
- Builder routine git defaults are now builder-native across local and remote steps: checkout/commit/pull/push automation can run from approved mission/delegation metadata, but push still remains approval-gated where policy requires it and remote operations fail fast when origin/upstream state is not explicit.
- Builder design treats branch drift as a first-class runtime state: when the stored base/main branch has advanced after beta bootstrap, the runtime prepares remediation/rebase preflight and stops for approval; once explicit destructive-gate remediation approval is present, builder-native remediation executes in the beta worktree and still returns control to finalize as a separate step.
- Manual runtime policy remains an explicit operator boundary: builder may prepare syncback metadata, but it must not invent or auto-run runtime commands.
- Destructive finalize execution now has a builder-native execute path, but it is still explicit-approval-only and cleanup remains conservative by default.
- Drift remediation execute is implemented only for explicit approval-confirmed rebase flow and fails fast on dirty beta state or rebase conflicts; no silent history rewrite or implicit conflict recovery is allowed.
- `packages/mcp/branch-cicd/src/beta-tool.ts` and the `beta-workflow` skill remain advisory/migration assets only: they may help operators or continuations understand the beta surface, but they are not build-admission authorities and must not be treated as enforcement boundaries.

## Account Management (3-Tier Architecture)

- **Tier 1 (Storage)**: `packages/opencode/src/account/index.ts`. A pure repository interacting with `accounts.json`. Enforces unique IDs strictly (throws on collision).
- **Tier 2 (Unified Identity Service)**: `packages/opencode/src/auth/index.ts`. The central gateway for deduplicating identities (OAuth/API), resolving collisions, generating unique IDs, and orchestrating async background disposal (`Provider.dispose()`).
- **Tier 3 (Presentation)**: CLI (`accounts.tsx`), Admin TUI (`dialog-admin.tsx`), Webapp (`packages/app/src/components/settings-accounts.tsx`). Thin clients that _must_ route all account additions/deletions through Tier 2.

## Gateway Google Login Binding Boundary

- The per-user daemon gateway remains Linux-PAM-first: Linux authentication continues to resolve the target uid and daemon authority.
- Google login may exist only as a compatibility path when a Google identity is already bound to a Linux user.
- Shared Google OAuth token storage (`~/.config/opencode/gauth.json`) is for managed app token persistence (e.g. Gmail / Calendar) and is not the binding authority for Linux↔Google identity routing.
- Unbound Google identities must fail fast at the gateway; no silent fallback, auto-match, or first-available-user rescue is allowed.
- The gateway exposes a Google compatibility login endpoint at `POST /auth/login/google` that accepts `google_email` and resolves it through the binding registry.
- Binding data, if added, must be separable from shared token storage and queryable by the gateway as an explicit lookup contract.
- The binding registry is modeled as a global module deployed under `/etc/opencode/` (default path `/etc/opencode/google-bindings.json` with optional `OPENCODE_GOOGLE_BINDINGS_PATH` override); it is distinct from user-scoped OAuth token storage and is the gateway's authoritative lookup surface for Linux↔Google identity routing.

## Compaction Subsystem

The compaction subsystem reduces a session's effective message-stream
size before the next LLM call. After the 2026-04-27 redesign
(`specs/compaction-redesign/`) the public surface is **3 concepts**:

- **Memory** (`packages/opencode/src/session/memory.ts`): per-session
  artifact persisted at Storage key `session_memory/<sid>`. Primary
  content is `turnSummaries[]` (AI's natural turn-end self-summary,
  captured at runloop exit). Auxiliary: `fileIndex`, `actionLog`,
  `lastCompactedAt` (cooldown source-of-truth per DD-7). Two render
  functions: `renderForLLM(sid)` for next LLM call (compact,
  provider-agnostic) and `renderForHuman(sid)` for UI preview.
- **Anchor**: assistant message with `summary: true` plus a part of
  type `compaction`. Lives in the session message stream.
  `filterCompacted` truncates history at the most recent anchor.
  Phase 8's DD-8 unification of the rebind-checkpoint disk file is
  deferred (the legacy file is still readable for restart recovery).
- **Cooldown**: `Memory.lastCompactedAt` (no separate Map). 4-round
  default window. Read by `isOverflow`, `shouldCacheAwareCompact`,
  `SessionCompaction.Cooldown.shouldThrottle`.

### Single entry point

```ts
SessionCompaction.run({
  sessionID, observed, step, intent?, abort?
}): Promise<"continue" | "stop">
```

Triggers (`observed`) are observable conditions, not signals: the
runloop's `deriveObservedCondition` reads pinned identity vs most
recent Anchor identity, `session.execution.continuationInvalidatedAt`
timestamp (DD-11), token budget, and message-stream tail. No flags
persist across iterations (DD-1).

### Cost-monotonic kind chain

```
trigger=overflow / cache-aware / idle:
  narrative → schema → replay-tail → low-cost-server → llm-agent

trigger=manual:
  narrative → low-cost-server → llm-agent  (skips schema by design;
                                            schema doesn't preserve reasoning)

trigger=manual + intent=rich:
  llm-agent only

trigger=rebind / continuation-invalidated:
  narrative → schema → replay-tail  (no paid kinds; maintenance only)

trigger=provider-switched:
  narrative → schema  (replay-tail / low-cost-server provider-specific format excluded)
```

`INJECT_CONTINUE` table is frozen: rebind / continuation-invalidated /
provider-switched / manual all map to `false`. The 2026-04-27 infinite
loop bug is structurally extinct — no code path takes one of those
observed values and emits a synthetic Continue.

### Subagent compaction (DD-12)

Subagents use the same state-driven path as parents for rebind /
continuation-invalidated / provider-switched / overflow / cache-aware.
Compaction writes to the subagent's own message stream (not the
parent's). The only `observed` value subagents do not trigger is
`"manual"` (no UI surface).

### Continuation-invalidated signal (DD-11)

Codex `ContinuationInvalidatedEvent` (when server rejects
`previous_response_id`) is recorded on
`session.execution.continuationInvalidatedAt`. Next runloop iteration
returns `"continuation-invalidated"` from `deriveObservedCondition`
when this timestamp is newer than the most recent Anchor's
`time.created`. State-driven cooldown via anchor-recency comparison —
no flag-clear step.

### Per-turn capture (DD-2)

`captureTurnSummaryOnExit` runs at the runloop exit point
(`prompt.ts`, finish ≠ tool-calls). Reads the assistant's final text,
appends a `TurnSummary` to Memory. Mid-run interruptions do NOT
capture partial summaries; rebind recovery uses the raw-tail
fallback (last N rounds via `Memory.rawTailBudget`).

### Plan reference

Full design: `specs/compaction-redesign/` (proposal.md, spec.md,
design.md, c4.json, sequence.json, idef0.json, grafcet.json,
data-schema.json, tasks.md, handoff.md, errors.md, observability.md,
invariants.md). Implementation history in
`docs/events/event_20260427_compaction_redesign_phase{1..7}.md`.

## Key Modules

- **`src/account`**: Disk persistence (`accounts.json`), ID generation, basic CRUD.
- **`src/auth`**: Identity resolution, OAuth token parsing, high-level API key addition, collision avoidance.
- **`src/provider`**: Manages active connections to model providers and their runtime instances.
- **`src/provider/supported-provider-registry.ts`**: Repo-owned canonical supported provider registry; the single source of truth for the cms official provider universe and product labels.
- **`src/provider/canonical-family-source.ts`**: Canonical provider row builder and runtime-provider resolver. Canonical rows are registry-first; accounts, connected providers, disabled state, and models.dev only overlay state onto supported providers.
- **`src/server/routes/provider.ts`**: `/provider` API assembly surface. Returns canonical provider rows keyed by supported provider registry, not raw observed provider IDs.
- **`packages/app/src/components/model-selector-state.ts`**: Web model manager provider-row state builder. Frontend canonical aliases may be used for provider grouping and display, but disabled-provider blacklist matching must keep legacy `anthropic` distinct from canonical `claude-cli` so WebApp provider gating does not misclassify Claude CLI as disabled.

## Runtime State Initialization Safety

- Module-scope eager `Instance.state(...)` initialization is now considered an architecture risk surface.
- Shared runtime modules should prefer lazy/guarded state access so import-time module evaluation does not hard-require a fully populated `Instance` context.
- This rule matters both for runtime resilience and for any execution surface that provides only partial `Instance` context (for example worker/bootstrap/test harness paths).
- When state truly belongs to the current `Instance`, the module should resolve it on demand; when `Instance.state` is unavailable, any fallback must remain explicit, local, and non-authoritative rather than silently changing higher-level runtime contracts.
- `packages/opencode/src/project/instance.ts` and `packages/opencode/src/bus/index.ts` now also treat missing project context defensively: `Instance.project` may fall back to the global sentinel and bus context resolution must not crash on absent project metadata.

## Config Resolution Boundary

- `packages/opencode/src/config/config.ts` remains the authority for repo/user/local config merge behavior.
- Legacy compatibility still includes `autoshare: true` → `share: "auto"`; removing that migration changes persisted user behavior and is therefore a contract change, not a cleanup.
- Config resolution for non-git nested projects must not be prematurely truncated by current-worktree boundaries alone; nested non-git execution surfaces may still inherit parent `opencode.json` / `.opencode` configuration through the documented upward merge path.
- Config/state initialization should follow the same lazy-state safety rule as other runtime modules so config import does not become a hidden bootstrap-time failure surface.

### Split Config Files + Crash Defense (plans/config-restructure)

**Three-file layout** (all optional; missing files → no-op merge):

- `~/.config/opencode/opencode.json` — boot-critical keys (`$schema`, `plugin`, `permissionMode`, `username`, `keybinds`, `compaction`, etc.). A parse failure here falls back through the LKG snapshot (see below); if no snapshot exists, `/config` returns HTTP 503 without crashing the daemon.
- `~/.config/opencode/providers.json` — `provider`, `disabled_providers`, `model`. **Section-isolated**: a parse failure only zeroes out the provider section. Other subsystems keep running.
- `~/.config/opencode/mcp.json` — `mcp`. **Section-isolated and lazy**: a parse failure only disables the MCP subsystem; MCP connects are already lazy (first tool call) so the main UI is untouched.

Legacy all-in-one `opencode.json` continues to work unchanged — the split files simply overlay additional merge layers when present.

**Error flow** (`packages/opencode/src/config/config.ts`, `packages/opencode/src/server/app.ts`, `packages/app/src/utils/server-errors.ts`):

- `Config.JsonError` / `Config.InvalidError` / `Config.ConfigDirectoryTypoError` map to HTTP **503** in `onError`. The response body is structured (`{ name, data: { path, line, column, code, problemLine, hint } }`) — **raw config text must never leave the daemon**. Daemon-side `log.error` carries a ±3-line debug snippet for operators.
- Webapp renders `ConfigJsonError` / `ConfigInvalidError` via `formatServerError` with a `truncate()` guard (500-char cap) as a defense in depth for older daemons or unexpected shapes.

**Last-known-good snapshot**:

- Path: `$XDG_STATE_HOME/opencode/config-lkg.json` (defaults to `~/.local/state/opencode/config-lkg.json`).
- Written atomically (`.pid.tmp` + `rename`) on every successful `createState()`; every fallback read emits `log.warn` with the failed path + snapshot age (AGENTS.md rule #1: no silent fallback).
- Served as `{ ...config, configStale: true }` so downstream consumers can surface a "using snapshot" banner when relevant.

**Provider availability derivation** (`packages/opencode/src/provider/availability.ts`):

- `ProviderAvailability.snapshot()` reads `Account.listAll()` + `config.disabled_providers` and yields `{ hasAccount, overrideDisabled, byProvider }` with availability ∈ `"enabled" | "disabled" | "no-account"`.
- Runtime behavior of `isProviderAllowed` is unchanged (still `!disabled.has(id)`) — the existing per-path gates (env / auth / account / plugin) already handle "no-account → hide" correctly, so a central filter would regress env-based providers. Availability is a first-class surface for UI and future Phase 3 `providers.json` override.
- `scripts/migrate-disabled-providers.ts --dry-run|--apply` and `scripts/migrate-config-split.ts --dry-run|--apply` are operator-invoked one-shots (with `.pre-*.bak` backups) for pruning the legacy denylist and splitting the combined config.

## Provider Universe Authority

- The cms official provider universe is defined by the repo-owned supported provider registry, not by observed runtime/config/models/account provider IDs.
- Initial supported provider set is: `openai`, `claude-cli`, `google-api`, `gemini-cli`, `github-copilot`, `gmicloud`, `openrouter`, `vercel`, `gitlab`, `opencode`.
- `models.dev` is an enrichment source only: it may update models and metadata for supported providers, but it must not introduce new product-visible providers by itself.
- Runtime custom providers and config-injected providers may still exist for execution, but unsupported keys must fail closed at the provider-list boundary and must not appear in `/provider` or primary UI provider lists unless explicitly added to the registry.
- Legacy provider aliases are not universally interchangeable. In particular, transport/protocol aliasing such as `anthropic -> claude-cli` must not be reused for WebApp disabled-provider matching or favorites/provider-visibility gates.

### `disabled_providers` runtime scope (plans/provider-hotfix, 2026-04-18)

- `disabled_providers` is an **auto-gate**, not a global kill. A listed provider is hidden from catalog iterators (`Provider.list()`, default-model selector, TUI/CLI provider lists, `/provider` REST surface) but the provider entry STAYS in `state().providers`.
- Explicit lookups via `Provider.getModel(providerId, modelId)` continue to resolve for disabled providers — this is the operator's rescue path when they have accounts or `config.provider.<id>` entries but listed the id in `disabled_providers` (e.g. to suppress default-model churn). Every explicit bypass logs once via `log.info`.
- `Provider.listAllIncludingHidden()` exposes the full set for admin/debug flows that need to show hidden entries.
- This narrowing mirrors the sibling `plans/manual-pin-bypass-preflight/` philosophy: auto-path gates must never block explicit operator intent.

### Codex provider request envelope (plans/provider-hotfix Phase 2, 2026-04-18)

- `/responses` requests carry three context-window lineage headers in addition to `ChatGPT-Account-Id` and `x-codex-turn-state`:
  - `x-codex-window-id` — `conversationId:generation` (stable per session; already present pre-hotfix)
  - `x-codex-parent-thread-id` — `Session.parentID` when the session is a subagent
  - `x-openai-subagent` — agent name for subagent lineage
- `session/llm.ts` sets `x-opencode-parent-session` / `x-opencode-subagent` opencode-side headers; `packages/opencode-codex-provider/src/provider.ts` reads them and feeds `buildHeaders()` in `packages/opencode-codex-provider/src/headers.ts`, which emits the upstream names.

### Codex logout revoke (plans/provider-hotfix Phase 1, 2026-04-18)

- `Account.remove("codex", accountId)` calls `CodexAuth.logoutCodex(refreshToken)` BEFORE deleting the local entry. The helper POSTs to `https://auth.openai.com/oauth/revoke` with `token_type_hint=refresh_token` and is **fail-closed**: a non-2xx response or network error throws, and the local credentials stay in place until the operator retries. This prevents orphaned backend tokens after logout.

### Anthropic effort variants for Opus 4.7+ (plans/provider-hotfix Phase 3, 2026-04-18)

- `packages/opencode/src/provider/transform.ts` Anthropic branch returns the `xhigh` variant (budget `min(32_000, model.limit.output - 1)`) for models whose id matches `claude-opus-4-N` with `N >= 7`, or whose `release_date >= "2026-03-19"`. Mirrors the OpenAI `xhigh` gate pattern.

### Codex family rotation rule (plans/codex-rotation-hotfix, 2026-04-18)

- Codex and openai share the ChatGPT subscription `wham/usage` endpoint. `RateLimitJudge.getBackoffStrategy` returns `"cockpit"` for both families; `fetchCockpitBackoff` treats them identically via the `COCKPIT_WHAM_USAGE_FAMILIES` set. The pure helper `evaluateWhamUsageQuota` drives per-candidate `isQuotaLimited` inside `rotation3d.buildFallbackCandidates`, so a codex account that drained its 5H or weekly window is skipped instead of blindly retried.
- `rotation3d.enforceCodexFamilyOnly` applies after candidate scoring: when the current vector's providerId is `codex`, non-codex candidates are removed from the pool (with a per-candidate `log.info` recording the rejection). Auto-rotation is strictly same-family; manual provider switches from UI/TUI remain unaffected.
- When `findFallback` returns null under the codex-only path, `session/llm.ts::handleRateLimitFallback` throws `CodexFamilyExhausted` (NamedError defined in `rate-limit-judge.ts`). `session/processor.ts` wraps each in-catch-block `handleRateLimitFallback` call with a local try/catch that surfaces the error via `MessageV2.fromError` and sets session state to idle; the preflight call in the outer try block bubbles the throw into the existing catch-fallthrough path.
- `account/rotation/backoff.ts::parseRateLimitReason` adds passive message-pattern guards for codex 5H / response-time-window / weekly-usage strings as a belt-and-suspenders when cockpit is unreachable, mapping them to `QUOTA_EXHAUSTED`.

## Managed App Registry (MCP Apps)

### Overview

The Managed App Registry (`packages/opencode/src/mcp/app-registry.ts`) provides a lifecycle state machine for built-in MCP apps that run under opencode runtime ownership. Apps are registered in `BUILTIN_CATALOG` and exposed as AI-callable tools through the MCP tool router.

### State Machine

```
available → installed → pending_config → pending_auth → ready
                     → disabled
                     → error
```

### Registered Apps

| App ID            | Name            | Scope                             | Tools                                                                                                                                               |
| ----------------- | --------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `google-calendar` | Google Calendar | `calendar`, `calendar.events`     | 7 (list-calendars, list-events, get-event, create-event, update-event, delete-event, freebusy)                                                      |
| `gmail`           | Gmail           | `https://mail.google.com/` (full) | 10 (list-labels, list-messages, get-message, send-message, reply-message, forward-message, modify-labels, trash-message, list-drafts, create-draft) |

### Shared Google OAuth

Both Google apps share a single OAuth token stored at `~/.config/opencode/gauth.json`. The OAuth connect flow (`/api/v2/mcp/apps/:appId/oauth/connect`) merges scopes from all installed Google apps before redirecting to Google's consent screen. After successful callback, all installed Google apps are marked configured and enabled.

- Shared Google token freshness is maintained by the MCP runtime, which must perform a silent daemon-start background sweep for the Google app surface only when at least one Google managed app is actually installed and enabled, and keep refresh work serialized so background and on-demand refresh do not race each other.
- Google managed-app observability remains derived from the shared token file, but refresh success must publish updates only for the active Google app set so observers re-read current state without receiving synthetic updates for inactive apps.

### Key Files

- `packages/opencode/src/mcp/app-registry.ts` — BUILTIN_CATALOG, state machine, persistence (`managed-apps.json`)
- `packages/opencode/src/mcp/index.ts` — Tool conversion (`convertManagedAppTool`), executor routing (`managedAppExecutors`)
- `packages/opencode/src/mcp/index.ts` — MCP lifecycle/init surface; hosts the daemon-start sweep entrypoint for shared Google token refresh orchestration.
- `packages/opencode/src/mcp/apps/google-calendar/` — Calendar client + executors
- `packages/opencode/src/mcp/apps/gmail/` — Gmail client + executors
- `packages/opencode/src/server/routes/mcp.ts` — OAuth connect/callback routes, app lifecycle API
- `~/.config/opencode/gauth.json` — Shared Google OAuth token storage
- `~/.config/opencode/managed-apps.json` — App install/config state persistence

## Account Bus Events

- **Event Types**: `account.added`, `account.removed`, `account.activated` — defined in `src/bus/index.ts`.
- **Sanitization**: `sanitizeInfo()` strips secrets (apiKey, refreshToken) before inclusion in bus event payloads.
- **Mutation Mutex**: All account mutations (`add`, `remove`, `setActive`, `update`) are serialized via an in-process Promise-chain mutex (`withMutex`) in `src/account/index.ts`, preventing concurrent race conditions on `accounts.json`.

## Data Flow (Account Deletion)

1. **User Request**: Triggered from TUI/Webapp.
2. **Optimistic UI**: Component removes account from local state immediately.
3. **Service Layer**: `Auth.remove()` calls `Account.remove()` (sync disk deletion).
4. **Background Cleanup**: `Auth.remove()` initiates a non-blocking promise to call `Provider.dispose()` and final disk save.
5. **Bus Event**: `Account.remove()` publishes `account.removed` via GlobalBus → SSE → all connected clients.

## Workspace Change Surfaces

- **Session-owned diff**: `GET /session/:sessionID/diff` returns the authoritative session-owned dirty diff for the current workspace. It is computed from session-owned candidate files intersected with current git-uncommitted state.
- **Workspace git status**: `GET /file/status` returns the whole workdir/project git status for the resolved directory.
- **UI boundary**:
  - Web/TUI session review flows may consume `session.diff` when the UX is explicitly about session-owned changes.
  - TUI sidebar `Changes` and webapp changes sidebar use workspace-level git status (`file.status`) when the UX is explicitly about current workdir uncommitted files.
- These two sources must not be silently conflated; session attribution and workdir cleanliness are separate contracts.

## beta-tool MCP Architecture

- `packages/mcp/branch-cicd` adds a standalone stdio MCP server published as capability `beta-tool`.
- Public tools are exactly `newbeta`, `syncback`, and `merge`.
- The package resolves project context before mutating git state: canonical repo root, authoritative base branch, deterministic beta worktree root, and runtime policy.
- The package is project-aware rather than `cms`-hard-coded: this repo resolves a `webctl.sh` runtime adapter, while non-matching repos must provide explicit runtime policy or complete a bounded clarification step.
- Ambiguity and destructive confirmation are surfaced as structured orchestrator-question contracts rather than silent fallback: repo root, branch name, runtime policy, merge target, and merge confirmation all stop until explicit selection is supplied.
- Loop metadata is persisted under XDG state so repeated beta edit → syncback → runtime validation cycles can reuse the same branch/worktree mapping across sessions.
- `merge` remains approval-gated and re-checks dirty state before merge, worktree removal, or branch deletion.

## Session Monitor / Telemetry Architecture

### Current State

- Runtime emits telemetry-related events from session processing, and supported telemetry events are persisted by `packages/opencode/src/bus/subscribers/telemetry-runtime.ts` into `RuntimeEventService`.
- `packages/opencode/src/session/monitor.ts` currently constructs telemetry-bearing monitor rows, and `GET /session/top` returns those rows as snapshots.
- App currently refreshes `session.top` through `packages/app/src/pages/session/use-status-monitor.ts` and hydrates `session_telemetry` through `packages/app/src/context/sync.tsx` plus `packages/app/src/pages/session/monitor-helper.ts`.
- This means current steady-state behavior is still influenced by hydration-first / monitor-first / page-hook-first paths.

### Target State

- Telemetry is bus-messaging-first / DDS-aligned.
- Runtime emits telemetry events as source facts.
- A server-side telemetry projector owns the authoritative telemetry read model.
- App global-sync reducer owns the canonical telemetry slice.
- UI surfaces are pure consumers of reducer-owned telemetry state.
- `session.top` is bootstrap / catch-up / degraded snapshot transport only.

### Builder Execution Path

1. Freeze current-state baseline and label every wrong authority path.
2. Define the runtime telemetry event contract before downstream design.
3. Define projector aggregate ownership and projector read-model boundaries.
4. Cut steady-state app ownership over to the reducer-owned `session_telemetry` slice.
5. Demote `session.top` and all snapshot/hydration/page-hook paths to bootstrap/recovery-only behavior.
6. Remove conflicting legacy glue and validate that no duplicate authority remains.

### Ownership Rules

- Runtime owns telemetry fact emission, not app hydration.
- Server projector is the only telemetry read-model authority.
- Monitor rows and snapshot routes are downstream projector consumers, not telemetry authorities.
- App page hooks, hydration helpers, and local fallback must not hold steady-state telemetry authority.
- UI components may render telemetry but must not synthesize or persist telemetry truth.

### Minimum Authority Shapes

- Runtime event contract must at minimum distinguish prompt telemetry, round telemetry, compaction telemetry, and session-summary-relevant facts.
- Projector aggregate must at minimum distinguish prompt summary, round summary, compaction summary, session cumulative summary, freshness metadata, and degraded/catch-up metadata.
- App reducer slice must remain session-scoped and canonical, with enough structure for UI consumption but without reintroducing helper-side truth synthesis.

### Context Sidebar Card Surface

- `packages/app/src/components/session/session-context-tab.tsx` is the context-sidebar composition surface for session context metrics plus telemetry cards.
- Legacy context information is grouped into three cards: `Summary`, `Breakdown`, and `Prompt`.
- Context sidebar card order is persisted in app layout state via `packages/app/src/context/layout.tsx` under `contextSidebar.order`.
- The sortable interaction pattern intentionally follows the same UI family as the status sidebar card ordering, but remains a separate persisted order key.
- This is a presentation-layer layout contract only; it does not change telemetry authority boundaries or backend data ownership.

### Migration Warnings

- Hydration-first steady-state is architecturally wrong and must be removed or demoted.
- Monitor-first steady-state is architecturally wrong and must be removed or demoted.
- Page-hook-first steady-state is architecturally wrong and must be removed or demoted.
- Any implementation that leaves `session.top`, monitor hydration, or local fallback as a steady-state telemetry writer is architecture drift.
- Partial migration that introduces projector/reducer while preserving legacy steady-state writers is invalid.

## Daemon Architecture (Multi-User Web Runtime)

### Overview

The web runtime supports a multi-user deployment model with process-level isolation:

```
Internet → [C Gateway :1080] → Unix Socket → [Per-User Daemon (uid=user)]
                                             → [Per-User Daemon (uid=user2)]
```

### Components

#### C Root Gateway (`daemon/opencode-gateway.c`)

- Runs as root, listens on TCP port (default :1080)
- **Non-blocking Event Loop**: Single-threaded `epoll_wait` loop; no blocking I/O in main loop. All sockets set `O_NONBLOCK` at accept time
- **Tagged epoll Context** (`EpollCtx`): Discriminated union (`ECTX_LISTEN | ECTX_PENDING | ECTX_SPLICE_CLIENT | ECTX_SPLICE_DAEMON | ECTX_AUTH_NOTIFY`) attached to each epoll fd so events dispatch by type and direction
- **HTTP Request Accumulation** (`PendingRequest`): Per-connection 8KB read buffer. TCP segments accumulated via EPOLLIN until `\r\n\r\n` detected, timeout (30s), or oversize (400/408). No assumption of single-recv completeness
- **Thread-per-auth PAM**: Login requests spawn `pthread` for `pam_authenticate`; result notified to main loop via `eventfd`. Main loop never blocked by PAM
- **Rate Limiting**: Per-IP hash table (mod 256), sliding window 5 failures / 60s → 429. Successful login clears counter
- **JWT Sessions**: HMAC-SHA256 with **file-backed persistent secret** (`/run/opencode-gateway/jwt.key`, configurable via `OPENCODE_JWT_KEY_PATH`). Validates `sub` + `exp` claims; `sub` → `getpwnam()` → uid
- **Per-User Daemon Spawning**: `fork() → initgroups() → setgid() → setuid() → execvp()` with pre-parsed argv array (no `sh -c` after setuid)
- **splice() Proxy**: Zero-copy bidirectional forwarding (TCP ↔ pipe ↔ Unix socket). Directional: each epoll event splices one direction only based on `EpollCtx.type`
- **Connection Lifecycle**: `EPOLL_CTL_DEL` before `close()` on all fds; `closed` flag guards against in-flight epoll events on same connection; `g_nconns` counter tracks active splice connections
- **Runtime Path Detection** (WSL2-safe): `resolve_runtime_dir()` probes `/run/user/<uid>` → `$XDG_RUNTIME_DIR` → `/tmp/opencode-<uid>/` (mkdir 700) with logging at each fallback
- **PAM Availability Probe**: Startup-time `pam_start("login", ...)` check; fails fast with guidance if PAM is unconfigured
- **Registry**: In-memory UID → (pid, socket_path, state) mapping; SIGCHLD handler cleans up crashed daemons
- **Login Page**: Serves static HTML login form for unauthenticated requests

#### Per-User Daemon (`opencode serve --unix-socket`)

- Runs as the authenticated user's UID
- Listens on Unix socket at `$XDG_RUNTIME_DIR/opencode/daemon.sock`
- Full opencode server (API + SSE + WebSocket) available over Unix socket
- **Discovery File**: `$XDG_RUNTIME_DIR/opencode/daemon.json` — contains `{ socketPath, pid, startedAt, version }`
- **PID File**: `$XDG_RUNTIME_DIR/opencode/daemon.pid` — single-instance guard
- **Cleanup**: Removes discovery + PID files on SIGTERM/SIGINT/process exit; stale files detected and cleaned by `readDiscovery()`
- **Idle Timeout**: 120s TCP/Unix socket idle timeout via `Bun.serve({ idleTimeout: 120 })`

#### TUI Attach Mode (`opencode --attach`)

- Connects to an already-running per-user daemon via Unix socket
- **Auto-Spawn**: If no daemon is discovered, `Daemon.spawn()` launches a detached `opencode serve --unix-socket` child process, polls for `daemon.json` readiness (timeout 10s), then attaches
- **Discovery**: Reads `daemon.json`, validates PID alive (`kill -0`)
- **Custom Fetch**: `createUnixFetch(socketPath)` — routes HTTP requests over Unix socket
- **Custom SSE**: `createUnixEventSource(socketPath, baseUrl)` — streaming SSE client with manual line parsing over Unix socket fetch
- **Graceful Disconnect**: Ctrl+C closes SSE (AbortController) without affecting daemon

#### Daemon Coordination (Discovery-First)

- **Discovery file is truth, in-memory registry is cache**: Both TUI and C gateway use `daemon.json` as the canonical coordination point
- **TUI auto-spawn**: `--attach` → no daemon → `Daemon.spawn()` → daemon writes `daemon.json` → TUI attaches; this is the explicit attach contract and replaces prior fail-fast drift in older docs
- **Gateway adopt**: On web login, C gateway checks `daemon.json` (path resolved via `resolve_runtime_dir()`) before spawning a new daemon. If PID alive and socket connect succeeds → adopt into registry → splice proxy. Stale discovery/socket state is explicitly cleaned instead of silently reused. Covers daemons pre-spawned by TUI `--attach`
- **Gateway JWT validation**: Gateway base64url-decodes payload, validates `sub` + `exp` claims, derives uid via `getpwnam(sub)`, routes by verified identity. JWT secret is file-backed and survives gateway restarts
- **Race safety**: `daemon.pid` acts as single-instance guard; whoever creates the daemon first wins, latecomers discover and adopt

### SSE Event ID + Catch-up (Phase ζ)

- **Global Counter**: Monotonically increasing `_sseCounter` in `src/server/routes/global.ts`
- **Ring Buffer**: Array of `{ id, event }` entries (MAX_SIZE = 1000)
- **Reconnect**: Client sends `Last-Event-ID` header → server replays missed events from buffer
- **Buffer Overflow**: If `lastId` is older than buffer range → server sends `sync.required` event → client does full bootstrap refresh

### Security Migration (Phase δ)

- **Removed**: `LinuxUserExec`, `buildSudoInvocation`, `opencode-run-as-user.sh`, all sudo wrapper logic
- **Rationale**: Per-user daemon already runs as the correct UID; shell/PTY commands spawn directly without privilege escalation
- **Preserved**: Utility functions `sanitizeUsername`, `resolveLinuxUserHome`, `resolveLinuxUserUID` in `src/system/linux-user-exec.ts`

### Subagent IO Visibility

子代理（subagent）透過 `task()` tool 委派工作時，主 session UI 即時顯示子代理活動。

**資料流**:

1. Task tool 建立子 session 後立即呼叫 `ctx.metadata({ sessionId })` → tool part 的 `state.metadata.sessionId` 在 running 狀態即可用
2. Worker process 的子 session events 透過 `__OPENCODE_BRIDGE_EVENT__` stdout protocol → 主 process `publishBridgedEvent()` → Bus → SSE → frontend sync store
3. `SubagentActivityCard` 組件（`packages/app/src/pages/session/components/message-tool-invocation.tsx`）讀取 `sync.data.message[childSessionId]` 顯示子代理的 tool calls 和文字輸出

**組件結構**:

- `tool === "task"` 的 ToolPart 渲染為 `SubagentActivityCard`（取代通用 MCP card）
- Header: agent type + description + elapsed timer
- Body（collapsible）: tool call 列表（status icon + tool name + subtitle）+ text output
- 狀態: running（spinner, auto-open）/ completed（final output）/ error（error banner + partial activity）

### Shared Context Structure

Per-session structured knowledge space that tracks files, actions, discoveries, and goals across turns. Under context sharing v2 it no longer serves as the primary parent→child bridge; it is now a compaction / observability surface plus parent-side knowledge merge target.

**Module**: `packages/opencode/src/session/shared-context.ts`

**Data Model**:

```typescript
Space {
  sessionID, version, updatedAt, budget,
  goal: string,
  files: FileEntry[],      // path, operation, lines, summary
  discoveries: string[],   // key findings extracted from assistant text
  actions: ActionEntry[],  // tool calls summarized per turn
  currentState: string,    // last paragraph of assistant text
}
```

**Storage**: `["shared_context", sessionID]` — per-session, separate namespace from messages. Both parent and child sessions persist their own Space.

**Update Trigger**: After every assistant turn in `prompt.ts` turn boundary loop (both parent and child sessions). Heuristic extraction: tool parts → files/actions; assistant text → goal/discoveries/currentState.

**V2 Context Sharing Contract**:

1. **Forward Path** (`prompt.ts` child prompt loop):
   - When `session.parentID` exists, child prompt-loop startup loads the parent's visible message history once via `MessageV2.filterCompacted(MessageV2.stream(session.parentID))`.
   - Each child model call prepends that parent message prefix, then inserts a delegated-subagent separator message, then appends the child session's own message history.
   - This path replaces dispatch-time SharedContext snapshot injection as the authoritative context bridge.

2. **Task Dispatch** (`task.ts`):
   - Child prompt seeding now contains only the task prompt / execution prompt parts.
   - `SharedContext.formatForInjection()` and `injectedSharedContextVersion` are no longer part of the dispatch contract for V2 child context sharing.

3. **Idle Compaction** (`prompt.ts` turn boundary, parent sessions only):
   - After turn containing task dispatch, evaluate context utilization.
   - If utilization ≥ `opportunisticThreshold` (default 0.6): use Space snapshot as compaction summary (no LLM call).
   - Falls back to LLM compaction agent if Space is empty.

4. **Overflow Compaction** (`prompt.ts` overflow path, parent sessions only):
   - When context overflows: if Space has content, use as summary instead of calling LLM compaction agent.
   - Falls back to standard LLM compaction agent.

**Child→Parent Feedback** (`task-worker-continuation.ts` on subagent completion):

1. Parent continuation must receive child completion evidence derived from child transcript output; `SharedContext` is no longer the sole return channel.
2. `SharedContext.mergeFrom(parent ← child)` remains in place so child files/actions/discoveries become available for later parent compaction and observability.
3. The V1 `snapshotDiff(childSessionID, injectedSharedContextVersion)` differential relay path is no longer the authority for V2 completion handoff.
4. Child completion must not auto-complete the parent linked todo inside `task` tool runtime. On successful child return, the control plane may clear `waitingOn: subagent`, but the parent orchestrator remains the only authority that can mark the current step completed after it actually consumes `<child_session_output>` and decides the next todo transition.

**Validation Evidence (2026-03-27)**:

- `packages/opencode/src/session/compaction.test.ts` verifies cooldown suppression and emergency-ceiling override for high-prefix sessions.
- `packages/opencode/src/session/prompt-context-sharing.test.ts` verifies model-message assembly order: full parent history → separator → child prompt.
- `packages/opencode/src/session/usage-cache-reuse.test.ts` verifies by-token cached usage is preserved as `tokens.cache.read` for telemetry/accounting.
- `packages/opencode/src/session/usage-by-request.test.ts` verifies by-request provider models with zero token rates remain cost-insensitive in local accounting even with very large input token counts.

**Production Telemetry (2026-03-27, 15 V2 child sessions, OpenAI gpt-5.4)**:

- Forward path confirmed: child first-round input avg 102K tokens (12.4x vs V1's 8.2K), avg 109.8 parent messages prepended.
- R2+ cache hit rate: **92.0%** overall; short-task children (3-5 rounds) reach 98-99%.
- Return path confirmed: `<child_session_output>` synthetic user messages contain child's last 3 assistant outputs (avg 1.5K chars), parent correctly integrates into orchestration flow.
- Cache stability: only 2 isolated misses across all 15 sessions (OpenAI eviction timing), all other rounds show stable prefix hit.
- By-request (Copilot) validation deferred — no child dispatches observed in window.

**Config** (`config.compaction`):

- `sharedContext: boolean` (default true) — disable entirely
- `sharedContextBudget: number` (default 8192 tokens) — Space size cap with consolidation
- `opportunisticThreshold: number 0-1` (default 0.6) — idle compaction trigger

### Continuous Orchestration Control Surface

- Dispatch-first continuous orchestration does **not** mean the session becomes globally idle once `task()` returns. If exactly one background subagent is still active, the parent session remains in an operator-controllable active-child state.
- This active-child state is a session-global control-plane concept distinct from foreground parent streaming state.
- **Single-child invariant** remains authoritative: one parent Orchestrator session may have at most one active background subagent at a time.
- **Stop contract** is staged:
  1. first stop interrupts foreground Orchestrator streaming;
  2. second consecutive stop, if the same child remains active, escalates to child termination.
- **Pinned status surface**: while the active-child state exists, Web and TUI should render a bottom-pinned subagent status surface showing child identity, task title, latest progress/step evidence, and a child-session entry affordance.
- **Presentation strategy**: first implementation should prefer extending the existing thinking / elapsed bottom-status UI family, so active-child state appears as the same class of runtime activity indicator rather than a separate widget system.
- **Child-session entry differs by surface**:
  - Web may expose a route URL / clickable child-session link.
  - When the operator is already inside a child/subsession view, the same pinned status-surface affordance should pivot to an explicit return-to-parent-session navigation target instead of reopening the child route.
  - TUI must use its own session-tree jump/navigation mechanism instead of URL rendering.
- The pinned status surface must remain mounted until authoritative runtime evidence shows either:
  - the parent continuation has taken over and active-child state is cleared; or
  - the child failed / was terminated and active-child state is cleared.
- The transcript-local `SubagentActivityCard` remains a detail surface, but it is no longer sufficient as the only operator-visible child-activity surface once continuous orchestration is active.
- Child/subsession views must not render a large observation-only prompt fallback block at the bottom dock; observation-only is expressed by the absence of conversational input plus explicit navigation back to the parent control surface.
- Continuation cleanup order is authoritative: when `TaskWorkerEvent.Done/Failed` arrives, the parent continuation path clears `active-child` before persistence / resume work proceeds, so the parent control plane does not keep advertising a stale wait state.
- Weak client network / SSE staleness may temporarily make Web appear as if the AI or backend is hung, but that is a presentation-layer symptom amplifier. Runtime stop/continue authority remains backend-owned and must not silently depend on frontend connectivity quality.

**Dispatch 規則**:

- SYSTEM.md §2.3: 一次只派出一個 subagent（sequential execution）
- Prompt-level soft enforcement（無 runtime 強制阻擋）

### Subagent Worker Lifecycle

- **Spawn**: `Bun.spawn([bun, run, index.ts, session, worker])` — independent OS process, no shared memory with daemon
- **IPC**: Bidirectional stdin/stdout JSON-line protocol: `{type:"run"|"ready"|"heartbeat"|"done"|"bridge_event"|"error"}`
- **No timeout**: Workers are waited on unconditionally. The only termination trigger is subprocess death (process exit detected by stdout reader loop). No inactivity timeout exists; long-running LLM calls are expected.
- **Liveness**: `worker.proc.exitCode` checked after unexpected stdout close to distinguish crash from clean exit
- **Continuation & Decoupling**: Subagent lifecycle is decoupled from the parent Orchestrator's wait loop via `Bus.publish(TaskWorkerEvent.Done/Failed)`. The parent continuation path is the authoritative clearing point for `active-child` state, ensuring the Orchestrator does not remain in a stale wait state even if the initial request stream was interrupted.
- **Instance context**: `spawnWorker()` captures `Instance.directory` at spawn time and passes it as Bus event context to all `TaskWorkerEvent.Done/Failed` publishes, so the continuation subscriber can re-establish `Instance.provide()` scope after the originating HTTP request scope has ended.
- **Bridge events**: Worker stdout `__OPENCODE_BRIDGE_EVENT__` lines forwarded to parent via `Bus.publish` for SSE/UI visibility

### Performance Hardening (Phase θ)

- **SDK LRU Cache**: `sdkSet()` in `src/provider/provider.ts` — Map-based FIFO eviction (MAX_SIZE = 50)
- **Server Idle Timeout**: 120s for both TCP and Unix socket modes

### Deployment (webctl.sh)

- `compile-gateway`: Compiles `daemon/opencode-gateway.c` via gcc
- `gateway-start`: Compiles + starts gateway daemon (nohup, PID file tracked)
- `gateway-stop`: Graceful SIGTERM → wait → SIGKILL fallback
- `reload`: Auto-detects dev/prod mode. Dev: kills per-user daemons (bun re-reads source on next request). Prod: builds binary + atomic install + kill daemons.
- `restart`: Runs `reload` then recompiles and restarts gateway if source changed.
- `install.sh --system-init`: Installs `opencode-gateway.service` + `opencode-user@.service` systemd units + gateway binary + login page

### systemd Units

- `opencode-gateway.service`: Root-level gateway daemon (`/usr/local/bin/opencode-gateway`)
- `opencode-user@.service`: Per-user daemon template (`/usr/local/bin/opencode serve --unix-socket ...`)

## Session Read Cache + Rate Limit Layer

Added 2026-04-19 via `specs/session-poll-cache/`. Defends the daemon against
high-frequency frontend polling on `GET /api/v2/session/{id}` and
`GET /api/v2/session/{id}/message` without forcing clients to migrate off
polling.

### Components (src paths)

- `packages/opencode/src/config/tweaks.ts` — `Tweaks` namespace. Parses
  `/etc/opencode/tweaks.cfg` (override via `OPENCODE_TWEAKS_PATH`). Missing
  file uses defaults + `log.info`; invalid values warn + per-key default
  fallback (AGENTS.md rule 1).
- `packages/opencode/src/server/session-cache.ts` — `SessionCache` namespace.
  In-process LRU keyed by `session:<id>` / `messages:<id>:<limit>`, plus a
  per-session monotonic version counter used in weak ETags.
- `packages/opencode/src/server/rate-limit.ts` — `RateLimit` namespace.
  Token bucket middleware keyed by `${username}:${method}:${routePattern}`,
  with `normalizeRoutePattern()` collapsing opencode ID segments into `:id`
  so per-session URLs share one bucket.
- `packages/opencode/src/server/routes/cache-health.ts` — `GET
/api/v2/server/cache/health` endpoint exposing cache + rate-limit stats
  via the pluggable `registerCacheStatsProvider` /
  `registerRateLimitStatsProvider` pattern.
- `packages/opencode/src/server/routes/session.ts` — `GET /:sessionID`,
  `GET /:sessionID/message`, `GET /:sessionID/autonomous/health` route
  through `SessionCache.get()` with loader-wrapped `Session.get` /
  `Session.messages`; 304 short-circuit via `SessionCache.currentEtag` +
  `isEtagMatch`.

### Invalidation flow

- Worker process writes trigger `Bus.publish(MessageV2.Event.*)` inside the
  worker's local bus.
- `packages/opencode/src/tool/task.ts:publishBridgedEvent` relays those
  events to the daemon's local bus (same mechanism already used for other
  cross-process session state).
- The daemon's `SessionCache.registerInvalidationSubscriber` subscribes to
  `MessageV2.Event.{Updated, Removed, PartUpdated, PartRemoved}` and
  `Session.Event.{Created, Updated, Deleted}`; each event bumps the
  per-session version counter and drops matching cache keys.
  `Session.Event.Deleted` additionally clears the counter entirely (I-4).

### ETag format

`W/"<sessionID>:<version>:<process-epoch>"` where `process-epoch =
Date.now().toString(36)` captured at module load. The epoch makes
post-restart ETag collisions impossible even though the version counter
resets to 0 per process.

### Rate-limit exempt surfaces

`EXEMPT_PATH_PREFIXES` in `rate-limit.ts`:

- `/log`, `/api/v2/global/log` — log ingestion is high-volume by design
- `/api/v2/global/health`, `/api/v2/server/cache/health` — ops inspectability
  must not be throttled
- `/api/v2/server/` (entire prefix) — ops surfaces extend here over time
- `hostname === "opencode.internal"` — internal worker-to-daemon requests

Unresolvable usernames produce a `log.warn` bypass (E-RATE-002) rather than
a silent throttle or a guess.

### Operator tunables (`/etc/opencode/tweaks.cfg`)

- `session_cache_enabled` (default `1`)
- `session_cache_ttl_sec` (default `60`)
- `session_cache_max_entries` (default `500`)
- `ratelimit_enabled` (default `1`)
- `ratelimit_qps_per_user_per_path` (default `10`)
- `ratelimit_burst` (default `20`)

Defaults live in `templates/system/tweaks.cfg` and are copied to
`/etc/opencode/tweaks.cfg` during install. Daemon reads once at startup;
restart to apply changes (same model as `opencode.cfg`).

### Race / integrity notes

- Subscription wiring failure → `subscriptionAlive=false`, `log.warn`, and
  **no memoization**; loader still runs per request (I-3).
- Cumulative stats only (no 5-min sliding window yet) — tracked as a
  follow-up plan candidate. The schema accommodates either implementation.
- The forwarded-to-per-user-daemon path
  (`UserDaemonManager.routeSessionReadEnabled`) is intentionally **not**
  cached on the gateway side; the per-user daemon owns its own cache.

---

## Question Tool Abort Lifecycle

Runtime SSOT for the `question` tool / `Question.ask` state machine. Added 2026-04-19 alongside [specs/question-tool-abort-fix/](question-tool-abort-fix/).

### Overview

`Question.ask` is the only blocking tool in the runtime — its `execute` function awaits human input indefinitely. Every other tool either completes in milliseconds or streams delta back to the LLM. Because this tool voluntarily yields control to a human, its lifecycle must be bound to the surrounding stream's `AbortSignal`; otherwise a stream teardown leaves a phantom `pending[id]` entry that:

1. keeps the dialog visible to the user after the stream is already gone
2. lets the user submit an answer that the LLM side no longer consumes
3. causes the AI to re-ask the same question on stream restart — generating the "answer → abort → re-ask" loop

### State machine

States: **Idle → Pending → { Replied | Rejected(manual) | Aborted(stream) } → Idle**

Transitions:

| From            | To       | Trigger                                                                                                                                                                   |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle            | Pending  | `Question.ask({ …, abort })` registers `pending[id]`, publishes `question.asked` (unless `abort.aborted` at entry)                                                        |
| Pending         | Replied  | HTTP `/question.reply` → `Question.reply` deletes pending, calls `dispose()`, publishes `question.replied`, resolves promise                                              |
| Pending         | Rejected | HTTP `/question.reject` → `Question.reject` deletes pending, calls `dispose()`, publishes `question.rejected`, rejects with `RejectedError`                               |
| Pending         | Aborted  | `abort` signal fires → `onAbort` listener deletes pending, publishes `question.rejected` (same event as manual reject), rejects with `RejectedError("aborted: <reason>")` |
| Pending+Replied | Replied  | late `abort` fires after `reply` — `onAbort` finds no `pending[id]` → no-op (idempotent)                                                                                  |

### Cancel reason propagation

`prompt-runtime.cancel(sessionID, reason: CancelReason)` → `controller.abort(reason)` → `AbortSignal.reason` visible to downstream `Question.ask` abort handler via `signal.reason`. `CancelReason` enum (see `packages/opencode/src/session/prompt-runtime.ts`):

- `manual-stop` — user pressed Stop in UI, CLI SIGINT/SIGTERM, ACP `session.abort`
- `rate-limit-fallback` — reserved (processor rotation currently uses `continue`, not `cancel`; would be used if future logic explicitly cancels the old stream)
- `monitor-watchdog` — reserved for future session monitor integration
- `instance-dispose` — Instance state cleanup (daemon restart / user switch)
- `replace` — `prompt-runtime.start({ replace: true })` tearing down the prior AbortController
- `session-switch` — reserved for explicit session-switching paths
- `killswitch` — emergency `KillSwitchService.forceKill` / cancel / pause
- Kill-switch stop semantics are two-layered: `KillSwitchService` must both call `SessionPrompt.cancel(sessionID, "killswitch")` and terminate any active child worker through `tool/task.ts::terminateActiveChild(sessionID)`. Aborting only the parent prompt is insufficient when the orchestrator is blocked waiting on a subagent worker result.
- `parent-abort` — subagent cascade: parent session's abort triggers child session cancel via `tool/task.ts`
- `unknown` — default when no meaningful reason is available (should not occur from internal callers; TypeScript enforces the closed set)

### Observability

- `log.info("cancel", { sessionID, reason, caller })` in `session.prompt-runtime` — `caller` is the first non-framework stack frame of whoever invoked `cancel`
- `log.info("aborted", { id, sessionID, reason })` in `question` — fired by the abort listener when a pending question is torn down by stream abort
- `log.info("aborted-pre-ask", …)` — pre-aborted signal at `Question.ask` entry (no `question.asked` published)
- Grep patterns for incident investigation:
  - `grep '"reason":"rate-limit-fallback"'` — count aborts attributed to rotation
  - `grep 'aborted-pre-ask'` — stream already dead when tool was invoked

### Webapp cache

`QuestionDock` (`packages/app/src/components/question-dock.tsx`) caches user input (tab, answers, typed custom text) under `${sessionID}:${fnv1a32(canonicalJson(questions))}` (see `question-cache-key.ts`):

- sessionID prefix isolates cross-session state
- content hash lets AI re-asks of the same question (new `request.id`) restore the user's draft automatically
- FNV-1a sync chosen over async SHA-1 to avoid a createStore race where the user's fresh keystrokes would be overwritten when async hash resolves (see DD-2 v2 in `specs/question-tool-abort-fix/design.md`)
- Cache entry is written on `onCleanup` (only when `replied=false`) and cleared on `reply` / `reject` success

---

## Mandatory Skills Preload Pipeline

Introduced by `specs/mandatory-skills-preload/` (2026-04-19, state=implementing as of 2026-04-20). Purpose: guarantee "must-be-present-every-round" skills are in system prompt without relying on AI to call the `skill()` tool, and without being subject to the 10-min summarize / 30-min unload idle-decay in `SkillLayerRegistry`.

### Data flow

```
session prompt.ts runLoop (every round, Main + coding subagent)
  ├── InstructionPrompt.system() → AGENTS.md text[] (existing, 10s TTL cache)
  ├── MandatorySkills.resolveMandatoryList({ sessionID, agent, isSubagent })
  │     ├── Main agent  → global + project AGENTS.md, parse <!-- opencode:mandatory-skills --> sentinel blocks
  │     └── coding sub  → coding.txt sentinel block only
  │     → dedup with project-priority order → skillName[]
  ├── MandatorySkills.reconcileMandatoryList({ sessionID, desired })
  │     └── for each previously-pinned mandatory entry not in desired → unpin + emit skill.mandatory_unpinned
  ├── MandatorySkills.preloadMandatorySkills({ sessionID, list, bySkill })
  │     ├── for each name: Skill.get(name)
  │     ├── found     → SkillLayerRegistry.recordLoaded + .pin, emit skill.mandatory_preloaded
  │     └── missing   → log.warn + emit skill.mandatory_missing anomaly event; skip (do NOT throw)
  └── processor.process → llm.ts → SkillLayerRegistry.listForInjection → skill-layer-seam renders <skill_layer> tags into system[]
```

Key properties:

- **Skill content bypasses AI self-discipline**: runtime injects content before `processor.process()`, so AI never needs to call `skill()` for mandatory skills.
- **Not subject to idle-decay**: `pinned=true` short-circuits `applyIdleDecay` (line [175-196 of skill-layer-registry.ts](../packages/opencode/src/session/skill-layer-registry.ts#L175-L196)).
- **Diff-based pin reconciliation**: removing a skill from AGENTS.md sentinel auto-unpins it next round.
- **Loud fallback**: missing SKILL.md file → warn + anomaly event, session remains operational.

### Sentinel block syntax

```markdown
<!-- opencode:mandatory-skills -->
- plan-builder
<!-- /opencode:mandatory-skills -->
```

- HTML comment invisible in AI's markdown read.
- Inline `#` stripped (bullets like `- plan-builder    # required` normalize to `plan-builder`).
- Empty bullets skipped; multi-block merge + dedup (first-occurrence order wins).
- Malformed blocks (unclosed / nested opener) → warn + treat body as one block, continue.

### Source authorities

| Audience | Source file | Lives in | Notes |
|---|---|---|---|
| Main agent | `<repo-root>/AGENTS.md` | docsWriteRepo | project-priority in merge |
| Main agent | `~/.config/opencode/AGENTS.md` | user XDG | secondary in merge |
| coding subagent | `packages/opencode/src/agent/prompt/coding.txt` | runtime code | sole source for subagent path |
| any subagent except coding | — | — | `resolveMandatoryList` returns [] |

### Observability

Runtime events appended to `RuntimeEventService`:

- `skill.mandatory_preloaded` — info/workflow, when a skill is freshly pinned
- `skill.mandatory_missing` — warn/anomaly, anomalyFlags=[mandatory_skill_missing]
- `skill.mandatory_read_error` — warn/anomaly, anomalyFlags=[mandatory_skill_read_error]
- `skill.mandatory_unpinned` — info/workflow, when user removes skill from AGENTS.md

Dashboard "已載技能" panel should show pinned badges + source label for mandatory entries.

### Current mandatory lists

- **Main agent** (via project + global AGENTS.md): `plan-builder`
- **coding subagent** (via coding.txt sentinel): `code-thinker`

### Related retirement — agent-workflow

`agent-workflow` skill retired on 2026-04-20 as part of this pipeline's rollout:

- Its §5 Syslog-style Debug Contract → merged into `code-thinker/SKILL.md` §3 as single source of truth.
- Its §0 core principles / §6 Narration / §7 Interrupt-safe Replanning / §8 WAITING_APPROVAL format / §10 Ops digest → merged into opencode repo AGENTS.md under "Autonomous Agent 核心紀律" (runtime-injected every round per 第三條).
- Its §1-§5 spec-driven execution content was already covered by `plan-builder` SKILL.md §16 Execution Contract.
- `templates/AGENTS.md`, `templates/system_prompt.md`, `templates/global_constitution.md`, `packages/opencode/src/agent/prompt/coding.txt`, and `enablement.json` references all cleaned up.
- Skills submodule commit `9103663` removes `agent-workflow/SKILL.md` and rewrites `code-thinker/SKILL.md`.

See `specs/mandatory-skills-preload/design.md` DD-8/DD-10 and `docs/events/event_20260419_mandatory_skills_preload.md` for full decision trace.

---

## Capability Layer vs Conversation Layer (Session Rebind Epoch)

Introduced by `specs/session-rebind-capability-refresh/` (2026-04-20). Extends and refines the Mandatory Skills Preload Pipeline above.

### Layer boundary

Session prompts live at two distinct layers; each has independent lifecycle rules.

| Layer | Content | Lifecycle | Checkpoint-safe? |
|---|---|---|---|
| **Capability** | system prompt, driver prompt, AGENTS.md (global + project), coding.txt sentinel, skill content (pinned via `SkillLayerRegistry`), enablement.json | **Never frozen**. Refreshed on rebind events; between events, served from per-(sessionID, epoch) in-memory cache. | ❌ must not be captured by checkpoint/SharedContext |
| **Conversation** | user messages, assistant responses, tool results, task progress, `SharedContext` snapshot, rebind checkpoint messages | Accumulates. Compressible via existing `SessionCompaction` / `SharedContext`. | ✅ checkpoint/shared-context owns compression |

Conversation-layer state is safe to freeze because it records "what happened". Capability-layer state must re-read authoritative sources because it describes "what the agent can do right now" — AGENTS.md / SKILL.md / enablement.json can change between rebinds.

### Rebind events (sole invalidation triggers)

Five canonical triggers bump a session's `RebindEpoch`; each bumps the epoch by 1 and emits a `session.rebind` RuntimeEvent. No other code path may invalidate the capability-layer cache.

| Trigger | Source | Example |
|---|---|---|
| `daemon_start` | Lazy on first `runLoop` iteration per session | Fresh daemon process; session first used |
| `session_resume` | `POST /session/:id/resume` from UI | User re-opens an idle session in UI |
| `provider_switch` | Pre-loop detection in `prompt.ts:~969` | Model/account switch within a session |
| `slash_reload` | `/reload` slash command | User manually refreshes |
| `tool_call` | `refresh_capability_layer` tool (AI-initiated) | AI detects stale capability layer |

### Cache contract

- Cache key = `(sessionID, epoch)`. Per-session isolation (DD-1); no global epoch.
- Max 2 entries retained per session (`MAX_ENTRIES_PER_SESSION=2`) — `current + previous` for R3 fallback semantics (DD-3 amended).
- **No time-based TTL**: `InstructionPrompt.systemCache` legacy 10s TTL was replaced with epoch-based invalidation. Cache stays valid indefinitely until next rebind.
- **Reinject failure retains previous cache** — loud-warn via `capability_layer.refresh_failed` anomaly event + `get()` falls back to previous epoch's entry. Session never crashes due to stale AGENTS.md / missing skill.

### Refresh order contract (DD-4)

When both events co-occur (e.g. provider switch), the pipeline **always** refreshes capability layer before applying conversation-layer compression:

```
bumpEpoch(sessionID, trigger)   ← invalidates capability cache
  ↓
CapabilityLayer.reinject(sessionID, newEpoch)   ← reads fresh AGENTS.md + driver + skills
  ↓
[optional] SessionCompaction.compactWithSharedContext(...)   ← rebuilds messages for new provider
  ↓
runLoop builds system[] from (fresh capability + compacted messages)
```

New providers / models see the current capability layer in their very first LLM call, not a version cached from the previous provider's startup.

### Silent init round (DD-5)

UI `POST /session/:id/resume` triggers a bump + reinject without invoking the LLM, writing message history, or triggering autonomous continuation. Cost-free. If the session is `busy`/`retry` at signal receipt, the daemon skips silent reinject (the in-flight `runLoop` will cache-miss on its next iteration and self-heal) — no lock, no preempt.

### Rate limits

- **Session-level**: `RebindEpoch.bumpEpoch` sliding window = 5 bumps per 1000ms/session (DD-11). Exceeding emits `session.rebind_storm` anomaly; bump rejected.
- **Tool-level**: `refresh_capability_layer` tool = 3 invocations per `(sessionID, messageID)` (DD-6). Exceeding emits `tool.refresh_loop_suspected` anomaly; tool returns rate-limited status without bumping epoch.

### Components

- `packages/opencode/src/session/rebind-epoch.ts` — RebindEpoch namespace (state + rate limit + event emit)
- `packages/opencode/src/session/capability-layer.ts` — per-(sessionID, epoch) cache + R3 fallback lookup
- `packages/opencode/src/session/capability-layer-loader.ts` — production loader (reads AGENTS.md + pins skills via `MandatorySkills.loadAndPinAll`)
- `packages/opencode/src/session/instruction.ts` — `InstructionPrompt.system(sessionID?)` now epoch-keyed
- `packages/opencode/src/session/prompt.ts` — `runLoop` wires `ensureCapabilityLoaderRegistered` + `CapabilityLayer.get` + daemon_start lazy bump + provider_switch bump
- `packages/opencode/src/tool/refresh-capability-layer.ts` — AI-initiated tool
- `packages/opencode/src/command/index.ts` (`Command.reloadHandler`) — user-initiated slash command
- `packages/opencode/src/server/routes/session.ts` — `POST /:sessionID/resume` endpoint

### Observability events

- `session.rebind` (info/workflow) — every successful `bumpEpoch`
- `capability_layer.refreshed` (info/workflow) — `reinject` succeeded
- `session.rebind_storm` (warn/anomaly) — session rate limit exceeded
- `capability_layer.refresh_failed` (error/anomaly) — reinject threw; previous cache retained
- `tool.refresh_loop_suspected` (warn/anomaly) — per-turn tool limit exceeded

See `specs/session-rebind-capability-refresh/design.md` (15 DDs) for the full decision trace.

## Tool Framework Contract

### Tool.define: execute() receives parsed args

`Tool.define(id, init)` wraps a tool's `execute(args, ctx)` to guarantee that by the time user code runs:

1. `parameters.parse(args)` has succeeded.
2. The **parsed** value — not the raw LLM arguments — is what `execute()` receives.

This means any `z.preprocess` / `z.transform` / `z.default` declared in `parameters` takes effect at runtime. Tool authors must **not** re-parse args inside `execute`, because side-effecting transforms would run twice.

Validation errors route through `formatValidationError` (if provided) → thrown as `Error` whose message is the hint; otherwise a generic fallback wrapping the `ZodError`. `execute` is not called on validation failure.

### Tool part `state.input` persistence

The session processor (`session/processor.ts`) persists tool-call arguments on the tool part's `state.input` field:

| Status | `state.input` content |
|---|---|
| `running` | Raw LLM args (short-lived; UI renderers must defensive-normalize) |
| `completed` | **Normalized** shape: `ToolRegistry.getParameters(toolName).safeParse(value.input).data` when available; raw if registry miss or parse fails |
| `error` | Raw LLM args (forensic evidence — we need the exact shape that failed) |

`ToolRegistry.getParameters(id)` caches each tool's parameters schema on first lookup (process-lifetime `Map`). Registry miss / parse failure is logged at `debug` level; state.input falls back to raw and downstream UIs still render via defensive normalize.

### Question tool normalize — cross-runtime single source of truth

`normalizeQuestionInput` / `normalizeSingleQuestion` live in `packages/sdk/js/src/v2/question-normalize.ts` so both server runtime (`Question.normalize` re-exports from SDK) and client runtimes (webapp `QuestionDock` / `message-part.tsx`, TUI `session/index.tsx`) use the same pure implementation. Any future tool with cross-runtime shape coercion should follow the same pattern.

See `specs/question-tool-input-normalization/` for the full RCA, design (DD-1…DD-6), and test vectors.

## UI Freshness Contract (session-ui-freshness)

**Principle**: session-scoped UI data freshness is tracked via client-side `receivedAt` timestamps, never via SSE connection state. Connection health is a transport concern; freshness is a data concern. The two must stay decoupled.

**Authoritative path**:
- Event reducer stamps `receivedAt = Date.now()` on every session-scoped write (`State.session_status`, `State.active_child`, monitor poll items) via intersection type `ClientStampMeta`. Inline field, not a wrapper (DD-1 / DD-8).
- `packages/app/src/hooks/use-freshness-clock.ts` exposes `freshnessNow` — a single module-level Solid signal ticking once per second (DD-2). Every freshness-aware memo subscribes to the same signal.
- `packages/app/src/utils/freshness.ts` exports `classifyFidelity(receivedAt, now, thresholds, enabled, opts)` as the **single source of truth** for classification. Three buckets: `fresh` / `stale` / `hard-stale`. Invalid `receivedAt` (undefined / NaN / Infinity / ≤0) forces `hard-stale` with optional warn callback (DD-4, AGENTS.md rule 1).
- Thresholds + feature flag come from `/config/tweaks/frontend` via `frontend-tweaks.ts`: `ui_session_freshness_enabled` (0/1, default 0), `ui_freshness_threshold_sec` (default 15), `ui_freshness_hard_timeout_sec` (default 60). Daemon-side parser clamps ranges + enforces soft < hard.

**UI consumers** (freshness-aware memos):
- `pages/session.tsx` activeChildDock memo → `session-prompt-dock.tsx` applies opacity + "stale" hint
- `pages/session/session-side-panel.tsx` process-card loop → opacity + "updated Ns ago" italic line, elapsed timer frozen on hard-stale
- `pages/session/tool-page.tsx` process-list → same pattern

**Forbidden**:
- Any signal / memo / toast that surfaces SSE connection health to the UI layer. The 2026-04-20 RCA (I-4, `docs/events/event_2026-04-20_frontend_oom_rca.md`) documented the OOM cascade that this rule prevents.
- Silent fallback to `fresh` when `receivedAt` is missing / invalid. Always `hard-stale` + rate-limited warn.
- Multiple `setInterval` freshness tickers. The module-level singleton in `use-freshness-clock.ts` is the only valid driver.

**Feature flag rollout**: `ui_session_freshness_enabled=0` (default) → `classifyFidelity` early-returns `"fresh"`, so every memo renders baseline (byte-equivalent to pre-plan `2fa1b0b2d~1`). Operators opt in by flipping the flag in `/etc/opencode/tweaks.cfg` and restarting the daemon. Retirement trigger is acceptance-based (not time-based): once R1–R6 pass with flag=1, a follow-up `amend` removes the flag and dead code.

See `specs/session-ui-freshness/` for the full lifecycle, design decisions DD-1 through DD-8, error catalogue, and observability contract.

## Daemon Lifecycle Authority

安全自重啟契約（spec: `specs/safe-daemon-restart/`）。

**唯一權威**: Gateway（`/usr/local/bin/opencode-gateway`，source `daemon/opencode-gateway.c`）是 per-user bun daemon 的唯一 lifecycle owner。Daemon 不 fork 自己、不 exec 兄弟、不呼叫 `webctl.sh` 做 spawn/kill。

**合法 restart 路徑**:

1. AI（或 UI 設定頁的 Restart Web 按鈕）呼叫 `system-manager:restart_self` tool（或直接 POST `/api/v2/global/web/restart`）。
2. Daemon endpoint 在 gateway-daemon 模式下 spawn `webctl.sh restart [--force-gateway]`。
3. `webctl.sh` smart-detect dirty 層（stamp 比對）並只 rebuild 變動部分（daemon bundle / frontend bundle / gateway C binary）；install 到系統路徑。
4. Webctl 成功 → daemon `process.exit(0)` → gateway 的 SIGCHLD handler 回 `state=DEAD` → 下一個 HTTP 請求觸發 `ensure_daemon_running` 乾淨 spawn。
5. Webctl 失敗（任何層 exit ≠ 0）→ daemon 不自殺，回 5xx + errorLogPath；系統維持舊版本可用。
6. `--force-gateway` → webctl `systemctl restart opencode-gateway`；systemd respawn 新 binary；期間所有 per-user daemon 斷線 3-5s（**使用者會感受到**）。

**自癒（phase 1 of safe-daemon-restart）**:

- `ensure_socket_parent_dir()`: spawn 前 `mkdir -p /run/user/<uid>/opencode/` + chown + chmod 0700。tmpfs 清掉也會自動重建。
- `detect_lock_holder_pid()`: 讀 `~/<user>/.config/opencode/daemon.lock`（JSON pid 檔，非 kernel flock），驗 `/proc/<pid>` st_uid 比對。
- `cleanup_orphan_daemon()`: SIGTERM → 1000ms poll → SIGKILL → 500ms reap。`waitpid(pid, NULL, WNOHANG)` 在 poll loop 內防殭屍。
- `ensure_daemon_running()` adopt 失敗後**先清 orphan 再 spawn**，解 2026-04-20 `waitpid ECHILD loop` 問題。

**Bash tool denylist**（`packages/opencode/src/tool/bash.ts` `DAEMON_SPAWN_DENYLIST`）: 擋 `webctl.sh (dev-start|dev-refresh|restart|...)`, `bun serve --unix-socket`, `opencode serve`, `kill $(pgrep opencode)`, `systemctl restart opencode-gateway`。違規丟 `FORBIDDEN_DAEMON_SPAWN`，log `denylist-block rule=...`。

**Invariants**:
- 每個 uid 最多一隻活的 bun daemon（gateway.lock JSON file + `kill(pid, 0)` liveness）
- Daemon pid 一定在 gateway `DaemonInfo.pid` 裡；否則視為 orphan
- Socket file 存在 ⇔ daemon alive & listening
- JWT uid 必須 = 目標 daemon uid

違反任一 invariant = P0 bug。


---

## Responsive Orchestrator (2026-04-23, spec `responsive-orchestrator` state=living)

Main agent (orchestrator) stays responsive while subagents run. `task` tool dispatches are **asynchronous**: the tool returns a `dispatched` stub immediately, the assistant turn closes, and the session releases its busy lock. Subagent results arrive on a subsequent turn as a one-line system-prompt addendum — they are NOT appended to the visible chat log.

### Dispatch contract

```
main agent emits task(description, prompt, subagent_type)
  ↓ (synchronous, <200ms)
task tool
  ├─ allocate jobId (= toolCallID)
  ├─ spawn subagent worker + register
  ├─ detach background watcher (IIFE)
  └─ return { status: "dispatched", jobId, childSessionID, output: "<instructions for LLM>" }
  ↓
main agent's assistant turn closes naturally; session → idle
```

Meanwhile, in background:

```
subagent runloop → writes terminal finish to disk (stop | error | canceled | rate_limited | quota_low)
  ↓
background watcher (watchdog A/B/C) detects
  ↓
Bus.publish(task.completed { jobId, parentSessionID, childSessionID, status, finish, elapsedMs, errorDetail?, rotateHint? })
  ↓
pending-notice-appender subscriber
  ↓
parent session info.json#pendingSubagentNotices += PendingSubagentNotice
  ↓ (next user turn)
prompt assemble reads notices → renderNoticeAddendum(n) → system prompt addendum + atomically drain
```

### Subagent self-protection

- **R3 rate-limit bounded wait**: subagent escalation to parent is bounded by `subagent_escalation_wait_ms` (default 30 s, tweak). On timeout, subagent writes `finish: "rate_limited"` with errorDetail and exits cleanly.
- **R6 proactive quota wrap-up**: post-turn check reads account remaining; if ≤ `subagent_quota_low_red_line_percent` (default 5 %), subagent injects a wrap-up directive into its own context, runs one final summary turn, writes `finish: "quota_low"` with `rotateHint { exhaustedAccountId, remainingPercent, directive: "rotate-before-redispatch" }`, and exits.

### LLM-facing operator tools

- `cancel_task(jobId, reason?)` — abort one running subagent via stdin cancel command; single-authority pattern (DD-6) means the normal disk-terminal pipeline still delivers the cancellation notice.
- `system-manager.list_subagents({ parentSessionID?, includeFinished? })` — MCP tool, lists active + recently-finished subagents with status/finish/elapsedMs/dispatchedAt.
- `system-manager.read_subsession({ sessionID, sinceMessageID?, limit? })` — MCP tool, reads child session messages; structured error on missing/inaccessible session (never throws).

### Historical fix

This architecture **restores the pre-2026-04-09 async dispatch intent** that was regressed by commit `c32b9612b` (which replaced the Bus-event-chain delivery with a synchronous `await worker.done` to fix race-induced "parent never resumes" bug). The replacement delivery substrate is disk-terminal + watchdog A (race-free, survives IPC severance) instead of the original racy Bus chain.

### Invariants

- Every `tool_use` gets a paired `tool_result` in the same turn (stub satisfies provider hard requirement)
- Every terminal subagent finish delivers a `PendingSubagentNotice` within `DISK_GRACE_MS + WATCHDOG_INTERVAL_MS` (≤ 10 s) — even if IPC is severed
- Each notice is consumed exactly once (per-turn atomic drain)
- Main agent never blocks on subagent lifecycle

Violations = P0 (user-facing orchestrator hang).

### Open issues (not in scope)

- `I-1` subagent status bar hydration after reload / multi-client
- `I-4` mobile UX collapse on large sessions (next spec)

See `specs/responsive-orchestrator/` for full documentation (proposal.md, spec.md, design.md DD-1..DD-11, IDEF0/GRAFCET, C4, sequence, tasks.md, handoff.md, errors.md, observability.md, test-vectors.json, issues.md).
