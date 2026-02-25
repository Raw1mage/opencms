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
