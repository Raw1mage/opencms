# Tasks

## Phase 0: Graduation Gate

- [x] T0.1 — Graduate to /specs/ after review

## Phase 1: Source Extraction

- [x] T1.1 — Extract `@anthropic-ai/claude-code-linux-x64@2.1.144` npm package
- [x] T1.2 — Locate and isolate `cli.js` minified bundle (14MB, 19641 lines)
- [x] T1.3 — Identify build metadata (VERSION, SHA, build timestamp)
- [x] T1.4 — Set up refs/claude-code-npm/ as local reference material

## Phase 2: Core Protocol Analysis

- [x] T2.1 — Extract core constants (VERSION, API_VERSION, CLIENT_ID, timeouts)
- [x] T2.2 — Map authentication endpoints and OAuth flow (authorize, token, profile, roles)
- [x] T2.3 — Extract OAuth scope list and compare against 2.1.126
- [x] T2.4 — Document all request headers (always-present + conditional)
- [x] T2.5 — Extract billing header format and `cch` hardcoding change
- [x] T2.6 — Map `anthropic-client-platform` header values (new in 2.1.144)
- [x] T2.7 — Document User-Agent variants and prefix change (`claude-code/` to `claude-cli/`)

## Phase 3: Beta Flags & Feature Surface

- [x] T3.1 — Locate U31 beta flag array in minified source
- [x] T3.2 — Extract all 24 active beta flags with internal names and header values
- [x] T3.3 — Identify 2 null/reserved slots filtered from the array
- [x] T3.4 — Document API-specific betas not in U31 (compact, skills, triggers, etc.)
- [x] T3.5 — Classify each flag as Same/NEW relative to 2.1.126

## Phase 4: Retry Architecture

- [x] T4.1 — Map Layer 1 (SDK) retry constants: maxRetries=2, timeout=600000
- [x] T4.2 — Extract SDK backoff formula (base 0.5s, cap 8s, jitter 0.75-1.0)
- [x] T4.3 — Document SDK shouldRetry decision logic (401/408/409/429/5xx)
- [x] T4.4 — Map Layer 2 (App/CD8) retry constants (13 named constants)
- [x] T4.5 — Extract app-level backoff function `rt()` with formula
- [x] T4.6 — Document full retry decision flow (12-step cascade)
- [x] T4.7 — Document watchdog mode (unlimited retries, 5min cap, 30s yield)
- [x] T4.8 — Extract unified rate limit header registry

## Phase 5: Transport & Payload

- [x] T5.1 — Document SSE event types including new `compaction_delta` and `signature_delta`
- [x] T5.2 — Extract request body structure and max_tokens defaults per model
- [x] T5.3 — Document model ID normalization (`[1m]`/`[2m]` suffix stripping)
- [x] T5.4 — Map tool system (MCP prefix format, built-in tool names)
- [x] T5.5 — Document cache control (ephemeral breakpoints, TTL, scope)
- [x] T5.6 — Document context management and server-side compaction

## Phase 6: Model Routing & Providers

- [x] T6.1 — Extract provider route table (firstParty, bedrock, vertex, foundry, etc.)
- [x] T6.2 — Document model family registry (haiku35 through opus47)
- [x] T6.3 — Map `?beta=true` endpoint list

## Phase 7: Delta Analysis & Datasheet Assembly

- [x] T7.1 — Enumerate all major changes from 2.1.126 (10+ items)
- [x] T7.2 — Confirm unchanged items (API version, client ID, retry constants, etc.)
- [x] T7.3 — Assemble protocol-datasheets.md with all 12 sections (SS1-SS12)
- [x] T7.4 — Cross-reference datasheet against spec.md requirements R1/R2/R3

## Phase 8: Diagrams & Schemas

- [x] T8.1 — Create IDEF0 diagram modeling retry pipeline as decomposed activities
- [x] T8.2 — Create GRAFCET diagram modeling retry state machine
- [x] T8.3 — Create sequence diagram for 429 handling through both retry layers
- [x] T8.4 — Create data-schema.json for key data structures
