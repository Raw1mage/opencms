# Missing Commit Appendix

## Baseline

- Working baseline: `main..3ab872842`
- Current working estimate: **42 commits** missing from `main` relative to old `cms` strong baseline `3ab872842`
- Composition:
  - `main..feature/claude-provider`: **32 commits**
  - `feature/claude-provider..3ab872842`: **10 commits**
- Rule: **inventory all remaining commits first; restore only after explicit user decision**

## Status Legend

- `pending_review`: 已列入 appendix，但尚未逐筆與使用者確認是否回復
- `approved_bucket`: 所屬功能桶已獲使用者原則同意回復，但該 commit 仍需逐筆 diff-first 檢查
- `skip_user_redone`: 使用者表示該區已重做，預設不回復舊 commit
- `already_recovered_equivalent`: 目前主線已有等價或手動整合版，不應盲目重回舊 commit
- `needs_deeper_analysis`: 已知重要，但目前不能安全判定該 commit 是否應直接回復
- `docs_restore_latest`: 文件類 commit，不逐筆回舊版內容；統一在本計畫收斂為該主題的最終最新版文件
- `confirmed_restore`: 使用者已逐筆確認要納入回復，後續只剩 diff-first 與實作方式判定
- `decompose_dedup_required`: 混合型 commit，必須先和前後已決定/已重做內容做拆片整併，僅保留仍缺 delta

## Inventory

| order | commit      | subject                                                                                               | bucket                            | provisional_status             |
| ----- | ----------- | ----------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------ |
| 1     | `335639b3d` | docs: reopen and align rebind-checkpoint plan                                                         | rebind/checkpoint docs            | `docs_restore_latest`          |
| 2     | `3fd1ef9b8` | feat(rebind): hardening implementation with atomic write, token limits, and boundary safety           | rebind/checkpoint runtime         | `confirmed_restore`            |
| 3     | `efc3b0dd9` | fix(session): prevent codex continuation id leak on rebind restart                                    | rebind/checkpoint runtime         | `confirmed_restore`            |
| 4     | `7bd35fb27` | feat(tools): lazy tool loading with adaptive auto-load                                                | lazy-tool-loading/tool runtime    | `confirmed_restore`            |
| 5     | `43d2ca35c` | fix(tool-loader): correct always-present tool IDs (todowrite/todoread not todo_write/todo_read)       | tool-loader                       | `confirmed_restore`            |
| 6     | `4a6e10f99` | fix(compaction): truncate history to fit small model context limit                                    | session/compaction                | `confirmed_restore`            |
| 7     | `a34d8027a` | fix(tool-loader): mutate description in place instead of rebuilding tool                              | tool-loader                       | `confirmed_restore`            |
| 8     | `74afa58e8` | docs(specs): promote rebind-checkpoint and lazy-tool-loading plans to specs/context_optimization/     | docs/specs                        | `docs_restore_latest`          |
| 9     | `b4674e116` | docs(plans): claude-provider plan package with A1 reverse engineering datasheets                      | claude-provider docs              | `docs_restore_latest`          |
| 10    | `eaced345d` | feat(prompt): enhance toolcall schemas with detailed examples and error recovery                      | prompt/tool schema                | `confirmed_restore`            |
| 11    | `f041f0db8` | fix(session): harden subagent lifecycle against weak model failures                                   | session/subagent lifecycle        | `confirmed_restore`            |
| 12    | `85691d6e3` | fix(session): avoid json truncation in model history and add checkpoint cooldown                      | session/checkpoint runtime        | `confirmed_restore`            |
| 13    | `3c60b613f` | refactor(session): standardize media parsing in model payload to improve LLM compatibility            | session/media payload             | `needs_deeper_analysis`        |
| 14    | `0f3176973` | chore(web): update website branding to TheSmartAI and replace favicon                                 | branding/browser tab              | `confirmed_restore`            |
| 15    | `18793931b` | feat(global): implement system-wide template support for repo-independent user-init                   | global user-init                  | `confirmed_restore`            |
| 16    | `5c18f28fe` | feat(global): automate repo-independent user-init including shell profile injection                   | global user-init                  | `confirmed_restore`            |
| 17    | `78a0f5d79` | docs(event): finalize user-init task list                                                             | user-init docs/event              | `docs_restore_latest`          |
| 18    | `db1050f06` | feat(gateway,web): multi-user onboarding, MCP marketplace, and branding fixes                         | onboarding/marketplace + branding | `decompose_dedup_required`     |
| 19    | `4264f4133` | feat(provider): custom provider CRUD, model visibility, and UI fixes                                  | provider manager                  | `skip_user_redone`             |
| 20    | `164930b23` | fix(dialog): remove resize/geometry hack that broke dialog reopen                                     | provider manager/dialog           | `skip_user_redone`             |
| 21    | `9870e4f53` | fix(provider): CRUD cache invalidation and cleanup                                                    | provider manager                  | `skip_user_redone`             |
| 22    | `197fc2bd7` | feat(claude-provider): C11 native OAuth plugin — shared library + CLI                                 | claude-provider/native            | `confirmed_restore`            |
| 23    | `267955d3a` | fix(transport): use heap-allocated stream parser (opaque type)                                        | claude-provider transport         | `needs_deeper_analysis`        |
| 24    | `9321ca7b1` | feat(claude-native): Bun FFI binding + ClaudeNativeAuthPlugin                                         | claude-provider/native            | `confirmed_restore`            |
| 25    | `ff2efd7d4` | docs(claude-provider): rearchitect Phase 9-10 — LanguageModelV1 bridge, anthropic.ts廢棄              | claude-provider docs              | `docs_restore_latest`          |
| 26    | `809135c30` | feat(claude-native): LanguageModelV2 JSCallback bridge — retire anthropic.ts fetch interceptor (DD-9) | claude-provider/native            | `approved_bucket`              |
| 27    | `81f2dc933` | fix(webapp): remove provider disabled_providers toggle from model manager                             | provider manager                  | `skip_user_redone`             |
| 28    | `cd8238313` | fix(webapp): 精選 tab filters by accounts > 0 instead of disabled state                               | provider manager                  | `skip_user_redone`             |
| 29    | `dda9738d8` | fix(webapp): provider visibility via localStorage, independent of TUI config                          | provider manager                  | `skip_user_redone`             |
| 30    | `4a4c69488` | fix(claude-cli): revert to AnthropicAuthPlugin fetch interceptor path                                 | claude-provider/claude-cli        | `confirmed_restore`            |
| 31    | `addb248b2` | fix(claude-cli): call mergeProvider to register claude-cli in providers map                           | claude-provider/claude-cli        | `already_recovered_equivalent` |
| 32    | `ba48f82ce` | docs(events): claude-cli provider beta debug + no-response fix (2026-04-01)                           | claude-provider docs/event        | `docs_restore_latest`          |
| 33    | `e039b1cb8` | chore(cms): restore uncommitted local changes for claude provider                                     | claude-provider misc              | `needs_deeper_analysis`        |
| 34    | `79e71cbde` | feat(github-copilot): enable reasoning variants for gpt-5-mini and gpt-5.4-mini                       | github-copilot reasoning          | `confirmed_restore`            |
| 35    | `6e774cc2b` | docs(events): add event log for github-copilot thinking effort implementation                         | github-copilot docs/event         | `docs_restore_latest`          |
| 36    | `f768f63a1` | feat(subagent): raise rebind checkpoint threshold and add subagent evolution plan                     | subagent/rebind threshold         | `confirmed_restore`            |
| 37    | `72ee7f4f1` | chore(refs): add claw-code submodule                                                                  | refs/claw-code                    | `confirmed_restore`            |
| 38    | `5f7d6f379` | docs(claude-provider): add HTTP transport spec from claw-code Rust analysis                           | claude-provider docs/spec         | `docs_restore_latest`          |
| 39    | `cdec6f0cb` | docs(claude-provider): correct auth model + add OAuthTokenSet from claw-code update                   | claude-provider docs/spec         | `docs_restore_latest`          |
| 40    | `a148c0e14` | chore(refs): update claw-code submodule to latest (9a86aa6)                                           | refs/claw-code                    | `needs_deeper_analysis`        |
| 41    | `515a1ca7d` | merge(claude-provider): claude-cli provider — webapp visibility + provider init fix                   | claude-provider/merge slice       | `needs_deeper_analysis`        |
| 42    | `3ab872842` | chore: add llm packet debug checkpoints                                                               | llm packet debug                  | `approved_bucket`              |

## Notes

- `skip_user_redone` does **not** mean ignored; it means inventoried and currently planned to skip because the user said that bucket was already rebuilt.
- `approved_bucket` does **not** mean safe to cherry-pick; it only means the surrounding bucket is approved in principle.
- `docs_restore_latest` means the user wants documentation subjects preserved, but as the final up-to-date version rather than an archaeological replay of each old docs commit.
- `decompose_dedup_required` means the old commit is a mixed bucket whose overlapping parts must be merged intelligently with newer work before any restore decision is finalized.
- Functional items must follow a history-aware restore rule: use old commits to identify the missing delta, but do not let an older patch overwrite newer mainline behavior.
- Functional items also require supersession review: if later history revised or overturned the old implementation, only the still-missing final delta may be restored.
- All remaining commit families follow a global execution principle: prefer ordered reconstruction to the newest workable version; direct final-shape recreation is acceptable only when the same latest outcome can be derived confidently with preserved override evidence.
- Documentation artifacts (`plans/`, `specs/`, `docs/events/`) follow the same rule: restore to the newest coherent readable/usable state implied by history, not an arbitrary intermediate draft.
- `needs_deeper_analysis` items are the main source of future surprise if not walked through explicitly; these should be reviewed with the user after the first full-table pass.
- If the user insists the true gap is 43 rather than 42, keep the appendix open for one more counting pass (for merge accounting / equivalent replay / counting baseline differences) before build mode.
