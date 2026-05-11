---
date: 2026-05-11
summary: "Chapter 01 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions"
---

# Chapter 01 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions

## Audit result: PASS

- **Submodule SHA pinned**: `76845d716b720ca701b2c91fec75431532e66c74` (rust-v0.0.2504301132-6092-g76845d716b).
- **Claims**: 12 (C1–C12).
- **Anchors**: 12, one per claim.
- **TEST/TYPE diversity** (gate requires ≥1): **2 TYPE + 1 TEST** — `ModelClientState` struct (C6), `AppServerArgs` struct (C11), `resolve_installation_id_generates_and_persists_uuid` tokio::test (C9).
- **Open questions**: 0.

## Audit table (re-read verification)

For each claim Cn, the chapter's "Claims & anchors" table records anchor `file:line:symbol` and one-line excerpt; spec_add_code_anchor entries are appended to design.md's Code anchors section. Manual re-read pass walked all 12 anchors:

| Cn | Anchor file:line | Anchor kind | Excerpt match? |
|---|---|---|---|
| C1 | `cli/src/main.rs:1` | use-imports | ✓ — imports `codex_tui`, `codex_exec`, `codex_app_server_daemon`, `codex_mcp_server` etc. |
| C2 | `app-server/src/main.rs:51` | `arg0_dispatch_or_else(...)` call | ✓ — explicit wrapper around `async move { ... }` |
| C3 | `tui/src/lib.rs:709` | `pub async fn run_main(mut cli, arg0_paths, loader_overrides, remote, remote_auth_token)` | ✓ — signature matches; exec/src/lib.rs:233 confirms symmetric pattern |
| C4 | `core/src/client.rs:311` | `pub fn new(auth_manager, session_id, thread_id, installation_id, provider_info, session_source, model_verbosity, enable_request_compression, include_timing_metrics, beta_features_header, attestation_provider)` | ✓ — 11 params; doc comment "stable for the lifetime of a Codex session" exact quote |
| C5 | `core/src/client.rs:315` | `installation_id: String,` | ✓ — String type, not constructed inside |
| C6 | `core/src/client.rs:164` | `struct ModelClientState { session_id, thread_id, window_generation: AtomicU64, installation_id: String, provider, auth_env_telemetry, session_source, ..., cached_websocket_session: StdMutex<WebsocketSession> }` | ✓ — TYPE evidence, all listed fields present |
| C7 | `core/src/client.rs:357` | `pub fn new_session(&self) -> ModelClientSession` with doc "This constructor does not perform network I/O itself" | ✓ — exact doc comment |
| C8 | `core/src/installation_id.rs:19` | `pub async fn resolve_installation_id(codex_home: &AbsolutePathBuf) -> Result<String>` with body opening file, advisory lock, 0o644 mode, Uuid::new_v4() generation, fsync | ✓ — full impl present |
| C9 | `core/src/installation_id.rs:79` | `#[tokio::test] async fn resolve_installation_id_generates_and_persists_uuid()` — asserts UUID parses, file contents == returned UUID, POSIX mode == 0o644 | ✓ — TEST, three explicit asserts |
| C10 | `mcp-server/src/lib.rs:118` | `let installation_id = resolve_installation_id(&config.codex_home).await?;` | ✓ — confirmed; thread-manager-sample/src/main.rs:119, memories/write/src/runtime.rs:173, core/src/prompt_debug.rs:42 all show same pattern |
| C11 | `app-server/src/main.rs:23` | `#[arg(long = "listen", default_value = AppServerTransport::DEFAULT_LISTEN_URL)] listen: AppServerTransport,` with doc line 22 listing five values | ✓ — TYPE evidence |
| C12 | `app-server/src/main.rs:32` | `#[arg(long = "session-source", default_value = "vscode", value_parser = SessionSource::from_startup_arg)] session_source: SessionSource,` | ✓ — defaults to "vscode" |

All 12 anchors verified. No mismatch found. Chapter 01 promoted from draft-framework-only to **audited**.

## Notes

- All entry-binary `main.rs` files use `arg0_dispatch_or_else` wrapper, including the trivial mcp-server/src/main.rs (11 lines total). This is a load-bearing pattern worth highlighting in any future on-boarding doc.
- C6 (ModelClientState struct) is the single best entry point for understanding "what does codex consider session-stable" — its field list IS the identity-dimension catalogue. Recommend citing this anchor heavily in Chapter 03 and Chapter 11.
- Bootstrap-time `installation_id` resolution is empirically required across **at least 4 distinct entry points** (C10) — the resolver is not a vestige.

## Next

Chapter 01 done. Proceed to Chapter 02 (Auth & Identity) on user signal — that chapter will produce datasheets `D2-1 auth.json` and `D2-2 installation_id file` which Chapter 01 references but does not author.
