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
