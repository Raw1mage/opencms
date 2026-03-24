# Tasks

## 1. Core Implementation

- [x] 1.1 Review + finalize Gmail REST API client (`gmail/client.ts`) — 已有草稿，需確認 interfaces, API methods, helpers, error handling
- [x] 1.2 Review + finalize Gmail tool executors (`gmail/index.ts`) — 已有草稿，需確認 10 tools, formatters, fail-fast

## 2. Registry & Routing

- [x] 2.1 Add `gmail` entry to BUILTIN_CATALOG in `app-registry.ts` — capabilities, auth contract, tool descriptors, config contract
- [x] 2.2 Add gmail executor to `managedAppExecutors` in `mcp/index.ts` — import GmailApp + routing entry

## 3. OAuth Generalization

- [x] 3.1 Generalize OAuth connect route in `mcp.ts` — Google OAuth app whitelist, scope merger from installed apps, dynamic redirect URI
- [x] 3.2 Generalize OAuth callback route in `mcp.ts` — multi-app setConfigKeys + enable, dynamic success HTML

## 4. Environment

- [x] 4.1 Add `GOOGLE_GMAIL_SCOPE` to `.env` and `.env.example`

## 5. Validation

- [x] 5.1 Build verification — no new type errors (pre-existing line 209 only)
- [~] 5.2 GCP Console manual steps — documented in event log, requires user manual action

## 6. Documentation

- [x] 6.1 Create event log `docs/events/event_20260325_gmail-mcp.md`
- [x] 6.2 Architecture sync — added Managed App Registry section to `specs/architecture.md`
