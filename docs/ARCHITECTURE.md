# OpenCode Project Architecture

This document provides a comprehensive overview of the `opencode` monorepo structure, detailing the various packages, their purposes, and relationships. It is intended to guide developers and AI agents in understanding the system's organization.

## Document Purpose & Maintenance Contract

This file is an **architecture state document**, not an event log.

1. **Primary purpose**
   - Record the **current architecture baseline** (what is true now).
   - Provide **high-signal file/module index summaries** for core runtime areas.

2. **What belongs here**
   - Stable architecture contracts, boundaries, invariants, and component responsibilities.
   - File-level summary/index updates when architecture-relevant code paths are added/changed.

3. **What does NOT belong here**
   - Chronological implementation diary, debug timeline, or step-by-step change history.
   - Temporary migration notes that are no longer part of current runtime truth.

4. **Where change history goes instead**
   - Use `docs/events/event_<YYYYMMDD>_<topic>.md` for decision trail, RCA, execution logs, and validation records.

5. **Update rule (mandatory)**
   - If a change affects architecture boundaries/contracts or adds/removes important runtime modules, update this document's relevant architecture section and/or file index summaries in the same task.

## System Overview

OpenCode is an open-source AI coding agent platform. The repository is a monorepo managed with **Bun** and **TurboRepo**, containing the core CLI, web applications, desktop apps, SDKs, and supporting services.

### Key Technologies

- **Runtime**: Bun (primary), Node.js (tooling)
- **Frontend**: SolidJS, Vite, Tailwind CSS
- **Backend/Serverless**: Hono, Cloudflare Workers, Nitro
- **Desktop**: Tauri
- **Infrastructure**: SST (Serverless Stack)
- **Documentation**: Mintlify

---

## Branching Strategy & Project Context

The project operates with a specific branching strategy that defines the architectural direction:

### `cms` Branch (Current Production Line)

The `cms` branch is the primary product line for this environment, featuring significant enhancements over the upstream `origin/dev`.

**Key Features of `cms`:**

1.  **Global Multi-Account Management**: A unified system for managing multiple provider accounts.
2.  **Rotation3D System**: A dynamic model switching and load balancing system (`rotation3d`), enabling high availability and rate limit management.
3.  **Admin Panel (`/admin`)**: A centralized "Three-in-One" management interface for system administration.
4.  **Provider Granularity**: The legacy monolithic `google` provider is canonically split into runtime families that maximize resource utilization:
    - `gemini-cli`: Optimized for batch processing and large context.
    - `google-api`: For lightweight, high-speed requests.
    - legacy aliases are not valid canonical runtime families.

### Upstream Integration

- **`origin/dev`**: The upstream source. Changes from `origin/dev` are **analyzed and refactored** before being integrated into `cms`. Direct merges are prohibited to preserve the `cms` architecture.
- **External Plugins**: Located in `/refs`, these are also subject to analysis and refactoring before integration.

### Cross-Surface Runtime Architecture (current state)

#### Web runtime boundaries

1. **Auth boundary (`WebAuth`)**
   - Browser uses cookie-session + CSRF protection.
   - CLI/TUI compatibility path can still use Basic auth where required.
   - CLI bearer-token requests are identity-bound: `Authorization: Bearer <OPENCODE_CLI_TOKEN>` must include `x-opencode-user`.

2. **Instance boundary (`Instance.directory`)**
   - Request directory is canonically resolved server-side and echoed via `X-Opencode-Resolved-Directory`.
   - Relative directory overrides are resolved from authenticated user home; absolute paths are preserved (then validated for existence).
   - Directory override from request is only accepted on loopback, authenticated web mode, or explicit global browse enablement.

3. **PTY boundary (`/pty`)**
   - PTY sessions require explicit create → connect lifecycle.
   - Stale PTY ids are treated as invalid session state and must be recreated.

#### TUI/Web admin capability boundary

- **TUI `/admin`** is the canonical control plane for provider/account/model operations and rotation-aware diagnostics.
- **Web** provides an admin-lite model manager that reuses the same backend account/provider APIs, including provider visibility toggles plus account add/view/rename/delete/set-active flows inside `packages/app/src/components/dialog-select-model.tsx`.

#### Deployment/runtime consistency

- Docker web profile (`docker-compose.production.yml` + `Dockerfile.production`) follows the same `/opt/opencode` runtime contract as native environments.
- MCP runtime services are canonicalized under `packages/mcp/*`; `scripts/*` keeps compatibility shims only.
- Beta dev helper `testbeta.sh` launches the beta repo as Linux user `betaman` and intentionally uses betaman's own home/XDG runtime state (`~betaman/.config/opencode`, etc.). This gives betaman a dedicated runtime identity while still avoiding writes into the pkcs12 cms checkout.
- Dev config sync scripts use non-owner/non-group-preserving rsync semantics for template/runtime mirroring, preventing permission failures when runtime user and repo owner differ.
- For dev safety, template/runtime skill mirroring is skipped when the effective runtime `skills` path resolves outside the current user's home (for example a shared symlink such as `~betaman/.config/opencode/skills -> /home/pkcs12/projects/skills`). This prevents beta launches from mutating shared/cms-adjacent skill trees.
- `script/runtime-init-check.ts` is a **dev-only preflight** wired into `bun run dev` variants. Its job is to ensure baseline XDG runtime dirs/files exist from `templates/manifest.json` before local development startup. Production/runtime install responsibility remains with `install.sh` + `script/install.ts`, not with this dev helper.

#### Web multi-user runtime architecture

1. **Service identity model**
   - `opencode-web.service` runs as a no-home service identity (`HOME=/nonexistent`).
   - Service binaries/wrappers are expected under `/usr/local/*`.

2. **Gateway + per-user daemon topology**
   - Gateway process serves web/auth/API entrypoints.
   - User-scoped runtime operations are routed to per-user daemon instances (`opencode-user-daemon@.service`) under authenticated Linux user context.

3. **Routed API policy**
   - Per-user-daemon routed APIs use strict no-fallback behavior: daemon path failure returns structured `503`.
   - This prevents mixed-source reads/writes across service-scope and user-scope runtime paths.

4. **Daemon-routed API domains**
   - Config APIs: read/update.
   - Account APIs: list + mutation routes.
   - Session APIs: list/read/status/top + mutation routes.
   - Model preference APIs: read/update.

5. **Web realtime behavior**
   - Primary path: SSE global events (`/global/event`) drive incremental UI updates.
   - Reliability fallback: while `session.status !== idle`, web periodically forces message snapshot hydration (`session.sync(..., { force: true })`) so assistant replies remain visible without page refresh if SSE propagation is delayed/dropped.
   - Prompt footer quota metadata is **not** driven by raw SSE deltas alone. For OpenAI usage, web uses a conditional refresh gate in `packages/app/src/components/prompt-input.tsx`: it refetches quota only when a new assistant turn completes **and** the previous quota refresh is older than 60 seconds **and** the effective provider family is `openai`.
   - This keeps footer usage reasonably fresh after real AI interaction while avoiding constant polling for idle pages or non-OpenAI providers.

6. **Runtime ownership target**
   - Runtime memory/history/config/state are owned by authenticated user home (`~/.config`, `~/.local/share`, `~/.local/state`).
   - Historical transition details and RCA remain in `docs/events/`.

7. **Review data-path observability contract (web)**
   - `GET /file/status` returns lightweight diagnostics headers:
     - `X-Opencode-Review-Directory`
     - `X-Opencode-Review-Count`
   - Deep diagnostics route `GET /experimental/review-checkpoint` is available only when `OPENCODE_DEBUG_REVIEW_CHECKPOINT=1`.

#### Capability registry contract

- Capability discovery source-of-truth is `packages/opencode/src/session/prompt/enablement.json` with template mirror at `templates/prompts/enablement.json`.
- Prompt/runtime routing should use this registry for tools/skills/MCP inventory and on-demand MCP lifecycle policy.

### Provider Identity & TUI Admin Runtime Architecture (cms)

This section defines the **authoritative** provider/account/model architecture for cms TUI `/admin` and backend runtime.
Historical change logs belong in `docs/events/`; this document keeps the current architecture only.

#### A) cms Provider Graph (authoritative coordinates)

The runtime must treat identities as explicit coordinates:

1. **Provider Family** (canonical): e.g. `nvidia`, `openai`, `gemini-cli`
2. **Account** (family-scoped): active + candidates in `accounts.json`
3. **Model** (provider-scoped): from models.dev/snapshot + config/plugin/custom loader overlays

No runtime decision should depend on "guessing" family from an arbitrary dashed provider string without canonical family inventory.

#### B) TUI `/admin` provider operation pipeline (cms)

| Stage                           | UI Component / Route                                                          | Runtime Side Effect                                                   |
| :------------------------------ | :---------------------------------------------------------------------------- | :-------------------------------------------------------------------- |
| Provider inventory bootstrap    | `tui/context/sync.tsx` (`provider.list`, `provider.auth`, `config.providers`) | Hydrates provider/auth/config state for admin menus                   |
| Add provider entry              | `dialog-admin.tsx` → `DialogProviderManualAdd`                                | Writes `config.provider[...]`, triggers sync bootstrap                |
| Add API key (models.dev family) | `DialogApiKeyAdd`                                                             | `Account.add(family, accountId, apiKey)` under canonical family scope |
| Add Google API account          | `DialogGoogleApiAdd`                                                          | Adds `google-api` account with explicit family key                    |
| OAuth account connect           | `DialogProvider` → `/provider/:id/oauth/*`                                    | Stores auth via `Auth.set(...)` / account module                      |
| Active account switch           | `/account/:family/active`                                                     | Rotation and model availability read new active account               |

#### B.1) Prompt footer quota/runtime metadata pipeline (TUI + Web)

This subsection documents how prompt footer usage/account metadata stays fresh without high CPU polling.

1. **TUI prompt footer orchestration**
   - Entry point: `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
   - TUI computes footer metadata from current provider/model/account state and provider-specific quota hints.
   - OpenAI quota is loaded through a Solid `createResource(quotaRefresh, ...)` path (`codexQuota`).
   - Refresh is triggered by two low-cost signals:
     - **turn completion signal**: when `lastCompletedAssistant` changes, TUI increments `quotaRefresh`
     - **low-frequency timer**: footer tick refresh (default 15s via `OPENCODE_TUI_FOOTER_REFRESH_MS`)
   - Result: footer usage looks near-realtime after real assistant work, but avoids aggressive background polling.

2. **Web prompt footer orchestration**
   - Entry point: `packages/app/src/components/prompt-input.tsx`
   - Web prompt footer also derives metadata from current provider/account state, but OpenAI quota refresh is stricter than TUI for browser efficiency.
   - The web quota resource key is gated by `quotaRefresh` and only becomes active for `openai`.
   - Refresh policy is event-driven, not interval-driven:
     - wait for a **new completed assistant turn**
     - require **more than 60 seconds** since the previous quota refresh
     - require effective provider family = `openai`
   - Non-OpenAI providers do not participate in this refresh path.

3. **Shared OpenAI quota source-of-truth**
   - Canonical implementation: `packages/opencode/src/account/quota/openai.ts`
   - Responsibilities:
     - refresh expired Codex/OpenAI OAuth access tokens
     - call `https://chatgpt.com/backend-api/wham/usage`
     - normalize usage windows into footer-friendly remaining percentages (`hourlyRemaining`, `weeklyRemaining`, `hasHourlyWindow`)
   - Backend route `packages/opencode/src/server/routes/account.ts` exposes `/account/quota` for web consumption.

4. **Caching / load-shedding contract**
   - OpenAI quota fetching uses in-process cache (`quotaCache`) with 5-minute TTL and stale-while-revalidate behavior.
   - This means UI-triggered refresh does **not** imply a guaranteed remote usage API call every time; cached quota may be served immediately while refresh happens only when stale.
   - Architectural goal: preserve operator-visible freshness after actual AI usage while keeping CPU/network cost bounded.

#### C) Backend provider graph assembly (canonical order)

`provider/provider.ts` state initialization is conceptually:

1. Load models registry (`models.dev` + snapshot) into provider database.
2. Apply provider-specific manual correction layer to raw model feeds (remove known-bad upstream entries, add curated missing entries).
3. Merge config providers and aliases.
4. Merge env/auth-derived provider options.
5. Merge account families (`Account.listAll`) into account-scoped provider entries.
6. Apply plugin/custom loaders.
7. Apply model/provider filtering (ignored/deprecated/disabled/rate-limit aware checks).

This order guarantees models are family-owned first, then account- and plugin-specific behavior is overlaid.

#### D) Family resolution and identity boundaries

To enforce 3D identity boundaries:

- Auth family resolution now uses canonical family inventory
  (`Account.PROVIDERS` + models.dev providers + existing account families), with deterministic resolution order:
  - exact family match
  - account-id pattern (`{family}-{api|subscription}-...`)
  - longest known family prefix
- Account load now normalizes legacy/non-canonical family keys (example: `nvidia-work` → `nvidia`) and preserves data during merge.
- Deprecated fallback behavior that treated arbitrary dashed IDs as valid family IDs was reduced.
- Canonical resolver API is now the primary runtime path:
  - `Account.resolveFamily(providerId)`
  - `Account.resolveFamilyOrSelf(providerId)`
- Family-level UI inventory is now separated from runtime account-scoped providers:
  - canonical UI family source: `packages/opencode/src/provider/canonical-family-source.ts`
  - current first consumer: TUI `/admin` root/provider list in `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
  - rule: UI provider lists consume canonical families only; account-scoped provider IDs remain internal runtime coordinates for account/model execution paths.
  - backend `/provider` route (`packages/opencode/src/server/routes/provider.ts`) now emits family-level provider rows from the same canonical source so web consumers can converge on the same provider family inventory.

#### D.1) Identity invariants (must hold)

1. **No fuzzy family parsing in runtime decisions**
   - Model routing, fallback, health checks, and provider route composition must use canonical resolver API.
2. **Family is canonical, account is scoped**
   - `provider-family` and `account-id` are distinct coordinates; account suffix strings are never treated as family source-of-truth.
3. **Storage self-heals legacy family keys**
   - On account load and explicit migration, non-canonical keys are normalized and merged without silent data loss.
4. **Operational migration is explicit**
   - `opencode auth migrate-identities` provides a reportable/manual path to normalize identity drift.

#### D.2) Refactor coverage and verification gates

This refactor is not limited to `Auth` or `Account`; canonical identity resolution was propagated to all major provider decision paths:

- Session model routing/fallback (`session/llm.ts`, `session/processor.ts`, `session/image-router.ts`)
- Provider health and availability checks (`provider/health.ts`)
- Provider API composition (`server/routes/provider.ts`)
- Rotation and scoring (`account/rotation3d.ts`, `agent/score.ts`)
- Runtime provider inheritance (`provider/provider.ts`) — legacy regex inheritance removed and replaced with resolver-based inheritance.

To prevent regressions for the original NVIDIA admin issue, the project now includes both test and script-level gates:

- Regression tests:
  - `packages/opencode/test/auth/family-resolution.test.ts`
  - `packages/opencode/test/account/family-normalization.test.ts`
  - `packages/opencode/test/provider/provider-cms.test.ts` (includes admin-like NVIDIA flow)
- Scripted E2E tester:
  - `scripts/test-e2e-provider-nvidia-admin.ts`
  - Verifies: add NVIDIA API account → activate account → provider model list visible → model resolvable
  - **Non-polluting cleanup guarantee**: tester always removes temporary `e2e-*` account and restores previous active account in `finally`.

#### E) Provider-logic network map (cms runtime)

```mermaid
flowchart TD
  A[TUI /admin] --> B[sync bootstrap\nprovider.list + provider.auth + config.providers]
  B --> C[Dialog actions\nmanual add / api key / oauth]
  C --> D[Server routes\n/provider, /account, /auth]
  D --> E[Auth module]
  D --> F[Account module\naccounts.json]
  E --> F
  F --> G[Provider.initState]
  G --> H[models.dev + snapshot]
  G --> I[config/env/auth overlay]
  G --> J[account overlay]
  G --> K[plugin/custom loaders]
  G --> L[filter + finalize provider/model list]
  L --> M[Rotation3D + Session LLM fallback]
```

Reference decision record:

- `docs/events/event_20260226_provider_identity_refactor.md`

---

## Detailed Package Analysis

This section provides a deep dive into the specific file structures and responsibilities of the core packages.

### 1. Core Agent (`packages/opencode`)

This package contains the core application logic, including the CLI, the Agent runtime, the Session manager, and the API server.

#### A. Core & CLI (`src/index.ts`, `src/cli`)

| File Path                                    | Description                                                                                                                                                             | Key Exports                                                                   | Input / Output                                                                                        |
| :------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| `src/index.ts`                               | **CLI Entry Point.** Configures `yargs`, sets up global error handling, and registers all CLI commands.                                                                 | _None_                                                                        | **Input:** CLI args<br>**Output:** Command execution                                                  |
| `src/cli/bootstrap.ts`                       | **Initialization Utility.** Wraps command execution to initialize the project context/directory.                                                                        | `bootstrap`                                                                   | **Input:** Directory, Callback<br>**Output:** Promise result                                          |
| `src/cli/cmd/run.ts`                         | **Run Command.** Primary interface for running agents. Handles interactive sessions and loops.                                                                          | `RunCommand`                                                                  | **Input:** Message, files, model<br>**Output:** Streaming output                                      |
| `src/cli/cmd/serve.ts`                       | **Serve Command.** Starts the OpenCode server in headless mode for remote connections or MCP.                                                                           | `ServeCommand`                                                                | **Input:** Port, Host<br>**Output:** HTTP Server                                                      |
| `src/cli/cmd/agent.ts`                       | **Agent Management.** Subcommands to create/list agents.                                                                                                                | `AgentCommand`                                                                | **Input:** Name, Tools<br>**Output:** Agent Config                                                    |
| `src/cli/cmd/session.ts`                     | **Session Management.** Manages chat sessions (list, step, worker).                                                                                                     | `SessionCommand`                                                              | **Input:** Session ID<br>**Output:** Session Logs                                                     |
| `src/cli/cmd/auth.ts`                        | **Authentication.** Manages provider credentials (login, logout, list).                                                                                                 | `AuthCommand`                                                                 | **Input:** Provider, Keys<br>**Output:** Stored Creds                                                 |
| `src/cli/cmd/admin.ts`                       | **Admin Interface.** Launches the Terminal User Interface (TUI).                                                                                                        | `AdminCommand`                                                                | **Input:** URL<br>**Output:** TUI Render                                                              |
| `src/cli/cmd/tui/component/prompt/index.tsx` | **TUI Prompt Footer + Variant Trigger.** Renders prompt footer model metadata and opens variant picker (`Thinking effort`) for supported model variants.                | `Prompt`                                                                      | **Input:** Local model/session state<br>**Output:** Prompt UI + variant selection interaction         |
| `src/cli/cmd/tui/util/model-variant.ts`      | **Variant Normalization Policy.** Canonicalizes provider/model variant options, OpenAI label/order mapping, and effective default value resolution (`medium` fallback). | `buildVariantOptions`, `getEffectiveVariantValue`, `shouldShowVariantControl` | **Input:** Raw variant list + provider family<br>**Output:** Display-ready variant options/visibility |
| `src/cli/ui.ts`                              | **UI Utilities.** Standardized terminal output, colors, styles, and user prompts.                                                                                       | `UI`                                                                          | **Input:** Text<br>**Output:** Formatted Stdout                                                       |

#### B. Agent Definition (`src/agent`, `src/acp`)

| File Path            | Description                                                             | Key Exports                    | Input / Output                                |
| :------------------- | :---------------------------------------------------------------------- | :----------------------------- | :-------------------------------------------- |
| `src/acp/agent.ts`   | **ACP Agent.** Implements Agent Client Protocol handling.               | `ACP`, `Agent`                 | **In:** ACP Conn<br>**Out:** Events           |
| `src/acp/session.ts` | **ACP Session.** Manages in-memory state of ACP sessions.               | `ACPSessionManager`            | **In:** Session ID<br>**Out:** State          |
| `src/agent/agent.ts` | **Agent Config.** Defines/loads native agents (coding, planning, etc.). | `Agent`, `Info`, `get`, `list` | **In:** Name<br>**Out:** Agent Config         |
| `src/agent/score.ts` | **Model Scoring.** Ranks models based on domain/capability/cost.        | `ModelScoring`, `rank`         | **In:** Task Domain<br>**Out:** Ranked Models |

#### C. Session Core (`src/session`)

| File Path                    | Description                                                                           | Key Exports                       | Input / Output                                   |
| :--------------------------- | :------------------------------------------------------------------------------------ | :-------------------------------- | :----------------------------------------------- |
| `src/session/index.ts`       | **Session Manager.** CRUD operations, persistence, event publishing.                  | `Session`, `create`, `get`        | **In:** ID/Data<br>**Out:** Session Info         |
| `src/session/llm.ts`         | **LLM Interface.** Handles generation, streaming, tool resolution, cost tracking.     | `LLM`, `stream`                   | **In:** Messages, Model<br>**Out:** StreamResult |
| `src/session/message-v2.ts`  | **Message Schema.** Defines User/Assistant message structures and rich content parts. | `MessageV2`, `Part`               | **In:** Raw Data<br>**Out:** Typed Message       |
| `src/session/prompt.ts`      | **Prompt Loop.** Entry point for the main agent execution loop (tools/reasoning).     | `SessionPrompt`, `prompt`, `loop` | **In:** User Input<br>**Out:** Execution Result  |
| `src/session/instruction.ts` | **System Instructions.** Loads system prompts from `AGENTS.md` and config.            | `InstructionPrompt`               | **In:** Context<br>**Out:** System Prompt        |

#### D. Server & API (`src/server`)

| File Path                           | Description                                                                                                                                                                                                              | Key Exports          | Input / Output                                                                                |
| :---------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------- | :-------------------------------------------------------------------------------------------- |
| `src/server/server.ts`              | **Server Entry.** Configures Hono app and HTTP listener.                                                                                                                                                                 | `Server`, `listen`   | **In:** Config<br>**Out:** Running Server                                                     |
| `src/server/routes/session.ts`      | **Session Routes.** API for chat session management.                                                                                                                                                                     | `SessionRoutes`      | **In:** HTTP Req<br>**Out:** JSON/Stream                                                      |
| `src/server/routes/file.ts`         | **File Routes.** API for file reading, searching, and git status; emits review diagnostic headers for web observability.                                                                                                 | `FileRoutes`         | **In:** Path/Pattern<br>**Out:** Content/List                                                 |
| `src/server/routes/project.ts`      | **Project Routes.** API for project metadata.                                                                                                                                                                            | `ProjectRoutes`      | **In:** ID<br>**Out:** Project Info                                                           |
| `src/server/routes/workspace.ts`    | **Workspace Routes.** API boundary for workspace list/current/status/read plus lifecycle state transitions and runtime-owned reset/delete operations (`reset-run`, `delete-run`) backed by workspace service/operations. | `WorkspaceRoutes`    | **In:** Instance project/workspace<br>**Out:** Workspace list/read/status/lifecycle/operation |
| `src/server/routes/provider.ts`     | **Provider Routes.** API for models and auth flows.                                                                                                                                                                      | `ProviderRoutes`     | **In:** ID<br>**Out:** Models/Auth                                                            |
| `src/server/routes/global.ts`       | **Global Routes.** System health and SSE stream.                                                                                                                                                                         | `GlobalRoutes`       | **In:** N/A<br>**Out:** Health/Events                                                         |
| `src/server/routes/account.ts`      | **Account Routes.** API for multi-account management.                                                                                                                                                                    | `AccountRoutes`      | **In:** ID<br>**Out:** Status                                                                 |
| `src/server/routes/experimental.ts` | **Experimental/Diagnostics Routes.** Includes per-user daemon snapshots and debug-gated review data-path checkpoint endpoint.                                                                                            | `ExperimentalRoutes` | **In:** HTTP Req<br>**Out:** JSON diagnostics                                                 |

#### E. Tools (`src/tool`)

| File Path              | Description                                                       | Key Exports      | Input / Output                            |
| :--------------------- | :---------------------------------------------------------------- | :--------------- | :---------------------------------------- |
| `src/tool/registry.ts` | **Tool Registry.** Manages available tools, filtering by context. | `ToolRegistry`   | **In:** Context<br>**Out:** Tool List     |
| `src/tool/tool.ts`     | **Tool Definition.** Type definitions and Zod schema builder.     | `Tool`, `define` | **In:** Schema<br>**Out:** Tool           |
| `src/tool/read.ts`     | **Read Tool.** Reads file content (with offset/limit support).    | `ReadTool`       | **In:** Path<br>**Out:** Content          |
| `src/tool/write.ts`    | **Write Tool.** Overwrites file content.                          | `WriteTool`      | **In:** Path, Content<br>**Out:** Success |
| `src/tool/edit.ts`     | **Edit Tool.** Replaces string in file (fuzzy match).             | `EditTool`       | **In:** Old/New String<br>**Out:** Diff   |
| `src/tool/bash.ts`     | **Bash Tool.** Executes shell commands.                           | `BashTool`       | **In:** Command<br>**Out:** Output        |
| `src/tool/glob.ts`     | **Glob Tool.** Finds files by pattern.                            | `GlobTool`       | **In:** Pattern<br>**Out:** Paths         |
| `src/tool/grep.ts`     | **Grep Tool.** Searches content by regex.                         | `GrepTool`       | **In:** Pattern<br>**Out:** Matches       |
| `src/tool/webfetch.ts` | **WebFetch Tool.** Fetches URL content (Markdown/HTML).           | `WebFetchTool`   | **In:** URL<br>**Out:** Content           |
| `src/tool/task.ts`     | **Task Tool.** Delegates to sub-agents.                           | `TaskTool`       | **In:** Prompt<br>**Out:** Result         |

#### F. Provider & Plugin (`src/provider`, `src/plugin`)

| File Path                                  | Description                                                                               | Key Exports                      | Input / Output                                             |
| :----------------------------------------- | :---------------------------------------------------------------------------------------- | :------------------------------- | :--------------------------------------------------------- |
| `src/provider/provider.ts`                 | **Provider Core.** Initializes providers, wraps SDK fetch, and applies response bridges.  | `Provider`                       | **In:** Config<br>**Out:** Registry                        |
| `src/provider/toolcall-bridge/index.ts`    | **ToolCall Bridge Manager.** Resolves and applies registered tool-call rewrite bridges.   | `ToolCallBridgeManager`          | **In:** Context, Raw Payload<br>**Out:** Rewritten Payload |
| `src/provider/toolcall-bridge/bridges/*`   | **Bridge Rules.** Provider/model-specific matchers and rewrite policies (e.g. GmiCloud).  | Bridge modules                   | **In:** Bridge Context<br>**Out:** Match + Rewrite         |
| `src/provider/gmicloud-toolcall-bridge.ts` | **Compatibility Wrapper.** Preserves legacy exports, delegates to generic bridge modules. | `rewriteGmiCloudToolCallPayload` | **In:** Raw Payload<br>**Out:** Rewritten Payload          |
| `src/provider/models.ts`                   | **Model DB.** Manages model definitions from `models.dev`.                                | `ModelsDev`                      | **In:** N/A<br>**Out:** Model Data                         |
| `src/provider/health.ts`                   | **Health Check.** Monitors model availability and latency.                                | `ProviderHealth`                 | **In:** Options<br>**Out:** Report                         |
| `src/plugin/index.ts`                      | **Plugin System.** Loads plugins and manages lifecycle hooks.                             | `Plugin`                         | **In:** Config<br>**Out:** Plugins                         |
| `src/mcp/index.ts`                         | **MCP Client.** Manages Model Context Protocol connections.                               | `MCP`                            | **In:** Config<br>**Out:** Clients                         |

#### G. Account & Utilities (`src/account`, `src/project`, `src/util`)

| File Path                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Key Exports                                                                                                                  | Input / Output                                                                                                                                    |
| :-------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/account/rotation3d.ts`       | **Rotation 3D.** Logic for fallback selection (Provider/Account/Model).                                                                                                                                                                                                                                                                                                                                                                                                                        | `findFallback`                                                                                                               | **In:** Vector<br>**Out:** Candidate                                                                                                              |
| `src/account/rate-limit-judge.ts` | **Rate Limit Judge.** Central authority for rate limit detection.                                                                                                                                                                                                                                                                                                                                                                                                                              | `RateLimitJudge`                                                                                                             | **In:** Error<br>**Out:** Backoff                                                                                                                 |
| `src/project/project.ts`          | **Project Manager.** Manages project metadata.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `Project`                                                                                                                    | **In:** Path<br>**Out:** Info                                                                                                                     |
| `src/project/workspace/*`         | **Workspace Kernel (Phase 1).** Defines workspace aggregate types, directory→workspace resolution, attachment ownership contracts, registry interface, runtime workspace service façade, lifecycle/update events, worker attachment registration, and runtime workspace operations (`reset`, `delete`) that archive sessions + dispose instance state before delegating git worktree mutations. `previewIds` remains a reserved field until a real preview runtime domain/event source exists. | `resolveWorkspace`, `WorkspaceRegistry`, `WorkspaceService`, `WorkspaceEvent`, `WorkspaceOperation`, workspace schemas/types | **In:** Project info + directory + session/pty/worker events<br>**Out:** Workspace aggregate / registry/service/lifecycle/event/operation lookups |
| `src/tool/task.ts`                | **Task Worker Orchestrator.** Manages subagent worker pool/dispatch and now emits worker lifecycle bus events so workspace service can track worker attachments.                                                                                                                                                                                                                                                                                                                               | `TaskTool`, `TaskWorkerEvent`                                                                                                | **In:** Task request + sessionID<br>**Out:** Worker lifecycle + bridged subagent events                                                           |
| `src/project/vcs.ts`              | **VCS Tracker.** Tracks current git branch.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `Vcs`                                                                                                                        | **In:** Events<br>**Out:** Branch                                                                                                                 |
| `src/file/index.ts`               | **File Ops.** Core file reading/listing/searching.                                                                                                                                                                                                                                                                                                                                                                                                                                             | `File`                                                                                                                       | **In:** Path<br>**Out:** Node/Content                                                                                                             |
| `src/util/git.ts`                 | **Git Wrapper.** Low-level git command execution.                                                                                                                                                                                                                                                                                                                                                                                                                                              | `git`                                                                                                                        | **In:** Args<br>**Out:** Result                                                                                                                   |

---

### 2. Client SDK (`packages/sdk`)

Provides a programmatic interface to interact with the OpenCode server, primarily used by the frontend or other integrations.

| File Path               | Description                                                                                            | Key Exports            | Input/Output                            |
| :---------------------- | :----------------------------------------------------------------------------------------------------- | :--------------------- | :-------------------------------------- |
| `js/src/index.ts`       | Main entry point. Exports client and server factories.                                                 | `createOpencode`       | `ServerOptions` -> `{ client, server }` |
| `js/src/client.ts`      | Wrapper around the generated client. Handles configuration and headers (e.g., `x-opencode-directory`). | `createOpencodeClient` | `Config` -> `OpencodeClient`            |
| `js/src/server.ts`      | Utility to spawn the `opencode serve` process as a child process.                                      | `createOpencodeServer` | `ServerOptions` -> `ServerInstance`     |
| `js/src/gen/sdk.gen.ts` | The typed API client generated from the server's OpenAPI spec.                                         | `OpencodeClient`       | Typed API calls                         |

### 3. Frontend Application (`packages/app`)

The main frontend application built with **SolidJS**. It handles the user interface for chat, coding, and workspace management.

| File Path                                         | Description                                                                                                                                                                                                                                                                           | Key Exports                                   | Input/Output                                                                                     |
| :------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| `entry.tsx`                                       | **Entry Point**. Bootstraps the application, detects the platform (Web/Desktop), and initializes the root `PlatformProvider`.                                                                                                                                                         | `(Execution Only)`                            | **In**: DOM Element<br>**Out**: Rendered App                                                     |
| `app.tsx`                                         | **App Root**. Sets up global shell providers (theme/i18n/dialog/router) and route boundaries; markdown/diff/code providers are session-scoped lazy modules.                                                                                                                           | `AppInterface`, `AppBaseProviders`            | **In**: Server URL (optional)<br>**Out**: Routing Context                                        |
| `pages/session.tsx`                               | **Canonical Session View**. The single source-of-truth session route implementation. Manages message timeline, terminal, drag/drop layout, file pane, and tool sidebar modes.                                                                                                         | `Page` (Default Export)                       | **In**: URL Params (ID)<br>**Out**: Chat Interface                                               |
| `pages/session/index.tsx`                         | **Session Route Forwarder**. Thin forwarding module that re-exports `pages/session.tsx` to avoid duplicate page implementations.                                                                                                                                                      | default re-export                             | **In**: N/A<br>**Out**: Route compatibility                                                      |
| `components/prompt-input.tsx`                     | **Prompt Runtime Guardrails.** Owns submit path + realtime watchdogs (session-status reconcile and forced message snapshot hydration during active runs).                                                                                                                             | `PromptInput`                                 | **In**: Prompt state + SDK sync<br>**Out**: Robust realtime UX                                   |
| `pages/session/session-rich-content-provider.tsx` | **Session Rich Content Boundary**. Route-scoped lazy provider bundle for markdown rendering, diff view, and code view components.                                                                                                                                                     | `SessionRichContentProvider`                  | **In**: Session route children<br>**Out**: Markdown/Diff/Code contexts                           |
| `context/server.tsx`                              | **Server Connection**. Manages the connection URL to the backend, health checks, and the list of available projects.                                                                                                                                                                  | `useServer`, `ServerProvider`                 | **In**: Default URL<br>**Out**: Connection Status                                                |
| `context/global-sdk.tsx`                          | **SDK & Events**. Initializes the OpenCode SDK client and establishes the global Server-Sent Events (SSE) stream.                                                                                                                                                                     | `useGlobalSDK`, `GlobalSDKProvider`           | **In**: Auth Token<br>**Out**: SDK Client, Event Emitter                                         |
| `context/global-sync.tsx`                         | **Directory Event Orchestrator.** Routes directory/global SSE events into child-store reducers; workspace child state now consumes live `workspace.created/updated/lifecycle/attachment` events in addition to bootstrap hydration.                                                   | `useGlobalSync`, `GlobalSyncProvider`         | **In**: Global SDK events + directory stores<br>**Out**: Live synchronized per-directory state   |
| `context/global-sync/child-store.ts`              | **Workspace Adapter Bridge.** Maintains directory-scoped child stores and now derives app-visible `workspace` identity snapshots from `project + worktree + directory`, with bootstrap state preserving the runtime workspace aggregate used by app consumers.                        | `createChildStoreManager`                     | **In**: Directory + hydrated project/path state<br>**Out**: Child store + workspace snapshot     |
| `context/global-sync/bootstrap.ts`                | **Workspace-Aware Directory Bootstrap.** Bootstraps per-directory state and consumes runtime `/workspace/current` via authenticated low-level fetch until SDK regeneration catches up, preserving full runtime workspace aggregate including lifecycle state.                         | `bootstrapDirectory`, workspace fetch helpers | **In**: SDK client + auth fetch + directory<br>**Out**: Bootstrapped workspace-aware child state |
| `context/global-sync/workspace-adapter.ts`        | **Workspace Identity Adapter Facade.** Thin app-side facade over shared `@opencode-ai/util/workspace` helpers so app consumers use the same normalization/kind/id rules as runtime.                                                                                                   | workspace adapter helpers                     | **In**: Directory/worktree/project id<br>**Out**: Normalized workspace identity                  |
| `context/terminal.tsx`                            | **Workspace-Owned PTY Persistence.** Persists terminal tabs against explicit workspace directory scope so terminal state survives session switches inside the same workspace.                                                                                                         | `useTerminal`, `TerminalProvider`             | **In**: Route params + globalSync workspace<br>**Out**: PTY tab state                            |
| `context/prompt.tsx`                              | **Session-with-Workspace-Default Prompt State.** Uses session directory when a session exists, but falls back to explicit workspace directory when no session is selected.                                                                                                            | `usePrompt`, `PromptProvider`                 | **In**: Route params + globalSync workspace<br>**Out**: Prompt/context draft state               |
| `context/comments.tsx`                            | **Session-with-Workspace-Default Comment State.** Mirrors prompt ownership rules for line comments, focus, and active-comment state.                                                                                                                                                  | `useComments`, `CommentsProvider`             | **In**: Route params + globalSync workspace<br>**Out**: Comment state                            |
| `context/file/view-cache.ts`                      | **Session-with-Workspace-Default File View Cache.** Persists per-file scroll/selection state by session when available, or by explicit workspace directory otherwise.                                                                                                                 | `createFileViewCache`                         | **In**: Directory + optional session/workspace scope<br>**Out**: File view cache                 |
| `pages/layout.tsx`                                | **Workspace UX Orchestrator.** Sidebar project/workspace interactions, prefetch/navigation logic, and lifecycle transition calls for reset/delete flows routed through runtime `/workspace/:id/*` endpoints, with busy gating beginning to consume runtime workspace lifecycle state. | `Page`                                        | **In**: globalSync + globalSDK + route state<br>**Out**: Sidebar/workspace UX                    |
| `context/sync.tsx`                                | **Session Sync Data Path.** Hydrates review state from git-backed `/file/status` and per-file read patches to produce renderable before/after diffs.                                                                                                                                  | `useSync`, `SyncProvider`                     | **In**: Session ID + SDK events<br>**Out**: Reactive session stores                              |
| `vite.config.ts`                                  | **Frontend Chunk Policy**. Defines manual chunk strategy for heavy dependencies (`ghostty-web`, markdown/katex, solid/core utils) plus i18n chunk isolation and warning threshold governance.                                                                                         | `manualChunks`                                | **In**: module id graph<br>**Out**: deterministic chunk layout                                   |

#### Session page shell contract (`packages/app`)

The web session UI now uses a single canonical page shell centered on `packages/app/src/pages/session.tsx`.

1. **Single page implementation**
   - `pages/session.tsx` is the only authoritative session page implementation.
   - `pages/session/index.tsx` exists only as a forwarding compatibility module and must not carry its own page logic.

2. **Pane topology**
   - **Main conversation pane**: message timeline + prompt dock.
   - **File pane**: dedicated file-view surface for opened file tabs.
   - **Tool sidebar**: right-side tool surface for `changes`, `context`, `files`, and `status` modes.
   - **Terminal panel**: separate bottom panel; not merged into the right sidebar system.

3. **Canonical shell API**
   - `layout.view(sessionKey).filePane` is the canonical open/close/toggle API for the file-view pane.
   - `layout.view(sessionKey).reviewPanel` remains as a temporary compatibility alias only; new work should use `filePane`.

4. **Naming boundary**
   - Shell-layer naming distinguishes:
     - `filePane` = opened file viewer container
     - `changesPanel` = diff/review content rendered inside the tool sidebar
   - Domain-level review concepts such as `SessionReviewTab` and `commentOrigin: "review"` remain valid and were not renamed as part of shell cleanup.

### 4. Console Backend (`packages/console/core`)

Contains the core business logic, database schemas, and data access layers for the console. Uses **Drizzle ORM**.

| File Path          | Description                                                                                                                | Key Exports                        | Input/Output                                          |
| :----------------- | :------------------------------------------------------------------------------------------------------------------------- | :--------------------------------- | :---------------------------------------------------- |
| `src/actor.ts`     | **Context/Permission Manager**. Manages the current execution context (User, Account, or System) and enforces permissions. | `Actor.use()`, `Actor.assert()`    | **In**: Context Type<br>**Out**: Current Actor ID     |
| `src/account.ts`   | **Account Management**. Handles creation and retrieval of accounts.                                                        | `Account.create`, `Account.fromID` | **In**: Account details<br>**Out**: Account ID/Object |
| `src/user.ts`      | **User Management**. Logic for user CRUD, invitations, and role management.                                                | `User.list`, `User.invite`         | **In**: User details<br>**Out**: User objects         |
| `src/workspace.ts` | **Workspace Management**. Handles creation, updating, and deletion of workspaces.                                          | `Workspace.create`                 | **In**: Workspace Name<br>**Out**: Workspace ID       |
| `src/model.ts`     | **AI Model Config**. Manages enabled/disabled AI models for a workspace.                                                   | `Model.enable`, `Model.disable`    | **In**: Model ID<br>**Out**: Boolean/List             |
| `src/zendata.ts`   | **Model Validation**. Validates and lists available AI model configurations and pricing.                                   | `ZenData.list`, `ZenData.validate` | **In**: None<br>**Out**: Model/Provider JSON          |

### 5. Console Functions (`packages/console/function`)

Backend serverless functions powering the console API and background processing.

| File Path              | Description                                                                                                          | Key Exports               | Input/Output                                         |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------- | :------------------------ | :--------------------------------------------------- |
| `src/auth.ts`          | **OpenAuth Issuer**: Handles authentication flows (GitHub, Google), account creation, and session management.        | `default` (Fetch Handler) | **In:** HTTP Request<br>**Out:** Auth Tokens         |
| `src/log-processor.ts` | **Trace Consumer**: Filters and processes Cloudflare Worker logs to extract LLM metrics and sends them to Honeycomb. | `default` (Tail Handler)  | **In:** `TraceItem[]`<br>**Out:** Honeycomb API Push |

### 6. Desktop App (`packages/desktop`)

The Tauri-based desktop application frontend.

| File Path         | Description                                                                                                                | Key Exports          | Input/Output                                      |
| :---------------- | :------------------------------------------------------------------------------------------------------------------------- | :------------------- | :------------------------------------------------ |
| `src/entry.tsx`   | **Entry Point**: Dynamic import router that loads either the main app (`index.tsx`) or the loading screen (`loading.tsx`). | (Side effects only)  | **In:** URL Path<br>**Out:** React Root Render    |
| `src/bindings.ts` | **Rust Bindings**: Type-safe interface for calling Rust backend commands.                                                  | `commands`, `events` | **In:** Function Calls<br>**Out:** IPC Messages   |
| `src/updater.ts`  | **Update Manager**: Handles checking for updates, downloading, and installing new versions.                                | `runUpdater`         | **In:** Update Config<br>**Out:** App Restart     |
| `src/cli.ts`      | **CLI Installer**: Installs the `opencode` command-line tool into the user's system path.                                  | `installCli`         | **In:** User Action<br>**Out:** System File Write |

### 7. Shared Utilities (`packages/util`)

Common utility functions used across the codebase.

| File Path           | Description                                                                                                | Key Exports              | Input/Output                                       |
| :------------------ | :--------------------------------------------------------------------------------------------------------- | :----------------------- | :------------------------------------------------- |
| `src/identifier.ts` | **ID Generator**: Generates sortable, unique identifiers (KSUID-like) with timestamp components.           | `Identifier` (Namespace) | **In:** Timestamp/Config<br>**Out:** Unique String |
| `src/retry.ts`      | **Retry Logic**: Implements exponential backoff retry for async operations with transient error filtering. | `retry`                  | **In:** Async Function<br>**Out:** Promise Result  |

### 8. Plugin System (`packages/plugin`)

Core definitions and types for the plugin architecture.

| File Path      | Description                                                                                              | Key Exports           | Input/Output                                          |
| :------------- | :------------------------------------------------------------------------------------------------------- | :-------------------- | :---------------------------------------------------- |
| `src/index.ts` | **Core Definitions**: Defines the `Plugin` function type and the `Hooks` interface for extension points. | `Plugin`, `Hooks`     | **In:** `PluginInput`<br>**Out:** `Promise<Hooks>`    |
| `src/tool.ts`  | **Tool Builder**: Helper function to define tools with Zod schema validation.                            | `tool`, `ToolContext` | **In:** Schema & Handler<br>**Out:** `ToolDefinition` |
| `src/shell.ts` | **Shell Integration**: Types and interfaces for the `BunShell` integration.                              | `BunShell`            | **In:** Command String<br>**Out:** Process Output     |

---

## 9. Dependency Graph (Simplified)

```mermaid
graph TD
    subgraph Apps
        App[app]
        Console[console/app]
        Desktop[desktop]
        CLI[opencode]
    end

    subgraph Core
        ConsoleCore[console/core]
        ConsoleFunc[console/function]
    end

    subgraph Shared
        UI[ui]
        SDK[sdk]
        Util[util]
        Plugin[plugin]
    end

    Desktop --> App
    App --> UI
    App --> SDK
    App --> Util

    Console --> UI
    Console --> ConsoleCore
    ConsoleFunc --> ConsoleCore

    CLI --> SDK
    CLI --> Util
    CLI --> Plugin

    SDK --> Util
    UI --> SDK
    Plugin --> Util

```

---

## 10. Documentation & Specifications (`docs/`)

Contains technical specifications, architecture overviews, and historical records.

| Folder / File  | Description                                                                                                                                |
| :------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/specs/`  | **Technical Standards.** Active architecture specifications for the `cms` branch, including system prompts, hooks, and UI design patterns. |
| `docs/events/` | **Chronological Knowledge Base.** Unified event logs, RCA reports, and historical project milestones named `event_YYYYMMDD_topic.md`.      |

---

## 10. Organizational Folders

In addition to the standard `packages/` directory, these top-level folders serve specific purposes:

| Folder           | Purpose                                                                                                   |
| :--------------- | :-------------------------------------------------------------------------------------------------------- |
| `scripts/`       | **Automation & DevOps.** Scripts for installation (`scripts/install/`), deployment, and daily operations. |
| `scripts/tools/` | **Legacy Tools.** System-level utilities, Nginx fixes, and port-forwarding scripts.                       |
| `scripts/debug/` | **Development Utilities.** Temporary scripts for testing filters, redirection, and model analysis.        |
| `patches/`       | **Package Fixes.** Custom patches applied to third-party dependencies via Bun's `patchedDependencies`.    |
| `refs/`          | **External References.** Upstream repositories or integration prototypes kept for cross-referencing.      |
| `infra/`         | **Infrastructure Definitions.** SST configurations for Cloudflare/AWS resources.                          |
| `docker/`        | **Docker Deployment.** Dockerfiles and compose files.                                                     |
| `github/`        | **GitHub Integration.** Definitions for OpenCode GitHub Action (`action.yml`).                            |
| `templates/`     | **Scaffolding.** Reusable templates for agents, tools, and project structures.                            |
| `recyclebin/`    | **Temporary Archive.** Deprecated files pending final deletion.                                           |

---

## 11. Root Directory Structure

The root directory is kept minimal, containing only essential configuration and orchestration files.

| File            | Description                                                                                                                                                                                                                                                   |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.env`          | **Runtime Secrets.** Local environment variables for API keys and database URLs.                                                                                                                                                                              |
| `package.json`  | **Monorepo Manifest.** Defines project dependencies, workspace structure, and core scripts.                                                                                                                                                                   |
| `bun.lock`      | **Lockfile.** Ensures consistent dependency versions across environments.                                                                                                                                                                                     |
| `turbo.json`    | **TurboRepo Config.** Orchestrates build, lint, and test tasks across the monorepo.                                                                                                                                                                           |
| `sst.config.ts` | **SST Entry.** Main entry point for serverless infrastructure deployment.                                                                                                                                                                                     |
| `flake.nix`     | **Nix Shell.** Defines a reproducible development environment with all required system tools.                                                                                                                                                                 |
| `tsconfig.json` | **TypeScript Config.** Global compiler options and path aliases.                                                                                                                                                                                              |
| `README.md`     | **Documentation Entry.** The primary project overview and quickstart guide.                                                                                                                                                                                   |
| `LICENSE`       | **License Information.** MIT License terms for the project.                                                                                                                                                                                                   |
| `webctl.sh`     | **Web Control Entry Point.** Unified command surface for bootstrap install (`install`), development runtime (`dev-*` / `dev-refresh`), and production systemd control (`web-*` / `web-refresh`), with non-interactive sudo preflight for privileged commands. |

---

## 12. Configuration & Provider State Architecture (Normative)

This section defines the authoritative behavior for runtime config and provider visibility in `cms`.

### A. Runtime Config Source of Truth

1. Runtime configuration for provider enable/disable is **global-scope only**.
2. Project-level `.opencode/opencode.json(c)` is **not part of runtime merge** in this build.
3. Admin/TUI mutations must write to global config via runtime-safe update flow.

**Primary files**

- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx`

### B. Provider State Semantics

1. `disabled` and `hidden` are the same product concept for provider visibility.
2. Provider visibility is controlled by `config.disabled_providers`.
3. Disabled providers are excluded from filtered provider list and shown in Show All as disabled.

**Primary files**

- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/plugin/index.ts`

### C. Admin Providers List Modes

1. **Filtered mode (default)**: show enabled providers only.
2. **Show All mode**: show full provider family set (enabled + disabled).
3. Both modes must use the same underlying provider universe; mode difference is filtering only.

### D. Toggle Behavior Contract

1. In provider root list, toggle action must update enable/disable state in both modes.
2. Root-level provider toggle uses `Space` as the canonical action; root `Delete` path is disabled/hidden.
3. Toggle success must update:
   - persisted config (`disabled_providers`)
   - in-memory runtime state
   - rendered list/status in current mode

### E. Event/Refresh Contract

1. After config mutation, instance disposal must complete before subsequent reads bootstrap new state.
2. TUI sync must refresh on:
   - `server.instance.disposed`
   - `global.disposed`

### F. Debugging Checklist (Provider Toggle)

If toast says success but UI does not change, verify in order:

1. `disabled_providers` actually changed in effective runtime config.
2. TUI sync received disposed event and re-bootstrapped state.
3. Provider list mode logic is filtering correctly (Show All vs filtered).
4. Status label and filter both read from the same disabled source.

## 13. Provider Toggle and Tool-Call Bridge Architecture

This section defines the current provider visibility/toggle architecture and tool-call bridge behavior for `/admin` and runtime provider normalization.

### A. Provider Toggle Behavior

1. Unified semantics:
   - `disable == hide`
   - `enable == show`
2. `Show All` is full list (no visibility filter).
3. `Filtered` mode only shows enabled providers.
4. Root-level provider toggle uses `Space` as primary action; root `Delete` path is disabled/hidden.

**Primary file**

- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`

### B. UX/State Consistency

1. Resolved stale/slow visual updates with optimistic provider-state updates.
2. Toggle success is reflected immediately in UI; persistence and bootstrap run in background.
3. Removed duplicate footer action label in root provider list.
4. Fixed `Show All` disappearing item regression after toggle.

### C. Config and Refresh Reliability

1. Runtime provider toggle writes through server global-config API path.
2. Post-update refresh chain is aligned with sync event handling.
3. TUI sync listens to both instance and global disposal events for refresh convergence.

**Primary files**

- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `packages/opencode/src/config/config.ts`

### D. Guardrail

Any future provider-toggle refactor must preserve:

1. Single source for disabled state (`disabled_providers`).
2. `Show All`/`Filtered` list parity except filter.
3. Disabled Antigravity plugin path must not initialize auth plugin hooks.

### E. Tool Call Bridge Generalization

1. Response rewrite logic for text-protocol tool calls is now routed through a generic Tool Call Bridge manager.
2. Provider/model-specific matching (for example, GmiCloud DeepSeek) is isolated in bridge rule modules under `src/provider/toolcall-bridge/bridges/`.
3. Legacy compatibility exports are preserved via `src/provider/gmicloud-toolcall-bridge.ts` to avoid breaking existing call sites and tests.
4. The generic OpenAI chat rewriter and protocol parser are reusable for future providers that emit textual tool-call markers.

**Primary files**

- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/provider/toolcall-bridge/index.ts`
- `packages/opencode/src/provider/toolcall-bridge/bridges/gmicloud-deepseek.ts`
- `packages/opencode/src/provider/toolcall-bridge/openai-chat-rewriter.ts`
- `packages/opencode/src/provider/toolcall-bridge/protocol/text-protocol.ts`
- `packages/opencode/src/provider/gmicloud-toolcall-bridge.ts`
- `packages/opencode/test/provider/toolcall-bridge/manager.test.ts`

---

## 14. External Dependency Architecture

This section inventories current external dependency surfaces for the `cms` branch and clarifies where dependency resolution happens at runtime vs build time.

### A. Dependency Layers (Where dependencies are actually resolved)

1. **Monorepo build/install layer**
   - Source: root `package.json` + workspace package manifests.
   - Manager: Bun workspace (`workspaces`, `catalog`, `overrides`, `patchedDependencies`).
   - Resolution timing: `bun install` in repo.

2. **Runtime user-space layer (dynamic, outside repo)**
   - Source: user directories (`~/.config/opencode`, `~/.local/share/opencode`) and optional custom config dir.
   - Manager: `Config.installDependencies()` in `packages/opencode/src/config/config.ts`.
   - Resolution timing: during runtime bootstrap (tool/plugin loading flow), not only during repo development.

3. **Template bootstrap layer**
   - Source: `templates/package.json` and `.opencode/package.json` templates.
   - Purpose: define default runtime dependencies for initialized user environments.

### B. Monorepo External Dependency Profile (high-level)

1. **AI/provider SDK cluster (core runtime heavy coupling)**
   - Root depends on many provider adapters under `@ai-sdk/*` (Anthropic/OpenAI/Google/Bedrock/Groq/etc.) and MCP/ACP stacks.
   - Architectural implication: provider availability and transport compatibility are external-SDK sensitive.

2. **UI/desktop cluster**
   - `packages/app` depends on Solid ecosystem + rendering/markdown/highlight stack.
   - `packages/desktop` depends on Tauri plugin suite (`@tauri-apps/*`).
   - Architectural implication: desktop release stability is tied to Tauri plugin matrix compatibility.

3. **Console/backend cluster**
   - `packages/console/core` and `packages/console/function` depend on Drizzle/Postgres/Stripe/AWS/OpenAuth stacks.
   - Architectural implication: cloud/service API version drift can affect serverless and billing/auth flows.

4. **Dependency governance mechanisms already present**
   - `catalog:` centralizes many versions.
   - `overrides` pins critical transitive behavior.
   - `patchedDependencies` currently includes `ghostty-web@0.3.0` patch path.

### C. Runtime Dynamic Dependencies (hidden coupling hotspots)

1. **Auto-install path exists in runtime config pipeline**
   - `Config.state()` iterates runtime config directories and calls `installDependencies(dir)`.
   - `installDependencies()` rewrites/ensures `package.json` dependency:
     - `"@opencode-ai/plugin": targetVersion`
   - `targetVersion = Installation.isLocal() ? "*" : Installation.VERSION`.

2. **Version-coupling risk**
   - When `Installation.VERSION` is a custom/non-published build tag (e.g., `0.0.0-cms-*`), runtime install can fail because npm registry has no matching `@opencode-ai/plugin` release.
   - This is a runtime bootstrap coupling, not a monorepo compile-time failure.

3. **Current runtime manifests (observed)**
   - `~/.config/opencode/package.json`
   - `~/.local/share/opencode/package.json`
   - Both are active dependency manifests used by runtime bootstrap.

### D. Template & User-Space Dependency Surfaces

1. `templates/package.json`
   - Includes:
     - `@opencode-ai/plugin`
     - `opencode-openai-codex-auth-multi`
2. `.opencode/package.json` (repo template/runtime scaffold)
   - Includes floating `@opencode-ai/plugin: "*"`.

Architectural implication: user runtime behavior depends not only on repo lockfile, but also on template-emitted manifests and post-install mutation logic.

### E. Coupling Risk Classification (inventory only)

1. **High risk**
   - Runtime pinning of internal package to non-published version identifiers.
   - Floating `*` specifiers in runtime manifests.

2. **Medium risk**
   - Pre-release/timestamped package references (for example OpenAuth prerelease line).
   - URL-based package source in catalog (e.g. preview channel dependencies).

3. **Operational risk**
   - Runtime dependency state split across repo + user directories can produce environment-specific failures that are not reproducible from repo lockfile alone.

### F. Current Conclusion

The project has **three dependency planes** (monorepo, template, runtime user-space), and the most failure-prone area is the runtime plane where dependency versions are mutated during bootstrap. This is the primary external-coupling boundary to target in the next decoupling plan.

---

## 15. External Dependency Decoupling Plan (Draft v1)

This plan aims to reduce runtime dependency fragility while preserving compatibility for current users.

### A. Objectives

1. Eliminate runtime breakage caused by non-published internal package version pins.
2. Reduce hidden dependency drift between repo lockfile and user-space manifests.
3. Keep bootstrap behavior deterministic and diagnosable.

### B. Scope Boundaries

1. **In scope**
   - Runtime dependency installation policy in `Config.installDependencies()`.
   - Template/runtime manifest default version policy.
   - Health checks and telemetry for dependency resolution outcomes.

2. **Out of scope (for v1)**
   - Full removal of runtime plugin extensibility.
   - Re-architecting provider SDK selection model.

### C. Phased Rollout

#### Phase 0 — Safety Guard (Immediate, low risk)

1. Before writing runtime `@opencode-ai/plugin` version:
   - Validate target version format and publish availability.
2. If target is non-resolvable:
   - Fallback to a known-safe version policy (priority: template-pinned version -> latest stable allowed by policy).
3. Emit structured warning/event with cause and chosen fallback.

**Exit criteria**: no startup hard-fail caused by non-published plugin specifier.

#### Phase 1 — Version Source Decoupling (Short-term)

1. Stop direct coupling `pluginVersion := Installation.VERSION` for non-local channels.
2. Introduce explicit plugin resolution strategy:
   - `runtimePluginVersionPolicy` in config (e.g., `pinned`, `range`, `latest-safe`).
3. Resolve plugin version via policy module, not inline conditional.

**Exit criteria**: custom app version tags (`0.0.0-cms-*`) no longer imply same plugin version tag.

#### Phase 2 — Runtime Manifest Governance (Mid-term)

1. Replace floating `*` in runtime/template manifests with policy-driven ranges.
2. Add manifest provenance metadata (who/when/why updated dependency pins).
3. Add `opencode doctor deps` (or equivalent) to display effective dependency state across:
   - repo
   - global config dir
   - global data dir

**Exit criteria**: operators can inspect and reproduce dependency state deterministically.

#### Phase 3 — Optional Bundling / Offline Mode (Long-term)

1. Evaluate bundling core plugin runtime with application release artifact.
2. Keep external plugin install path only for explicitly opt-in custom plugins.
3. Add offline bootstrap path that does not require npm resolution for core runtime.

**Exit criteria**: baseline startup no longer depends on network package resolution for core plugin path.

### D. Policy Proposal (Version Resolution)

Resolution order for `@opencode-ai/plugin` during runtime install:

1. Explicit admin-managed override (managed config).
2. Explicit user config override.
3. Template baseline pinned version.
4. Registry-validated stable fallback.

Hard rules:

1. Never write unresolved/non-published exact version to runtime manifest.
2. Never persist `*` for core runtime dependency in production channels.
3. Record fallback decision in logs/events for auditability.

### E. Risk & Rollback Strategy

1. **Risk**: stricter policy may block previously tolerated custom pins.
   - Mitigation: provide explicit escape hatch config with warning banner.
2. **Risk**: compatibility drift between template version and runtime fallback.
   - Mitigation: CI check to compare template baseline against allowed policy set.
3. **Rollback**:
   - Feature-flag dependency policy module.
   - Revert to legacy install behavior behind emergency env flag.

### F. Validation Matrix

1. Local channel (`Installation.isLocal() = true`) bootstrap.
2. CMS custom version channel (`0.0.0-cms-*`) bootstrap.
3. Managed config override + read-only directory behavior.
4. No-network / registry timeout scenario.
5. Existing user manifests with historical invalid pins.

### G. Deliverables for Implementation Sprint

1. `DependencyVersionResolver` module + unit tests.
2. Runtime install guard in `Config.installDependencies()`.
3. Template manifest policy update.
4. Dependency health report command or admin diagnostics panel entry.

---

## 16. Implementation Tickets (Decoupling Plan v1)

This section translates the decoupling draft into executable engineering tickets.

### TKT-001 — Runtime plugin version resolver module

- **Goal**: Isolate plugin version decision logic from inline install flow.
- **Primary files**:
  - `packages/opencode/src/config/config.ts`
  - `packages/opencode/src/installation/index.ts`
  - `packages/opencode/src/config/` (new resolver module)
- **Work items**:
  1. Add `DependencyVersionResolver.resolvePluginVersion(context)`.
  2. Inputs include channel/version/local flag + optional overrides.
  3. Output includes `{version, source, fallbackReason?}`.
- **Acceptance criteria**:
  1. No direct `Installation.VERSION` assignment to runtime plugin dependency outside resolver.
  2. Resolver returns deterministic output for same input.
  3. Unit tests cover local, stable, and cms-custom version channels.
- **Suggested tests**:
  - `bun test packages/opencode/test/config/dependency-version-resolver.test.ts`

### TKT-002 — Runtime install guard + fallback behavior

- **Goal**: Prevent unresolved package versions from being persisted to runtime manifests.
- **Primary files**:
  - `packages/opencode/src/config/config.ts` (`installDependencies`)
  - `packages/opencode/src/bun.ts` (if helper needed)
- **Work items**:
  1. Validate candidate plugin version before writing `package.json`.
  2. If invalid/unpublished, fallback according to policy order.
  3. Emit warning with structured fields (`requested`, `resolved`, `reason`, `source`).
- **Acceptance criteria**:
  1. Invalid specifier (e.g., `0.0.0-cms-*`) does not cause hard failure.
  2. Runtime manifest stores fallback resolvable version.
  3. Install path remains non-blocking when directory is read-only.
- **Suggested tests**:
  - Add/extend config install tests under `packages/opencode/test/config/*`.

### TKT-003 — Runtime/template manifest version policy hardening

- **Goal**: Remove floating core dependency specifier and align template/runtime policy.
- **Primary files**:
  - `templates/package.json`
  - `.opencode/package.json`
  - `packages/opencode/.opencode/package.json`
  - docs: `docs/ARCHITECTURE.md` (policy reference)
- **Work items**:
  1. Replace `"@opencode-ai/plugin": "*"` with policy-compliant baseline/range.
  2. Define update rule for template baseline version bump.
  3. Document compatibility expectations.
- **Acceptance criteria**:
  1. Core runtime manifest no longer relies on `*` for plugin dependency in production policy.
  2. Template and runtime scaffold are policy-consistent.
  3. CI/policy check fails on forbidden specifier patterns.

### TKT-004 — Dependency diagnostics surface

- **Goal**: Make effective dependency state observable.
- **Primary files**:
  - `packages/opencode/src/cli/cmd/` (new or extended command)
  - `packages/opencode/src/server/routes/` (optional API endpoint)
  - `packages/opencode/src/config/config.ts` (state provider)
- **Work items**:
  1. Add diagnostics output for dependency planes:
     - repo
     - global config dir
     - global data dir
  2. Include source of truth and last resolution reason.
  3. Return actionable remediation hints.
- **Acceptance criteria**:
  1. Operator can identify mismatch between repo and runtime manifests from one command/view.
  2. Diagnostics clearly flags invalid/non-published pins.
  3. Output is stable enough for automation parsing.

### TKT-005 — Regression harness for runtime dependency bootstrap

- **Goal**: Protect against recurrence of startup failures from dependency pins.
- **Primary files**:
  - `packages/opencode/test/` (new integration tests)
  - test fixtures under `packages/opencode/test/fixtures/` (if needed)
- **Work items**:
  1. Add fixture cases for:
     - valid stable pin
     - invalid custom pin
     - read-only config directory
     - network/registry failure simulation
  2. Verify fallback and warning behavior.
- **Acceptance criteria**:
  1. Test suite fails if unresolved pin is persisted.
  2. Test suite validates fallback version is written.
  3. No regression on local/dev startup path.

### Execution Order (Recommended)

1. TKT-001
2. TKT-002
3. TKT-005
4. TKT-003
5. TKT-004

### Ownership & Timeline Template

For each ticket, track:

- **Owner**
- **PR**
- **Target date**
- **Risk level (H/M/L)**
- **Rollback plan**

---

## 17. Runtime Dependency Principle (Normative, cms)

This section defines the dependency boundary policy for runtime behavior in `cms`.

### A. Core Principle

1. Runtime must minimize direct dependency on external package registries.
2. Public LLM provider APIs are an explicit exception (business-required external connectivity).
3. Non-LLM core runtime path must remain bootable under registry/network instability.

### B. Required Runtime Behavior

1. **Bundle-first for core runtime dependencies**
   - Core plugin/runtime capabilities should be loaded from release-bundled artifacts first.
2. **External-optional for non-core extensions**
   - External plugin installation is opt-in and must not block baseline startup.
3. **No runtime speculative version coupling**
   - Runtime install logic must not derive package versions directly from app build tags (for example `0.0.0-cms-*`).
4. **Deterministic fallback policy**
   - On unresolved external dependency, runtime must fallback/degrade with warnings, not hard-fail bootstrap.

### C. Ticket Alignment Update (v1 -> bundle-first)

1. `TKT-003` (manifest policy)
   - Upgrade target: remove floating `*` and mark core dependency path as bundle-first.
2. `TKT-004` (diagnostics)
   - Must classify dependencies as:
     - `core-bundled`
     - `external-optional`
     - `external-required`
3. Add implementation focus to `TKT-001/002`:
   - resolver/guard should prefer non-network core path before any external resolution.

### D. Success Criteria

1. Baseline runtime startup works when npm registry is unavailable (excluding first-time optional extension install).
2. Core agent/session/tool path does not require live dependency fetch.
3. Dependency failures in optional extensions are isolated and observable.

---

## 18. Test Governance Rule: Retire Obsolete Tests (Normative)

As `cms` architecture evolves, test maintenance must distinguish between regressions and obsolete contracts.

### A. Core Rule

If a test validates behavior that is intentionally removed by current architecture, that test should be **retired** (delete or move to legacy suite), not force-fixed.

### B. Retirement Decision Criteria

A test is eligible for retirement when all conditions hold:

1. The behavior is explicitly replaced/disabled in current architecture policy (`docs/ARCHITECTURE.md`) or recorded event decisions.
2. The test asserts legacy contract semantics that no longer represent production responsibilities.
3. Keeping the test causes persistent false alarms and reduces CI signal quality.

### C. Allowed Actions

1. **Delete** test if capability is permanently removed.
2. **Move to legacy suite** gated by explicit flag (e.g., compatibility verification only).
3. **Rewrite** test to validate the new contract if the capability still exists with changed semantics.

### D. PR/Review Requirements

When retiring tests, PR must include:

1. Reason for retirement mapped to architecture/event record.
2. Replacement coverage (if any) for current behavior.
3. Confirmation that CI signal quality improves (lower flaky/false-fail surface).

---

## 19. Web Auth Credential Management Baseline

This section defines the credential-management baseline for self-hosted Web deployments.

### A. Security Policy

1. Runtime credential strategy is selected by `OPENCODE_AUTH_MODE` (`pam`/`htpasswd`/`legacy`/`auto`).
2. Current cms baseline is **PAM-first** (`OPENCODE_AUTH_MODE=pam`) for Linux self-host deployments.
3. Keep htpasswd and legacy env-password as explicit compatibility modes, not implicit defaults.
4. Browser auth flow uses session cookie + CSRF protection; no URL-embedded basic credentials.

### B. Runtime credential behavior by mode

1. `pam`: Linux PAM only (`su` PTY via `bun-pty`); no htpasswd or legacy env password check.
2. `htpasswd`: file-based hash verification only (`OPENCODE_SERVER_HTPASSWD` or `OPENCODE_SERVER_PASSWORD_FILE`).
3. `legacy`: `OPENCODE_SERVER_USERNAME + OPENCODE_SERVER_PASSWORD` only.
4. `auto` (compatibility): htpasswd → legacy env password → PAM (Linux only).

### C. File-to-function mapping

| File Path                                              | Function / Responsibility                                                                                                     | Architectural Impact                                                                      |
| :----------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| `packages/opencode/src/server/web-auth-credentials.ts` | Resolves `OPENCODE_AUTH_MODE`, verifies credentials by mode (pam/htpasswd/legacy/auto), and runs Linux PAM auth via PTY `su`. | Enables deterministic PAM-only deployments while preserving explicit compatibility modes. |
| `packages/opencode/src/server/web-auth.ts`             | Web auth policy layer (session cookie signing, CSRF enforcement helpers, lockout integration).                                | Central auth gate contract consumed by server middleware and auth routes.                 |
| `packages/opencode/src/server/routes/global.ts`        | Auth endpoints for session probe/login/logout; returns `usernameHint` for login UX.                                           | Provides explicit auth API contract for browser clients.                                  |
| `packages/opencode/src/flag/flag.ts`                   | Defines auth flags (`OPENCODE_AUTH_MODE`, `OPENCODE_SERVER_HTPASSWD`, `OPENCODE_SERVER_PASSWORD_FILE`).                       | Standardizes mode-based auth routing across runtime and startup scripts.                  |
| `packages/app/src/context/web-auth.tsx`                | Frontend auth state manager, cookie-based authorized fetch, CSRF header injection.                                            | Aligns browser transport security with server-side CSRF/session model.                    |
| `packages/app/src/components/auth-gate.tsx`            | Login gate UI using `usernameHint` and explicit sign-in flow.                                                                 | Replaces browser-native Basic auth popup with controllable app UX.                        |
| `packages/app/src/components/terminal.tsx`             | Removes websocket URL basic credentials.                                                                                      | Prevents credential exposure in URL/user-info surface.                                    |
| `docker/docker-compose.production.yml`                 | Exposes `OPENCODE_SERVER_HTPASSWD` default path `/opt/opencode/config/opencode/.htpasswd`.                                    | Makes secure-by-default self-host setup practical for home installations.                 |

### D. Operational baseline for Docker self-host

1. Credential file location: `/opt/opencode/config/opencode/.htpasswd`
2. File format: one credential per line (`username:<argon2/bcrypt hash>`)
3. Do not ship default plaintext password values in compose defaults.

---

## 20. WebApp File Structure & Runtime Flow (cms)

This section provides the current architecture view focused on:

1. where core WebApp logic lives, and
2. how the runtime data/auth/terminal flows operate end-to-end.

### A. WebApp structure map (high-signal paths)

| Area                | Primary Files                                                                                                                                                                                     | Responsibility                                                                                                                                           |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry / bootstrap   | `packages/app/src/entry.tsx`, `packages/app/src/app.tsx`                                                                                                                                          | App bootstrap, platform/provider tree, dynamic-import recovery guard.                                                                                    |
| Auth boundary       | `packages/app/src/context/web-auth.tsx`, `packages/app/src/components/auth-gate.tsx`                                                                                                              | Cookie-session auth state, CSRF-aware fetch, login gate UX.                                                                                              |
| SDK + event stream  | `packages/app/src/context/global-sdk.tsx`, `packages/app/src/context/global-sync.tsx`, `packages/app/src/context/global-sync/bootstrap.ts`, `packages/app/src/context/global-sync/child-store.ts` | API client wiring, SSE/global event stream, bootstrap/state hydration, and directory-scoped workspace adapter state for child stores.                    |
| Session surface     | `packages/app/src/pages/session.tsx`, `packages/app/src/pages/session/*`                                                                                                                          | Conversation timeline, side panels, request tree, session page orchestration.                                                                            |
| Prompt + slash      | `packages/app/src/components/prompt-input.tsx`, `packages/app/src/pages/session/use-session-commands.tsx`                                                                                         | Prompt submit pipeline, slash command list/merge semantics, session command actions.                                                                     |
| Terminal / PTY UI   | `packages/app/src/components/terminal.tsx`, `packages/app/src/context/terminal.tsx`, `packages/app/src/pages/session/terminal-panel.tsx`, `packages/app/src/pages/session/terminal-popout.tsx`    | PTY tab state, websocket rendering, popout lifecycle, restore policy, and workspace-scoped terminal persistence keyed from explicit workspace directory. |
| Model selector      | `packages/app/src/components/dialog-select-model.tsx`, `packages/app/src/components/model-selector-state.ts`                                                                                      | 3-column provider/account/model selection and deterministic derivation rules.                                                                            |
| Settings admin-lite | `packages/app/src/components/settings-providers.tsx`, `packages/app/src/components/settings-models.tsx`, `packages/app/src/components/settings-accounts.tsx`                                      | Web-side provider/account/model operations and rotation-guided actions.                                                                                  |
| Web diagnostics     | `packages/app/src/utils/api-error.ts`                                                                                                                                                             | Boundary-aware error mapping for user-facing recovery guidance.                                                                                          |

### B. Runtime flow 1: Auth + API request path

```mermaid
flowchart LR
  B[Browser] --> C[AuthGate]
  C --> W[web-auth context\nauthorizedFetch + CSRF]
  W --> A[Server WebAuth middleware]
  A --> R[API routes /api/v2 + /global]
  R --> G[global-sdk/global-sync stores]
  G --> UI[Session + Settings UI]
```

Key contract:

- Browser path is cookie-session + CSRF.
- TUI/CLI compatibility may still use Basic auth where required.
- Pre-login event/SDK requests must be gated to avoid expected-but-noisy 401 loops.

### C. Runtime flow 2: Terminal / PTY lifecycle

```mermaid
flowchart LR
  UI[Terminal UI] --> P1[POST /pty create]
  P1 --> P2[WS /pty/:id/connect]
  P2 --> BUF[Terminal renderer\ncontrol frame vs payload frame]
  BUF --> STORE[terminal context state]
  STORE --> UI
```

Required invariants:

1. PTY uses explicit create -> connect contract; stale IDs are invalid state.
2. Hydrated persisted PTY IDs must be validated/pruned on startup.
3. WebSocket handling must separate metadata control frames from renderable payload frames.
4. Popout/inline transitions use `skipRestore` policy to avoid stale-frame replay artifacts.

### C1. Workspace-scoped app state ownership (current beta/cms direction)

The web app currently uses a mixed ownership model while the new workspace kernel is being rolled out:

1. **Workspace-owned state**
   - `context/terminal.tsx`
   - `context/global-sync/child-store.ts`
   - These states now key off explicit workspace directory truth, not just raw route params.

2. **Session-with-workspace-default state**
   - `context/prompt.tsx`
   - `context/comments.tsx`
   - `context/file/view-cache.ts`
   - Rule: if a session id exists, keep per-session scope; otherwise fall back to the explicit workspace directory derived by `globalSync.child(directory).workspace`.

3. **Why this matters**
   - The app no longer treats every persistence surface as a plain directory string.
   - `global-sync` is now the first consumer-facing bridge between runtime workspace modeling and app-side persistence scope.
   - This is still an intermediate phase: runtime owns the canonical workspace kernel under `packages/opencode/src/project/workspace/*`, while app/runtime now share identity normalization via `@opencode-ai/util/workspace`.

### D. Runtime flow 3: Model selector and admin-lite parity path

```mermaid
flowchart TD
  S[DialogSelectModel] --> M[model-selector-state.ts]
  M --> PR[Provider rows]
  M --> AR[Account rows]
  M --> MR[Model rows]
  MR --> ACT[Apply: set active account -> set model]
  ACT --> SYNC[global dispose/bootstrap refresh]
```

Behavior boundary (current cms WebApp):

1. Provider/account rows derive from provider universe + account families.
2. Mode switch (`favorites`/`all`) affects model filtering layer only.
3. Unavailable/cooldown states are surfaced and selection is blocked with explicit reason.
4. Web has admin-lite parity slices; TUI `/admin` remains canonical full control plane.

### E. Deployment/runtime contract for WebApp correctness

1. Server should serve local frontend bundle via `OPENCODE_FRONTEND_PATH` for cms-consistent behavior.
2. If not set, CDN proxy fallback can produce frontend/runtime contract drift (auth and feature mismatch risk).
3. Operationally, direct web mode is primary for host-workspace parity; Docker remains optional isolation path.

### F. Reference decision records

- `docs/events/event_20260223_web_architecture_first_plan.md`
- `docs/events/event_20260223_web_runtime_bug_backlog.md`
- `docs/events/event_20260224_web_auth_401_loop_fix.md`
- `docs/events/event_20260227_web_model_selector_refactor_arch_sync.md`
- `docs/events/event_20260227_web_slash_commands_tui_alignment.md`
- `docs/events/event_20260228_terminal_popout_return_and_selection_fix.md`
- `docs/events/event_20260301_web_dev_refactor_integration.md`

---

## 21. Desktop Runtime Architecture

This section documents the desktop application's current operating principles. The desktop is a **thin Tauri shell** that loads the same web frontend served by `opencode serve`.

### A. Process Architecture (stdout-based sidecar)

```
Tauri Main Process (Rust, minimal)
  ├── Platform env setup (display backend, proxy bypass)
  ├── Spawns child: `opencode serve --hostname 127.0.0.1 [--port N]`
  │   with env: OPENCODE_SERVER_PASSWORD={random UUID}
  │             OPENCODE_CLIENT=desktop
  │             OPENCODE_FRONTEND_PATH={bundled frontend resource}
  ├── Waits for stdout: "opencode server listening on http://..."
  │   (no HTTP health polling — parsed directly from stdout line)
  ├── Opens WebView → parsed server URL (External URL, not bundled HTML)
  │   with init script injecting auto-login credentials
  └── On exit: kill child process (RunEvent::Exit handler)

Child Process (Bun / opencode serve)
  ├── Hono HTTP server on localhost
  ├── API at /api/v2 and /
  ├── Frontend served from OPENCODE_FRONTEND_PATH (bundled in Tauri resources)
  └── SSE event stream at /event
```

**Port selection**: `OPENCODE_PORT` env → explicit `--port N` → port 0 (OS-assigned, reported via stdout).

**Readiness detection**: `cli.rs` reads the child's stdout line-by-line. When a line starts with `SERVER_READY_PREFIX` (`"opencode server listening on http://"`), the URL is parsed from that line and sent via a oneshot channel. Timeout: 30s → error dialog.

**Auto-login**: `windows.rs` injects `window.__OPENCODE__.autoLoginCredentials = { username, password }` via WebView initialization script. The web frontend's `AuthGate` component picks this up on mount and calls `auth.login()` automatically — no login form shown.

### B. Frontend Architecture (web-unified)

Desktop now loads the **same web frontend** (`packages/app/src/entry.tsx`) served by the opencode server, rather than a separate Tauri-specific entry. The WebView points to the server's HTTP URL (`WebviewUrl::External`).

**What this eliminates** (compared to the pre-refactor architecture):

- Desktop-specific `index.tsx` with 15+ Platform interface methods
- Separate Vite build for desktop frontend
- `bindings.ts` fragility (fewer Tauri commands called from frontend)
- Tauri plugins for: dialog, store, notification, clipboard, http

**What remains in Rust**:

- Window creation with server URL + auto-login injection
- Auto-updater (`tauri-plugin-updater`)
- Deep linking (`tauri-plugin-deep-link`)
- Single instance enforcement
- Window state persistence (`tauri-plugin-window-state`)
- Linux display backend configuration (`main.rs`)
- macOS traffic light + overlay title bar styling

### C. Frontend Serving & Runtime Config (Fail-Fast)

The web server frontend path (`server/app.ts`) follows a **fail-fast** contract:

1. Runtime must provide **`OPENCODE_FRONTEND_PATH`** (configured from `/etc/opencode/opencode.cfg` in webctl/systemd flows).
2. If frontend bundle path is missing/invalid, server returns explicit errors (`503/404/400`) — **no silent CDN fallback**.
3. For SPA routes, server serves local `index.html` from the configured frontend root.

Canonical runtime source of truth for web/server launch parameters:

- **`/etc/opencode/opencode.cfg`**
  - Examples: `OPENCODE_PORT`, `OPENCODE_HOSTNAME`, `OPENCODE_PUBLIC_URL`, `OPENCODE_FRONTEND_PATH`, auth-related env.

Canonical launch paths:

- **Dev**: `./webctl.sh dev-start` (reads `/etc/opencode/opencode.cfg`, injects `OPENCODE_LAUNCH_MODE=webctl`)
- **Prod**: `./webctl.sh web-start` (systemd service with `EnvironmentFile=/etc/opencode/opencode.cfg`, injects `OPENCODE_LAUNCH_MODE=systemd`)

Direct manual `opencode web` launch is guarded by launch-mode checks to prevent configuration drift.

**Desktop (Tauri)**: Bundles `packages/app/dist` as a Tauri resource at `frontend/`, sets `OPENCODE_FRONTEND_PATH` pointing to the resolved resource path at sidecar spawn time.

**Standalone CLI install** (`scripts/install/install`): Downloads `opencode-frontend.tar.gz` from the GitHub release and extracts to `$XDG_DATA_HOME/opencode/frontend/` for standalone distribution scenarios.

```
~/.local/share/opencode/
├── bin/opencode          ← CLI binary
├── frontend/             ← pre-built app dist (index.html, assets/, etc.)
│   ├── index.html
│   └── assets/
├── skills/               ← bundled skills
└── ...
```

### D. Initialization Flow (post-refactor)

1. **`main.rs`**: Set `NO_PROXY` for loopback; on Linux, configure display backend env vars.
2. **`lib.rs::run()`**: Register Tauri plugins + commands; spawn async `initialize()` task.
3. **`initialize()`**: Check for explicit port (`OPENCODE_PORT` or custom server URL) → spawn sidecar via `cli::serve()` → await stdout readiness signal → create `MainWindow` with `ServerReadyData { url, username, password }`.
4. **`MainWindow::create()`**: Build WebView with `WebviewUrl::External(server_url)`, inject auto-login credentials via initialization script.
5. **Web frontend `AuthGate`**: On mount, reads `window.__OPENCODE__.autoLoginCredentials`, calls `auth.login()`, renders app.

### E. Cross-Surface Comparison (TUI vs Web vs Desktop)

| Aspect              | TUI                                    | Web (`opencode web`)                                                           | Desktop (Tauri)                                   |
| :------------------ | :------------------------------------- | :----------------------------------------------------------------------------- | :------------------------------------------------ |
| Server hosting      | In-process `Server.listen()` in worker | In-process `Server.listen()`                                                   | Separate child process (`opencode serve`)         |
| Frontend renderer   | Terminal (`@opentui/solid`)            | Browser (same-origin)                                                          | Tauri WebView (External URL to localhost)         |
| Frontend entry      | TUI-specific renderer                  | `packages/app/src/entry.tsx`                                                   | Same as web (served by child process)             |
| Auth model          | Env var password → in-process          | Cookie-session + CSRF                                                          | Auto-login via `window.__OPENCODE__` credentials  |
| Frontend resolution | N/A                                    | `OPENCODE_FRONTEND_PATH` (from `/etc/opencode/opencode.cfg`) → fail-fast error | Bundled Tauri resource → `OPENCODE_FRONTEND_PATH` |
| Process count       | 1 (main + worker thread)               | 1                                                                              | 2 (Tauri host + child)                            |
| Readiness detection | In-process (immediate)                 | In-process (immediate)                                                         | stdout line parsing (no HTTP polling)             |

### F. Platform-Specific Behavior

**Windows**:

- WebView2 custom data directory and proxy bypass for loopback (`--proxy-bypass-list=<-loopback>`).
- Overlay titlebar via `tauri-plugin-decorum`.

**macOS**:

- Private API enabled for improved scrolling (`macOSPrivateApi: true`).
- Overlay title bar with hidden title, traffic lights at `(12, 18)`.

**Linux / WSL**:

- WebKit env vars: `WEBKIT_DISABLE_DMABUF_RENDERER`, `WEBKIT_DISABLE_COMPOSITING_MODE`, `WEBKIT_FORCE_SANDBOX=0`, `LIBGL_ALWAYS_SOFTWARE`, `WEBKIT_DISABLE_ACCELERATED_2D_CANVAS`.
- Wayland detection with X11 fallback (respects `OC_ALLOW_WAYLAND` and stored preference).
- GTK gesture zoom handler removal via `PinchZoomDisable` plugin.

### G. Key Files

| Layer           | Files                                                                                                            |
| :-------------- | :--------------------------------------------------------------------------------------------------------------- |
| Rust entry      | `src-tauri/src/main.rs` (env + display backend), `src-tauri/src/lib.rs` (setup, initialize, commands)            |
| Rust sidecar    | `src-tauri/src/cli.rs` (stdout-based spawn + readiness), `src-tauri/src/server.rs` (Tauri commands, URL helpers) |
| Rust windows    | `src-tauri/src/windows.rs` (MainWindow + LoadingWindow + auto-login injection)                                   |
| Build           | `scripts/predev.ts`, `vite.config.ts`                                                                            |
| Config          | `src-tauri/tauri.conf.json` (resources: `../../app/dist → frontend`)                                             |
| Server frontend | `packages/opencode/src/server/app.ts` (local frontend serving + explicit fail-fast errors)                       |
| XDG paths       | `packages/opencode/src/global/index.ts` (`Global.Path.frontend`)                                                 |
| Install         | `scripts/install/install` (downloads frontend tarball alongside binary)                                          |
| Release         | `script/build.ts` (produces `opencode-frontend.tar.gz` artifact)                                                 |
| Runtime config  | `/etc/opencode/opencode.cfg` (single source for web/server runtime parameters)                                   |

### H. Decision Records

- `docs/events/event_20260301_desktop_sidecar_refactor.md`

---

## 22. System Identity & PAM Authentication Architecture

This section details the current Systemd-based user isolation, PAM authentication logic, and authorization bypasses (TUI) used to securely manage user identity impersonation while preserving single-user and local terminal workflows.

### A. Architectural Goals

1. **Strict User Isolation (Web):** A centralized system daemon (`opencode` service) hosts the web UI but spawns processes (like Bash shells or LLM scripts) under the explicitly authenticated Linux user's identity.
2. **Native Environment (TUI):** A terminal user launching the TUI must have requests run seamlessly under their _current session identity_, bypassing web auth flows without escalating or switching privileges.
3. **No Sudo for Opencode Core:** The main server runs as a less-privileged or dedicated `opencode` user and delegates command execution down to the target user via a narrowly-scoped sudoers policy.

### B. Core Components & Responsibilities

| File / Component                                  | Responsibility                                                                                                                          | Impact                                                                                                             |
| :------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/system/linux-user-exec.ts` | **Execution Bridge:** Intercepts shell creation and command execution. Decides whether to prefix commands with `sudo -u <target_user>`. | Centralizes the decision point for user impersonation logic.                                                       |
| `packages/opencode/src/runtime/request-user.ts`   | **Context Manager:** Holds the `username` associated with the _current asynchronous request/call stack_.                                | Enables deep functions (like PTY spawners) to know who originated the HTTP request without prop drilling.          |
| `packages/opencode/src/server/web-auth.ts`        | **PAM Authenticator:** Validates credentials via Node-PAM. On success, issues a signed session cookie containing the `username`.        | The sole gatekeeper for browser-to-server trust. Extracts Linux user info and injects it into the request context. |
| `packages/opencode/src/server/app.ts`             | **Auth Middleware:** Rejects unauthenticated requests. Parses session cookies or bypass tokens and populates `RequestUser`.             | Secures all backend routes from unauthorized web access.                                                           |
| `scripts/opencode-run-as-user.sh`                 | **Sudo Target Script:** A restricted script that executes a payload as the target user while loading their `.bashrc` / `.bash_profile`. | Ensures the shell and agents have the correct environment variables (Node, Git, IDE settings) for that user.       |

### C. The TUI Auth Bypass (`OPENCODE_CLI_TOKEN`)

Because the TUI acts as a client to the local server, pushing it through the web's PAM authentication would require prompt interruptions or manual password entries on an already-authenticated terminal.

To solve this securely:

1. **Dynamic Token Generation (`packages/opencode/src/index.ts`)**: When the CLI starts, it dynamically generates an `OPENCODE_CLI_TOKEN` (random crypto bytes) and sets it in the environment variable.
2. **Worker Injection (`packages/opencode/src/cli/cmd/tui/thread.ts`)**: The TUI worker process inherits this variable.
3. **Authorized Fetches (`packages/opencode/src/cli/cmd/tui/worker.ts`)**: The TUI worker attaches `Bearer <OPENCODE_CLI_TOKEN>` to its local server requests instead of standard auth credentials.
4. **Server Bypass (`packages/opencode/src/server/app.ts`)**: The server's middleware intercepts `OPENCODE_CLI_TOKEN`. If it matches the server's running token, the request is permitted **without a `username` context**.

### D. Execution Decision Matrix

When `linux-user-exec.ts` (`resolveExecutionUser`) evaluates how to run a command:

| Auth Method                | Origin         | `RequestUser` Username | Sudo Execution Action                                        | Reason                                                                      |
| :------------------------- | :------------- | :--------------------- | :----------------------------------------------------------- | :-------------------------------------------------------------------------- |
| **PAM Session Cookie**     | Browser WebApp | `<logged_in_user>`     | `sudo -u <user> /usr/local/libexec/opencode-run-as-user ...` | Explicit login requires isolating execution to the selected identity.       |
| **`OPENCODE_CLI_TOKEN`**   | Local TUI      | `undefined`            | Native Execution (No Sudo)                                   | TUI is already running under the active terminal user's system permissions. |
| **No Auth (Public Route)** | Any            | `undefined`            | N/A (Denied by Server)                                       | Unauthenticated endpoints cannot trigger execution.                         |

### E. Security & Deployment Posture

- **Sudoers Policy:** For the WebApp impersonation to work, the daemon user (e.g., `opencode`) must be granted passwordless sudo access _only_ to the execution bridge script (`/usr/local/libexec/opencode-run-as-user`), not arbitrary commands.
- **Token Secrecy:** `OPENCODE_CLI_TOKEN` only lives in volatile memory and the environment variables of child processes spawned by the immediate CLI invocation. It is never written to disk.
