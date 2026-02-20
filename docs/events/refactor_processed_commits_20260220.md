# Refactor Processed Commit Ledger (2026-02-20)

## 已處理（origin/dev delta 2026-02-20 round1 @ 2026-02-20T14:13:46.535Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `93615bef2` | ported | - | Harden plugin loading path: internal plugin init failure and dynamic import failure no longer crash TUI bootstrap. |
| `ac0b37a7b` | ported | - | Snapshot add/patch/diff now sync source repo info/exclude to snapshot gitdir before staging. |
| `241059302` | ported | - | GitHub action and github run now pass optional VARIANT through to SessionPrompt for provider-specific reasoning. |
| `7e681b0bc` | skipped | - | Touches prompt-input DOM behavior in packages/app; requires cms UI compatibility validation before porting. |
| `4e9ef3ecc` | skipped | - | Touches terminal rendering lifecycle in packages/app plus pty token matching; defer pending cms terminal architecture review. |

## 已處理（origin/dev delta 2026-02-20 round2 @ 2026-02-20T14:19:32.564Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `7e681b0bc` | ported | - | Ported large-paste prompt input hardening: avoid expensive normalization path, fast-path empty detection, large paste fallback insertion, and line-break cap in text fragment builder. |
| `4e9ef3ecc` | ported | - | Ported terminal lifecycle mitigations in cms app layer: close websocket with code 1000, render only active terminal instance, and defer focus handoff to next tick. Skipped upstream pty token-matching hunk due cms pty architecture divergence (socket-id isolation already present). |

## 已處理（origin/dev delta 2026-02-20 round3 @ 2026-02-20T14:27:16.864Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `1de12604c` | ported | - | Preserve path text when workspace directory is root path ('/' or '\\') by guarding relativizeProjectPaths replacement. |
| `7e1051af0` | ported | - | Turn duration now uses max completed timestamp across assistant messages in the same turn, preventing under-reporting when final text part completes earlier than other assistant parts. |

## 已處理（origin/dev delta 2026-02-20 round4 @ 2026-02-20T14:33:00.751Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `7419ebc87` | ported | - | Ported experimental cross-project session listing using cms file-storage model: added Session.listGlobal(), /experimental/session route with filters/cursor pagination, and global session listing tests. |

## 已處理（origin/dev delta 2026-02-20 round5 @ 2026-02-20T14:38:30.526Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `1c2416b6d` | ported | - | Ported desktop connection policy: skip sidecar spawn when configured default server is already localhost, expose username/is_sidecar in ServerReadyData, and align health-check timeout/helper changes. |
| `92ab4217c` | integrated | - | No action needed: current cms already uses interactive login shell args ('-il') when spawning non-Windows sidecar command. |

## 已處理（origin/dev delta 2026-02-20 round6 @ 2026-02-20T14:55:10.783Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `1a329ba47` | ported | - | Ported TUI prompt history/stash stability fix by cloning de-proxied data via structuredClone(unwrap(...)) to avoid Solid store proxy cloning edge cases. |

## 已處理（origin/dev delta 2026-02-20 round7 @ 2026-02-20T15:09:31.537Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `81b5a6a08` | integrated | - | Workspace reset hardening already present in cms (platform-aware persisted-state cleanup + workspace list/state synchronization). |
| `81ca2df6a` | integrated | - | UUID guard path already present in cms via utils/uuid fallback and call-site adoption in prompt attachments/comments/perf. |
| `ed472d8a6` | integrated | - | Session context metrics already defensive in cms with undefined-safe defaults and test coverage. |
| `a82ca8600` | integrated | - | UI code component already handles non-string contents defensively by coercing to safe text before render/line counting. |
| `0771e3a8b` | integrated | - | Plain-text paste undo preservation already present in cms through execCommand insertText fast-path fallback behavior. |
| `ff0abacf4` | integrated | - | Sidebar project icon unload regression already fixed in cms via lazy tile renderer usage in preview/hover trigger. |

## 已處理（origin/dev delta 2026-02-20 round8 @ 2026-02-20T15:21:06.714Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `624dd94b5` | ported | - | Ported LLM-friendly tool output wording in edit/glob/grep, including clearer no-op/not-found/ambiguous edit guidance and richer truncation hints. |
| `ba54cee55` | ported | - | Ported webfetch binary-image handling: non-SVG image responses now return file attachments (data URL) with MIME metadata; added dedicated tool tests. |
| `3befd0c6c` | ported | - | Ported MCP tools enumeration to parallel Promise.all listTools calls across connected clients with per-client failure isolation. |
| `56ad2db02` | ported | - | Ported plugin visibility enhancement by exposing tool args in tool.execute.after hook input via centralized tool invoker flow. |

## 已處理（origin/dev delta 2026-02-20 round9 @ 2026-02-20T15:42:01.208Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `958320f9c` | integrated | - | Global SDK remote HTTP event-stream/auth handling already present in cms (platform fetch for non-loopback http + local auth gating). |
| `50f208d69` | integrated | - | Slash popover active-state handling already aligned in cms using per-item key + direct classList hover tracking. |
| `0303c29e3` | integrated | - | Child-store eviction skip-on-mark fix and regression test already present in cms global-sync store manager. |
| `7f95cc64c` | integrated | - | Prompt input quirks fixes already present (BR/placeholder normalization, multiline history boundary checks, cursor handling, tests). |
| `c9719dff7` | integrated | - | Notification click navigation helper already extracted and wired in web + desktop entry points with tests. |
| `dec304a27` | integrated | - | Avatar grapheme-safe fallback rendering for emoji is already present via Intl.Segmenter-first extraction. |
| `dd296f703` | integrated | - | Global SDK SSE reconnect loop with bounded retry delay is already present in cms. |
| `1c71604e0` | integrated | - | Terminal resize throttling/scheduling and connection-order improvements already present in cms terminal component. |
| `d30e91738` | ported | - | Ported inline-code URL auto-linking and hover affordance for cmd/ctrl-click behavior in markdown renderer. |
| `ebb907d64` | integrated | - | Large diff/file performance path already present (sampled checksum, code/diff virtualization controls, large-diff guard UI, and related styling). |

## 已處理（origin/dev delta 2026-02-20 round10 @ 2026-02-20T15:50:44.991Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `548608b7a` | integrated | - | Terminal PTY isolation stack already present in cms (buffered terminal writer, convertEol false, socket identity map in PTY core/routes, and isolation regression tests). |
| `8da5fd0a6` | integrated | - | Worktree delete resilience already present in cms (post-remove stale detection and filesystem cleanup fallback with dedicated regression test). |
| `d01890388` | ported | - | Ported run-command tool-dispatch hardening: malformed tool props now fall back safely instead of crashing opencode run. |

## 已處理（origin/dev delta 2026-02-20 round11 @ 2026-02-20T15:55:44.869Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `29671c139` | integrated | - | OPENCODE_CONFIG_CONTENT dynamic getter and token-substitution load path already present in cms config/flag stack; targeted substitution test passes. |
| `98aeb60a7` | integrated | - | @ directory attachment flow already routes through Read tool in current user-message-parts pipeline (post prompt runtime split), including filePath args and synthetic trace text. |
| `67c985ce8` | skipped | - | Upstream SQLite WAL checkpoint patch is not applicable to current cms file-storage architecture (no src/storage/db.ts runtime path). |
| `179c40749` | ported | - | Ported websearch description cache-stability tweak from date token to year token to avoid daily cache bust churn. |

## 已處理（origin/dev delta 2026-02-20 round12 @ 2026-02-20T16:07:02.107Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `693127d38` | ported | - | Ported run --dir support: local mode changes cwd before bootstrap, attach mode forwards directory context to remote SDK client. |
| `b0afdf6ea` | ported | - | Ported session delete subcommand with existence check, safe error message for missing session, and success confirmation output. |

## 已處理（origin/dev delta 2026-02-20 round13 @ 2026-02-20T16:25:39.808Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `a580fb47d` | ported | - | Phase-S1 partial port: tool attachment ownership normalization started by removing id/session/message metadata emission from webfetch and avoiding id-decorated attachment re-export in batch output. |
| `e269788a8` | skipped | - | Deferred by scope for dedicated high-risk phase after attachment ownership normalization completes; requires cross-layer session/llm/sdk contract rollout. |

## 已處理（origin/dev delta 2026-02-20 round14 @ 2026-02-20T16:38:18.792Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `e269788a8` | ported | - | Ported structured-output core contract across message schema, session prompt loop, LLM toolChoice plumbing, and SDK v2 generated types/client format wiring; added unit coverage for format persistence and StructuredOutput tool capture. |
