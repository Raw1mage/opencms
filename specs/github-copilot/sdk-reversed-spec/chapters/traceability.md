# Traceability Matrix & Evidence

## Source Inventory

| Module | Primary Source Files | Language | LOC (approx) |
|---|---|---|---|
| CopilotClient | `nodejs/src/client.ts` | TypeScript | 2,175 |
| CopilotSession | `nodejs/src/session.ts` | TypeScript | 1,155 |
| Types / API Surface | `nodejs/src/types.ts` | TypeScript | 1,936 |
| Generated RPC | `nodejs/src/generated/rpc.ts` | TypeScript | ~5,000 |
| Session Events | `nodejs/src/generated/session-events.ts` | TypeScript | ~800 |
| SessionFsProvider | `nodejs/src/sessionFsProvider.ts` | TypeScript | 160 |
| Extension (child) | `nodejs/src/extension.ts` | TypeScript | 45 |
| Telemetry | `nodejs/src/telemetry.ts` | TypeScript | ~100 |
| Docs (auth) | `docs/auth/*.md` | Markdown | ~1,500 |
| Docs (features) | `docs/features/*.md` | Markdown | ~3,000 |
| Docs (hooks) | `docs/hooks/*.md` | Markdown | ~1,200 |
| Rust SDK | `rust/src/*.rs` | Rust | ~2,000 |

## Boundary Map

```
┌──────────────────────────────────────────────────────────────────┐
│ User Application                                                  │
│ (imports CopilotClient, CopilotSession, defineTool)              │
├──────────────────────────────────────────────────────────────────┤
│ SDK Public Boundary (nodejs/src/index.ts exports)                │
│ - CopilotClient class                                            │
│ - CopilotSession class                                           │
│ - defineTool helper                                               │
│ - approveAll helper                                               │
│ - createSessionFsAdapter                                          │
│ - 90+ type exports                                                │
├──────────────────────────────────────────────────────────────────┤
│ Transport Boundary (JSON-RPC 2.0)                                │
│ - Stdio (pipes to child process)                                  │
│ - TCP (socket to external server)                                 │
│ - Content-Length framing (vscode-jsonrpc)                         │
├──────────────────────────────────────────────────────────────────┤
│ CLI Server Boundary (closed-source @github/copilot binary)       │
│ - LLM API routing (GPT, Claude, Gemini)                          │
│ - Built-in tool execution (grep, glob, edit, bash)               │
│ - OAuth token → Copilot API token exchange                       │
│ - Context compaction / session persistence                        │
│ - MCP server management                                           │
├──────────────────────────────────────────────────────────────────┤
│ External Services                                                 │
│ - GitHub OAuth (github.com/login/device/code)                    │
│ - Copilot API (api.githubcopilot.com)                            │
│ - LLM providers (OpenAI, Anthropic, Google)                      │
│ - MCP servers (stdio/HTTP)                                        │
│ - Mission Control (GitHub remote sessions)                        │
└──────────────────────────────────────────────────────────────────┘
```

## IDEF0 → Evidence Trace

| IDEF0 | Activity | Evidence File | Evidence Line/Section |
|---|---|---|---|
| 01-A1 | Resolve CLI Binary Path | `nodejs/src/client.ts` | require.resolve('@github/copilot') |
| 01-A2 | Spawn CLI Server Process | `nodejs/src/client.ts` | spawn() with stdio/TCP |
| 01-A3 | Establish JSON-RPC Connection | `nodejs/src/client.ts` | createMessageConnection() |
| 01-A4 | Negotiate Protocol Version | `nodejs/src/client.ts` | connect() RPC, MIN_PROTOCOL_VERSION=2 |
| 01-A5 | Register Client-Side RPC Handlers | `nodejs/src/client.ts` | registerClientSessionApiHandlers() |
| 01-A6 | Monitor Connection Health | `nodejs/src/client.ts` | connectionState property |
| 01-A7 | Terminate Connection | `nodejs/src/client.ts` | stop() method |
| 02-A1 | Create Session Instance | `nodejs/src/client.ts` | createSession(config) |
| 02-A2 | Send User Prompt | `nodejs/src/session.ts` | send() / sendAndWait() |
| 02-A3 | Process Agent Loop Turns | `docs/features/` | turn_start/turn_end events |
| 02-A4 | Handle Session Idle | `nodejs/src/session.ts` | session.idle event handler |
| 02-A5 | Compact Session History | `docs/features/` | 80%/95% thresholds |
| 02-A6 | Resume Existing Session | `nodejs/src/client.ts` | resumeSession(id) |
| 02-A7 | Disconnect Session | `nodejs/src/session.ts` | disconnect() |
| 03-A1 | Receive Tool Call Request | `nodejs/src/session.ts` | tool-call RPC handler |
| 03-A2 | Invoke Pre-Tool-Use Hook | `docs/hooks/` | onPreToolUse |
| 03-A3 | Gate Through Permission Handler | `nodejs/src/types.ts` | PermissionHandler type |
| 03-A4 | Resolve Tool Handler | `nodejs/src/session.ts` | toolHandlers Map |
| 03-A5 | Execute Tool Handler | `nodejs/src/session.ts` | handler invocation |
| 03-A6 | Invoke Post-Tool-Use Hook | `docs/hooks/` | onPostToolUse |
| 03-A7 | Return Tool Result to CLI | `nodejs/src/types.ts` | ToolResultObject |
| 04-A1 | Detect Credential Source | `docs/auth/authenticate.md` | Priority chain |
| 04-A2 | Pass Token via Connect Handshake | `nodejs/src/client.ts` | connect() params |
| 04-A3 | Configure BYOK Provider | `docs/auth/byok.md` | ProviderConfig |
| 04-A4 | Exchange Token for Copilot API Access | CLI-internal (closed) | N/A — inferred from behavior |
| 04-A5 | Handle Token Expiry Mid-Session | `docs/auth/authenticate.md` | "auto-refreshes" note |
| 04-A6 | Validate Subscription Entitlement | CLI-internal (closed) | N/A — inferred from errors |
| 05-A1 | Receive Raw Event Notification | `nodejs/src/generated/session-events.ts` | SessionEvent type |
| 05-A2 | Classify Event by Type | `nodejs/src/session.ts` | type discriminator |
| 05-A3 | Accumulate Delta Content | `nodejs/src/session.ts` | delta buffer logic |
| 05-A4 | Dispatch to Typed Handlers | `nodejs/src/session.ts` | typedEventHandlers Map |
| 05-A5 | Dispatch to Wildcard Handlers | `nodejs/src/session.ts` | eventHandlers Set |
| 05-A6 | Emit Session Lifecycle Signals | `nodejs/src/session.ts` | promise resolution |

## GRAFCET → IDEF0 Cross-Reference

| GRAFCET | Step | ModuleRef | IDEF0 Activity |
|---|---|---|---|
| 01 | 0-8 | A1-A7 | Connection lifecycle (all 7 activities) |
| 02 | 0-8 | A1-A7 | Session lifecycle (all 7 activities) |
| 03 | 0-7 | A1-A7 | Tool execution (all 7 activities) |
| 04 | 0-7 | A1-A6 | Auth flow (6 activities) |
| 05 | 0-5 | A1-A6 | Event streaming (6 activities) |

## Confidence Notes

| Area | Confidence | Rationale |
|---|---|---|
| SDK Public API | HIGH | Full TypeScript source available, types well-documented |
| JSON-RPC Protocol | HIGH | Generated RPC stubs visible; method names exhaustive |
| Event System | HIGH | session-events.ts has discriminated unions for all 40+ types |
| Auth Priority Order | HIGH | Explicitly documented in docs/auth/authenticate.md |
| Token Exchange (internal) | LOW | CLI-internal; inferred from behavior + docs hints |
| Compaction Thresholds | MEDIUM | Documented in features/ but exact implementation is CLI-internal |
| Model Routing | LOW | CLI-internal; SDK only passes model name, CLI decides endpoint |
| Permission Persistence | MEDIUM | approve-always semantics visible in types but storage unclear |
| Remote Sessions | MEDIUM | API surface visible but Mission Control server is closed |

## Open Questions

1. **Copilot API internal token endpoint** — What is the exact URL where CLI exchanges a GitHub OAuth token for a short-lived Copilot API bearer token? (CLI-internal, not exposed to SDK)

2. **Token TTL and refresh cadence** — How long does the Copilot API token live? How far in advance does CLI refresh? (Docs say "automatic" but no specifics)

3. **Rate limit headers** — Does the Copilot API return standard rate-limit headers (`X-RateLimit-*`)? OpenCMS's plugin/copilot.ts doesn't parse any — is there a separate rate-limit mechanism?

4. **Model routing inside CLI** — When a BYOK provider is NOT configured, how does CLI decide which upstream LLM endpoint to call? Is there a model→endpoint mapping table inside the binary?

5. **Session persistence format** — What is the exact file format of `checkpoints/` directory? Is it plain JSON, JSONL, or binary?

6. **Mission Control protocol** — What protocol does `session.remote.enable()` use to export events to GitHub? Is it WebSocket, SSE, or HTTP polling?

7. **Compaction algorithm** — What compression technique does CLI use for history compaction? Summarization via LLM? Truncation? Sliding window?

8. **Protocol v3 breaking changes** — What specifically changed between v2 and v3? (MIN_PROTOCOL_VERSION is 2, implying v2 is still compatible)

9. **HMAC auth path** — The `HMAC_KEY` / `COPILOT_HMAC_KEY` env vars are mentioned in auth priority but not documented anywhere — what is this for? (Possibly enterprise deployment pattern)

10. **Fleet sessions** — `session.fleet.start(params)` exists in RPC but has no documentation. What is its purpose? Parallel agent execution?
