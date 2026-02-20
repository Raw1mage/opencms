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
