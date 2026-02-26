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

## 已處理（origin/dev delta 2026-02-26 round68 (rewrite-only) @ 2026-02-25T20:19:07.123Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `9163611989678e7d8b585003655b6c8863e81f97` | skipped | - | publish workflow cache fix is CI pipeline scope without runtime behavior delta |
| `0e669b6016526d8966aae6ef548140765c93be9d` | skipped | - | setup-bun action runner condition change is CI scope |
| `422609722803c9babf5c9d28527725f488e5dda4` | skipped | - | publish workflow rust cache fix is CI scope |
| `ea2d089db0f4cc135234abcf8a231a49d23d53c5` | skipped | - | publish workflow condition fix is CI scope |
| `ed4e4843c2a65018d6f23f24f86c6a471e391053` | skipped | - | triage workflow/tool updates are repo operations scope, not runtime behavior |
| `ea96f898c01ae93be010c6904d0d736e31b96b04` | skipped | - | triage remap maintenance is repo operations scope, not runtime behavior |
| `1109a282e0070a8743243f614240526df38afcdd` | skipped | - | nix-eval workflow addition is CI infrastructure scope |
| `bca793d0643daccfdb06a8a2318cc78ba598cfe7` | skipped | - | triage agent label policy doc update only; no runtime behavior delta |
| `a344a766fd9190b994432e3889271e64fae5aa6f` | skipped | - | generated triage doc artifact only; no runtime behavior delta |

## 已處理（origin/dev delta 2026-02-26 round69 (rewrite-only) @ 2026-02-25T20:19:19.403Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `ace63b3ddb99335b9ff71121336f70407c4b3ea5` | skipped | - | zen docs content update only; no core runtime behavior delta |
| `a93a1b93e119a976935e5ab6f214ef7c33d60d45` | skipped | - | wip zen/catalog infra content track deferred from current runtime-focused stream |
| `8d0a303af48da5e6c6d5287ef2144bfb49ca13d0` | skipped | - | ko zen docs translation update only; no runtime behavior delta |
| `4fd3141ab5d43a55566042982fb4459b5716e140` | skipped | - | zh-cn/zh-tw docs translation wave only; no runtime behavior delta |
| `6e984378d7601f2a74640bb61e27648e2c470758` | skipped | - | ko plugins docs translation correction only; no runtime behavior delta |
| `4eed55973f002b4fecfcdfe10a01a798e80e83a3` | skipped | - | generated docs artifact only; no runtime behavior delta |
| `7a66ec6bc9e98c158d56c01ce5f3d23e1f8d512e` | skipped | - | zen docs content update only; no runtime behavior delta |
| `1e25df21a2db1efb60b51fa4e13ae79b6606d5af` | skipped | - | zen model/catalog content update deferred with zen track |

## 已處理（origin/dev delta 2026-02-26 round70 (rewrite-only) @ 2026-02-25T20:19:31.939Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `a580fb47d207150b0fdfe18297afb71edbdf577c` | skipped | - | attachment-id lifecycle refactor touches session/tool prompt contract and needs dedicated validation |
| `e35a4131d00729b9ef75ca86b03e70b656f00e2f` | skipped | - | message part ordering change in prompt assembly touches core prompt semantics; defer for focused session tests |
| `3b9758062126430a5665cae717092ac4cf93ea86` | skipped | - | read tool fs path handling refactor deferred to dedicated tool IO validation batch |
| `c56f4aa5d85df55f7c447821b07ee4b88d9b1d73` | skipped | - | session index micro-refactor deferred with broader session core cleanup batch |
| `47435f6e17ad44c62b4f439d2ff490212e1fa9e3` | skipped | - | models.dev fetch behavior change touches provider model-loading strategy; defer for focused provider test suite |
| `ad92181fa7fad0d81bce055a2a601072af6b38a9` | skipped | - | add Kilo provider is high-risk provider-surface expansion; defer for dedicated provider integration round |
| `0ca75544abe6f9aee28c9bf5d626055a5a5c862f` | skipped | - | Kilo autoload behavior fix depends on deferred Kilo provider integration |
| `572a037e5dd805f0b8124a87226969f70742dc08` | skipped | - | generated provider test changes tied to deferred Kilo provider track |
| `07947bab7d7f164ae5b46038deadda2284e97025` | skipped | - | new session banner UX change in tui route deferred with tui UX refresh batch |
| `5512231ca8744b222e5ecbd6e2c5140a204245af` | skipped | - | tui scrollbox style change deferred with tui visual polish batch |
| `ad3c192837cc740e189034d8f6fc9f6b72db9bda` | skipped | - | tui thread/worker exit lifecycle fix deferred for dedicated tui threading verification |
| `2a2437bf22cb8f5db5ddb46a004be628ea4a6624` | skipped | - | generated auth command artifact only; deferred with cli generation churn |
| `cb88fe26aa05dfb865c0f7f2589a35197deb6e24` | skipped | - | missing newline cleanup in export cmd is non-functional micro-change deferred |

## 已處理（origin/dev delta 2026-02-26 round71 (rewrite-only) @ 2026-02-26T02:22:55.142Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `fb7b2f6b4d66d14177b5c0168049863842665925` | skipped | - | app provider-model toggle UI feature deferred with app parity track |
| `0186a8506340f6f6715262d4986c45740fb488d5` | skipped | - | app prompt-input Escape handling fix is app UX scope outside current core runtime stream |
| `10985671ad9553e7ac594ede30981166f69ba3c5` | skipped | - | large app session timeline/turn rework is product UI architecture scope, deferred |
| `277c68d8e5f95b57d44e00ea180c359ada56bd3c` | skipped | - | app polish commit is UI scope, deferred |
| `e273a31e70741f48dbc316145c568306dfd09624` | skipped | - | titlebar icon spacing tweak is UI polish scope, deferred |
| `703d6347445e1465cdf5ac5c4381a9d89afa3889` | skipped | - | generated app header artifact only; deferred with app UI batch |
| `9b1d7047d4f17b37f6b3a3223a2669948424be08` | skipped | - | file tree toggle visibility tweak is app UI scope, deferred |
| `0cb11c241281b4d21ea6b2034b16aae1027b2884` | skipped | - | titlebar padding tweak is app UI scope, deferred |
| `d31e9cff6a76af9a4667507b359f713b6fdd1e7d` | skipped | - | titlebar border styling tweak is app UI scope, deferred |
| `a8669aba8fd37ae7b95b8bcadd44fd37c1b49c84` | skipped | - | titlebar active background tweak is app UI scope, deferred |
| `8fcfbd697a18477b899ca17454089c05e48366b8` | skipped | - | titlebar search text-size tweak is app UI scope, deferred |
| `ce0844273241ce842593cf55800b1409c01966cf` | skipped | - | titlebar search/keybind visual tweak is app UI scope, deferred |
| `98f3ff62734cde32eeaf1d6929ab76d923dd046f` | skipped | - | titlebar search/padding tweak is app UI scope, deferred |
| `8e243c6500e32af41cae47bba62dbba451f6a79d` | skipped | - | titlebar action padding tweak is app UI scope, deferred |
| `222b6cda96895fb86cee12b2a692a016bb09d637` | skipped | - | magnifying-glass icon tweak is UI polish scope, deferred |
| `5a3e0ef13aabd973f48b94fb74b9924a85211de0` | skipped | - | message hover meta display tweak is UI polish scope, deferred |
| `2cac84882380c8b2a6e3ae27521fedf80407124c` | skipped | - | provider catalog naming tweak in ui message meta is UI/product scope, deferred |
| `14684d8e75bfc9113657de6678dec7c03aeba7a1` | skipped | - | user message hover meta refinement is UI polish scope, deferred |
| `57a5d5fd342b6451384d7549b00189b6891116bf` | skipped | - | assistant response hover meta tweak is UI polish scope, deferred |
| `1d78100f63e81b7c945c8eda2ce0e42a9986fad2` | skipped | - | full-width user message meta tweak is UI scope, deferred |
| `652a77655461b9ae379d437ae667f6a0b97655eb` | skipped | - | copy-response tooltip text tweak is UI copy scope, deferred |
| `adfbfe350dac1c78359a38180bba8dafeed9d192` | skipped | - | prompt mode toggle clickability tweak is app UI scope, deferred |
| `92912219dfa0ef51c88a329e04e0b69446328c2b` | skipped | - | prompt mode icon color/padding tweak is app UI scope, deferred |
| `d327a2b1cf750a7552d149078658fdc8ad037171` | skipped | - | prompt input radio-group UX refactor is app UI scope, deferred |
| `26c7b240bac7ae9c4b9d0d4d50ae288479f861c3` | skipped | - | app css cleanup is non-core maintenance churn |
| `e345b89ce56cf7fbd0c58c5f882eaf9a8ebc8fb0` | skipped | - | tool-call batching display behavior in ui layer deferred with app/ui parity track |
| `20f43372f6714803246d50c08a60723469418f3a` | skipped | - | terminal disconnect/resync fix in app layer deferred with app parity track |
| `3a505b2691f956f4d11e167fe30096e346ad28ae` | skipped | - | virtualizer scroll-root fix in ui library scope deferred with app/ui track |
| `bab3124e8b74343fb93a4ff543fb7f9ed1a6f3c3` | skipped | - | prompt input quirks fix in app layer deferred with app parity track |

## 已處理（origin/dev delta 2026-02-26 round72 (rewrite-only) @ 2026-02-26T02:23:08.630Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `d93cefd47af5cb18f4c5e0a978537e1da9d58658` | skipped | - | console website Safari css fix is web product surface scope, deferred |
| `d338bd528c010bdab481e0e9ecc637674a2d5246` | skipped | - | desktop windows cli visibility behavior is desktop shell scope, deferred |
| `4d5e86d8a56f3aca4ef00eead34d33f3c6a41e07` | skipped | - | desktop e2e tests addition is app/desktop verification scope outside current runtime stream |
| `d055c1cad6b46bee80909d1feffc87be14598e00` | skipped | - | desktop sidecar health-check timeout behavior is desktop shell scope, deferred |
| `4025b655a403141ef34102daf33fca1a886ae540` | skipped | - | desktop shell replication refactor is desktop runtime scope, deferred |
| `7379903568552be7dcfe846856f6cdd547bd97f0` | skipped | - | file tree/titlebar visual tweaks are app UI scope, deferred |
| `a685e7a805454110d92ed4da5a3799a15ea1bcb9` | skipped | - | file icon monochrome behavior tweak is app UI scope, deferred |
| `df59d1412bd459d0f6cdc6b2c715501eaabf7043` | skipped | - | homepage video layout shift css fix is console website scope, deferred |

## 已處理（origin/dev delta 2026-02-26 round73 (rewrite-only) @ 2026-02-26T02:23:25.488Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `3dfbb7059345350fdcb3f45fe9a44697c08a040a` | skipped | - | cross app+server SSE reconnect hardening spans volatile surfaces; defer to dedicated reconnect validation round |

## 已處理（origin/dev delta 2026-02-26 round74 (rewrite-only) @ 2026-02-26T02:27:55.123Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `d27dbfe062b18f832acf958357e175ed18ab98d9` | ported | - | session list now uses listGlobal roots+limit path so --max-count is honored for root sessions |
| `e96f6385c20ddd7d2101f59bdd77a1ac58b1bd52` | ported | - | updated clojure parser wasm source to anomalyco fork to fix syntax highlighting |

## 已處理（origin/dev delta 2026-02-26 round75 (rewrite-only) @ 2026-02-26T02:28:08.685Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `b784c923a8eeab52412eaebb9a44ad05a1411165` | skipped | - | permission/layout visual adjustments are ui/tui polish scope deferred from current core runtime parity stream |
| `2c17a980ffdc019d46b9e48a22bf719c009075e0` | skipped | - | dock prompt shell extraction is ui refactor scope, deferred |
| `bd3d1413fdd1ae7708191c25c26bfb2cff347fd7` | skipped | - | warning icon visibility tweak for permission prompt is ui polish scope, deferred |
| `26f835cdd264b3e70afd6f8e3f4f14c12cd3aec4` | skipped | - | theme/icon color tweak is ui visual scope, deferred |
| `a69b339bafd3a1b95cdec9a3374e38959db9fe7b` | skipped | - | active icon button color tweak is ui visual scope, deferred |
| `0bc1dcbe1ba1f03c6c2af990bdbf784ca25a8c11` | skipped | - | icon transparency tweak is ui visual scope, deferred |
| `ce7484b4f5c3de1b83db4223052bdf9ce4c0cfb9` | skipped | - | share button text styling tweak is app ui polish scope, deferred |
| `bcca253dec379f5e16890d763a6e8ff5e06b5486` | skipped | - | titlebar hover/active style tweaks are ui polish scope, deferred |
| `3690cafeb842dd69f2d432e84b5c5d5f50268f77` | skipped | - | button hover/active style tweak is ui visual scope, deferred |
| `4e959849f6a09b8b8094797d0885c6ae5030e6ee` | skipped | - | filetree tab hover/active style tweak is ui visual scope, deferred |
| `2f567610600a133a668d2ebd4d7c3fdd9efa098b` | skipped | - | expanded titlebar button color state tweak is ui visual scope, deferred |
| `fbe9669c5785d51e3e4e5ec17dbb846a742614ca` | skipped | - | file-tree icon group-hover color swap tweak is app/ui visual scope, deferred |

## 已處理（origin/dev delta 2026-02-26 round76 (rewrite-only) @ 2026-02-26T02:28:25.164Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `7ed449974864361bad2c1f1405769fd2c2fcdf42` | skipped | - | generated app e2e artifact only; no selected core runtime behavior port |
| `6eb043aedb81705aa2fa47629d8c778c16b307f9` | skipped | - | beta PR workflow/automation update is CI operations scope, deferred |
| `5aeb305344830aec9a3c8f84f595487bfd930417` | skipped | - | desktop WSL feature toggle change is app/desktop product scope, deferred |
| `6cd3a5902260764899a566b33d7f76123b9c9800` | skipped | - | desktop cleanup refactor is desktop shell maintenance scope, deferred |
| `3394402aefecbaa7f7f469344811b4089a2ddb01` | skipped | - | ui cleanup churn without selected core runtime objective |
| `cc86a64bb57bfa4361eafdaa31bdda29cf8b52ee` | skipped | - | mode-toggle icon styling simplification is app ui polish scope, deferred |
| `c34ad7223afff318cffef97cf84b8ec579ac352d` | skipped | - | message-part cleanup is ui maintenance scope, deferred |
| `e132dd2c703907dd42b56be98ce72ac1bf0b08d8` | skipped | - | message-part cleanup is ui maintenance scope, deferred |
| `e4b548fa768a59cea7e5c8279e327d990cd36c27` | skipped | - | SECURITY.md policy text update only; no runtime behavior delta |
| `bad394cd497da2245956e3e301b12351a379a940` | skipped | - | remove leftover patch file is repo hygiene scope, non-runtime |
| `00c238777ae11dfd61c6249426cd201fc3612f1b` | skipped | - | app cleanup across session pages is maintenance scope, deferred |
| `2611c35acc3dc64582e15ad1efca36c60a2883a8` | skipped | - | diff hiding threshold behavior in ui review is app/ui product scope, deferred |
| `1bb8574179bbf7c49a34ad0e5df522a752af08c2` | skipped | - | server management backend refactor is broad app architecture scope, deferred |
| `4a5823562ca2f2ee0255aa815228e9973b6efb28` | skipped | - | desktop isLocal behavior fix in app server context deferred with desktop/app parity track |
| `f8904e3972fba3d9fc3b08fa2531da8fca378dd1` | skipped | - | desktop sidecar project key behavior fix deferred with desktop/app parity track |
| `fc1addb8f4830e71c268fb0609fa6489cd55e2b2` | skipped | - | CONTRIBUTING.md tweak only; no runtime behavior delta |

## 已處理（origin/dev delta 2026-02-26 round77 (rewrite-only) @ 2026-02-26T02:30:05.716Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `d447b7694afc0080b78e7052b9de4c5a1a5f9eaf` | ported | - | github command now emits explicit PROMPT_TOO_LARGE diagnostics for ContextOverflowError with prompt-file size details |
| `de25703e9dd33df4dff6b5b8ae9a722f6ca2aa81` | integrated | - | pty cross-talk protections already covered in cms via stronger socket/token isolation and existing pty-output-isolation regression tests |

## 已處理（origin/dev delta 2026-02-26 round78 (rewrite-only) @ 2026-02-26T02:30:41.756Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `d6331cf792e02c75a96f5f8a39adaedd9a2d1298` | skipped | - | ui colors update is presentation/theme scope, deferred |
| `12016c8eb451a119c1017b2fc5554b49232399e3` | skipped | - | oc-2 theme init is theme system rollout scope, deferred |
| `5d69f00282376bdde4133459374593457ab33e83` | skipped | - | button style tweaks are ui visual scope, deferred |
| `24ce49d9d7c225651eb04db49f4a92f57a0d3412` | skipped | - | smoke color fallback tweak is ui visual scope, deferred |
| `0888c02379f0dd57a17b42788469d713c71ddb51` | skipped | - | file tree background color tweak is ui visual scope, deferred |
| `9110e6a2a7bc87ef34187f40803c8eb0b3025569` | skipped | - | share button border tweak is ui visual scope, deferred |
| `f20c0bffd3e6701ce191ed49dab1fa29400e866f` | skipped | - | titlebar expanded button background tweak is ui visual scope, deferred |
| `e5d52e4eb528055ffc0d461c451ff4c79fe7e99d` | skipped | - | pill tabs pressed background tweak is ui visual scope, deferred |
| `4db2d94854500cf939b95fb030e35c29982f1fdf` | skipped | - | filetree tab height tweak is ui visual scope, deferred |
| `08739080309bb84be71b5dd30ce6541e1bf9c029` | skipped | - | oc-2 theme color updates are theme visual scope, deferred |
| `1f9be63e962374e2a0c668d8098b4dccb4d0b79a` | skipped | - | secondary button border/icon style tweak is ui visual scope, deferred |
| `6d69ad557448ffb11194af0e37e3818422cc4bd6` | skipped | - | oc-2 secondary button color tweak is theme visual scope, deferred |
| `db4ff895793d61e7a99e1c6c86f6d50bf4a854c6` | skipped | - | oc-2 theme update is visual scope, deferred |
| `1ed4a982333c494590c1798cc01aeb19b72f6aca` | skipped | - | secondary button transition tweak is ui visual scope, deferred |
| `431f5347af8d67f0ae0d46dae2b388f253b45da4` | skipped | - | search button style tweak is ui visual scope, deferred |
| `c7a79f1877d0f13f194db5e072f2ee4cef5e174a` | skipped | - | icon-button css update is ui visual scope, deferred |
| `e42cc8511299ce1a9f311d3446b03747823a23fc` | skipped | - | oc-2 theme update is visual scope, deferred |
| `d730d8be01366999f4f453db3b7bddaf7970e0c1` | skipped | - | review diff style toggle sizing tweak is ui visual scope, deferred |
| `1571246ba8f9c0f41889de5516769116aee38692` | skipped | - | segmented control cursor tweak is ui visual scope, deferred |
| `1b67339e4dd9902b4d59abc444df8d9b52a6b67e` | skipped | - | radio-group css update is ui visual scope, deferred |

## 已處理（origin/dev delta 2026-02-26 round79 (rewrite-only) @ 2026-02-26T02:31:37.359Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `6b29896a35700805750a53caff7d4c6aad7e1f11` | skipped | - | broad Filesystem-module migration foundation touches many core surfaces; defer to dedicated stabilization branch |
| `37b24f4870dc35f369e4827b89b0159c12daf4df` | skipped | - | index.ts filesystem migration is part of broad refactor wave deferred for focused validation |
| `3d189b42a3bdd98675a972524389399d229d96a3` | skipped | - | ripgrep/config filesystem migration is part of deferred refactor wave |
| `a5c15a23e4b352b21c4e0fe8056c302436564107` | skipped | - | filesystem readJson typing refactor deferred with core filesystem migration wave |
| `472d01fbaf8e5aa46048062d3dd8f7acb1fc2c49` | skipped | - | run/github filesystem migration is part of deferred refactor wave |
| `a500eaa2d425978ad97b3e034404adcaab171411` | skipped | - | formatter filesystem migration deferred with broad refactor wave |
| `82a323ef7005206541de7a40e975c63a9977e902` | skipped | - | github command filesystem migration commit in deferred refactor wave |
| `ef155f3766868d3148efa8925e432b974edf0353` | skipped | - | file/index filesystem migration deferred with broad refactor wave |
| `8f4a72c57a28009a576f65ee713c1241fc3df35f` | skipped | - | config/markdown/uninstall filesystem migration deferred with broad refactor wave |
| `e0e8b94384c3df20fd56a8754383a7b52cbd0240` | skipped | - | uninstall filesystem migration deferred with broad refactor wave |
| `c88ff3c08b508da1c3f473d1a4ffc883df7b65f8` | skipped | - | bun/index filesystem migration deferred with broad refactor wave |
| `eb3f337695638234c28b06cdaa8515ac48443e56` | skipped | - | tui clipboard filesystem migration touches UX path and is deferred |
| `5638b782c56e00bceeb029066811a0712c68e2ec` | skipped | - | tui editor filesystem migration touches UX path and is deferred |
| `8bf06cbcc159a3a3a0711cff67c2e5538793445d` | skipped | - | global index filesystem migration deferred with broad refactor wave |
| `38572b81753aa56b7d87a9e46cdb04293bbc6956` | skipped | - | julia LSP support is medium-scope feature addition deferred from current runtime parity priorities |
| `1aa18c6cd64412db89ccfb58c2641ab3e49233e4` | skipped | - | plugin shell.env hook payload expansion touches prompt/tool contract; defer for focused plugin compatibility round |
| `2d7c9c9692f9232d2977487f13ecddc758a4a250` | skipped | - | generated artifacts tied to deferred plugin shell.env hook payload change |
| `be2e6f1926176dadb5a5cf12d5790189a6a5bb50` | skipped | - | pasteImage count behavior tweak in tui prompt path deferred with high-volatility UX fixes |

## 已處理（origin/dev delta 2026-02-26 round80 (rewrite-only) @ 2026-02-26T02:31:53.550Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `3aaf29b69344917f3dfee8a9ca35fb24b74f2b9b` | skipped | - | nix hash bookkeeping only; no selected runtime behavior delta |
| `91a3ee642d72b95367f745134c381c129552fbc9` | skipped | - | nix hash bookkeeping only; no selected runtime behavior delta |
| `c6bd32000302c0cf607c1e91c536537e43848237` | skipped | - | nix hash bookkeeping only; no selected runtime behavior delta |
| `83b7d8e04cd4e4d343f2006278ade0caa82173d2` | skipped | - | gitlab provider dependency bump deferred to dependency maintenance track |
| `24a98413223c8309194e1578f491d92874c9aa9f` | skipped | - | sst version/tooling update across infra/env files deferred from current runtime parity stream |
| `b714bb21d232d9c9fbb7fb1915c752d7ff4f150d` | skipped | - | setup-bun cache action switch is CI/tooling scope without selected runtime behavior objective |

## 已處理（origin/dev delta 2026-02-26 round81 (rewrite-only) @ 2026-02-26T02:33:58.889Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `46739ca7cd970cf84f88c3f0cf5ca8b756b64f7d` | skipped | - | app tab-switch flashing fix is app/global-sync layer scope deferred with app parity track |
| `3f60a6c2a46dab1622ee4f4c99e4dfad876f3a3c` | skipped | - | app cleanup maintenance scope, deferred |
| `ef14f64f9ee10ee7945a547bde4b13d6dcf2f0bd` | skipped | - | app/global-sync cleanup refactor scope, deferred |
| `8408e4702e0d0eebd3a459577be3d50082c3f603` | skipped | - | app session commands cleanup scope, deferred |
| `72c12d59afca7092dc98842b094305d385cf7863` | skipped | - | ui i18n cleanup scope, deferred |
| `42aa28d512d4ea77bef6159530b8bac9c7c872a0` | skipped | - | app cleanup sweep scope, deferred |
| `1133d87be043ab999be5002380584b21653e09c4` | skipped | - | app helper/session-side cleanup scope, deferred |

## 已處理（origin/dev delta 2026-02-26 round82 (rewrite-only) @ 2026-02-26T02:34:13.157Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `09286ccae0759880513ca8beba0ef81b0cb0fb09` | skipped | - | oc-2 theme update is ui visual scope, deferred |
| `06b2304a5f66cc4f72c95900717b674a66b5f308` | skipped | - | review radio-group css tweak is ui visual scope, deferred |
| `31e964e7cf4f83abec80640bb1f70a950615c595` | skipped | - | oc-2 theme update is ui visual scope, deferred |
| `bb6d1d502fb9afb034da2c20078e6d4b5f9c6e2f` | skipped | - | review diff hover-radius tweak is ui visual scope, deferred |
| `47b4de3531ac8f32f90be3f867dba02120d2b83a` | skipped | - | review header spacing tweak is ui visual scope, deferred |
| `ba919fb619312c4c77865d4506d5a400d2abca26` | skipped | - | review expand/collapse width tweak is ui visual scope, deferred |
| `50923f06f14b32e30adada30417a931bcb5bb03a` | skipped | - | secondary button pressed-scale tweak is ui visual scope, deferred |
| `d8a4a125c008ba75e28d9391ec040da6d9da6d65` | skipped | - | oc-2 theme update is ui visual scope, deferred |
| `7faa8cb1101041b65eab32c92790e5ad033f63d5` | skipped | - | review panel padding tweak is ui visual scope, deferred |
| `dec7827548acc3fda3cbfcbb19e0bcbda1222e7a` | skipped | - | generated theme artifact only; no selected core runtime behavior delta |
| `c71f4d4847b1a9689955ee63f9a18fcd577794ee` | skipped | - | oc-2 theme update is ui visual scope, deferred |
| `ec7c72da3fbc232e4eaceed6a3ccecb255f00756` | skipped | - | reasoning block restyle is ui visual scope, deferred |

## 已處理（origin/dev delta 2026-02-26 round83 (rewrite-only) @ 2026-02-26T02:34:37.470Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `d5971e2da55fe266da577387c79f9967a5b8c5c1` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `898bcdec870c1c9c1ea6f3bea9af5bc8616ac5cd` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `3cde93bf2decbebf9869cfbe9e8f6e960ca9ac86` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `a2469d933e1a72db6b3ccdeb29624b56ad1c3547` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `e37a9081a673045c7be2de803806e968e5db806c` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `a4b36a72adabe37e2799bd0c6c81acfaf2516005` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `d366a1430fddf22499068e60428e4b278a84ee31` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `b75a89776dc5f52b44bc7731a96d7b27b199d215` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `97520c827ec59556eff6cff48b80eb84556eb5ec` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `48dfa45a9ac1ba92d94289da26c23e2dba6c2db7` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `6fb4f2a7a5d768c11fafdeae4aa8b5c7fcb46b44` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `5d12eb952853ea94881e3a06e8213b7e0f20975c` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `359360ad86e34db9074d9ef1281682206615d9cc` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `ae398539c5de6f0dea245807f9a58c8126acc29f` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `5fe237a3fda1b4dcc5e76ed8b36f07d73fad3321` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `57b63ea83d5926ee23f72185c6fb8894654e2981` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `a8347c3762881f03e096e484a72302302f025a65` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `9e6cb8910109cc6b11792e0bfac9268d65122c74` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `819d09e64e1ef7c49f33ee5f668f37f50e6d61fb` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `a624871ccdd9066b5949825176970625748b9c03` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `bd52ce5640f0299f49f2bc2bfadcb95c2acec260` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `270b807cdf004b4ae398414e1475f9dc24e5cb43` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `36bc07a5af1c5a98bf1f9e6c1913ee720286ca6d` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `14c0989411a408c680404b7313382b54dee8ca07` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `3a07dd8d96e3e4cbc6787ae14add19b2d58023be` | skipped | - | filesystem migration wave commit deferred for dedicated stabilization branch |
| `568eccb4c654e83382253eb0c1478d24585288aa` | skipped | - | upstream revert wave for filesystem migration is deferred with the same branch-level stabilization track |
| `02a94950638b4403a9ea44aeeb2d3d19212a04ec` | skipped | - | broad remove-Bun.file wave touches many core/runtime/test surfaces; deferred from throughput pass |
| `38572b81753aa56b7d87a9e46cdb04293bbc6956` | skipped | - | julia LSP support feature deferred to dedicated LSP feature batch |
| `87c16374aaafc309c237d05244d8cca974e28c34` | skipped | - | terraform-ls installer source change deferred with LSP integration batch |
| `11a37834c2afd5a1ba88f8417701472234caaa3a` | skipped | - | tui exit callback timing behavior touches high-volatility lifecycle path; deferred |
| `3c21735b35f779d69a5458b1fa5fada49fb7decb` | skipped | - | Bun.Glob -> npm glob migration is broad core refactor with high regression risk; deferred |

## 已處理（origin/dev delta 2026-02-26 round84 (rewrite-only) @ 2026-02-26T02:48:03.634Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `2589eb207fddda12418eb38af675eea6da4be6e7` | skipped | - | app prompt/input tooltip polish scope, deferred from runtime parity stream |
| `cfea5c73de94474d7584906caf4b3f55b2903b23` | skipped | - | app prompt cleanup scope, deferred from runtime parity stream |
| `7fb2081dcecacddf780a91cb5f1e7c6a81574fb5` | skipped | - | app prompt cleanup scope, deferred from runtime parity stream |
| `c76a81434d2228ac1913cf52caf4d3953ab75fe2` | skipped | - | app command cleanup scope, deferred from runtime parity stream |

## 已處理（origin/dev delta 2026-02-26 round85 (rewrite-only) @ 2026-02-26T02:48:09.926Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `7033b4d0a856982a326d48dd8d86f717e28ed379` | skipped | - | desktop sidecar event/addon cleanup in app-shell lifecycle scope, deferred |
| `885d71636f99074dcc87ba6527f0c9beaba5f623` | skipped | - | desktop sidecar reconnect flow in app-shell lifecycle scope, deferred |
| `d2d5f3c04b09228d2d94e00695de8ca3a4d58a16` | skipped | - | desktop sidecar cleanup scope, deferred |
| `1c2416b6deb1eee856d1fddbf08300cf851a19fc` | skipped | - | desktop sidecar cleanup scope, deferred |
| `fca0166488a9318540c02c63b59933d976d84ea9` | skipped | - | app-server plugin socket behavior in desktop/app integration scope, deferred |
| `a04e4e81fbd1ec0e2a7d20ec6f40dd0dfa277b81` | skipped | - | app-server cleanup in desktop/app integration scope, deferred |

## 已處理（origin/dev delta 2026-02-26 round86 (rewrite-only) @ 2026-02-26T02:48:18.136Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `639d1dd8fea6d77c648df4eabf8ea9d6973c27bb` | skipped | - | CI policy update scope without selected runtime behavior delta |
| `b9096793678c721b7fae5ae31a8e00622edbf780` | skipped | - | docs wording update scope, deferred |
| `c1620748887c9b963fe665b47519b264fe748044` | skipped | - | CI policy update scope without selected runtime behavior delta |
| `d86c10816d75837c8f85e7b1ab0de5ff37ecf77b` | skipped | - | docs wording update scope, deferred |
| `d32dd4d7fde75faa802dd8a306aae43bcfa1ef61` | skipped | - | CI workflow maintenance scope without selected runtime behavior delta |
| `ae50f24c0678c58b4e5e796b3ff5b86eeaa3f7fd` | skipped | - | CI policy update scope without selected runtime behavior delta |
| `b64d0768baac8066b5002c2e31a5afe8687bdf3b` | skipped | - | docs wording update scope, deferred |

## 已處理（origin/dev delta 2026-02-26 round87 (rewrite-only) @ 2026-02-26T02:49:47.008Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `ba53c56a2161a42de468f77a6e5f59a7f0a5fa3b` | skipped | - | ui review diff grouping tweak is visual UX scope, deferred |
| `9c7629ce61b4525d0a773bf307e805b3a414dd34` | skipped | - | oc-2 theme update is visual theme scope, deferred |
| `4a8bdc3c7593f0444355edb5193744faaeeb76ed` | skipped | - | edited-files list styling tweak is visual UI scope, deferred |
| `fd61be40788b53915f2b7f97ccefb0416327c452` | skipped | - | review diff count display tweak is visual UI scope, deferred |
| `a301051263187275afa25f62bfb4affe35776d4b` | skipped | - | review diff spacing tweak is visual UI scope, deferred |
| `40f00ccc1c269a31a761617d42f47330eb6ade8d` | skipped | - | chevron icon style tweak is visual UI scope, deferred |
| `44049540b06d1abcd5d3de17308802e96614cb7f` | skipped | - | open-file tooltip icon tweak is visual UI scope, deferred |

## 已處理（origin/dev delta 2026-02-26 round88 (rewrite-only) @ 2026-02-26T02:49:54.079Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `3d0f24067c14bb8b4815c45ebd22f3f34c87a446` | skipped | - | app prompt dock padding tweak is app UX polish scope, deferred |
| `5d8664c13eae3328eddf3177028e6d332dbc865c` | skipped | - | session turn padding tweak is app UX polish scope, deferred |
| `6042785c57d9488568da0cda5267510d969b1316` | skipped | - | edited file path truncate tweak is UI polish scope, deferred |
| `802ccd37888b355dcd779be48b4994efc92168fa` | skipped | - | collapsible chevron rotation tweak is UI polish scope, deferred |
| `d620455531443340d2719510d37e80af433cef7e` | skipped | - | app server list dedup tweak is app behavior polish scope, deferred |
| `3a416f6f33254e541de05cb2d661bdc0d010dd9e` | skipped | - | sdk publish script nested export transform tweak is sdk tooling scope, deferred |

## 已處理（origin/dev delta 2026-02-26 round89 (rewrite-only) @ 2026-02-26T02:50:01.616Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `1893473148e90e98e49759b58bfe88d97ff9f7d3` | skipped | - | OPENCODE_CONFIG_CONTENT substitution alternate take deferred pending dedicated config parity batch |
| `4b878f6aebb089244d69aa7cb7806e65e61bfbed` | skipped | - | generated config artifact commit only; deferred |
| `308e5008326df36e23ed97106f1acbfcac247c45` | skipped | - | provider auth package bake-in is high-risk provider packaging change, deferred |
| `c7b35342ddca083b2a2b9668778b4cccb6b5f602` | skipped | - | nix hash bookkeeping only; no selected runtime behavior delta |
| `d07f09925fae3dd0eac245b1817ace5eee19f0aa` | integrated | - | terminal isolation/rework behavior already represented in cms PTY handling path |
| `38f7071da95075bce7029eff52ec7153046dd318` | skipped | - | ui pierre cleanup scope, deferred |
| `338393c0162452777ce40f4dbc75eefe4667a3e6` | skipped | - | accordion style fixes are app/ui presentation scope, deferred |
| `0fcba68d4cd07014dda445543f70945379519ba0` | skipped | - | mixed cleanup across app/ui components, deferred |

## 已處理（origin/dev delta 2026-02-26 round90 (rewrite-only) @ 2026-02-26T02:50:09.166Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `08a2d002b8f972c98911fd3b25c847c0da8b1d9b` | skipped | - | zen docs update scope only, deferred |
| `6b8902e8b91a7561d57f80249feada949c4d0665` | skipped | - | app project-nav session behavior is app-shell scope, deferred |
| `56dda4c98c209a96967f045988e17486d616269f` | skipped | - | app/ui cleanup scope, deferred |
| `f2858a42ba17fba1e3376440e8f3aae2aa64ca61` | skipped | - | app e2e/layout cleanup scope, deferred |
| `50883cc1e995df3f14e31bdc1b5efa0d70b5ac51` | skipped | - | app localhost isLocal tweak in app context scope, deferred |
| `af72010e9fa78e68be74f6ab6f29f507a44f4f86` | skipped | - | revert of Bun.Glob migration wave tracked as deferred core stabilization scope |
| `850402f093be5345390a5a07ecfa8939d7275d9a` | skipped | - | nix hash bookkeeping only; no selected runtime behavior delta |
| `91f8dd5f573ff00ebe14dc3ad701d1e038fca64c` | skipped | - | nix hash bookkeeping only; no selected runtime behavior delta |

## 已處理（origin/dev delta 2026-02-26 round91 (rewrite-only) @ 2026-02-26T02:50:17.017Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `5364ab74a242197e76a4ad3f5b557878eaa63960` | skipped | - | provider transform reasoning support change is provider policy scope, deferred |
| `7e35d0c61053e43f18da18a0158d7e0d325b5f96` | skipped | - | ai sdk dependency bump wave is high-risk provider/tooling scope, deferred |
| `cb8b74d3f1d16b50e4d7b641cb2ac205fc275565` | skipped | - | Bun.Glob migration wave is broad/high-risk core refactor, deferred |
| `8b99648790c6c0137e763c0755111908d585578f` | skipped | - | nix hash bookkeeping only; no selected runtime behavior delta |
| `00c079868af4068cc43f52f1b6ff11a1a975aad4` | skipped | - | test discovery fixture/server boot update is test harness scope, deferred |
| `1867f1acaa894244086d994c71b47bff8301f747` | skipped | - | generated fixture docs commit only; deferred |
| `3d9f6c0fe0c73eacdd50bc0041f53826eaa82e19` | skipped | - | i18n translation update scope, deferred |
| `7729c6d895a7dff4e39fd28574103f97aabd2c0d` | skipped | - | ui css cleanup scope, deferred |

## 已處理（origin/dev delta 2026-02-26 round92 (rewrite-only) @ 2026-02-26T02:50:26.082Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `40a939f5f0897c9bd22153a0269cfaeb178d84ff` | skipped | - | app/ui cleanup scope, deferred |
| `f8dad0ae170acb9667d9402c162f7c29980373c1` | skipped | - | app terminal issues fix stays in app-terminal parity track, deferred |
| `49cc872c4415f081b4208d16fd0d85e425a75eed` | skipped | - | composer/dock refactor wave is app architecture scope, deferred |
| `1a1437e78b37c37a6f96531366957ea8f0252d11` | skipped | - | github action branch/422 handling follow-up deferred to dedicated github parity batch |
| `04cf2b82683042482b33f4ca15a24a9024a67a50` | skipped | - | release rollup bookkeeping commit; no standalone behavior to rewrite-port |
| `dd011e879cbfd59c1abf9dc649b89a23bd6d4665` | skipped | - | app todo abort-clear behavior is app UI flow scope, deferred |
| `7a42ecdddb4aa9a768c6193988e0935d77119123` | skipped | - | app composer cleanup scope, deferred |
| `824ab4cecc9defe2cecc8109af291a2fdb1de736` | skipped | - | tui custom tool/mcp response UX change is tui feature scope, deferred |

## 已處理（origin/dev delta 2026-02-26 round93 (rewrite-only) @ 2026-02-26T02:50:34.044Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `193013a44dfd62645ef03475b4f2f3a0380167fd` | skipped | - | adaptive thinking support change is provider policy scope, deferred |
| `686dd330a09c3b4f774b699cfa294fd7224619b5` | skipped | - | generated provider transform artifact commit only; deferred |
| `f2090b26c161dab7cfd366a782ce484bee936266` | skipped | - | release rollup bookkeeping commit; no standalone behavior to rewrite-port |
| `cb5a0de42f6bac3b328fd158692ca15b37c63d84` | skipped | - | llm test assertion maintenance scope only; deferred |
| `01d518708ac86368463712568e84ef8995d99578` | skipped | - | session loop deep-clone removal is high-risk core runtime refactor, deferred |
| `8ad60b1ec2002e8d9f841ba256c3eed1953a7ec6` | skipped | - | structuredClone prompt history/stash refactor is high-risk tui internals scope, deferred |
| `998c8bf3a5ad3e0244034030f9e981dce3f71168` | skipped | - | ui chevron hover tweak is visual scope, deferred |
| `a3181d5fbd73acb13561665987373a28d3a27b40` | skipped | - | ui chevron nudge tweak is visual scope, deferred |

## 已處理（origin/dev delta 2026-02-27 round62 (rewrite-only app-ui batch A-D1+e345) @ 2026-02-26T16:28:33.256Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `878ddc6a0a9eff4fe990dfc241a8eb1c72f0659d` | ported | `979fb5025d070ac8082b7b60513cdd1b97d533e4` | allow Tab/Shift-Tab keybind path in editable targets to avoid blocking prompt interactions |
| `3c85cf4fac596928713685068c6c92f356b848f3` | ported | `979fb5025d070ac8082b7b60513cdd1b97d533e4` | tighten prompt history navigation to cursor boundary semantics including in-history mode |
| `958320f9c1572841c6c4b7aeba4559a79693002d` | ported | `53b9998817cc86d172cc8e2ab49c9bed16cde946` | use platform fetch for remote non-loopback HTTP event stream with authenticated fallback |
| `460a87f359cef2cdcd4638ba49b1d7d652ddedd5` | ported | `6d75714314c48fc34a49b0f8d55e1058748b10fe` | harden file tree against deep/cyclic traversal via depth+cycle guards and iterative walk |
| `0186a8506340f6f6715262d4986c45740fb488d5` | ported | `459c58348c9317509d661e4da6fed3a6659eabf6` | keep Escape handling local in prompt input and support macOS desktop blur behavior |
| `20f43372f6714803246d50c08a60723469418f3a` | ported | `459c58348c9317509d661e4da6fed3a6659eabf6` | terminal writer now flushes with completion callback before persistence on cleanup/disconnect |
| `3a505b2691f956f4d11e167fe30096e346ad28ae` | ported | `459c58348c9317509d661e4da6fed3a6659eabf6` | virtualizer resolves actual scroll root outside session-review container |
| `46739ca7cd970cf84f88c3f0cf5ca8b756b64f7d` | ported | `459c58348c9317509d661e4da6fed3a6659eabf6` | avoid unnecessary loading-state reset in global-sync bootstrap to reduce tab-switch flashing |
| `e345b89ce56cf7fbd0c58c5f882eaf9a8ebc8fb0` | ported | `a41b289a530e6d854fdbabe55c9192574b971bc9` | batch assistant tool-call parts across turn messages with cms-specific filtering rules preserved |
| `0771e3a8bee1b099468f3c95e19bd78699f62b12` | integrated | - | plain-text paste undo preservation already present in current cms prompt input behavior |
| `0303c29e3ff4f45aff4176e496ecb3f5fa5b611a` | integrated | - | store creation defensive handling already present in cms app layer |
| `7f95cc64c57b439f58833d0300a1da93b3b893df` | integrated | - | prompt input quirks fixes are largely already covered in cms implementation |
| `1c71604e0a2a34786daa99b7002c2f567671051a` | integrated | - | terminal resize stability behavior already integrated in cms terminal component |
| `d30e91738570ee9ea06ca6f2d49bdae65b0ff3ec` | integrated | - | inline-code cmd-click link behavior already integrated in current ui markdown stack |
| `81b5a6a08b6b2f591096a0f9a7fed04871002a33` | integrated | - | workspace reset behavior already present in cms state/layout flow |
| `ed472d8a6789c882dfbba7facfd987fd8dd6fb2c` | integrated | - | session context metrics defensive defaults already present in cms |
| `ff0abacf4bcc78a1464f54eec2424f234c1723c9` | integrated | - | project icon unloading fix already covered by cms sidebar/project rendering behavior |
| `50f208d69f9a3b418290f01f96117308842d9e9d` | integrated | - | slash suggestion active-state logic already integrated in cms prompt popover flow |
| `c9719dff7223aa1fc19540f3cd627c7f40e4bf36` | integrated | - | notification click routing to session is already present in cms desktop/app integration |
| `dd296f703391aa67ef8cf8340e2712574b380cb1` | integrated | - | event-stream reconnect path already integrated in cms global sdk loop |
| `ebe5a2b74a564dd92677f2cdaa8d21280aedf7fa` | integrated | - | sdk/sync remount-on-server-url-change behavior already integrated in cms app lifecycle |
| `81ca2df6ad57085b895caafc386e4ac4ab9098a6` | integrated | - | randomUUID insecure-context guard already present in cms uuid helpers |
| `a82ca860089afde16afdcb1cff0592c6ac0f4aa4` | integrated | - | defensive code component behavior already present in current ui code renderer |
| `ff3b174c423d89b39ee8154863840e48c8aac371` | integrated | - | oauth error message normalization already present in cms connect-provider path |
| `dec304a2737b7accb3bf8b199fb58e81d65026e9` | integrated | - | emoji avatar handling already integrated in current ui avatar component |

## 已處理（origin/dev delta 2026-02-27 round63 (rewrite-only app-ui+desktop E1/E2/E3A/E3B) @ 2026-02-26T16:57:39.995Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `7e681b0bc02b98e932a51e5469bcaeb6649c5f75` | integrated | - | large-paste prompt lock runtime fix already present in cms; added regression test coverage only |
| `9c5bbba6eab4466621028e3cf3467119051423fb` | integrated | - | patch tool single-file apply_patch rendering already aligned with edit-style path in cms |
| `0ce61c817b74e31e08bd140611e2f7ae6ba1684c` | integrated | - | auto-scroll pinned behavior for todos/questions/perms already present in session scroller logic |
| `46361cf35ce39c5b233fb5a727744255312c85d6` | integrated | - | session-review rerender controls already integrated via existing memoization/diff mapping path |
| `1de12604cf74aaeacbff54d7feb18c7d41bea2b1` | integrated | - | root workspace slash/path handling already present in message-part path helpers |
| `7e1051af0784693d7fc37ae31d6f513d47e0d24b` | skipped | - | assistant-meta duration model diverges in cms UI and current turn-level duration display is accepted |
| `8e96447960637c2371fb94ca7ce7b456048a0de6` | skipped | - | upstream todo-dock target path does not exist in current cms composer layout |
| `3b5b21a91e2a8f084ee8ed85aca81246880a9384` | ported | `409496e870b0ebc960576c516999b4dbdab59da8` | harden markdown decoration to prevent duplicate wrappers/buttons under morph updates |
| `8f2d8dd47a45a4b3972ac8badc09cc280f84b838` | ported | `409496e870b0ebc960576c516999b4dbdab59da8` | follow-up duplicate markdown safeguards included in same markdown decoration rewrite |
| `93615bef28fe0e17f673ba0f90c171309f7d5f91` | integrated | - | plugin dependency install/load failure handling already integrated in cms cli/plugin flow |
| `ac0b37a7b7a8dfc55a682b94cff0020ad28cca66` | integrated | - | snapshot staging already respects .git/info/exclude through add/syncExclude pipeline |
| `2410593023d2c61f05123c9b0faf189a28dfbeee` | integrated | - | github action/run variant wiring already present in cms action.yml and github command path |
| `0042a07052ec0db777b2ea8bff46101466f0a942` | ported | `bc4f9dac226f8a1ba379ea1784a67bfcc100301d` | normalize patch/apply_patch/snapshot/bash path parsing and display for Windows compatibility |
| `e70d2b27de3aaed5a19b9ca2c6749ed7fce3ef93` | integrated | - | pty wrapper identity token isolation already integrated in cms pty connect route flow |
| `9f4fc5b72aaa0a4cd44f8ef9c399e801f3015692` | skipped | - | revert of terminal isolation fix intentionally not adopted because integrated behavior is desired |
| `4e9ef3ecc1506c5087511105ac905564d2b0c73f` | integrated | - | terminal issue fixes mostly integrated; remaining ws.close codepath difference deferred as low-value delta |
| `68cf011fd3432ffe5f38848c6ec747702077dfbe` | ported | `091388a90da644416bd832db3b48ebf5f965c0a5` | skip stale message.part.delta events when a newer part.updated exists in same flush window |
| `45191ad144f6546c051fb3a94f9f3cb1e2c00ed3` | ported | `091388a90da644416bd832db3b48ebf5f965c0a5` | fix prev/next message keyboard navigation boundary and hash-scroll sticky inset handling |
| `aae75b3cfb10cdff965fb434c487980b152efdec` | ported | `091388a90da644416bd832db3b48ebf5f965c0a5` | add mousedown middle-button preventDefault for reliable middle-click tab close in scrollable tabs |
| `082f0cc12734ccc961797ab9a63dd88a2ce3eed5` | ported | `091388a90da644416bd832db3b48ebf5f965c0a5` | make file path root stripping separator-agnostic and preserve native separators on Windows |
| `659068942eda0e48f8453d96b03724cfb1f9698d` | ported | `d597d9b1cfc06273a7cfb23d7cc2504c207101d5` | support CRLF frontmatter line splitting and normalize markdown fixture assertion |
| `392a6d993f5cbb233bc0eeab297919cb21099f2c` | ported | `d597d9b1cfc06273a7cfb23d7cc2504c207101d5` | switch desktop sidecar shell spawn from -il to -l to avoid interactive-shell hang |
| `bb8a1718a63c2caae9e40c85dd4bdfe34f8012d7` | ported | `d597d9b1cfc06273a7cfb23d7cc2504c207101d5` | restore shell-derived PATH/env for desktop sidecar via shell env probe+merge before spawn |

## 已處理（origin/dev delta 2026-02-27 round64 (rewrite-only E4A/E4B settings+stability) @ 2026-02-26T17:12:08.472Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `ae98be83b3f8eb6b740e785347e1d4365dc202d2` | ported | `1dc5ceec8341425497a5ff1e85d0ede4fb3eb08d` | restore settings header mask by using surface-stronger non-alpha gradient token across settings pages |
| `63a469d0ce3ac30954ccb96c4b4b0698992162a5` | ported | `1dc5ceec8341425497a5ff1e85d0ede4fb3eb08d` | refine session feed spacing and reasoning markdown styling baseline |
| `8b99ac65135f9f4f800bd5df41846d3cd879155c` | ported | `1dc5ceec8341425497a5ff1e85d0ede4fb3eb08d` | tone down reasoning emphasis by reducing strong/bold contrast in reasoning blocks |
| `8d781b08ce7fa2d722a1069c8745d281962483d5` | ported | `1dc5ceec8341425497a5ff1e85d0ede4fb3eb08d` | finalize text-part spacing adjustment for session feed readability |
| `f07e8772042d9980bf6b6912d20b59709cbccd51` | integrated | - | share button double-border fix already present via conditional border-r-0 class in cms session header |
| `ce2763720e499ba7e7ca8021f2cbf6d62596a6e8` | integrated | - | sound disabling UX with none option and demo stop/play behavior already integrated in cms settings-general |
| `eda71373b0f37e56ca07921d13b3faf566824d04` | ported | `ac43a032ae30401689cd9a7746af268564b46872` | open review file waits for loadFile completion before opening tab to avoid race conditions |
| `a592bd968454f0b8c55733f7a8df85e38a293de5` | ported | `ac43a032ae30401689cd9a7746af268564b46872` | update helper test call order to match async-safe open-review flow |
| `de796d9a00544001fe196d9a3068ea241165293a` | skipped | - | upstream glob test target path does not exist in current cms opencode test layout |
| `79254c10201a3978ac72ef2a047bb4070efdc41d` | ported | `ac43a032ae30401689cd9a7746af268564b46872` | normalize excludesFile path in snapshot test fixture for Windows-compatible git config parsing |
| `ad5f0816a33d323f2a7e6a6228136fa6a6c4b056` | ported | `ac43a032ae30401689cd9a7746af268564b46872` | stabilize typecheck scheduling by adding ^build dependency in turbo task graph |

## 已處理（origin/dev delta 2026-02-27 round65-round66 (rewrite-only E5A-E6D) @ 2026-02-26T18:07:32.288Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `e27d3d5d4` | ported | `e16b7d1bf` | removed filetree tooltip wrappers and tooltip prop plumbing in app file tree |
| `c6d8e7624` | ported | `e16b7d1bf` | cancel comment now clears selected lines and closes commenting state consistently |
| `cc02476ea` | ported | `e16b7d1bf` | centralized server error formatting for sync/bootstrap toast errors via shared utility |
| `0d0d0578e` | integrated | - | generate-only follow-up represented by prior refactor port changes |
| `b8337cddc` | ported | `e16b7d1bf` | session permission/question lookup now traverses parent-child session tree in cms flow |
| `286992269` | ported | `e16b7d1bf` | copilot provider note text corrected across selected locale files |
| `05ac0a73e` | ported | `e16b7d1bf` | simplified review layout by removing file-tree-tab gated review branch on desktop |
| `7afa48b4e` | ported | `e16b7d1bf` | reasoning inline code subdued in dark mode styles |
| `a292eddeb` | ported | `65e302277` | preload cleanup uses gc+retry async rm loop to tolerate Windows EBUSY |
| `06f25c78f` | skipped | - | target discovery test file path not present in current cms tree |
| `3d379c20c` | ported | `65e302277` | cross-platform assumptions fixed in bash/external-directory tests; missing write.test segment skipped |
| `32417774c` | ported | `65e302277` | process.env cloning in tests switched from structuredClone to spread |
| `36197f5ff` | ported | `65e302277` | FileTime stale-read assert allows 50ms mtime tolerance for NTFS fuzziness |
| `a74fedd23` | ported | `5ac573bab` | windows/cygwin path normalization applied in filesystem, project gitpath, watcher, and bash path handling; app-side follow-up in 390b2aba9 |
| `b4d0090e0` | ported | `45f9d3df5` | project-switch now opens latest valid root session with remembered/fetched fallback to reduce flaky navigation |
| `0a9119691` | ported | `326bcfc23` | playwright defaults moved to IPv4 loopback 127.0.0.1 to avoid intermittent localhost ipv6 failures on win32 |
| `fce811b52` | skipped | - | deferred as larger release/build/runtime bundle; core parts already aligned in current cms baseline |

## 已處理（origin/dev delta 2026-02-27 round67 (rewrite-only E7A e2e parity) @ 2026-02-26T18:16:39.996Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `6d58d899f` | ported | `19876b779` | align app settings e2e sound behavior with none-selection model and remove obsolete sound-enabled selectors |

## 已處理（origin/dev delta 2026-02-27 batch8 windows-desktop @ 2026-02-26T18:31:20.826Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `34495a70d5069355bbad95c95625818afa677eb1` | integrated | - | Equivalent win32 script fixes already present in cms (fileURLToPath + bun-invoked build scripts). |
| `3201a7d34b03210f108e6caf49f20260d531a1a6` | integrated | - | Console app build script already includes bun-prefixed schema invocation in cms. |
| `6b021658ad514255c7398983b088c1636caaa5e4` | ported | `b79c524c3` | Rewrite-ported PowerShell open path behavior via new tauri command and desktop routing. |
| `fc6e7934bd365ad1665dea68556dbfc80ac3b611` | skipped | - | Deferred for dedicated batch: large desktop refactor (UI + tauri windows module) with broader regression surface. |
| `92ab4217c241f1fe75ac3d99bc455d0005383d3b` | skipped | - | Deferred unless sidecar regression requires -i; current cms desktop hardening strategy retained. |

## 已處理（origin/dev delta 2026-02-27 batch8B fc6 ui slice @ 2026-02-26T18:33:08.014Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `fc6e7934bd365ad1665dea68556dbfc80ac3b611` | ported | `3aff3ac30` | Partial rewrite-port: session-header open action loading UX (spinner/disable/in-flight guard). Tauri architecture refactor portion remains deferred. |

## 已處理（origin/dev delta 2026-02-27 batch8C fc6 resolver slice @ 2026-02-26T18:38:48.139Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `fc6e7934bd365ad1665dea68556dbfc80ac3b611` | ported | `f2ddf4701` | Additional partial rewrite-port: Windows app resolver hardening (candidate probing, hidden where, cmd/bat resolution, registry App Paths fallback). |

## 已處理（origin/dev delta 2026-02-27 batch8D windows constants @ 2026-02-26T18:40:37.602Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `fc6e7934bd365ad1665dea68556dbfc80ac3b611` | ported | `5eeec9dde` | Additional partial rewrite-port alignment: replace Win32 creation flag literals with windows-sys constants for hidden where probing and PowerShell launch. |

## 已處理（origin/dev delta 2026-02-27 batch8E os extraction @ 2026-02-26T18:45:29.170Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `fc6e7934bd365ad1665dea68556dbfc80ac3b611` | ported | `94a89c7e5` | Additional partial rewrite-port: extracted Windows resolver/open helpers into os module without behavior changes. |

## 已處理（origin/dev delta 2026-02-27 batch9A alpha models endpoint @ 2026-02-26T18:47:29.921Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `5190589632c97b570bb6f9035aa5c80c0fe833e7` | ported | `ee0abf4b4` | Rewrite-ported zen models endpoint filter to exclude alpha-* models from list response. |

## 已處理（origin/dev delta 2026-02-27 batch9B alpha admin guard @ 2026-02-26T18:48:45.479Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `f8cfb697bd10a328afab4e6a074148c2e651fcb2` | ported | `5c3e9aeae` | Rewrite-ported production guard restricting alpha-* models to ADMIN_WORKSPACES in zen handler auth path. |

## 已處理（origin/dev delta 2026-02-27 batch9C usage visibility @ 2026-02-26T18:55:03.606Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `284251ad6615dd37d4f2c0c9b14e0a989dbf3f1e` | ported | `8bfaf0441` | Rewrite-ported BYOK usage labeling and no-balance-deduction behavior with enriched usage metadata. |
| `5596775c35fbf92b7e83729deed4ec8e286ab3ab` | ported | `8bfaf0441` | Rewrite-ported session display in usage table via enrichment.sessionID (no physical schema column introduced in this batch). |
