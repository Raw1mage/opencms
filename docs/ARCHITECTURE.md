# OpenCode Project Architecture

This document provides a comprehensive overview of the `opencode` monorepo structure, detailing the various packages, their purposes, and relationships. It is intended to guide developers and AI agents in understanding the system's organization.

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
4.  **Provider Granularity**: The monolithic `google` provider has been split into three distinct providers to maximize resource utilization:
    - `antigravity`: Specialized for high-reasoning tasks.
    - `gemini-cli`: Optimized for batch processing and large context.
    - `google-api`: For lightweight, high-speed requests.

### Upstream Integration

- **`origin/dev`**: The upstream source. Changes from `origin/dev` are **analyzed and refactored** before being integrated into `cms`. Direct merges are prohibited to preserve the `cms` architecture.
- **External Plugins**: Located in `/refs`, these are also subject to analysis and refactoring before integration.

### Recent Architectural Notes (2026-02-20)

The following refactor-ported changes were integrated into `cms` and are relevant to runtime behavior boundaries:

1. **Plugin bootstrap fault isolation (`packages/opencode/src/plugin/index.ts`)**
   - Internal plugin init and dynamic plugin import failures are now isolated and surfaced as session errors instead of crashing plugin bootstrap.
   - Architectural effect: plugin subsystem failure domain is narrowed from "global startup failure" to "per-plugin degraded mode".

2. **Snapshot staging exclude sync (`packages/opencode/src/snapshot/index.ts`)**
   - Snapshot `track/patch/diff` now sync source repo `info/exclude` into snapshot gitdir before `git add .`.
   - Architectural effect: snapshot diff/patch behavior is now aligned with project-local exclude policy, reducing false-positive staged changes.

3. **GitHub Action variant propagation (`github/action.yml`, `packages/opencode/src/cli/cmd/github.ts`)**
   - Added optional `variant` action input and propagated `VARIANT` through `opencode github run` to `SessionPrompt.prompt()`.
   - Architectural effect: CI-triggered agent runs can now carry provider/model-specific reasoning variants through the same session prompt pipeline as interactive runs.

4. **Experimental cross-project session listing (`packages/opencode/src/session/index.ts`, `packages/opencode/src/server/routes/experimental.ts`)**
   - Added `Session.listGlobal()` and `GET /experimental/session` to enumerate sessions across all projects with optional filtering and cursor pagination.
   - Architectural effect: session discovery now has an explicit global-read path (project-agnostic index + project metadata join), separate from project-scoped `/session` APIs.

5. **Desktop server connection policy refinement (`packages/desktop/src-tauri/src/lib.rs`, `packages/desktop/src-tauri/src/server.rs`, `packages/desktop/src/index.tsx`)**
   - Desktop now avoids spawning a local sidecar when the configured default server is already localhost; remote defaults still permit local sidecar fallback.
   - Architectural effect: desktop runtime now supports a dual-mode bootstrap (existing local server vs sidecar) with explicit `is_sidecar` signaling from Rust to frontend.

6. **Tool/runtime observability and multimodal fetch updates (`packages/opencode/src/session/tool-invoker.ts`, `packages/plugin/src/index.ts`, `packages/opencode/src/tool/webfetch.ts`)**
   - `tool.execute.after` hook input now includes tool `args`, enabling plugins to correlate tool outcomes with original invocation arguments.
   - `webfetch` now returns non-SVG image responses as file attachments (data URLs) instead of forcing text decoding.
   - Architectural effect: plugin hook contract gains argument-level visibility, and tool result pipeline now supports binary-first web artifacts in the same attachment channel as other file parts.

7. **Attachment ownership normalization (phase-in) (`packages/opencode/src/tool/webfetch.ts`, `packages/opencode/src/tool/batch.ts`, session prompt/processor pipeline)**
   - Tool outputs are being normalized so attachments are returned without transport identity fields (`id/sessionID/messageID`), with message-part identity injected centrally in session processing.
   - Architectural effect: attachment identity responsibility shifts from per-tool implementation to session pipeline boundaries, reducing duplicated metadata logic and preventing mixed ownership bugs.

8. **Structured output contract rollout (`packages/opencode/src/session/message-v2.ts`, `packages/opencode/src/session/prompt.ts`, `packages/opencode/src/session/llm.ts`, `packages/sdk/js/src/v2/gen/*`)**
   - Session prompt now accepts an optional output format (`text` or `json_schema`) and can enforce schema-constrained completion via a dedicated `StructuredOutput` tool path.
   - Message and SDK schemas now include structured-output message metadata (`format`, `structured`, `StructuredOutputError`) and prompt API format wiring.
   - Architectural effect: output representation evolves from text-only completion to dual-mode (text/structured) contracts across runtime + SDK boundaries.

9. **Structured output continuity across compaction (`packages/opencode/src/session/prompt.ts`, `packages/opencode/src/session/compaction.ts`)**
   - Auto-compaction paths now propagate the originating user `format` into synthetic continuation user messages and compaction-create requests.
   - When `format=json_schema`, prompt loop now preserves schema-enforcement intent after compaction/re-entry, instead of silently falling back to plain-text-only continuation.
   - Architectural effect: structured-output contract is now continuous across normal turn, compaction turn, and post-compaction resume boundaries.

10. **SDK/OpenAPI generation decoupling + model-shape compatibility (`packages/opencode/src/openapi/generate.ts`, `packages/sdk/js/script/build.ts`, `packages/opencode/src/acp/agent.ts`, `packages/opencode/src/cli/cmd/tui/context/local.tsx`)**

- SDK generation no longer depends on CLI `generate` stdout piping; it now uses a dedicated OpenAPI generator entrypoint that calls `Server.openapi()` directly.
- Consumers that read config model defaults now normalize both legacy string refs and object-shaped model refs (from newer SDK config schema) into `{ providerId, modelID }` before selection logic.
- Architectural effect: SDK build pipeline is isolated from CLI/TUI runtime side effects, and model-selection consumers are resilient across schema evolution boundaries.

11. **MCP surface simplification + dev/binary parity (`packages/opencode/src/config/config.ts`, `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`, `package.json`)**

- Memory MCP config normalization now keeps a single visible `memory` MCP entry instead of auto-expanding additional `memory-project` / `memory-global` MCP server entries.
- Sidebar MCP rows now rely on status dot color for common states and hide redundant `Connected` / `Disabled` text labels.
- `bun run dev` no longer forces `OPENCODE_SKIP_MCP_AUTO=1`, aligning default MCP connect behavior with binary runtime.
- Architectural effect: lower MCP UI/config surface complexity, reduced status noise, and consistent MCP lifecycle semantics across development and binary execution paths.

12. **MCP implementation layout refactor (`packages/mcp/**`, `scripts/\*.ts`, `templates/skills/refactor-from-src/**`)**

- Project-owned MCP server implementations are now centralized under `packages/mcp/` (e.g. `system-manager`, `refacting-merger`).
- Legacy script entrypoints are retained as thin compatibility shims in `scripts/` to avoid breaking existing local commands and configs.
- Developer tooling/docs were updated to point to the new canonical MCP paths.
- Architectural effect: clearer separation between operational scripts and MCP runtime services, improving discoverability and future MCP scalability.

13. **Capability Enablement Layer (new fourth layer for prompt/runtime routing)**

- Added a centralized capability registry at `packages/opencode/src/session/prompt/enablement.json` with template mirror `templates/prompts/enablement.json`.
- Registry now consolidates tool/skill/MCP inventory, routing hints, and on-demand MCP lifecycle policy (enable-on-need / disable-when-idle).
- `SystemPrompt.seedAll()` now seeds `enablement.json` into runtime prompt config space so session/system prompts can reference a single capability map.
- `SYSTEM` rules were updated to treat `prompts/enablement.json` as capability discovery source-of-truth and to demote scattered driver tool hints to non-authoritative heuristics.
- `AGENTS` policy was updated to elevate `mcp-finder` + `skill-finder` as primary expansion skills and require updating `enablement.json` whenever new capabilities are installed.
- `LLM.stream()` now injects an enablement snapshot block into system context so model turns can see current capability classes and intent matches.
- `resolve-tools` now applies on-demand MCP policy from registry routing keywords: auto-connect matching MCP servers before tool resolution and auto-disconnect previously auto-enabled servers after idle timeout.
- Verification baseline policy is now codified via:
  - `scripts/typecheck-with-baseline.ts` + root `check` routing (`lint + verify:typecheck`), which treats `src/plugin/antigravity/**` diagnostics as non-blocking only when the antigravity plugin path is untouched in the current diff.
  - `scripts/test-with-baseline.ts` + root `test` routing, which excludes antigravity auth plugin test scopes from global regression runs.
- Architectural effect: capability discovery is shifted from fragmented prompt fragments to a unified registry + lifecycle model, improving tool discoverability and reducing manual user reminders.

14. **ACP tool-call pending dedupe across replay/live streams (`packages/opencode/src/acp/agent.ts`)**

- ACP now emits synthetic pending (`tool_call`) through a shared deduped path for both replayed message history and live `message.part.updated` tool events.
- Terminal tool states (`completed` / `error`) clear dedupe markers so future calls can start cleanly.
- Architectural effect: ACP tool-call timeline semantics are now stable (single pending start per callID), reducing duplicate state transitions and downstream UI/event confusion.

### Recent Architectural Notes (2026-02-23 Web Alignment Matrix: TUI → Web)

This round completed an incremental Web alignment pass against existing TUI capabilities without a large-scale frontend rewrite.

#### File-to-Function Mapping (Web alignment scope)

| File Path                                                      | Function / Responsibility                                                                                                     | Architectural Impact                                                                                                   |
| :------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `packages/app/src/pages/session/index.tsx`                     | Reconnected `questionRequest` pipeline and prompt blocking logic (`permission` + `question`).                                 | Restores Web parity for ask/reply control flow with shared session event model.                                        |
| `packages/app/src/components/settings-accounts.tsx`            | New Accounts settings panel: list families/accounts and set active account.                                                   | Introduces minimum viable Web account-management surface using existing `/account` API contracts.                      |
| `packages/app/src/components/dialog-settings.tsx`              | Added Accounts tab and `initialTab` deep-link support.                                                                        | Enables cross-surface navigation (e.g., status popover → settings/accounts) with reusable settings container behavior. |
| `packages/app/src/components/status-popover.tsx`               | Added Accounts tab with rotation recommendations + account summary; manage action opens settings accounts tab.                | Upgrades popover to “admin-lite” status surface while keeping mutating actions in Settings.                            |
| `packages/app/src/context/local.tsx`                           | Added `parseConfiguredModel()` to normalize legacy string and object-shaped `config.model`.                                   | Hardens model-selection boundary against SDK schema evolution; removes `.split()` type fragility.                      |
| `packages/app/src/i18n/en.ts`                                  | Added account/status-related i18n keys (`settings.accounts.*`, `status.popover.tab.accounts`, `common.refresh/manage`, etc.). | Establishes localization contract for new Web account/admin-lite UI elements.                                          |
| `docs/events/event_20260223_web_alignment_matrix_execution.md` | Event ledger of scope, decisions, risks, and validation.                                                                      | Preserves architecture decision traceability for future incremental parity work.                                       |

#### Validation State (for this alignment set)

- `bun x tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅
- `bun turbo typecheck --filter=@opencode-ai/app` ✅

### Recent Architectural Notes (2026-02-23 Docker Web Service Rebuild)

This round also repaired `/docker` deployment so the Web service can be brought up reliably while preserving the existing production runtime model.

#### File-to-Function Mapping (Docker web service)

| File Path                              | Function / Responsibility                                                                        | Architectural Impact                                                                                                        |
| :------------------------------------- | :----------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| `docker/docker-compose.production.yml` | Defines `opencode` and `opencode-web` services, runtime mounts, and web profile startup command. | Build context now resolves from repo root, removing path breakage when invoked via `/docker` scripts.                       |
| `docker/Dockerfile.production`         | Production image assembly (binary, frontend assets, synced config/data/state, runtime env).      | Maintains existing `/opt/opencode` runtime contract while clarifying canonical build/run commands.                          |
| `docker/webctl.sh`                     | One-command operational workflow (`deploy/start/stop/build/logs`) for web profile.               | Corrected repo-root path resolution for build artifacts and Docker build context, making helper script runnable end-to-end. |
| `docker/docker-setup.sh`               | Bootstrap utility for host directories, binary build, and image build.                           | Build invocation now points to `docker/Dockerfile.production`, aligning setup path with actual repo layout.                 |
| `docker/sync-config.sh`                | Syncs host XDG config/data/state into repo `config/` for image baking and host volume seeding.   | Preserves existing config migration strategy and avoids drift between host runtime and container runtime.                   |

#### Validation State (Docker rebuild)

- `docker compose -f docker/docker-compose.production.yml --profile web config` ✅
- `bash -n docker/webctl.sh && bash -n docker/docker-setup.sh && bash -n docker/sync-config.sh` ✅

### Recent Architectural Notes (2026-02-23 Web Auth Refactor)

The web authentication path has been refactored from browser HTTP Basic prompt flow to explicit cookie-session auth with CSRF protection.

#### File-to-Function Mapping (Web auth refactor)

| File Path                                       | Function / Responsibility                                                                                                                    | Architectural Impact                                                                                     |
| :---------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/server/web-auth.ts`      | Central web auth primitives: signed stateless session cookie, CSRF token, lockout state, route/public-path helpers.                          | Introduces dedicated auth boundary module instead of ad-hoc middleware checks.                           |
| `packages/opencode/src/server/app.ts`           | Request gate middleware using `WebAuth` (public route allowlist, cookie session verification, CSRF checks for mutations, credentialed CORS). | Replaces transport-level Basic challenge with app-layer session policy and structured 401/403 responses. |
| `packages/opencode/src/server/routes/global.ts` | Adds web auth lifecycle endpoints (`/global/auth/session`, `/global/auth/login`, `/global/auth/logout`).                                     | Establishes explicit browser auth API contract for login/session probing/logout.                         |
| `packages/app/src/context/web-auth.tsx`         | Frontend auth state machine and `authorizedFetch` wrapper (credentials include + CSRF header injection).                                     | Moves auth handling into composable client runtime context, reusable across SDK/event calls.             |
| `packages/app/src/components/auth-gate.tsx`     | Login gate UI for unauthenticated browser sessions.                                                                                          | Removes dependency on browser-native Basic auth popup and enables controlled UX flow.                    |
| `packages/app/src/context/global-sdk.tsx`       | SDK and SSE client now use auth-aware fetch wrapper instead of Basic header injection.                                                       | Aligns API and event transport with cookie/session auth model.                                           |
| `packages/app/src/components/terminal.tsx`      | Removes websocket URL embedded basic credentials.                                                                                            | Unifies PTY auth path with session cookie model.                                                         |
| `packages/app/src/app.tsx`                      | Adds `WebAuthProvider` + `AuthGate` in root composition.                                                                                     | Makes auth gating a first-class app bootstrap stage before router runtime.                               |

### Recent Architectural Notes (2026-02-23 Web Architecture-First Stabilization Plan)

After the auth refactor and initial admin-lite work, Web runtime behavior still diverges from TUI in three critical areas: workspace boundary handling, PTY lifecycle robustness, and `/admin` parity depth. The project now adopts an **architecture-first** stabilization sequence before additional UI feature expansion.

#### Core boundary model (Web)

1. **Auth boundary (`WebAuth`)**
   - Browser requests use cookie-session + CSRF; CLI/TUI compatibility path keeps Basic auth available.
   - Decision: keep dual-mode auth contract, but treat Web cookie path as primary for browser surfaces.

2. **Instance boundary (`Instance.directory`)**
   - File/tool routes enforce project-root confinement (`Access denied: path escapes project directory`).
   - Decision: keep confinement semantics, but add explicit UX/diagnostic handling for cross-directory expectations instead of implicit failures.

3. **PTY boundary (`/pty` create + connect)**
   - PTY websocket connect depends on an existing PTY id; stale ids produce `Session not found`.
   - Decision: enforce explicit create→connect sequencing and add recovery path for stale local PTY state.

4. **Admin parity boundary (TUI `/admin` vs Web)**
   - Web currently provides account/status admin-lite and settings-based account activation.
   - TUI `/admin` still owns richer provider/account/model activity, rate-limit/quota visibility, and rotation-aware model/account workflows.
   - Decision: port by capability slices (read-first, then mutate actions), not by one-shot screen cloning.

#### TUI → Web parity slices (incremental)

| Slice                                  | TUI status | Web status                    | Planned landing                          |
| :------------------------------------- | :--------- | :---------------------------- | :--------------------------------------- |
| Account list + set active              | Complete   | Complete (settings + popover) | keep + polish                            |
| Rotation recommendations               | Complete   | Read-only in popover          | add richer reason/context                |
| Provider enable/disable + add flow     | Complete   | Partial                       | Web admin section (phase 2)              |
| Model activity + cooldown/quota matrix | Complete   | Missing                       | Web admin section (phase 3)              |
| Rate-limit guided recovery UX          | Complete   | Missing                       | model switcher + session hints (phase 3) |

Reference event ledger:

- `docs/events/event_20260223_web_architecture_first_plan.md`

---

## Detailed Package Analysis

This section provides a deep dive into the specific file structures and responsibilities of the core packages.

### 1. Core Agent (`packages/opencode`)

This package contains the core application logic, including the CLI, the Agent runtime, the Session manager, and the API server.

#### A. Core & CLI (`src/index.ts`, `src/cli`)

| File Path                | Description                                                                                             | Key Exports      | Input / Output                                                   |
| :----------------------- | :------------------------------------------------------------------------------------------------------ | :--------------- | :--------------------------------------------------------------- |
| `src/index.ts`           | **CLI Entry Point.** Configures `yargs`, sets up global error handling, and registers all CLI commands. | _None_           | **Input:** CLI args<br>**Output:** Command execution             |
| `src/cli/bootstrap.ts`   | **Initialization Utility.** Wraps command execution to initialize the project context/directory.        | `bootstrap`      | **Input:** Directory, Callback<br>**Output:** Promise result     |
| `src/cli/cmd/run.ts`     | **Run Command.** Primary interface for running agents. Handles interactive sessions and loops.          | `RunCommand`     | **Input:** Message, files, model<br>**Output:** Streaming output |
| `src/cli/cmd/serve.ts`   | **Serve Command.** Starts the OpenCode server in headless mode for remote connections or MCP.           | `ServeCommand`   | **Input:** Port, Host<br>**Output:** HTTP Server                 |
| `src/cli/cmd/agent.ts`   | **Agent Management.** Subcommands to create/list agents.                                                | `AgentCommand`   | **Input:** Name, Tools<br>**Output:** Agent Config               |
| `src/cli/cmd/session.ts` | **Session Management.** Manages chat sessions (list, step, worker).                                     | `SessionCommand` | **Input:** Session ID<br>**Output:** Session Logs                |
| `src/cli/cmd/auth.ts`    | **Authentication.** Manages provider credentials (login, logout, list).                                 | `AuthCommand`    | **Input:** Provider, Keys<br>**Output:** Stored Creds            |
| `src/cli/cmd/admin.ts`   | **Admin Interface.** Launches the Terminal User Interface (TUI).                                        | `AdminCommand`   | **Input:** URL<br>**Output:** TUI Render                         |
| `src/cli/ui.ts`          | **UI Utilities.** Standardized terminal output, colors, styles, and user prompts.                       | `UI`             | **Input:** Text<br>**Output:** Formatted Stdout                  |

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

| File Path                       | Description                                                       | Key Exports        | Input / Output                                |
| :------------------------------ | :---------------------------------------------------------------- | :----------------- | :-------------------------------------------- |
| `src/server/server.ts`          | **Server Entry.** Configures Hono app and HTTP listener.          | `Server`, `listen` | **In:** Config<br>**Out:** Running Server     |
| `src/server/routes/session.ts`  | **Session Routes.** API for chat session management.              | `SessionRoutes`    | **In:** HTTP Req<br>**Out:** JSON/Stream      |
| `src/server/routes/file.ts`     | **File Routes.** API for file reading, searching, and git status. | `FileRoutes`       | **In:** Path/Pattern<br>**Out:** Content/List |
| `src/server/routes/project.ts`  | **Project Routes.** API for project metadata.                     | `ProjectRoutes`    | **In:** ID<br>**Out:** Project Info           |
| `src/server/routes/provider.ts` | **Provider Routes.** API for models and auth flows.               | `ProviderRoutes`   | **In:** ID<br>**Out:** Models/Auth            |
| `src/server/routes/global.ts`   | **Global Routes.** System health and SSE stream.                  | `GlobalRoutes`     | **In:** N/A<br>**Out:** Health/Events         |
| `src/server/routes/account.ts`  | **Account Routes.** API for multi-account management.             | `AccountRoutes`    | **In:** ID<br>**Out:** Status                 |

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

| File Path                         | Description                                                             | Key Exports      | Input / Output                        |
| :-------------------------------- | :---------------------------------------------------------------------- | :--------------- | :------------------------------------ |
| `src/account/rotation3d.ts`       | **Rotation 3D.** Logic for fallback selection (Provider/Account/Model). | `findFallback`   | **In:** Vector<br>**Out:** Candidate  |
| `src/account/rate-limit-judge.ts` | **Rate Limit Judge.** Central authority for rate limit detection.       | `RateLimitJudge` | **In:** Error<br>**Out:** Backoff     |
| `src/project/project.ts`          | **Project Manager.** Manages project metadata.                          | `Project`        | **In:** Path<br>**Out:** Info         |
| `src/project/vcs.ts`              | **VCS Tracker.** Tracks current git branch.                             | `Vcs`            | **In:** Events<br>**Out:** Branch     |
| `src/file/index.ts`               | **File Ops.** Core file reading/listing/searching.                      | `File`           | **In:** Path<br>**Out:** Node/Content |
| `src/util/git.ts`                 | **Git Wrapper.** Low-level git command execution.                       | `git`            | **In:** Args<br>**Out:** Result       |

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

| File Path                | Description                                                                                                                        | Key Exports                         | Input/Output                                              |
| :----------------------- | :--------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------- | :-------------------------------------------------------- |
| `entry.tsx`              | **Entry Point**. Bootstraps the application, detects the platform (Web/Desktop), and initializes the root `PlatformProvider`.      | `(Execution Only)`                  | **In**: DOM Element<br>**Out**: Rendered App              |
| `app.tsx`                | **App Root**. Sets up global providers (`AppBaseProviders`), themes, and the main `Router`.                                        | `AppInterface`, `AppBaseProviders`  | **In**: Server URL (optional)<br>**Out**: Routing Context |
| `pages/session.tsx`      | **Session View**. The core chat/coding interface. Manages the message timeline, terminal, file reviews, and drag-and-drop layouts. | `Page` (Default Export)             | **In**: URL Params (ID)<br>**Out**: Chat Interface        |
| `context/server.tsx`     | **Server Connection**. Manages the connection URL to the backend, health checks, and the list of available projects.               | `useServer`, `ServerProvider`       | **In**: Default URL<br>**Out**: Connection Status         |
| `context/global-sdk.tsx` | **SDK & Events**. Initializes the OpenCode SDK client and establishes the global Server-Sent Events (SSE) stream.                  | `useGlobalSDK`, `GlobalSDKProvider` | **In**: Auth Token<br>**Out**: SDK Client, Event Emitter  |

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

### 9. Antigravity Plugin (`packages/opencode/src/plugin/antigravity`)

The Antigravity plugin is a high-performance identity spoofing and reasoning enhancement layer. It transforms standard Google AI API calls into internal Cloud Code Assist requests, enabling advanced features like multi-tier thinking and global account rotation.

#### Directory Structure

```text
packages/opencode/src/plugin/antigravity/
├── index.ts                # Main plugin registration and request orchestration
├── constants.ts            # API endpoints, tokens, and model instructions
├── shims.d.ts              # Type shims for external dependencies
└── plugin/
    ├── accounts.ts         # Multi-account pool and sticky rotation logic
    ├── auth.ts             # OAuth credential validation and refresh
    ├── debug.ts            # Detailed logging for troubleshooting
    ├── errors.ts           # Custom error types (e.g., RefreshError)
    ├── fingerprint.ts      # Device identity randomization
    ├── image-saver.ts      # Logic for handling image generation output
    ├── logger.ts           # Internal plugin logger
    ├── project.ts          # Google Cloud project discovery and context
    ├── quota.ts            # Quota fetching and classification (cockpit integration)
    ├── quota-group.ts      # Model-to-quota-group mapping
    ├── request.ts          # API request construction and payload transformation
    ├── request-helpers.ts  # Utilities for body parsing and thinking blocks
    ├── server.ts           # Local callback server for OAuth flows
    ├── storage.ts          # Persistence of account metadata
    ├── token.ts            # Access token lifecycle management
    ├── thinking-recovery.ts # Logic for recovering interrupted thinking turns
    ├── cache/
    │   ├── index.ts        # Cache system entry point
    │   └── signature-cache.ts # Disk-persistent thought signature storage
    ├── stores/
    │   └── signature-store.ts # In-memory store for active session signatures
    └── transform/
        ├── index.ts        # Transformation module index
        ├── claude.ts       # Claude-specific request/response transforms
        ├── gemini.ts       # Gemini-specific request/response transforms
        ├── model-resolver.ts # Tier-aware model mapping and quota routing
        ├── types.ts        # Shared transformation types
        └── cross-model-sanitizer.ts # Sanitization for inter-model compatibility
```

#### A. Core & Registration

| File Path      | Description                                                                                             | Key Exports              |
| :------------- | :------------------------------------------------------------------------------------------------------ | :----------------------- |
| `index.ts`     | **Main Plugin Entry.** Orchestrates OAuth flows, model routing, and the high-level request/retry loop.  | `AntigravityOAuthPlugin` |
| `constants.ts` | **System Constants.** Defines API endpoints, OAuth credentials, and model-specific system instructions. | `ANTIGRAVITY_ENDPOINT`   |

#### B. Component Architecture (`plugin/`)

| Folder / File          | Description                                                                                                                          | Key Functions / Classes        |
| :--------------------- | :----------------------------------------------------------------------------------------------------------------------------------- | :----------------------------- |
| `accounts.ts`          | **Account Management.** Implements a sticky-rotation account pool synced with the global `Account` module.                           | `AccountManager`               |
| `request.ts`           | **Request Orchestration.** High-level builder for transforming payloads, injecting signatures, and handling streaming.               | `prepareAntigravityRequest`    |
| `request-helpers.ts`   | **Payload Utilities.** Low-level tools for body parsing, thinking block extraction, and tool-call alignment.                         | `transformAntigravityResponse` |
| `quota.ts`             | **Quota Integration.** Communicates with the Antigravity "cockpit" to fetch real-time usage and model availability.                  | `checkAccountsQuota`           |
| `transform/`           | **Model Transforms.** Specialized logic for mapping Claude and Gemini models to their internal API equivalents.                      | `applyClaudeTransforms`        |
| `cache/`               | **Signature Caching.** Disk-persistent storage for "Thought Signatures", ensuring conversation continuity across turns and restarts. | `SignatureCache`               |
| `fingerprint.ts`       | **Anti-Bot Mitigation.** Generates randomized device identities (User-Agents, IDs) to distribute traffic and avoid rate limits.      | `generateFingerprint`          |
| `thinking-recovery.ts` | **Error Recovery.** Heuristics for detecting and recovering from interrupted reasoning turns or tool-call errors.                    | `needsThinkingRecovery`        |

---

## 10. Dependency Graph (Simplified)

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

---

## 9. Documentation & Specifications (`docs/`)

Contains technical specifications, architecture overviews, and historical records.

| Folder / File | Description |
| :--- | :--- |
| `docs/specs/` | **Technical Standards.** Active architecture specifications for the `cms` branch, including system prompts, hooks, and UI design patterns. |
| `docs/events/` | **Chronological Knowledge Base.** Unified event logs, RCA reports, and historical project milestones named `event_log_YYYYMMDD_topic.md`. |

---

## 10. Organizational Folders

In addition to the standard `packages/` directory, these top-level folders serve specific purposes:

| Folder | Purpose |
| :--- | :--- |
| `scripts/` | **Automation & DevOps.** Scripts for installation (`scripts/install/`), deployment, and daily operations. |
| `scripts/tools/` | **Legacy Tools.** System-level utilities, Nginx fixes, and port-forwarding scripts. |
| `scripts/debug/` | **Development Utilities.** Temporary scripts for testing filters, redirection, and model analysis. |
| `patches/` | **Package Fixes.** Custom patches applied to third-party dependencies via Bun's `patchedDependencies`. |
| `refs/` | **External References.** Upstream repositories or integration prototypes kept for cross-referencing. |
| `infra/` | **Infrastructure Definitions.** SST configurations for Cloudflare/AWS resources. |
| `docker/` | **Docker Deployment.** Dockerfiles, compose files, and control scripts (`webctl.sh`). |
| `github/` | **GitHub Integration.** Definitions for OpenCode GitHub Action (`action.yml`). |
| `templates/` | **Scaffolding.** Reusable templates for agents, tools, and project structures. |
| `recyclebin/` | **Temporary Archive.** Deprecated files pending final deletion. |

---

## 11. Root Directory Structure

The root directory is kept minimal, containing only essential configuration and orchestration files.

| File | Description |
| :--- | :--- |
| `.env` | **Runtime Secrets.** Local environment variables for API keys and database URLs. |
| `package.json` | **Monorepo Manifest.** Defines project dependencies, workspace structure, and core scripts. |
| `bun.lock` | **Lockfile.** Ensures consistent dependency versions across environments. |
| `turbo.json` | **TurboRepo Config.** Orchestrates build, lint, and test tasks across the monorepo. |
| `sst.config.ts` | **SST Entry.** Main entry point for serverless infrastructure deployment. |
| `flake.nix` | **Nix Shell.** Defines a reproducible development environment with all required system tools. |
| `tsconfig.json` | **TypeScript Config.** Global compiler options and path aliases. |
| `README.md` | **Documentation Entry.** The primary project overview and quickstart guide. |
| `LICENSE` | **License Information.** MIT License terms for the project. |

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
2. `Space` and `Delete` in provider root perform the same enable/disable toggle.
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

### G. Antigravity Disable Resource Contract

1. `antigravity` and `antigravity-legacy` are controlled by `disabled_providers`.
2. When either provider family is disabled, the Antigravity auth plugins must not be initialized.
3. Internal plugin loading must use conditional dynamic import for Antigravity modules so disabled state avoids plugin module initialization work.

**Primary file**
- `packages/opencode/src/plugin/index.ts`

---

## 13. Session Change Summary (2026-02-20)

This session finalized the provider visibility/toggle architecture and fixed multiple regressions in `/admin`.

### A. Provider Toggle Behavior

1. Unified semantics:
   - `disable == hide`
   - `enable == show`
2. `Show All` is full list (no visibility filter).
3. `Filtered` mode only shows enabled providers.
4. Root-level provider toggle uses `Space` as primary action; root `Delete` path is disabled/hidden.

**Primary file**
- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`

### B. UX/State Consistency Fixes

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
```

---

## 14. External Dependency Inventory (2026-02-21)

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

## 18. Web Auth Credential Management Baseline (2026-02-23)

This section defines the credential-management baseline for self-hosted Web deployments.

### A. Security Policy

1. Prefer hashed credential file (`htpasswd`-style `username:hash`) over plaintext env password.
2. Preserve backward compatibility with legacy `OPENCODE_SERVER_USERNAME/OPENCODE_SERVER_PASSWORD` only as fallback.
3. Browser auth flow uses session cookie + CSRF protection; no URL-embedded basic credentials.

### B. Runtime credential sources (priority)

1. `OPENCODE_SERVER_HTPASSWD` (or `OPENCODE_SERVER_PASSWORD_FILE`) if file exists.
2. Fallback: `OPENCODE_SERVER_USERNAME + OPENCODE_SERVER_PASSWORD`.

### C. File-to-function mapping

| File Path                                              | Function / Responsibility                                                                      | Architectural Impact                                                                  |
| :----------------------------------------------------- | :--------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------ |
| `packages/opencode/src/server/web-auth-credentials.ts` | Loads/caches htpasswd-style credential file and verifies hash with `Bun.password.verify()`.    | Decouples credential storage from env plaintext and allows hash-based auth lifecycle. |
| `packages/opencode/src/server/web-auth.ts`             | Web auth policy layer (session cookie signing, CSRF enforcement helpers, lockout integration). | Central auth gate contract consumed by server middleware and auth routes.             |
| `packages/opencode/src/server/routes/global.ts`        | Auth endpoints for session probe/login/logout; returns `usernameHint` for login UX.            | Provides explicit auth API contract for browser clients.                              |
| `packages/opencode/src/flag/flag.ts`                   | Defines new auth-file flags (`OPENCODE_SERVER_HTPASSWD`, `OPENCODE_SERVER_PASSWORD_FILE`).     | Standardizes configuration surface for secure credential-file deployments.            |
| `packages/app/src/context/web-auth.tsx`                | Frontend auth state manager, cookie-based authorized fetch, CSRF header injection.             | Aligns browser transport security with server-side CSRF/session model.                |
| `packages/app/src/components/auth-gate.tsx`            | Login gate UI using `usernameHint` and explicit sign-in flow.                                  | Replaces browser-native Basic auth popup with controllable app UX.                    |
| `packages/app/src/components/terminal.tsx`             | Removes websocket URL basic credentials.                                                       | Prevents credential exposure in URL/user-info surface.                                |
| `docker/docker-compose.production.yml`                 | Exposes `OPENCODE_SERVER_HTPASSWD` default path `/opt/opencode/config/opencode/.htpasswd`.     | Makes secure-by-default self-host setup practical for home installations.             |

### D. Operational baseline for Docker self-host

1. Credential file location: `/opt/opencode/config/opencode/.htpasswd`
2. File format: one credential per line (`username:<argon2/bcrypt hash>`)
3. Do not ship default plaintext password values in compose defaults.
