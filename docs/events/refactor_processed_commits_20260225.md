# Refactor Processed Commit Ledger (2026-02-25)

## 已處理（origin/dev delta 2026-02-25 round1 (mcp) @ 2026-02-25T13:34:36.832Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `088a81c116f3fda865851292c92754385292b92d` | ported | - | auth login: consume stdout concurrently with process exit; refactor-ported into cms auth command |

## 已處理（origin/dev latest delta round2 (mcp) @ 2026-02-25T14:09:35.095Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `25f3eef9570267d3368a74556a830ca62be0f231` | ported | - | agent permission model diverged; manually ported core behavior so explore subagent now asks on non-whitelisted external_directory paths while preserving Truncate.DIR/GLOB allow rules |
| `eb553f53ac9689ab2056fceea0c7b0504f642101` | skipped | - | sqlite migration block in packages/opencode/src/index.ts no longer matches cms architecture (conflict); deferred for targeted reimplementation if migration path reintroduced |
| `179c40749d759e2b56cfa4abc49b587373540851` | integrated | `5cbff4c2d` | already present in cms history as equivalent websearch cache-bust fix |

## 已處理（origin/dev delta 2026-02-25 round3 (rewrite-only) @ 2026-02-25T14:55:48.497Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `e7182637784b7d558657da5b6aede92f0db1c11f` | ported | - | project git id cache write now awaited to avoid race between id generation and cache persistence in project detection |
| `3af12c53c433d1f49abde0874dc02c2e6c018930` | ported | - | custom tool module loading now imports absolute file paths via file:// URL conversion for runtime compatibility |
| `088a81c116f3fda865851292c92754385292b92d` | ported | - | auth login reads stdout concurrently with process exit and guards missing stdout to avoid deadlock/failure edge cases |

## 已處理（origin/dev delta 2026-02-25 round4 (rewrite-only) @ 2026-02-25T15:10:54.784Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `da40ab7b3d242208b5c759e55e548c13c658372a` | ported | - | plugin/dependency installs now force bun no-cache in CI to reduce stale cache related install failures in automated environments |

## 已處理（origin/dev delta 2026-02-25 round5 (rewrite-only) @ 2026-02-25T15:14:01.599Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `8c7b35ad05c9dca5778501b287c5f17ee59dd0a2` | ported | - | compaction overflow threshold now reserves dynamic output budget in context-only models instead of subtracting reserved twice, aligning trigger behavior across model limit modes |
| `3befd0c6c57d15369b3177e7d64dd7658ca5ab6a` | integrated | - | mcp tools() already uses parallel listTools Promise.all behavior in current cms implementation |
| `624dd94b5dd8dca03aa3b246312f8b54fd3331f1` | integrated | - | llm-friendly edit/glob/grep output wording and metadata behaviors are already present in cms tool implementations |

## 已處理（origin/dev delta 2026-02-25 round6 (rewrite-only) @ 2026-02-25T15:20:27.444Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `6b4d617df080cef71cd8f4b041601cf47ce0edf3` | ported | - | read tool now supports directory targets with proper external_directory scope (directory/*) and paged directory listing output while preserving cms file read formatting |
| `006d673ed2e795ce41f30fc240189a54ff12c231` | skipped | - | 1-indexed offset semantics would break existing API contract and tests in cms; deferred unless explicit migration decision is approved |

## 已處理（origin/dev delta 2026-02-25 round7 (rewrite-only) @ 2026-02-25T15:23:44.621Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `e6e9c15d34f096a472e24603e05f0f6c1cb3dfb7` | ported | - | codex OAuth model filtering now keeps any model id containing codex in addition to gpt-5.* families, improving compatibility with newly named codex variants |
| `d1ee4c8dca7ec88a608cc640dd11ecb1b0ceb347` | integrated | - | project test hardening scenarios for git command failures are already present in cms test suite |
| `ba54cee55e18b47fb70badc84ae2cbac7c83d258` | integrated | - | webfetch already returns image responses as file attachments in current cms implementation |

## 已處理（origin/dev delta 2026-02-25 round8 (rewrite-only) @ 2026-02-25T15:28:48.781Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `45fa5e7199b2306395e1d07b9544f2e7dbd1c9a5` | ported | - | removed per-message title generation LLM call from session summary path to avoid redundant title model invocations and reduce latency/failure surface |
| `98aeb60a7f0e00e251ff02c360829a3679d65717` | integrated | - | directory @-references already route through Read tool flow in current session user-message parts implementation |
| `d018903887861c64ec7ee037e60b24a61501c9c6` | integrated | - | run command tool rendering already guards malformed tool payloads and falls back safely |

## 已處理（origin/dev delta 2026-02-25 round9 (rewrite-only) @ 2026-02-25T15:33:05.224Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `86e545a23ecdb2c1840ab01e82eca292117c6bbc` | ported | - | ACP session creation no longer sets synthetic random title so default title pipeline can generate meaningful titles |
| `67c985ce82b3a0ef3b22bef435f58884a3aab990` | skipped | - | upstream sqlite WAL checkpoint open-hook targets db module not present in cms storage architecture; defer until sqlite db layer is adopted |

## 已處理（origin/dev delta 2026-02-25 round10 (rewrite-only) @ 2026-02-25T15:37:45.152Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `c1b03b728af259a1556dc39db58e162b382527b3` | ported | - | read tool now streams file lines instead of loading full file text into memory, preserving current cms output contract while reducing peak memory usage on large files |
| `3b9758062b4417b6ff3df2dd9a6c461be24ee0b6` | skipped | - | upstream all-fs/promises cleanup is style-level and overlaps with cms-specific Bun+fs hybrid behavior; defer to dedicated io-standardization round |

## 已處理（origin/dev delta 2026-02-25 round11 (rewrite-only) @ 2026-02-25T15:44:33.612Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `fb79dd7bf857a95a6045209cc1f3f859563a8081` | ported | - | mcp oauth provider now supports invalidateCredentials(all/client/tokens) so oauth provider-directed credential invalidation can clear stale auth state safely |
| `991496a753545f2705072d4da537c175dca357e6` | integrated | - | ACP windows hang protections are already present across cms via util/git ACP-safe spawn path and snapshot ACP bypass guards |

## 已處理（origin/dev delta 2026-02-25 round12 (rewrite-only) @ 2026-02-25T15:51:16.752Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `1608565c808c9136bdc6930a356649bd9824cc69` | ported | - | added plugin hook tool.definition so plugins can mutate tool description and parameters before they are exposed to the model in tool registry |
| `56ad2db02055955f926fda0e4a89055b22ead6f9` | integrated | - | tool.execute.after already receives args payload through ToolInvoker in current cms runtime |

## 已處理（origin/dev delta 2026-02-25 round13 (rewrite-only) @ 2026-02-25T15:55:19.479Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `8631d6c01d8c8f5e8c616e09e85e5a27791d1a56` | ported | - | added comprehensive session list filter tests at server route level (directory/roots/search/start/limit) to lock expected behavior and prevent regression |
| `b020758446254e6c03b0182247b611ce1e5f2c55` | integrated | - | session listing across project directories is already the default behavior in current cms implementation |

## 已處理（origin/dev delta 2026-02-25 round14 (rewrite-only) @ 2026-02-25T15:59:59.275Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `4ccb82e81ab664f53a9ab0d84ea99c18c50dc5c3` | ported | - | auth login picker now surfaces plugin-provided auth providers not present in models list, with dedupe and enable/disable filtering plus dedicated unit coverage |
| `693127d382abed14113f3b7a347851b7a44d74cd` | integrated | - | run command already supports --dir and passes directory override when attaching to remote server in current cms implementation |

## 已處理（origin/dev delta 2026-02-25 round15 (rewrite-only) @ 2026-02-25T16:17:43.595Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `9d3c81a68391399e46fab5307b03984511f92b09` | ported | - | added OPENCODE_ENABLE_QUESTION_TOOL flag so ACP and other non-interactive clients can opt in to QuestionTool explicitly when they support interactive prompts |
| `2bab5e8c39f4ed70dbfe6d971728d8d899b88e4f` | skipped | - | path-derived id migration patch targets json-migration module that is absent in current cms storage layout; defer until migration layer is introduced |

## 已處理（origin/dev delta 2026-02-25 round16 (rewrite-only) @ 2026-02-25T17:02:49.518Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `088eac9d4eaba040e7e19084fd82cbb2e32ce6ed` | ported | - | run command now handles malformed task tool payloads defensively and surfaces errored tool calls in output instead of crashing |
| `d2d7a37bca7febac7df4dd0ecdbc5b1a2d55ef65` | integrated | - | tool attachment ownership already materialized centrally with id/sessionID/messageID via session attachment-ownership helper |

## 已處理（origin/dev delta 2026-02-25 round17 (rewrite-only) @ 2026-02-25T17:13:03.523Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `ee754c46f992dd4024e56e93246421246d16d13f` | ported | - | normalized permission-boundary path matching for cross-platform behavior by converting backslashes to slash form in external_directory globs and wildcard matching with win32 case-insensitive mode |

## 已處理（origin/dev delta 2026-02-25 round18 (rewrite-only) @ 2026-02-25T17:20:21.876Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `1af3e9e557a6df4f933a01d0dad2e52e418ebd52` | ported | - | config plugin resolution now falls back to createRequire().resolve when import.meta.resolve fails (notably on win32 with freshly created node_modules paths) |
| `1a0639e5b89265ac89afd7bcfae835a64744768d` | ported | - | normalized backslash paths in config rel() and file ignore matching to keep cross-platform behavior consistent |

## 已處理（origin/dev delta 2026-02-25 round19 (rewrite-only) @ 2026-02-25T17:23:06.607Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `190d2957eb34246ac942b1e082ea79fd151ea973` | ported | - | file.status now normalizes changed file paths by first resolving to absolute against instance directory, then converting back to stable relative path output |

## 已處理（origin/dev delta 2026-02-25 round20 (rewrite-only) @ 2026-02-25T17:39:55.674Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `8ebdbe0ea2bbf4b2ca7499d59ff9549d3e291557` | ported | - | file.read now treats common source/script/config filenames as text and avoids binary-extension short-circuit misclassification for text-like files |

## 已處理（origin/dev delta 2026-02-25 round21 (rewrite-only) @ 2026-02-25T17:44:24.369Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `2cee947671fa373098db308b173c859cada0b108` | ported | - | ACP live/replay tool updates now share a deduped synthetic pending path so running tools emit exactly one initial tool_call before tool_call_update events |

## 已處理（origin/dev delta 2026-02-25 round22 (rewrite-only) @ 2026-02-25T17:59:59.471Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `79b5ce58e9d3ad940330c2fd82784a4d8b7e004d` | ported | - | added session delete-message API endpoint with busy-session guard and route-level regression coverage to support safe message removal workflows |

## 已處理（origin/dev delta 2026-02-25 round23 (rewrite-only) @ 2026-02-25T18:06:57.254Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `637059a515a6afd983a8a615f90650d997a821ce` | ported | - | TUI now shows LSP diagnostics for apply_patch edits and reuses a shared diagnostics renderer across write/edit/apply_patch tool views |

## 已處理（origin/dev delta 2026-02-25 round24 (rewrite-only) @ 2026-02-25T18:27:08.160Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `13cabae29f7ed2bd658037c0c676f7807d63d8b3` | ported | - | snapshot git operations now include win32-safe compatibility flags (longpaths/symlinks/autocrlf) and test cleanup uses retry policy to reduce transient EBUSY failures |

## 已處理（origin/dev delta 2026-02-26 round25 (rewrite-only) @ 2026-02-25T18:44:18.991Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `c0814da785d40273f36eda835c4cfd583cf20d75` | ported | - | disabled OpenTUI openConsoleOnError so runtime failures remain in ErrorBoundary-driven in-app UX instead of forcing raw console overlay |

## 已處理（origin/dev delta 2026-02-26 round26 (rewrite-only) @ 2026-02-25T19:02:53.131Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `8da5fd0a66b2b31f4d77eb8c0949c148b9a7d760` | integrated | - | worktree delete defensive flow and regression test are already present in cms (locate/verify stale worktree, non-zero remove tolerance, residual clean+branch delete) |
