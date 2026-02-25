# Refactor Processed Commit Ledger (2026-02-25)

## 已處理（origin/dev delta 2026-02-25 round1 (mcp) @ 2026-02-25T13:34:36.832Z）

| Upstream Commit                            | Status | Local Commit | Note                                                                                             |
| ------------------------------------------ | ------ | ------------ | ------------------------------------------------------------------------------------------------ |
| `088a81c116f3fda865851292c92754385292b92d` | ported | -            | auth login: consume stdout concurrently with process exit; refactor-ported into cms auth command |

## 已處理（origin/dev latest delta round2 (mcp) @ 2026-02-25T14:09:35.095Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                                                                                                   |
| ------------------------------------------ | ---------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `25f3eef9570267d3368a74556a830ca62be0f231` | ported     | -            | agent permission model diverged; manually ported core behavior so explore subagent now asks on non-whitelisted external_directory paths while preserving Truncate.DIR/GLOB allow rules |
| `eb553f53ac9689ab2056fceea0c7b0504f642101` | skipped    | -            | sqlite migration block in packages/opencode/src/index.ts no longer matches cms architecture (conflict); deferred for targeted reimplementation if migration path reintroduced          |
| `179c40749d759e2b56cfa4abc49b587373540851` | integrated | `5cbff4c2d`  | already present in cms history as equivalent websearch cache-bust fix                                                                                                                  |

## 已處理（origin/dev delta 2026-02-25 round3 (rewrite-only) @ 2026-02-25T14:55:48.497Z）

| Upstream Commit                            | Status | Local Commit | Note                                                                                                                  |
| ------------------------------------------ | ------ | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `e7182637784b7d558657da5b6aede92f0db1c11f` | ported | -            | project git id cache write now awaited to avoid race between id generation and cache persistence in project detection |
| `3af12c53c433d1f49abde0874dc02c2e6c018930` | ported | -            | custom tool module loading now imports absolute file paths via file:// URL conversion for runtime compatibility       |
| `088a81c116f3fda865851292c92754385292b92d` | ported | -            | auth login reads stdout concurrently with process exit and guards missing stdout to avoid deadlock/failure edge cases |

## 已處理（origin/dev delta 2026-02-25 round4 (rewrite-only) @ 2026-02-25T15:10:54.784Z）

| Upstream Commit                            | Status | Local Commit | Note                                                                                                                             |
| ------------------------------------------ | ------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `da40ab7b3d242208b5c759e55e548c13c658372a` | ported | -            | plugin/dependency installs now force bun no-cache in CI to reduce stale cache related install failures in automated environments |

## 已處理（origin/dev delta 2026-02-25 round5 (rewrite-only) @ 2026-02-25T15:14:01.599Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                                                                                              |
| ------------------------------------------ | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `8c7b35ad05c9dca5778501b287c5f17ee59dd0a2` | ported     | -            | compaction overflow threshold now reserves dynamic output budget in context-only models instead of subtracting reserved twice, aligning trigger behavior across model limit modes |
| `3befd0c6c57d15369b3177e7d64dd7658ca5ab6a` | integrated | -            | mcp tools() already uses parallel listTools Promise.all behavior in current cms implementation                                                                                    |
| `624dd94b5dd8dca03aa3b246312f8b54fd3331f1` | integrated | -            | llm-friendly edit/glob/grep output wording and metadata behaviors are already present in cms tool implementations                                                                 |

## 已處理（origin/dev delta 2026-02-25 round6 (rewrite-only) @ 2026-02-25T15:20:27.444Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                                                                                      |
| ------------------------------------------ | ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `6b4d617df080cef71cd8f4b041601cf47ce0edf3` | ported  | -            | read tool now supports directory targets with proper external_directory scope (directory/\*) and paged directory listing output while preserving cms file read formatting |
| `006d673ed2e795ce41f30fc240189a54ff12c231` | skipped | -            | 1-indexed offset semantics would break existing API contract and tests in cms; deferred unless explicit migration decision is approved                                    |

## 已處理（origin/dev delta 2026-02-25 round7 (rewrite-only) @ 2026-02-25T15:23:44.621Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                                                                          |
| ------------------------------------------ | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e6e9c15d34f096a472e24603e05f0f6c1cb3dfb7` | ported     | -            | codex OAuth model filtering now keeps any model id containing codex in addition to gpt-5.\* families, improving compatibility with newly named codex variants |
| `d1ee4c8dca7ec88a608cc640dd11ecb1b0ceb347` | integrated | -            | project test hardening scenarios for git command failures are already present in cms test suite                                                               |
| `ba54cee55e18b47fb70badc84ae2cbac7c83d258` | integrated | -            | webfetch already returns image responses as file attachments in current cms implementation                                                                    |

## 已處理（origin/dev delta 2026-02-25 round8 (rewrite-only) @ 2026-02-25T15:28:48.781Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                                                                  |
| ------------------------------------------ | ---------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `45fa5e7199b2306395e1d07b9544f2e7dbd1c9a5` | ported     | -            | removed per-message title generation LLM call from session summary path to avoid redundant title model invocations and reduce latency/failure surface |
| `98aeb60a7f0e00e251ff02c360829a3679d65717` | integrated | -            | directory @-references already route through Read tool flow in current session user-message parts implementation                                      |
| `d018903887861c64ec7ee037e60b24a61501c9c6` | integrated | -            | run command tool rendering already guards malformed tool payloads and falls back safely                                                               |

## 已處理（origin/dev delta 2026-02-25 round9 (rewrite-only) @ 2026-02-25T15:33:05.224Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                                                       |
| ------------------------------------------ | ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `86e545a23ecdb2c1840ab01e82eca292117c6bbc` | ported  | -            | ACP session creation no longer sets synthetic random title so default title pipeline can generate meaningful titles                        |
| `67c985ce82b3a0ef3b22bef435f58884a3aab990` | skipped | -            | upstream sqlite WAL checkpoint open-hook targets db module not present in cms storage architecture; defer until sqlite db layer is adopted |

## 已處理（origin/dev delta 2026-02-25 round10 (rewrite-only) @ 2026-02-25T15:37:45.152Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                                                                                   |
| ------------------------------------------ | ------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c1b03b728af259a1556dc39db58e162b382527b3` | ported  | -            | read tool now streams file lines instead of loading full file text into memory, preserving current cms output contract while reducing peak memory usage on large files |
| `3b9758062b4417b6ff3df2dd9a6c461be24ee0b6` | skipped | -            | upstream all-fs/promises cleanup is style-level and overlaps with cms-specific Bun+fs hybrid behavior; defer to dedicated io-standardization round                     |

## 已處理（origin/dev delta 2026-02-25 round11 (rewrite-only) @ 2026-02-25T15:44:33.612Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                                                                          |
| ------------------------------------------ | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fb79dd7bf857a95a6045209cc1f3f859563a8081` | ported     | -            | mcp oauth provider now supports invalidateCredentials(all/client/tokens) so oauth provider-directed credential invalidation can clear stale auth state safely |
| `991496a753545f2705072d4da537c175dca357e6` | integrated | -            | ACP windows hang protections are already present across cms via util/git ACP-safe spawn path and snapshot ACP bypass guards                                   |

## 已處理（origin/dev delta 2026-02-25 round12 (rewrite-only) @ 2026-02-25T15:51:16.752Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                                                          |
| ------------------------------------------ | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `1608565c808c9136bdc6930a356649bd9824cc69` | ported     | -            | added plugin hook tool.definition so plugins can mutate tool description and parameters before they are exposed to the model in tool registry |
| `56ad2db02055955f926fda0e4a89055b22ead6f9` | integrated | -            | tool.execute.after already receives args payload through ToolInvoker in current cms runtime                                                   |

## 已處理（origin/dev delta 2026-02-25 round13 (rewrite-only) @ 2026-02-25T15:55:19.479Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                                                                      |
| ------------------------------------------ | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `8631d6c01d8c8f5e8c616e09e85e5a27791d1a56` | ported     | -            | added comprehensive session list filter tests at server route level (directory/roots/search/start/limit) to lock expected behavior and prevent regression |
| `b020758446254e6c03b0182247b611ce1e5f2c55` | integrated | -            | session listing across project directories is already the default behavior in current cms implementation                                                  |

## 已處理（origin/dev delta 2026-02-25 round14 (rewrite-only) @ 2026-02-25T15:59:59.275Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                                                                            |
| ------------------------------------------ | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4ccb82e81ab664f53a9ab0d84ea99c18c50dc5c3` | ported     | -            | auth login picker now surfaces plugin-provided auth providers not present in models list, with dedupe and enable/disable filtering plus dedicated unit coverage |
| `693127d382abed14113f3b7a347851b7a44d74cd` | integrated | -            | run command already supports --dir and passes directory override when attaching to remote server in current cms implementation                                  |

## 已處理（origin/dev delta 2026-02-25 round15 (rewrite-only) @ 2026-02-25T16:17:43.595Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                                                                          |
| ------------------------------------------ | ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9d3c81a68391399e46fab5307b03984511f92b09` | ported  | -            | added OPENCODE_ENABLE_QUESTION_TOOL flag so ACP and other non-interactive clients can opt in to QuestionTool explicitly when they support interactive prompts |
| `2bab5e8c39f4ed70dbfe6d971728d8d899b88e4f` | skipped | -            | path-derived id migration patch targets json-migration module that is absent in current cms storage layout; defer until migration layer is introduced         |

## 已處理（origin/dev delta 2026-02-25 round16 (rewrite-only) @ 2026-02-25T17:02:49.518Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                                           |
| ------------------------------------------ | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `088eac9d4eaba040e7e19084fd82cbb2e32ce6ed` | ported     | -            | run command now handles malformed task tool payloads defensively and surfaces errored tool calls in output instead of crashing |
| `d2d7a37bca7febac7df4dd0ecdbc5b1a2d55ef65` | integrated | -            | tool attachment ownership already materialized centrally with id/sessionID/messageID via session attachment-ownership helper   |

## 已處理（origin/dev delta 2026-02-25 round17 (rewrite-only) @ 2026-02-25T17:13:03.523Z）

| Upstream Commit                            | Status | Local Commit | Note                                                                                                                                                                                                |
| ------------------------------------------ | ------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ee754c46f992dd4024e56e93246421246d16d13f` | ported | -            | normalized permission-boundary path matching for cross-platform behavior by converting backslashes to slash form in external_directory globs and wildcard matching with win32 case-insensitive mode |

## 已處理（origin/dev delta 2026-02-25 round18 (rewrite-only) @ 2026-02-25T17:20:21.876Z）

| Upstream Commit                            | Status | Local Commit | Note                                                                                                                                                         |
| ------------------------------------------ | ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `1af3e9e557a6df4f933a01d0dad2e52e418ebd52` | ported | -            | config plugin resolution now falls back to createRequire().resolve when import.meta.resolve fails (notably on win32 with freshly created node_modules paths) |
| `1a0639e5b89265ac89afd7bcfae835a64744768d` | ported | -            | normalized backslash paths in config rel() and file ignore matching to keep cross-platform behavior consistent                                               |

## 已處理（origin/dev delta 2026-02-25 round19 (rewrite-only) @ 2026-02-25T17:23:06.607Z）

| Upstream Commit                            | Status | Local Commit | Note                                                                                                                                                         |
| ------------------------------------------ | ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `190d2957eb34246ac942b1e082ea79fd151ea973` | ported | -            | file.status now normalizes changed file paths by first resolving to absolute against instance directory, then converting back to stable relative path output |

## 已處理（origin/dev delta 2026-02-25 round20 (rewrite-only) @ 2026-02-25T17:39:55.674Z）

| Upstream Commit                            | Status | Local Commit | Note                                                                                                                                               |
| ------------------------------------------ | ------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `8ebdbe0ea2bbf4b2ca7499d59ff9549d3e291557` | ported | -            | file.read now treats common source/script/config filenames as text and avoids binary-extension short-circuit misclassification for text-like files |

## 已處理（origin/dev delta 2026-02-25 round21 (rewrite-only) @ 2026-02-25T17:44:24.369Z）

| Upstream Commit                            | Status | Local Commit | Note                                                                                                                                                       |
| ------------------------------------------ | ------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2cee947671fa373098db308b173c859cada0b108` | ported | -            | ACP live/replay tool updates now share a deduped synthetic pending path so running tools emit exactly one initial tool_call before tool_call_update events |

## 已處理（origin/dev delta 2026-02-25 round22 (rewrite-only) @ 2026-02-25T17:59:59.471Z）

| Upstream Commit                            | Status | Local Commit | Note                                                                                                                                            |
| ------------------------------------------ | ------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `79b5ce58e9d3ad940330c2fd82784a4d8b7e004d` | ported | -            | added session delete-message API endpoint with busy-session guard and route-level regression coverage to support safe message removal workflows |

## 已處理（origin/dev delta 2026-02-25 round23 (rewrite-only) @ 2026-02-25T18:06:57.254Z）

| Upstream Commit                            | Status | Local Commit | Note                                                                                                                                  |
| ------------------------------------------ | ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `637059a515a6afd983a8a615f90650d997a821ce` | ported | -            | TUI now shows LSP diagnostics for apply_patch edits and reuses a shared diagnostics renderer across write/edit/apply_patch tool views |

## 已處理（origin/dev delta 2026-02-25 round24 (rewrite-only) @ 2026-02-25T18:27:08.160Z）

| Upstream Commit                            | Status | Local Commit | Note                                                                                                                                                                   |
| ------------------------------------------ | ------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `13cabae29f7ed2bd658037c0c676f7807d63d8b3` | ported | -            | snapshot git operations now include win32-safe compatibility flags (longpaths/symlinks/autocrlf) and test cleanup uses retry policy to reduce transient EBUSY failures |

## 已處理（origin/dev delta 2026-02-26 round25 (rewrite-only) @ 2026-02-25T18:44:18.991Z）

| Upstream Commit                            | Status | Local Commit | Note                                                                                                                                    |
| ------------------------------------------ | ------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `c0814da785d40273f36eda835c4cfd583cf20d75` | ported | -            | disabled OpenTUI openConsoleOnError so runtime failures remain in ErrorBoundary-driven in-app UX instead of forcing raw console overlay |

## 已處理（origin/dev delta 2026-02-26 round26 (rewrite-only) @ 2026-02-25T19:02:53.131Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                                                                                  |
| ------------------------------------------ | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `8da5fd0a66b2b31f4d77eb8c0949c148b9a7d760` | integrated | -            | worktree delete defensive flow and regression test are already present in cms (locate/verify stale worktree, non-zero remove tolerance, residual clean+branch delete) |

## 已處理（origin/dev delta 2026-02-26 round27 (rewrite-only) @ 2026-02-25T19:04:30.964Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                                                |
| ------------------------------------------ | ---------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `548608b7ad1252af3181201ef764b16c05d0b786` | integrated | -            | PTY isolation fix already present in cms with stronger socket identity guards and existing pty-output-isolation regression coverage |

## 已處理（origin/dev delta 2026-02-26 round28 (rewrite-only) @ 2026-02-25T19:04:47.327Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                                          |
| ------------------------------------------ | ---------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `93eee0daf40668a487bdbda439147ad13c8d13cc` | integrated | -            | Provider.defaultModel already checks recent model.json entries first and falls back only after provider/model validity checks |

## 已處理（origin/dev delta 2026-02-26 round29 (rewrite-only) @ 2026-02-25T19:05:34.666Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                                           |
| ------------------------------------------ | ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `45f0050372a1bc035164a5953b1fdb46df106d4a` | skipped | -            | upstream sqlite db command depends on storage/db.ts + Database.Path surface not present in cms file-index storage architecture |

## 已處理（origin/dev delta 2026-02-26 round30 (rewrite-only) @ 2026-02-25T19:06:06.428Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                                  |
| ------------------------------------------ | ------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `f66624fe6eba5aa00662c8d0925c5c6795b2b986` | skipped | -            | cleanup-only flag refactor has low user value and intersects cms-diverged env default semantics; avoid behavior drift |

## 已處理（origin/dev delta 2026-02-26 round31 (rewrite-only) @ 2026-02-25T19:07:10.242Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                               |
| ------------------------------------------ | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `29671c1397b0ecfb9510186a0aae89696896da2a` | integrated | -            | OPENCODE_CONFIG_CONTENT token substitution support is already present in cms config load path with dedicated tests |
| `1fb6c0b5b356e3816398ba71ac1b01485697bc31` | skipped    | -            | upstream revert is not adopted; cms intentionally keeps OPENCODE_CONFIG_CONTENT token substitution behavior        |

## 已處理（origin/dev delta 2026-02-26 round32 (rewrite-only) @ 2026-02-25T19:07:49.562Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                                                      |
| ------------------------------------------ | ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `68bb8ce1da922229e6ab4dde4207b431cf9d76a8` | skipped | -            | db-table session filtering optimization is not directly portable to cms file/index storage architecture without broader storage migration |

## 已處理（origin/dev delta 2026-02-26 round33 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                                      |
| ------------------------------------------ | ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `ad2087094d84cb9255f08c787f8ffbe0f78fdba0` | skipped | -            | deferred to dedicated provider-focused round to avoid broad formatting drift risk in volatile provider normalization file |

## 已處理（origin/dev delta 2026-02-26 round34 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                                                                                 |
| ------------------------------------------ | ------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bf5a01edd94352e9027f428f7d5817590726ad26` | skipped | -            | venice-specific variant branch targets venice-ai-sdk-provider runtime not currently in cms dependency surface; openai-compatible variants already cover current path |

## 已處理（origin/dev delta 2026-02-26 round35 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                                |
| ------------------------------------------ | ------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `135f8ffb2a0b6759a5bf8e03b2869d4258d5013b` | skipped | -            | session header visibility toggle is optional UX preference with low value vs current cms TUI layout regression risk |

## 已處理（origin/dev delta 2026-02-26 round36 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status | Local Commit | Note                                                                                                   |
| ------------------------------------------ | ------ | ------------ | ------------------------------------------------------------------------------------------------------ |
| `a115565054c9c905788b1684f9b64f0e6dc2dbb4` | ported | -            | relaxed model.provider schema to allow optional npm/api fields for broader config compatibility in cms |

## 已處理（origin/dev delta 2026-02-26 round37 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                                              |
| ------------------------------------------ | ------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `8f9742d9886b4bfb5ac36a49810b7533985487ad` | skipped | -            | win32 FFI console-mode guard is a large platform-specific lifecycle change; defer to dedicated Windows-hardening validation round |

## 已處理（origin/dev delta 2026-02-26 round38 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                                         |
| ------------------------------------------ | ---------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `e269788a8feb987a579b8700726dd8b02bf2e7f1` | integrated | -            | structured-output json_schema + StructuredOutput tool/error flow already exists across cms session prompt/message pipeline   |
| `f6e7aefa728585832b6ac737c0fb2bc97461dc16` | skipped    | -            | generated OpenAPI/docs artifact update has no required runtime behavior delta for current cms rewrite-only integration round |

## 已處理（origin/dev delta 2026-02-26 round39 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                 |
| ------------------------------------------ | ---------- | ------------ | ------------------------------------------------------------------------------------ |
| `125727d09c4482f351ee3e0d448db7efc116213d` | integrated | -            | cms already uses @opentui/core and @opentui/solid version 0.1.79 in package manifest |

## 已處理（origin/dev delta 2026-02-26 round40 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status     | Local Commit | Note                                                                                                     |
| ------------------------------------------ | ---------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| `4018c863e3b4b9857fe9378ae54e406a5cf5ab48` | integrated | -            | baseline CPU capability detection and fallback binary resolution behavior already exists in cms launcher |

## 已處理（origin/dev delta 2026-02-26 round41 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                        |
| ------------------------------------------ | ------- | ------------ | ----------------------------------------------------------------------------------------------------------- |
| `a8f2884521e755cea9b9e4e52406267bcbda15d2` | skipped | -            | windows selection/manual ctrl+c UX patch touches multiple TUI interaction paths; deferred to dedicated pass |

## 已處理（origin/dev delta 2026-02-26 round42 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                                  |
| ------------------------------------------ | ------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `759ec104b6e537235afd3177acd28b6c9694e496` | skipped | -            | gateway variant/providerOptions remapping sequence is high-risk under cms-diverged provider routing                   |
| `933a491adeeed875d3ba4cbc88ed301a60456734` | skipped | -            | amazon→bedrock slug remapping for gateway variants deferred with the same provider-sequence hardening batch           |
| `839c5cda12fa978d4c7ba85c7cf51600ec853bc8` | skipped | -            | openrouter anthropic variant + patch lifecycle update deferred to dedicated provider integration and patch validation |

## 已處理（origin/dev delta 2026-02-26 round43 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                               |
| ------------------------------------------ | ------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `6d95f0d14cbd83fc8b7775f77ba39ab2881008f3` | skipped | -            | large sqlite migration wave is architectural in scope and out-of-bounds for current file/index rewrite-only stream |

## 已處理（origin/dev delta 2026-02-26 round44 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                              |
| ------------------------------------------ | ------- | ------------ | --------------------------------------------------------------------------------- |
| `3b6b3e6fc8a8a4da5798c9f00027e954263a483e` | skipped | -            | release bookkeeping/version rollup commit; no standalone behavior to rewrite-port |
| `c190f5f611c1520a553facc362749f8aefaa5005` | skipped | -            | release bookkeeping/version rollup commit; no standalone behavior to rewrite-port |
| `d1482e148399bfaf808674549199f5f4aa69a22d` | skipped | -            | release bookkeeping/version rollup commit; no standalone behavior to rewrite-port |

## 已處理（origin/dev delta 2026-02-26 round45 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                       |
| ------------------------------------------ | ------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `b5c8bd3421e4b89cf9dabc6ccf019a82eefc64a5` | skipped | -            | json-migration path-id regression test depends on migration/test stack not present in current cms topology |

## 已處理（origin/dev delta 2026-02-26 round46 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                                                                 |
| ------------------------------------------ | ------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `d475fd6137ad669a8a73027d91b516a57846c379` | skipped | -            | generated-only provider file churn without standalone behavior intent; deferred unless tied to selected feature port |

## 已處理（origin/dev delta 2026-02-26 round47 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                       |
| ------------------------------------------ | ------- | ------------ | -------------------------------------------------------------------------- |
| `2db618dea33517a0f36567de28d010ee7770a800` | skipped | -            | bun downgrade conflicts with current cms 1.3.9-aligned toolchain direction |

## 已處理（origin/dev delta 2026-02-26 round48 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                              |
| ------------------------------------------ | ------- | ------------ | --------------------------------------------------------------------------------- |
| `76db218674496f9ca9e91b49e5718eabf6df7cc0` | skipped | -            | release bookkeeping/version rollup commit; no standalone behavior to rewrite-port |
| `847e06f9e1aa1629944df3657e7aed46c3210596` | skipped | -            | nix hash bookkeeping only; no direct runtime behavior delta for cms               |

## 已處理（origin/dev delta 2026-02-26 round49 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                    |
| ------------------------------------------ | ------- | ------------ | ----------------------------------------------------------------------- |
| `8eea53a41e92257d1a4ad6653d0d2930465bf34a` | skipped | -            | docs-only localization cleanup; no runtime behavior delta for cms       |
| `aea68c386a4f64cf718c3eeee9dffec8409ee6b0` | skipped | -            | docs locale translation wave; outside current behavior-focused refactor |

## 已處理（origin/dev delta 2026-02-26 round50 (rewrite-only) @ 2026-02-26T00:00:00.000Z）

| Upstream Commit                            | Status  | Local Commit | Note                                                                              |
| ------------------------------------------ | ------- | ------------ | --------------------------------------------------------------------------------- |
| `03de51bd3cf9e05bd92c9f51763b74a3cdfbe61a` | skipped | -            | release version-rollup bookkeeping commit; no standalone behavior to rewrite-port |

## 已處理（origin/dev delta 2026-02-26 round51 (rewrite-only) @ 2026-02-25T20:03:25.744Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `1413d77b1ff36ed030c179b3bc59dc6a9b9679b3` | skipped | - | desktop sqlite migration progress UI depends on sqlite migration flow not adopted in current cms stream |
| `adb0c4d4f94f6260a67bb9a48ef3a7faa6042bf3` | skipped | - | desktop loading-window condition is coupled to sqlite migration detection path deferred with sqlite track |

## 已處理（origin/dev delta 2026-02-26 round52 (rewrite-only) @ 2026-02-25T20:03:34.413Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `81ca2df6ad57085b895caafc386e4ac4ab9098a6` | skipped | - | packages/app browser randomUUID guard fix is outside current cms core runtime refactor scope |
| `0771e3a8bee1b099468f3c95e19bd78699f62b12` | skipped | - | packages/app prompt paste undo behavior is app-client UX scope, deferred |
| `ff0abacf4bcc78a1464f54eec2424f234c1723c9` | skipped | - | packages/app project icon unloading fix is app UI scope, deferred |
| `958320f9c1572841c6c4b7aeba4559a79693002d` | skipped | - | packages/app remote HTTP server connection fix is app client scope, deferred in current stream |
| `50f208d69f9a3b418290f01f96117308842d9e9d` | skipped | - | packages/app slash suggestion active-state fix is UI behavior scope, deferred |
| `0303c29e3ff4f45aff4176e496ecb3f5fa5b611a` | skipped | - | packages/app store creation fix is app layer scope, deferred |
| `ff3b174c423d89b39ee8154863840e48c8aac371` | skipped | - | packages/app oauth error normalization is app surface scope, deferred |
| `4e0f509e7b7d84395a541bdfa658f6c98f588221` | skipped | - | packages/app sound effects toggle feature is app UI scope, not current core runtime target |

## 已處理（origin/dev delta 2026-02-26 round53 (rewrite-only) @ 2026-02-25T20:03:44.125Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `ff4414bb152acfddb5c0eb073c38bedc1df4ae14` | skipped | - | large packages/app refactor churn is outside current cms core runtime parity stream |
| `da952135cabba2926698298797cd301e7adaf48c` | skipped | - | solidjs hygiene refactor in packages/app deferred to dedicated app parity initiative |
| `3696d1ded152d08e8d45fae9cbbdb25c50a189ef` | skipped | - | cleanup-only app churn without core runtime behavior delta |
| `81c623f26eddf9aa014510b25c4621ed39678de7` | skipped | - | cleanup-only app churn without core runtime behavior delta |
| `e9b9a62fe4df1fcc92b9d410a1982f26418d87a1` | skipped | - | cleanup-only app churn without core runtime behavior delta |
| `7ccf223c847564f5f2a032a92493c8c67e6a822d` | skipped | - | cleanup-only app churn without core runtime behavior delta |
| `70303d0b4272fee94f412c851de133fb3a45464f` | skipped | - | cleanup-only app churn without core runtime behavior delta |

## 已處理（origin/dev delta 2026-02-26 round54 (rewrite-only) @ 2026-02-25T20:04:45.489Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `e2a33f75e1635830b559322b507a7ed4ff114e59` | skipped | - | VOUCHED trust-list maintenance only; no cms runtime behavior delta |
| `5bdf1c4b96545619e3b062b47912f845de7ca1b8` | skipped | - | VOUCHED trust-list maintenance only; no cms runtime behavior delta |
| `0eaeb4588e0d44023a2e89c2ed516dbfe68c0e43` | skipped | - | SignPath CI integration files are release/signing pipeline scope outside current runtime refactor |
| `fa97475ee82eaca292a72baa01d7da0ef1695f1b` | skipped | - | SignPath policy file relocation is CI governance scope, not runtime behavior |
| `11dd281c92d88726aa4a5da762b8f9300572ccf1` | skipped | - | docs typo fix only; no runtime behavior delta |
| `20dcff1e2e73c19b3184bbd181b533409c4567e7` | skipped | - | generated docs update only; no runtime behavior delta |
| `ecab692ca15dceb065463731adfdee45ea91c49a` | skipped | - | docs-only correction for SDK guide format attribute |
| `789705ea96ae28af7e30801fd6039ce89b6ac48e` | skipped | - | test fixture AGENTS documentation only; no runtime behavior delta |

## 已處理（origin/dev delta 2026-02-26 round55 (rewrite-only) @ 2026-02-25T20:04:52.476Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `c856f875a1f136c058512b6e388a3aa66098286a` | integrated | - | cms already aligned on Bun 1.3.9 toolchain baseline |

## 已處理（origin/dev delta 2026-02-26 round56 (rewrite-only) @ 2026-02-25T20:05:00.856Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `892bb75265602cd3dbcbe1cfc634f1d7f4ca7f5e` | skipped | - | release bookkeeping/version rollup commit; no standalone behavior to rewrite-port |
| `aaee5fb680b5ca20aaae89fe84ac7cf619461343` | skipped | - | release bookkeeping/version rollup commit; no standalone behavior to rewrite-port |
| `ac018e3a35fe75b57d55ae349a91624609e11448` | skipped | - | release bookkeeping/version rollup commit; no standalone behavior to rewrite-port |

## 已處理（origin/dev delta 2026-02-26 round57 (rewrite-only) @ 2026-02-25T20:06:16.142Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `d86f24b6b3d0e4772a3da07724771e0172e533db` | skipped | - | console zen cost-return feature is outside current cms core runtime parity scope |
| `d82d22b2d760e85a4e9a84ff7a69e43420553e20` | skipped | - | wip zen commit in console track deferred to dedicated zen sync initiative |
| `ae811ad8d249c5d37622c26f2078eb0bef40087b` | skipped | - | wip zen commit in console track deferred to dedicated zen sync initiative |
| `658bf6fa583eb027ff78eb9163b413222e9e6d95` | skipped | - | zen docs content update only; no core runtime behavior delta |
| `59a323e9a87d315ff5c0e73c4eb5af089aeff87f` | skipped | - | wip zen docs content update only; no core runtime behavior delta |

## 已處理（origin/dev delta 2026-02-26 round58 (rewrite-only) @ 2026-02-25T20:06:21.661Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `5f421883a8aa92338bee1399532f359c5e986f41` | skipped | - | desktop/ui loading screen styling change is out of current core runtime scope |
| `ecb274273a04920c215625b4bf93845d166411e2` | skipped | - | ui diff virtualization wip is app/ui optimization scope, deferred |
| `a82ca860089afde16afdcb1cff0592c6ac0f4aa4` | skipped | - | defensive ui code component fix is app/ui layer scope, deferred in current stream |

## 已處理（origin/dev delta 2026-02-26 round59 (rewrite-only) @ 2026-02-25T20:06:34.187Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `81b5a6a08b6b2f591096a0f9a7fed04871002a33` | skipped | - | packages/app workspace reset fix is app client scope outside current core runtime stream |
| `8f56ed5b850ce4ad71ced4903a36d822cf91553f` | skipped | - | generated app context change without selected runtime behavior objective |
| `fbabce1125005bc4a658401fbbc1c04e50d2f5bc` | skipped | - | translations-only app/ui i18n update; no core runtime behavior delta |
| `e3471526f4c71b2c4ee00117e125e179da01e6e2` | skipped | - | brand assets/page update in console app scope; deferred from runtime-focused stream |

## 已處理（origin/dev delta 2026-02-26 round60 (rewrite-only) @ 2026-02-25T20:10:57.843Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `6b30e0b7528bb467450c20524fdd075b893d9b3c` | skipped | - | docs locale sync workflow update is CI/docs pipeline scope without cms runtime behavior delta |
| `d723147083ef972e82de5e33765874e35be64079` | skipped | - | pr-management workflow behavior is repository CI policy scope, not runtime |
| `ed439b20572178ced9cd93ffe07542d50e624598` | skipped | - | signpath policy config is signing pipeline scope, no runtime behavior delta |
| `df3203d2dd06edd70693ea99312e1ae3e59accd5` | skipped | - | signpath policy move is CI governance housekeeping |
| `b06afd657d59c2c88394513e3b633060ec6f454b` | skipped | - | signpath policy removal is CI governance housekeeping |
| `264dd213f9fc0592d19e9c4a6e090820ff74f063` | skipped | - | nix hash bookkeeping only; no runtime behavior delta |
| `8577eb8ec92b8f2d5f91a043dbd03d0fbc5209ee` | skipped | - | nix hash bookkeeping only; no runtime behavior delta |
| `9f9f0fb8eb10ab4e90a6f38c222eb40116becb50` | skipped | - | nix hash bookkeeping only; no runtime behavior delta |
| `445e0d76765d745ee59a16eb13eb3206f6037cce` | skipped | - | nix hash bookkeeping only; no runtime behavior delta |
| `b8ee88212639ec63f4fe87555b5e87f74643e76b` | skipped | - | nix hash bookkeeping only; no runtime behavior delta |
| `d0dcffefa7c70ea180fd565a79d42d9db58977e4` | skipped | - | nix hash bookkeeping only; no runtime behavior delta |
| `8c1af9b445a45128d147f6f818dfd3ed7c4e75ef` | skipped | - | nix hash bookkeeping only; no runtime behavior delta |

## 已處理（origin/dev delta 2026-02-26 round61 (rewrite-only) @ 2026-02-25T20:11:13.799Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `34ebe814ddd130a787455dda089facb23538ca20` | skipped | - | release bookkeeping/version rollup commit; no standalone behavior to rewrite-port |
| `ffc000de8e446c63d41a2e352d119d9ff43530d0` | skipped | - | release bookkeeping/version rollup commit; no standalone behavior to rewrite-port |
| `cd775a2862cf9ed1d5aaf26fdee0e814ce28936b` | skipped | - | release bookkeeping/version rollup commit; no standalone behavior to rewrite-port |
| `62a24c2ddaf56c4234898269b1951ab11483f57a` | skipped | - | release bookkeeping/version rollup commit; no standalone behavior to rewrite-port |
| `d8c25bfeb44771cc3a3ba17bf8de6ad2add9de2c` | skipped | - | release bookkeeping/version rollup commit; no standalone behavior to rewrite-port |

## 已處理（origin/dev delta 2026-02-26 round62 (rewrite-only) @ 2026-02-25T20:11:51.384Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `ed472d8a6789c882dfbba7facfd987fd8dd6fb2c` | skipped | - | app session-context metrics defensive fixes are app-layer scope outside current cms core runtime stream |
| `7f95cc64c57b439f58833d0300a1da93b3b893df` | skipped | - | app prompt-input quirks fix is app UI/editor behavior scope, deferred |
| `c9719dff7223aa1fc19540f3cd627c7f40e4bf36` | skipped | - | app notification navigation behavior is app shell scope, deferred |
| `dec304a2737b7accb3bf8b199fb58e81d65026e9` | skipped | - | ui avatar emoji handling is presentation-layer scope, deferred |
| `dd296f703391aa67ef8cf8340e2712574b380cb1` | skipped | - | app reconnect event stream fix is app global-sdk layer scope, deferred |
| `ebe5a2b74a564dd92677f2cdaa8d21280aedf7fa` | skipped | - | app remount SDK/sync tree behavior is app shell scope, deferred |
| `e242fe19e48f6aa70e5c3f7d54f34d688181edb2` | skipped | - | app prompt_async endpoint usage fix is app request UX path, deferred |
| `1c71604e0a2a34786daa99b7002c2f567671051a` | skipped | - | app terminal resize behavior is app component scope, deferred |
| `460a87f359cef2cdcd4638ba49b1d7d652ddedd5` | skipped | - | app filetree stack-overflow fix is app UI scope, deferred in current stream |
| `85b5f5b705e8f7852184a4ef147bdc826639d224` | skipped | - | app clear notifications feature is app UX scope, deferred |
| `985c2a3d15c13512b9bb456882b97ebe863cae5f` | skipped | - | app font option addition is settings/UI scope, deferred |
| `878ddc6a0a9eff4fe990dfc241a8eb1c72f0659d` | skipped | - | app keybind shift-tab fix is app command layer scope, deferred |
| `3c85cf4fac596928713685068c6c92f356b848f3` | skipped | - | app prompt history boundary navigation fix is app input scope, deferred |
| `cf50a289db056657171b73fb5e1f907b0baedd59` | skipped | - | app new-file viewing issue fix is app session page scope, deferred |
| `3a3aa300bb846ae60391ba96c5f1f4aa9a9a5d74` | skipped | - | ui localized free-usage message/link is ui/i18n feature scope, deferred |
| `b055f973dfd66965d998216db67df8534957e5e8` | skipped | - | app cleanup refactor is maintenance churn without targeted core runtime delta |
| `e0f1c3c20efb60f19f36e2c8df87dfd30fd2523e` | skipped | - | desktop loading-page cleanup is desktop shell UI scope, deferred |
| `3aaa34be1efe2e202312fe1312605c4cdac2e115` | skipped | - | desktop focus-after-update fix is desktop shell behavior scope, deferred |
| `920255e8c69270942206b60f94e26b545af18050` | skipped | - | desktop process-wrap/job-object architecture update is desktop shell scope, deferred |
| `60807846a92be5ab75367d8ca14b6b1bc697aebe` | skipped | - | desktop wayland/x11 normalization is platform windowing scope, deferred |
| `7d468727752646e30a1fcc70a9c1b2849c4da4cf` | skipped | - | desktop OPENCODE_SQLITE env handling depends on desktop/sqlite track not in current stream |
| `0b9e929f68f07652af85de70fa57f82760bc3331` | skipped | - | desktop rust fix is desktop shell maintenance scope, deferred |

## 已處理（origin/dev delta 2026-02-26 round63 (rewrite-only) @ 2026-02-25T20:14:52.314Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `9b23130ac47442a216d84eace4032369620e548a` | ported | - | added cljfmt formatter support (.clj/.cljs/.cljc/.edn) in cms formatter registry |
| `160ba295a88462844457342ca74fa036f19ecede` | ported | - | added dfmt formatter support (.d) in cms formatter registry |

## 已處理（origin/dev delta 2026-02-26 round64 (rewrite-only) @ 2026-02-25T20:15:20.571Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `0d90a22f9057dd69dca65ab52450f17d47a8656e` | skipped | - | provider adaptive reasoning + ai-sdk package update touches high-volatility provider transform path; defer to dedicated provider validation round |
| `afd0716cbdca5191b6c45dbc8325c6f9e658715f` | skipped | - | venice provider transform option support touches high-volatility provider path; defer for focused provider suite |
| `f7708efa5b87ae292c973d3fb409d060b5ed8f56` | skipped | - | google-vertex openai-compatible endpoint support is high-risk provider architecture delta; defer |
| `1d041c8861cdeb72fa2f31020991860a2cde8c28` | skipped | - | google vertex env var priority fix touches provider precedence semantics; defer with provider batch |
| `5cc1d6097e02e2f157b7ae68de9e5df06531b53d` | skipped | - | tui attach continue/fork flags alter session flow UX; defer to dedicated tui flow validation batch |
| `16332a858396c23c1bf6fa673964ae306d5414ab` | skipped | - | tui prompt autocomplete server-dir path behavior is high-volatility UX path; defer |
| `bb30e06855fb979b5fd765796a6b7428b9177b91` | skipped | - | tui tips text fix deferred with tui UX micro-fix batch |
| `fdad823edc13fbc8fbaf4bf54eae53b1286ee2e9` | skipped | - | db migrate command depends on sqlite migration command surface intentionally deferred in cms stream |
| `b0afdf6ea4c016c46762b649adc30c0456814a43` | skipped | - | session delete CLI command deferred pending broader session command parity batch |

## 已處理（origin/dev delta 2026-02-26 round65 (rewrite-only) @ 2026-02-25T20:16:42.725Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `b1764b2ffdba86c70c6f2777d1342ad87ac6ec41` | skipped | - | docs zh-cn translation correction only; no runtime behavior delta |
| `f991a6c0b6bba97be27f3c132c14c5fa78d05536` | skipped | - | generated docs content update only; no runtime behavior delta |
| `b8848cfae1012556f029b3b7c7317e4a27a30dfe` | skipped | - | docs ko phrasing polish only; no runtime behavior delta |
| `88e2eb5416043378f96720db83920f28e0250245` | skipped | - | README/docs installation text update only; no runtime behavior delta |
| `72c09e1dcceee8b38476b3541852436fa045b2be` | skipped | - | docs zh-cn terminology standardization only; no runtime behavior delta |
| `d9363da9eebc0481e9829f5b96cb07adcb4caaa8` | skipped | - | docs zh-cn zen translation correction only; no runtime behavior delta |
| `21e07780023dc34b57b1b79cf9715b537971d673` | skipped | - | generated docs content update only; no runtime behavior delta |
| `3ebf27aab92ac9c25b24f18c7fbd151da0f778ea` | skipped | - | docs ru zen translation correction only; no runtime behavior delta |
| `9f20e0d14b1d7db2167b2a81523a2521fe1c3b73` | skipped | - | web/app locale cookie redirect behavior is docs/web scope outside current core runtime stream |
| `37611217282b81458bcd5a74850bd96787721b06` | skipped | - | README translation addition only; no runtime behavior delta |

## 已處理（origin/dev delta 2026-02-26 round66 (rewrite-only) @ 2026-02-25T20:16:53.712Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `bc1fd0633dfd021545cd22041fab995f93ec2413` | integrated | - | cms test script already uses bun test --timeout 30000, matching upstream intent |
| `ef979ccfa899fe520d1cb15314dfbd487206a507` | skipped | - | dependency bump only (gitlab provider/auth); defer to dedicated dependency update batch |
| `ef205c366062fbf89ec49c9fc7f2a4b4c5223614` | skipped | - | dependency bump only (google-vertex); defer to dedicated dependency update batch |
| `575f2cf2a5e2246175a38dbf96bb1fed33186edc` | skipped | - | nixpkgs/toolchain bump bookkeeping; no standalone runtime behavior port |
| `66780195dc9ea5c79a4015f17771f53c19b37dcb` | skipped | - | generated sdk/openapi artifacts only; no selected runtime behavior delta |
| `85df1067130ef17e819900e303caec30ab012384` | skipped | - | generated openapi docs artifact only; no selected runtime behavior delta |
| `afb04ed5d48d40b20a7d7a33af54cc950f974425` | skipped | - | generated snapshots/openapi artifacts only; no selected runtime behavior delta |
| `089ab9defabc5887f741d8ae777249689bc0d2bf` | skipped | - | generated provider test artifact only; no selected runtime behavior delta |
| `306fc77076fa3ac0930efefc842e2f61cd5ddd19` | skipped | - | nix hash bookkeeping only; no runtime behavior delta |
| `7911cb62abe424337d934c03e48bc431199401e7` | skipped | - | nix hash bookkeeping only; no runtime behavior delta |

## 已處理（origin/dev delta 2026-02-26 round67 (rewrite-only) @ 2026-02-25T20:17:38.321Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `d30e91738570ee9ea06ca6f2d49bdae65b0ff3ec` | skipped | - | ui markdown cmd-click enhancement is app/ui interaction scope outside current cms core runtime stream |
| `b525c03d205e37ad7527e6bd1749b324395dd6b7` | skipped | - | toast css cleanup is presentation maintenance without runtime core behavior delta |
| `ebb907d646022d2e7bb8effc164e1f09943d64a9` | skipped | - | desktop/app large diff/file performance optimization is app/ui scope deferred with app parity track |
| `4f51c0912d76698325862e8fcd7d484b7b9a61fe` | skipped | - | app cleanup maintenance churn without selected core runtime behavior objective |
| `ae6e85b2a4d9addec1913ac2f770870456aa694a` | skipped | - | local opencode.jsonc comment cleanup is non-runtime housekeeping |
