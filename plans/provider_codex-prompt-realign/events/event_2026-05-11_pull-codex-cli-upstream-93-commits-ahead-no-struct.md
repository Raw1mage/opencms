---
date: 2026-05-11
summary: "Pull codex-cli upstream — 93 commits ahead, no structural realignment needed"
---

# Pull codex-cli upstream — 93 commits ahead, no structural realignment needed

## What

Pull `refs/codex` submodule from `f7e8ff8e50` to `76845d716b` (93 commits). Audit confirms our Stage A.1–A.4 alignment is still current.

## Audit summary

| Aspect we depend on | Upstream change | Our alignment |
|---|---|---|
| `prompt_cache_key = self.state.thread_id` | unchanged | ✅ DD-6 still valid |
| `instructions` field carries BaseInstructions only | unchanged | ✅ DD-1 still valid |
| `build_initial_context()` emits developer bundle + user bundle | unchanged structure (refactor only) | ✅ A.3-2 still aligned |
| Persona files (`default.md`, `gpt_5_*.md`) | unchanged | ✅ md5 `7a62de0a7552d52b455f48d9a1e96016` still matches |
| `EnvironmentContext` body | network section refactored into helper, output identical when network is None | ✅ no impact (we don't emit network) |

## Non-prompt upstream changes (informational)

- Attestation header (`X_OAI_ATTESTATION_HEADER`) added — not relevant; opencode doesn't run on Codex's desktop attestation flow
- Skills watcher moved from core to app-server — orthogonal
- Various TUI improvements, sqlite migration policy, analytics, sandboxing
- `dfa1e864a2 Send response.processed after remote compaction v2` — could be relevant for future compaction work but not Stage A

## Commit

- Bump `refs/codex` pointer from `f7e8ff8e50` → `76845d716b` (`rust-v0.0.2504301132-6092-g76845d716b`)

