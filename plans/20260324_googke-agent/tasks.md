# Tasks

## 1. Define App Market Core

- [x] 1.1 Map built-in MCP app registry domain model and install state machine
- [x] 1.2 Define app catalog authority, persistence shape, and runtime ownership boundaries
- [x] 1.3 Define Web/TUI app management entrypoints and observability states

## 2. Define Google Calendar Managed App

- [x] 2.1 Map Google Calendar app auth/config/tool contract against canonical account/auth surfaces
- [x] 2.2 Define Google Calendar capability surface for LLM-driven calendar operations
- [x] 2.3 Define fail-fast error states for unauthenticated, misconfigured, and runtime-error app usage

## 3. Plan MVP Execution Path

- [x] 3.1 Slice the first build milestone for app market shell + Google Calendar MVP
- [x] 3.2 Define validation commands and operator-visible acceptance checks
- [x] 3.3 Define documentation sync requirements for architecture and event logs

## 4. Diagram And Handoff Sync

- [x] 4.1 Produce IDEF0/GRAFCET/C4/Sequence artifacts aligned with the plan
- [x] 4.2 Finalize build handoff with stop gates and execution entry recommendation

## 5. Implementation — App Market Registry + Google Calendar MVP

- [x] 5.1 Implement ManagedAppRegistry domain model, state machine, persistence, and bus events (`mcp/app-registry.ts`)
- [x] 5.2 Implement managed app REST API endpoints (`server/routes/mcp.ts`)
- [x] 5.3 Integrate managed app tools into MCP tool surface with cache invalidation (`mcp/index.ts`)
- [x] 5.4 Implement Google Calendar REST API client (`mcp/apps/google-calendar/client.ts`)
- [x] 5.5 Implement Google Calendar tool executors with canonical auth resolution (`mcp/apps/google-calendar/index.ts`)
- [x] 5.6 Register `google-calendar` as known provider in account system
- [x] 5.7 Fix implicit any type error in app-registry.ts
- [x] 5.8 Write registry schema + lifecycle + app structure tests (17 pass, 0 fail)
- [x] 5.9 Verify type-check passes for all new files (0 new tsc errors)
- [x] 5.10 Create event log and documentation sync
- [x] 5.11 Web app market UI: sidebar entry (`app-market` icon) + Synology-style dialog with card grid, search, install/enable/disable/uninstall actions
