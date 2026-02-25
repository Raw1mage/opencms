# Event: origin/dev refactor round70 (core deferred batch)

Date: 2026-02-26
Status: In Progress

## 1) Goal

Triage remaining core-surface commits that require dedicated validation (provider/session/tui/sqlite paths).

## 2) Candidate(s)

- Session/tool core:
  - `a580fb47d207150b0fdfe18297afb71edbdf577c`
  - `e35a4131d00729b9ef75ca86b03e70b656f00e2f`
  - `3b9758062126430a5665cae717092ac4cf93ea86`
  - `c56f4aa5d85df55f7c447821b07ee4b88d9b1d73`
- Provider core:
  - `47435f6e17ad44c62b4f439d2ff490212e1fa9e3`
  - `ad92181fa7fad0d81bce055a2a601072af6b38a9`
  - `0ca75544abe6f9aee28c9bf5d626055a5a5c862f`
  - `572a037e5dd805f0b8124a87226969f70742dc08`
- TUI/CLI core:
  - `07947bab7d7f164ae5b46038deadda2284e97025`
  - `5512231ca8744b222e5ecbd6e2c5140a204245af`
  - `ad3c192837cc740e189034d8f6fc9f6b72db9bda`
  - `2a2437bf22cb8f5db5ddb46a004be628ea4a6624`
  - `cb88fe26aa05dfb865c0f7f2589a35197deb6e24`

## 3) Decision + rationale

- Decision: **Skipped** (deferred)
- Rationale:
  - All candidates touch sensitive runtime surfaces with higher regression risk under current cms divergence.
  - Defer to dedicated focused validation batches instead of broad throughput pass.

## 4) File scope reviewed

- `packages/opencode/src/session/**`
- `packages/opencode/src/tool/**`
- `packages/opencode/src/provider/**`
- `packages/opencode/src/cli/cmd/tui/**`

## 5) Validation plan / result

- Validation method: volatility/risk-based triage.
- Result: skipped for this batch; queued for focused follow-up.

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before decision.
- No architecture change applied.
