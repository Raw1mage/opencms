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

| File Path                  | Description                                                        | Key Exports      | Input / Output                      |
| :------------------------- | :----------------------------------------------------------------- | :--------------- | :---------------------------------- |
| `src/provider/provider.ts` | **Provider Core.** Initializes providers and manages capabilities. | `Provider`       | **In:** Config<br>**Out:** Registry |
| `src/provider/models.ts`   | **Model DB.** Manages model definitions from `models.dev`.         | `ModelsDev`      | **In:** N/A<br>**Out:** Model Data  |
| `src/provider/health.ts`   | **Health Check.** Monitors model availability and latency.         | `ProviderHealth` | **In:** Options<br>**Out:** Report  |
| `src/plugin/index.ts`      | **Plugin System.** Loads plugins and manages lifecycle hooks.      | `Plugin`         | **In:** Config<br>**Out:** Plugins  |
| `src/mcp/index.ts`         | **MCP Client.** Manages Model Context Protocol connections.        | `MCP`            | **In:** Config<br>**Out:** Clients  |

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

## Dependency Graph (Simplified)

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
