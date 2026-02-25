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
