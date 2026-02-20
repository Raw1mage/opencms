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
