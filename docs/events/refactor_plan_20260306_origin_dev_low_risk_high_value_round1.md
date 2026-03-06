# Refactor Plan: 2026-03-06 (origin/dev → HEAD, origin_dev_low_risk_high_value_round1)

Date: 2026-03-06
Status: IN_PROGRESS

## Summary

- Upstream pending (raw): 840 commits
- Excluded by processed ledger: 593 commits
- Commits for this round: 247 commits
- Execution strategy approved by user: 先自動完成「高價值、低風險」項目，再由使用者試用後決定退回/微調。

## Execution Batches

1. **Batch A — Session / Review UI polish**
   - Scope: session tabs, review header/padding/scroll/thumb, timeline jank, queued-message visibility, bash output selection.
   - Why first: 高價值、低風險、主要集中於 `packages/app` / `packages/ui`，容易試用回饋。
   - Progress: **partial landed**（session tabs compact styling / tooltip gutter / drag preview / centered layout when filetree=`all` / assistant path display fix）
2. **Batch B — Permission / Prompt / Provider icon UX**
   - Scope: auto-accept permission UX、permission indicator/notification、provider icon fallback/reactivity、agent selection UI logic。
   - Why second: 直接影響 cms 使用流程，但仍避開 protected runtime 核心。
3. **Batch C — Desktop / tooling / release hygiene**
   - Scope: desktop open-path、latest.json finalizer、electron/update 邏輯、Nix/deps generated artifacts。
   - Why third: 使用者可感知但不干擾 cms 核心 provider/session 架構。
4. **Batch D — Safe docs/i18n parity**
   - Scope: app/ui/console 可安全同步的 i18n 與低風險文案。
   - Why fourth: 收尾批次，降低與前面 UI 行為變更互相衝突的風險。

## Explicit Deferrals

- Deferred for separate design/review: workspace/control-plane、provider/runtime error-path、MCP lifecycle、TUI navigation / task tool UX。

## Policy Guardrails

- Execution mode: rewrite-only refactor-port.
- Forbidden: `git cherry-pick`, `git merge`, or direct upstream patch transplant.
- Allowed: analyze behavior intent, then re-implement on cms architecture and validate.

## Actions

| Commit      | Logical Type   | Value Score   | Risk   | Decision | Notes                                                                                                                                           |
| :---------- | :------------- | :------------ | :----- | :------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| `7e6a007c3` | feature        | 1/0/0/1=2     | low    | ported   | feat(app): auto-accept all permissions mode                                                                                                     |
| `931286756` | feature        | 1/0/0/1=2     | low    | ported   | feat(app): new tabs styling (#15284)                                                                                                            |
| `270d084cb` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(ui): avoid truncating workspace paths in assistant text (#14584)                                                                            |
| `a0b3bbffd` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(ui): prevent filename and diff count overlap in session changes (#14773)                                                                    |
| `8c484a05b` | behavioral-fix | 1/1/0/0=2     | medium | ported   | fix(app): terminal issues                                                                                                                       |
| `05d77b7d4` | infra          | 1/0/0/1=2     | low    | ported   | chore: storybook (#15285)                                                                                                                       |
| `9736fce8f` | infra          | 1/0/0/1=2     | low    | ported   | chore: update nix node_modules hashes                                                                                                           |
| `c95febb1d` | feature        | 1/0/0/1=2     | low    | ported   | tui: fix session tab alignment in compact view to prevent vertical overflow                                                                     |
| `7a74be3b4` | feature        | 1/0/0/1=2     | low    | ported   | tweak(ui): add border to filetree on scroll                                                                                                     |
| `adabad19f` | feature        | 1/0/0/1=2     | low    | ported   | Revert "fix(ui): prevent filename and diff count overlap in session changes (#14773)"                                                           |
| `37d42595c` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix: test                                                                                                                                       |
| `09e1b98bc` | feature        | 1/0/0/1=2     | low    | ported   | tweak(ui): max-width on session when the review is closed but the file tree is open                                                             |
| `bf442a50c` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(ui): mute inactive file tab icons                                                                                                           |
| `fa119423e` | feature        | 1/0/0/1=2     | low    | ported   | tweak(app): align review changes select height                                                                                                  |
| `9a6bfeb78` | feature        | 1/0/0/1=2     | low    | ported   | refactor(app): dedupe filetree scroll state                                                                                                     |
| `fc52e4b2d` | feature        | 1/0/0/1=2     | low    | ported   | feat(app): better diff/code comments (#14621)                                                                                                   |
| `4205fbd2a` | feature        | 1/0/0/1=2     | low    | ported   | tweak(app): show keybind on context tab close                                                                                                   |
| `e9a7c7114` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): permission notifications                                                                                                              |
| `b0b88f679` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): permission indicator                                                                                                                  |
| `f2100dcfd` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): scroll jacking                                                                                                                        |
| `8c739b4a7` | feature        | 1/0/0/1=2     | low    | ported   | zen: fix go plan usage limit                                                                                                                    |
| `752841917` | feature        | 1/0/0/1=2     | low    | ported   | app: allow providing username and password when connecting to remote server (#14872)                                                            |
| `2a4ed4955` | feature        | 1/0/0/1=2     | low    | ported   | wip: zen                                                                                                                                        |
| `0da8af8a2` | feature        | 1/0/0/1=2     | low    | ported   | desktop: move open_path to rust (#15323)                                                                                                        |
| `6b3118883` | feature        | 1/0/0/1=2     | low    | ported   | wip: zen                                                                                                                                        |
| `1f108bc40` | feature        | 1/0/0/1=2     | low    | ported   | feat(app): recent projects section in command pallette (#15270)                                                                                 |
| `dc8c01151` | docs           | -1/-1/-1/1=-2 | low    | skipped  | docs(readme): add Greek translation and update language navigation (#15281)                                                                     |
| `a325c9af8` | feature        | 1/0/0/1=2     | low    | ported   | feat(app): add Turkish (tr) locale for app and ui packages (#15278)                                                                             |
| `3407ded9d` | infra          | 1/0/0/1=2     | low    | ported   | chore: generate                                                                                                                                 |
| `4a9409699` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): update provider sprite                                                                                                                |
| `dfa028111` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): auto-accept permissions                                                                                                               |
| `967313234` | feature        | 1/0/1/1=3     | low    | ported   | desktop: add latest.json finalizer script (#15335)                                                                                              |
| `157920b2f` | infra          | 1/0/0/1=2     | low    | ported   | chore: update test                                                                                                                              |
| `3dc10a1c1` | ux             | 0/0/0/-1=-1   | high   | skipped  | Change keybindings to navigate between child sessions (#14814)                                                                                  |
| `78cea89e0` | feature        | 1/0/0/1=2     | low    | ported   | chore(script): source team members from TEAM_MEMBERS (#15369)                                                                                   |
| `e49e781cb` | feature        | 1/0/0/1=2     | low    | ported   | feat(app): add Warp to the open menu (#15368)                                                                                                   |
| `9d76ef6c6` | docs           | 1/-1/-1/1=0   | low    | skipped  | chore: update docs locale sync workflow                                                                                                         |
| `e5ae6c51b` | docs           | -1/-1/-1/1=-2 | low    | skipped  | chore: update translator model                                                                                                                  |
| `6ef3af73d` | feature        | 1/0/0/1=2     | low    | ported   | chore(app): i18n sync (#15362)                                                                                                                  |
| `a94f564ff` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): scroll issues                                                                                                                         |
| `c12ce2fff` | feature        | 1/0/0/0=1     | medium | skipped  | feat(core): basic implementation of remote workspace support (#15120)                                                                           |
| `7ff2710ce` | infra          | 1/0/0/1=2     | low    | ported   | chore: generate                                                                                                                                 |
| `f347194e3` | docs           | -1/-1/-1/1=-2 | low    | skipped  | docs: add missing Bosanski link to Arabic README (#15399)                                                                                       |
| `1f2348c1e` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): make bash output selectable (#15378)                                                                                                  |
| `46d678fce` | infra          | 1/0/0/1=2     | low    | ported   | chore: generate                                                                                                                                 |
| `a3bdb974b` | feature        | 1/0/0/1=2     | low    | ported   | chore(app): deps                                                                                                                                |
| `7f851da15` | feature        | 1/0/0/1=2     | low    | ported   | chore(console): i18n sync (#15360)                                                                                                              |
| `1f1f36aac` | infra          | 1/0/0/1=2     | low    | ported   | chore: update nix node_modules hashes                                                                                                           |
| `d2a8f44c2` | feature        | 1/0/0/1=2     | low    | ported   | doc: opencode go                                                                                                                                |
| `2eb1d4cb9` | docs           | -1/-1/-1/1=-2 | low    | skipped  | doc: go                                                                                                                                         |
| `0b8c1f1f7` | docs           | -1/-1/-1/1=-2 | low    | skipped  | docs: Update OpenCode Go subscription and usage details (#15415)                                                                                |
| `267d2c82d` | docs           | -1/-1/-1/1=-2 | low    | skipped  | chore: cleanup                                                                                                                                  |
| `2a2082233` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): display skill name in skill tool call (#15413)                                                                                        |
| `971bd3051` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): fallback to synthetic icon for unknown provider IDs (#15295)                                                                          |
| `e1e18c7ab` | docs           | -1/-1/-1/1=-2 | low    | skipped  | chore(docs): i18n sync (#15417)                                                                                                                 |
| `114eb4244` | docs           | -1/-1/-1/1=-2 | low    | skipped  | docs: fix broken config imports in translated documentation                                                                                     |
| `cec16dfe9` | feature        | 1/0/0/0=1     | medium | skipped  | feat(core): add WorkspaceContext (#15409)                                                                                                       |
| `fcd733e3d` | infra          | 1/0/0/1=2     | low    | ported   | chore: generate                                                                                                                                 |
| `3ee1653f4` | feature        | 1/0/0/0=1     | medium | skipped  | feat(core): add workspace_id to `session` table (#15410)                                                                                        |
| `b88e8e0e0` | infra          | 1/0/0/1=2     | low    | ported   | chore: generate                                                                                                                                 |
| `4d968ebd6` | docs           | -1/-1/-1/1=-2 | low    | skipped  | docs(ecosystem): add opencode-vibeguard (#15464)                                                                                                |
| `38704acac` | docs           | -1/-1/-1/1=-2 | low    | skipped  | chore: generate                                                                                                                                 |
| `c4c0b23bf` | behavioral-fix | 1/1/0/0=2     | medium | ported   | fix: kill orphaned MCP child processes and expose OPENCODE_PID on shu… (#15516)                                                                 |
| `438610aa6` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): show proper usage limit errors (#15496)                                                                                               |
| `f5eade1d2` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(i18n): polish turkish translations (#15491)                                                                                                 |
| `c8866e60b` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): make provider icon resolved id reactive (#15583)                                                                                      |
| `b15fb2119` | feature        | 1/0/0/1=2     | low    | ported   | feat(app): add compact ui (#15578)                                                                                                              |
| `6b7e6bde4` | behavioral-fix | 0/1/0/-1=0    | high   | skipped  | fix(opencode): show human-readable message for HTML error responses (#15407)                                                                    |
| `90270c615` | ux             | 0/0/0/-1=-1   | high   | skipped  | feat(tui): improve task tool display with subagent keybind hints and spinner animations (#15607)                                                |
| `ae0f69e1f` | docs           | -1/-1/-1/1=-2 | low    | skipped  | doc: add zen deprecated models                                                                                                                  |
| `c0483affa` | feature        | 1/0/0/1=2     | low    | ported   | perf(session): faster session switching via windowed rendering and staged timeline (#15474)                                                     |
| `d1938a472` | infra          | 1/0/0/1=2     | low    | ported   | chore: generate                                                                                                                                 |
| `a692e6fdd` | feature        | 1/0/0/1=2     | low    | ported   | desktop: use correct download link in finalize-latest-json                                                                                      |
| `cf7885516` | feature        | 1/0/0/1=2     | low    | ported   | Revert "fix(i18n): polish turkish translations" (#15656)                                                                                        |
| `b1bfecb71` | feature        | 1/0/0/1=2     | low    | ported   | desktop: fix latest.json finalizer                                                                                                              |
| `7bfbb1fcf` | behavioral-fix | 1/1/0/0=2     | medium | ported   | fix: project ID conflict, and update on same session id (#15596)                                                                                |
| `be20f865a` | behavioral-fix | 0/1/0/-1=0    | high   | skipped  | fix: recover from 413 Request Entity Too Large via auto-compaction (#14707)                                                                     |
| `4b9e19f72` | infra          | 1/0/0/0=1     | medium | skipped  | chore: generate                                                                                                                                 |
| `bf2cc3aa2` | feature        | 1/0/0/1=2     | low    | ported   | feat(app): show which messages are queued (#15587)                                                                                              |
| `51e600019` | protocol       | 1/0/0/1=2     | low    | ported   | core: keep review header buttons visible when scroll thumb shows                                                                                |
| `4c2aa4ab9` | feature        | 1/0/0/1=2     | low    | ported   | ui: widen scroll thumb hit area                                                                                                                 |
| `d60696ded` | feature        | 1/0/0/1=2     | low    | ported   | ui: tighten scroll thumb and review padding                                                                                                     |
| `633a3ba03` | protocol       | 1/0/0/1=2     | low    | ported   | ui: avoid session review header clipping                                                                                                        |
| `0a3a3216d` | feature        | 1/0/0/1=2     | low    | ported   | ui: move session review bottom padding                                                                                                          |
| `8176bafc5` | feature        | 1/0/0/1=2     | low    | ported   | chore(app): solidjs refactoring (#13399)                                                                                                        |
| `1cd77b107` | docs           | 1/-1/-1/1=0   | low    | skipped  | chore: fix docs sync permissions                                                                                                                |
| `78069369e` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): default auto-respond to false                                                                                                         |
| `9d7852b5c` | feature        | 1/0/0/1=2     | low    | ported   | Animation Smorgasbord (#15637)                                                                                                                  |
| `b5dc6e670` | infra          | 1/0/0/1=2     | low    | ported   | chore: generate                                                                                                                                 |
| `98c75be7e` | infra          | 1/0/0/1=2     | low    | ported   | chore: update nix node_modules hashes                                                                                                           |
| `fd6f7133c` | behavioral-fix | 1/1/0/0=2     | medium | ported   | fix(opencode): clone part data in Bus event to preserve token values (#15780)                                                                   |
| `96d6fb78d` | behavioral-fix | 0/1/0/-1=0    | high   | skipped  | fix(provider): forward metadata options to cloudflare-ai-gateway provider (#15619)                                                              |
| `e41b53504` | infra          | 0/0/0/-1=-1   | high   | skipped  | chore: generate                                                                                                                                 |
| `7e3e85ba5` | behavioral-fix | 0/1/0/-1=0    | high   | skipped  | fix(opencode): avoid gemini combiner schema sibling injection (#15318)                                                                          |
| `9f150b077` | infra          | 0/0/0/-1=-1   | high   | skipped  | chore: generate                                                                                                                                 |
| `6aa4928e9` | feature        | 1/0/0/1=2     | low    | ported   | wip: zen                                                                                                                                        |
| `881ca8643` | infra          | 1/0/0/1=2     | low    | ported   | chore: generate                                                                                                                                 |
| `1233ebcce` | feature        | 1/0/0/1=2     | low    | ported   | wip: zen                                                                                                                                        |
| `b985ea344` | feature        | 1/0/0/1=2     | low    | ported   | wip: zen                                                                                                                                        |
| `6deb27e85` | docs           | -1/-1/-1/1=-2 | low    | skipped  | zen: docs                                                                                                                                       |
| `48412f75a` | infra          | 1/0/0/1=2     | low    | ported   | chore: nix flake update for bun 1.3.10 (#15648)                                                                                                 |
| `18850c4f9` | ux             | 0/0/0/-1=-1   | high   | skipped  | fix(opencode): disable session navigation commands when no parent session (#15762)                                                              |
| `5e8742f43` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): timeline jank                                                                                                                         |
| `e4af1bb42` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): timeline jank                                                                                                                         |
| `1e2da6016` | infra          | 1/0/0/1=2     | low    | ported   | chore: fix test                                                                                                                                 |
| `7305fc044` | infra          | 1/0/0/1=2     | low    | ported   | chore: cleanup                                                                                                                                  |
| `356b5d460` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): stabilize project close navigation (#15817)                                                                                           |
| `cbf057048` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix: update Turkish translations (#15835)                                                                                                       |
| `70b6a0523` | docs           | -1/-1/-1/1=-2 | low    | skipped  | chore: generate                                                                                                                                 |
| `da82d4035` | docs           | -1/-1/-1/1=-2 | low    | skipped  | chore: tr glossary                                                                                                                              |
| `fa45422bf` | infra          | 1/0/0/1=2     | low    | ported   | chore: cleanup                                                                                                                                  |
| `10c325810` | protocol       | 1/0/0/1=2     | low    | ported   | fix(app): tighten up header elements                                                                                                            |
| `fd4d3094b` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): timeline jank                                                                                                                         |
| `c2091acd8` | docs           | -1/-1/-1/1=-2 | low    | skipped  | wip: zen                                                                                                                                        |
| `b751bd037` | docs           | -1/-1/-1/1=-2 | low    | skipped  | docs(i18n): sync locale docs from english changes                                                                                               |
| `3310c25dd` | ux             | 0/0/0/-1=-1   | high   | skipped  | Upgrade opentui to v0.1.86 and activate markdown renderable by default (#14974)                                                                 |
| `6f90c3d73` | infra          | 1/0/0/1=2     | low    | ported   | chore: update nix node_modules hashes                                                                                                           |
| `70c6fcfbb` | infra          | 1/0/0/1=2     | low    | ported   | chore: cleanup                                                                                                                                  |
| `9d427c1ef` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): defer diff rendering                                                                                                                  |
| `502dbb65f` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): defer diff rendering                                                                                                                  |
| `3c8ce4ab9` | feature        | 1/0/0/1=2     | low    | ported   | feat(console): add /go landing page                                                                                                             |
| `b1c166edf` | feature        | 1/0/0/1=2     | low    | ported   | chore(console): add Go to nav                                                                                                                   |
| `1663c11f4` | docs           | -1/-1/-1/1=-2 | low    | skipped  | wip: zen                                                                                                                                        |
| `74ebb4147` | protocol       | 1/0/0/0=1     | medium | ported   | fix(auth): normalize trailing slashes in auth login URLs (#15874)                                                                               |
| `c2f5abe75` | feature        | 1/0/0/1=2     | low    | ported   | chore(console): move Enterprise after Go                                                                                                        |
| `d80334b2b` | feature        | 1/0/0/1=2     | low    | ported   | chore(console): update /go hero copy                                                                                                            |
| `12f4315d9` | feature        | 1/0/0/1=2     | low    | ported   | chore(console): trim /go model logos                                                                                                            |
| `e3a787a7a` | ux             | 0/0/0/-1=-1   | high   | skipped  | tui: use arrow indicator for active tool execution (#15887)                                                                                     |
| `c78e7e1a2` | ux             | 0/0/0/-1=-1   | high   | skipped  | tui: show pending toolcall count instead of generic 'Running...' message                                                                        |
| `c4ffd93ca` | ux             | 0/0/0/-1=-1   | high   | skipped  | tui: replace curved arrow with straight arrow for better terminal compatibility                                                                 |
| `e66d829d1` | feature        | 1/0/0/1=2     | low    | ported   | release: v1.2.16                                                                                                                                |
| `9a4292726` | feature        | 1/0/0/1=2     | low    | skipped  | revert: undo turbo typecheck dependency change from #14828 (#15902)                                                                             |
| `109ea1709` | behavioral-fix | 1/1/0/0=2     | medium | ported   | fix: `run --attach` agent validation (#11812)                                                                                                   |
| `e79d41c70` | docs           | 1/-1/-1/0=-1  | medium | skipped  | docs(bash): clarify output capture guidance (#15928)                                                                                            |
| `7f37acdaa` | feature        | 1/0/0/0=1     | medium | skipped  | feat(core): rework workspace integration and adaptor interface (#15895)                                                                         |
| `2a0be8316` | infra          | 1/0/0/1=2     | low    | ported   | chore: generate                                                                                                                                 |
| `3ebebe0a9` | ux             | 0/0/0/-1=-1   | high   | skipped  | fix(process): prevent orphaned opencode subprocesses on shutdown (#15924)                                                                       |
| `e4f0825c5` | protocol       | 1/0/0/1=2     | low    | ported   | zen: fix aws bedrock header                                                                                                                     |
| `5cf235fa6` | feature        | 1/0/1/1=3     | low    | ported   | desktop: add electron version (#15663)                                                                                                          |
| `5dcf3301e` | infra          | 1/0/0/1=2     | low    | ported   | chore: update nix node_modules hashes                                                                                                           |
| `db3eddc51` | feature        | 1/0/0/1=2     | low    | ported   | ui: rely on task part href instead of onClick handler (#15978)                                                                                  |
| `850fd9419` | docs           | -1/-1/-1/1=-2 | low    | skipped  | fix(docs): update dead opencode-daytona ecosystem link (#15979)                                                                                 |
| `a2d3d62db` | feature        | 1/0/0/1=2     | low    | ported   | chore(console): move login to end on zen/go                                                                                                     |
| `0541d756a` | docs           | -1/-1/-1/1=-2 | low    | skipped  | docs(i18n): sync locale docs from english changes                                                                                               |
| `e8f67ddbc` | feature        | 1/0/0/1=2     | low    | ported   | chore(console): update /go hero body                                                                                                            |
| `9909f9404` | feature        | 1/0/0/1=2     | low    | ported   | chore(console): hide Go nav item on /go                                                                                                         |
| `570956191` | feature        | 1/0/0/1=2     | low    | ported   | chore(console): refine /go hero and pricing copy                                                                                                |
| `e44cdaf88` | feature        | 1/0/0/1=2     | low    | ported   | chore(console): use Go ornate logo on /go                                                                                                       |
| `0a2aa8688` | feature        | 1/0/0/1=2     | low    | ported   | chore(console): switch /go page to go.\* i18n keys                                                                                              |
| `d7569a562` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): terminal tab close                                                                                                                    |
| `eb7185673` | docs           | 1/-1/-1/1=0   | low    | skipped  | docs: send Go landing page links to Go docs                                                                                                     |
| `dd4ad5f2c` | feature        | 1/0/0/1=2     | low    | ported   | chore(console): edit copy                                                                                                                       |
| `2ccf21de9` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): loading session should be scrolled to the bottom                                                                                      |
| `ad5633810` | feature        | 1/0/0/1=2     | low    | ported   | chore(console): update copy                                                                                                                     |
| `e482405cd` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): remove diff lines from sessions in sidebar                                                                                            |
| `64b21135f` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): delay dock animation on session load                                                                                                  |
| `a69742ccb` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): remove blur from todos                                                                                                                |
| `18cad1064` | ux             | 0/0/0/-1=-1   | high   | skipped  | show scrollbar by default (#15282)                                                                                                              |
| `e3267413c` | feature        | 1/0/0/1=2     | low    | ported   | remove build from typecheck                                                                                                                     |
| `faf501200` | infra          | 1/0/0/1=2     | low    | ported   | ci: only publish electron on beta                                                                                                               |
| `1b0d65f80` | infra          | 1/0/0/1=2     | low    | ported   | ci: remove electron beta requirement                                                                                                            |
| `715b844c2` | feature        | 1/0/0/1=2     | low    | ported   | release: v1.2.17                                                                                                                                |
| `7c215c0d0` | docs           | 1/-1/-1/1=0   | low    | skipped  | docs: replace Go landing page video with interactive limits graph                                                                               |
| `61795d794` | docs           | 1/-1/-1/1=0   | low    | skipped  | docs: clarify Go models in FAQ answer                                                                                                           |
| `d94c51640` | docs           | 1/-1/-1/1=0   | low    | skipped  | docs: update Go privacy copy for global hosting                                                                                                 |
| `c6187ee40` | docs           | 1/-1/-1/1=0   | low    | skipped  | docs: de-link Go testimonials and swap Zen→Go                                                                                                   |
| `ca5a7378d` | docs           | 1/-1/-1/1=0   | low    | skipped  | docs: localize Go graph and testimonial copy                                                                                                    |
| `b42a63b88` | docs           | 1/-1/-1/1=0   | low    | skipped  | docs: make Go hero CTA translatable with pricing emphasis                                                                                       |
| `22fcde926` | feature        | 1/0/0/1=2     | low    | ported   | tui: reduce excessive spacing in go route layout to improve visual balance                                                                      |
| `e9de2505f` | feature        | 1/0/0/1=2     | low    | ported   | Merge branch 'dev' into go-page                                                                                                                 |
| `744c38cc7` | feature        | 1/0/0/1=2     | low    | ported   | tui: clarify which models are available in Go subscription                                                                                      |
| `0f1f55a24` | feature        | 1/0/0/1=2     | low    | ported   | tui: show Go request limits per 5-hour session                                                                                                  |
| `de6a6af5a` | feature        | 1/0/0/1=2     | low    | ported   | tweak(ui): remove section                                                                                                                       |
| `b7198c28c` | feature        | 1/0/0/1=2     | low    | ported   | tweak(ui): darker text                                                                                                                          |
| `6f2327174` | feature        | 1/0/0/1=2     | low    | ported   | chore(ui): remove quotes                                                                                                                        |
| `40fc40642` | infra          | 1/0/0/1=2     | low    | ported   | ci: make tsgo available for pre-push typechecks                                                                                                 |
| `29dbfc25e` | docs           | -1/-1/-1/1=-2 | low    | skipped  | docs: Add opencode-sentry-monitor to ecosystem documentation (#16037)                                                                           |
| `22a4c5a77` | docs           | -1/-1/-1/1=-2 | low    | skipped  | docs(i18n): sync locale docs from english changes                                                                                               |
| `0b825ca38` | docs           | 1/-1/-1/1=0   | low    | skipped  | docs: redesign Go pricing graph with horizontal bars and inline request labels                                                                  |
| `6cbb1ef1c` | feature        | 1/0/0/1=2     | low    | ported   | wip: Make bar colors in limit graph customizable via CSS variables for consistent theming across the go route visualization                     |
| `f8685a4d5` | feature        | 1/0/0/1=2     | low    | ported   | tui: clarify free tier includes Big Pickle and promotional requests on Go pricing page                                                          |
| `cd3a09c6a` | feature        | 1/0/0/1=2     | low    | ported   | tui: clearer graph labels and responsive layout for usage visualization                                                                         |
| `67fa7903c` | feature        | 1/0/0/1=2     | low    | ported   | tui: prevent Go pricing graph from overflowing on medium screens by constraining width and moving axis labels outside SVG for sharper rendering |
| `218330aec` | feature        | 1/0/0/1=2     | low    | ported   | Merge branch 'go-page' into dev                                                                                                                 |
| `45ac20b8a` | behavioral-fix | 1/1/0/0=2     | medium | ported   | fix(core): handle SIGHUP and kill process (#16057)                                                                                              |
| `27447bab2` | feature        | 1/0/0/1=2     | low    | ported   | wip: zen                                                                                                                                        |
| `7f7e62242` | ux             | 0/0/0/-1=-1   | high   | skipped  | dont let dax touch the ui (#16060)                                                                                                              |
| `324230806` | infra          | 1/0/0/1=2     | low    | ported   | chore: update turborepo (#16061)                                                                                                                |
| `85ff05670` | feature        | 1/0/0/1=2     | low    | ported   | zen: update go page                                                                                                                             |
| `f363904fe` | protocol       | 1/0/0/0=1     | medium | skipped  | feat(opencode): Adding options to auth login to skip questions (#14470)                                                                         |
| `7948de161` | feature        | 1/0/0/1=2     | low    | ported   | app: prefer using useLocation instead of window.location (#15989)                                                                               |
| `6ddd13c6a` | infra          | 1/0/0/1=2     | low    | ported   | chore: update nix node_modules hashes                                                                                                           |
| `6531cfc52` | feature        | 1/0/0/1=2     | low    | ported   | desktop-electon: handle latest version update check properly                                                                                    |
| `4e26b0aec` | feature        | 1/0/0/1=2     | low    | ported   | desktop: new-session deeplink (#15322)                                                                                                          |
| `161734fb9` | feature        | 1/0/0/1=2     | low    | ported   | desktop: remove unnecessary macOS entitlements (#16161)                                                                                         |
| `a60e715fc` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): improve agent selection logic passing in configured models and variants correctly (#16072)                                            |
| `62909e917` | infra          | 1/0/0/1=2     | low    | ported   | chore: generate                                                                                                                                 |
| `27baa2d65` | feature        | 1/0/0/1=2     | low    | ported   | refactor(desktop): improve error handling and translation in server error formatting (#16171)                                                   |
| `2bb3dc585` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): no delay on tooltip close                                                                                                             |
| `3448118be` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): mod+f always opens search                                                                                                             |
| `0e5edef51` | feature        | 1/0/0/1=2     | low    | ported   | chore(console): go page i18n                                                                                                                    |
| `5f40bd42f` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): icon jiggle                                                                                                                           |
| `07348d14a` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): preserve question dock state across session switches (#16173)                                                                         |
| `8cbe7b4a0` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): file icon stability                                                                                                                   |
| `6c9ae5ce9` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): file path truncation in session turn                                                                                                  |
| `6f9e5335d` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): file icon stability                                                                                                                   |
| `4c185c70f` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): provider settings consistency                                                                                                         |
| `1a420a1a7` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): websearch and codesearch tool rendering                                                                                               |
| `152df2428` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): stale read error                                                                                                                      |
| `a3d4ea0de` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): locale error                                                                                                                          |
| `7665b8e30` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): stale keyed show errors                                                                                                               |
| `d802e2838` | feature        | 1/0/0/1=2     | low    | ported   | update sdk package.json                                                                                                                         |
| `bb37e908a` | infra          | 1/0/0/1=2     | low    | ported   | ci: remove unused publishConfig that was breaking npm publishing                                                                                |
| `9cccaa693` | feature        | 1/0/0/1=2     | low    | ported   | chore(app): ghostty-web fork                                                                                                                    |
| `4da199697` | ux             | 0/0/0/-1=-1   | high   | skipped  | feat(tui): add onClick handler to InlineTool and Task components (#16187)                                                                       |
| `9507b0eac` | infra          | 1/0/0/1=2     | low    | ported   | chore: update nix node_modules hashes                                                                                                           |
| `2c58964a6` | feature        | 1/0/0/1=2     | low    | ported   | release: v1.2.18                                                                                                                                |
| `0638e49b0` | docs           | -1/-1/-1/1=-2 | low    | skipped  | zen: gpt5.4                                                                                                                                     |
| `e3b6d84b5` | docs           | -1/-1/-1/1=-2 | low    | skipped  | docs(i18n): sync locale docs from english changes                                                                                               |
| `2ba1ecabc` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): load tab on open file                                                                                                                 |
| `76cdc668e` | docs           | 1/-1/-1/1=0   | low    | skipped  | fix(console): follow-up for #13108 docs/en routing and locale cookie sync (#13608)                                                              |
| `80c36c788` | docs           | -1/-1/-1/1=-2 | low    | skipped  | zen: gpt5.3 codex spark                                                                                                                         |
| `a6978167a` | docs           | -1/-1/-1/1=-2 | low    | skipped  | ci: fix                                                                                                                                         |
| `adaee6636` | docs           | -1/-1/-1/1=-2 | low    | skipped  | zen: gpt 5.4 pro                                                                                                                                |
| `39691e517` | feature        | 1/0/0/1=2     | low    | ported   | tui: remove keyboard shortcut tooltips from new session and new workspace buttons in the sidebar                                                |
| `cf425d114` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): stale show (#16236)                                                                                                                   |
| `3ebba02d0` | ux             | 0/0/0/-1=-1   | high   | skipped  | refactor: replace Bun.sleep with node timers (#15013)                                                                                           |
| `6e89d3e59` | feature        | 1/0/0/0=1     | medium | skipped  | refactor: replace Bun.write/file with Filesystem utilities in snapshot                                                                          |
| `dad248832` | feature        | 1/0/0/0=1     | medium | skipped  | refactor: replace Bun.write with Filesystem.write in config files                                                                               |
| `a9bf1c050` | feature        | 0/0/0/-1=-1   | high   | skipped  | refactor: replace Bun.hash with Hash.fast using xxhash3-xxh64                                                                                   |
| `ae5c9ed3d` | ux             | 0/0/0/-1=-1   | high   | skipped  | refactor: replace Bun.stdin.text with Node.js stream reading                                                                                    |
| `7e2809836` | ux             | 0/0/0/-1=-1   | high   | skipped  | refactor: use node:stream/consumers for stdin reading                                                                                           |
| `6733a5a82` | behavioral-fix | 1/1/0/0=2     | medium | ported   | fix: use sha1 for hash instead of unsupported xxhash3-xxh64                                                                                     |
| `bf35a865b` | feature        | 1/0/0/0=1     | medium | skipped  | refactor: replace Bun.connect with net.createConnection                                                                                         |
| `d68afcaa5` | feature        | 1/0/0/0=1     | medium | skipped  | refactor: replace Bun.stderr and Bun.color with Node.js equivalents                                                                             |
| `46d7d2fdc` | feature        | 1/0/0/0=1     | medium | skipped  | feat: add "gpt-5.4" to codex allowed models list (#16274)                                                                                       |
| `cb411248b` | feature        | 1/0/0/1=2     | low    | ported   | release: v1.2.19                                                                                                                                |
| `74effa8ee` | ux             | 0/0/0/-1=-1   | high   | skipped  | refactor(opencode): replace Bun.which with npm which (#15012)                                                                                   |
| `c04da45be` | infra          | 1/0/0/1=2     | low    | ported   | chore: update nix node_modules hashes                                                                                                           |
| `aec6ca71f` | behavioral-fix | 1/1/0/0=2     | medium | ported   | fix(git): stop leaking fsmonitor daemons e.g. 60GB+ of commited memory after running tests (#16249)                                             |
| `326c70184` | ux             | 0/0/0/-1=-1   | high   | skipped  | fix: restore Bun stdin reads for prompt input (#16300)                                                                                          |
| `6c7d968c4` | feature        | 1/0/0/1=2     | low    | ported   | release: v1.2.20                                                                                                                                |
| `b7605add5` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): enable auto-accept keybind regardless of permission config (#16259)                                                                   |
| `d4d1292a0` | infra          | 1/0/0/1=2     | low    | ported   | chore: generate                                                                                                                                 |
| `eb9eb5e33` | docs           | -1/-1/-1/1=-2 | low    | skipped  | feat: Add Vietnamese README and update all language navigation links … (#16322)                                                                 |
| `f64bb9125` | behavioral-fix | 1/1/0/1=3     | low    | ported   | fix(app): add english to locale matchers (#16280)                                                                                               |
| `e1cf761d2` | docs           | -1/-1/-1/1=-2 | low    | skipped  | chore: generate                                                                                                                                 |

## Execution Queue

1. [ ] Confirm high-risk items (ported vs skipped).
2. [ ] Refactor-port selected items by behavior reimplementation (no cherry-pick/merge).
3. [ ] Update ledger with final status mapping.

## Mapping to Ledger

| Upstream Commit | Status  | Local Commit | Note                                                                                                                                            |
| :-------------- | :------ | :----------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| `7e6a007c3`     | ported  | -            | feat(app): auto-accept all permissions mode                                                                                                     |
| `931286756`     | ported  | -            | feat(app): new tabs styling (#15284)                                                                                                            |
| `270d084cb`     | ported  | -            | fix(ui): avoid truncating workspace paths in assistant text (#14584)                                                                            |
| `a0b3bbffd`     | ported  | -            | fix(ui): prevent filename and diff count overlap in session changes (#14773)                                                                    |
| `8c484a05b`     | ported  | -            | fix(app): terminal issues                                                                                                                       |
| `05d77b7d4`     | ported  | -            | chore: storybook (#15285)                                                                                                                       |
| `9736fce8f`     | ported  | -            | chore: update nix node_modules hashes                                                                                                           |
| `c95febb1d`     | ported  | -            | tui: fix session tab alignment in compact view to prevent vertical overflow                                                                     |
| `7a74be3b4`     | ported  | -            | tweak(ui): add border to filetree on scroll                                                                                                     |
| `adabad19f`     | ported  | -            | Revert "fix(ui): prevent filename and diff count overlap in session changes (#14773)"                                                           |
| `37d42595c`     | ported  | -            | fix: test                                                                                                                                       |
| `09e1b98bc`     | ported  | -            | tweak(ui): max-width on session when the review is closed but the file tree is open                                                             |
| `bf442a50c`     | ported  | -            | fix(ui): mute inactive file tab icons                                                                                                           |
| `fa119423e`     | ported  | -            | tweak(app): align review changes select height                                                                                                  |
| `9a6bfeb78`     | ported  | -            | refactor(app): dedupe filetree scroll state                                                                                                     |
| `fc52e4b2d`     | ported  | -            | feat(app): better diff/code comments (#14621)                                                                                                   |
| `4205fbd2a`     | ported  | -            | tweak(app): show keybind on context tab close                                                                                                   |
| `e9a7c7114`     | ported  | -            | fix(app): permission notifications                                                                                                              |
| `b0b88f679`     | ported  | -            | fix(app): permission indicator                                                                                                                  |
| `f2100dcfd`     | ported  | -            | fix(app): scroll jacking                                                                                                                        |
| `8c739b4a7`     | ported  | -            | zen: fix go plan usage limit                                                                                                                    |
| `752841917`     | ported  | -            | app: allow providing username and password when connecting to remote server (#14872)                                                            |
| `2a4ed4955`     | ported  | -            | wip: zen                                                                                                                                        |
| `0da8af8a2`     | ported  | -            | desktop: move open_path to rust (#15323)                                                                                                        |
| `6b3118883`     | ported  | -            | wip: zen                                                                                                                                        |
| `1f108bc40`     | ported  | -            | feat(app): recent projects section in command pallette (#15270)                                                                                 |
| `dc8c01151`     | skipped | -            | docs(readme): add Greek translation and update language navigation (#15281)                                                                     |
| `a325c9af8`     | ported  | -            | feat(app): add Turkish (tr) locale for app and ui packages (#15278)                                                                             |
| `3407ded9d`     | ported  | -            | chore: generate                                                                                                                                 |
| `4a9409699`     | ported  | -            | fix(app): update provider sprite                                                                                                                |
| `dfa028111`     | ported  | -            | fix(app): auto-accept permissions                                                                                                               |
| `967313234`     | ported  | -            | desktop: add latest.json finalizer script (#15335)                                                                                              |
| `157920b2f`     | ported  | -            | chore: update test                                                                                                                              |
| `3dc10a1c1`     | skipped | -            | Change keybindings to navigate between child sessions (#14814)                                                                                  |
| `78cea89e0`     | ported  | -            | chore(script): source team members from TEAM_MEMBERS (#15369)                                                                                   |
| `e49e781cb`     | ported  | -            | feat(app): add Warp to the open menu (#15368)                                                                                                   |
| `9d76ef6c6`     | skipped | -            | chore: update docs locale sync workflow                                                                                                         |
| `e5ae6c51b`     | skipped | -            | chore: update translator model                                                                                                                  |
| `6ef3af73d`     | ported  | -            | chore(app): i18n sync (#15362)                                                                                                                  |
| `a94f564ff`     | ported  | -            | fix(app): scroll issues                                                                                                                         |
| `c12ce2fff`     | skipped | -            | feat(core): basic implementation of remote workspace support (#15120)                                                                           |
| `7ff2710ce`     | ported  | -            | chore: generate                                                                                                                                 |
| `f347194e3`     | skipped | -            | docs: add missing Bosanski link to Arabic README (#15399)                                                                                       |
| `1f2348c1e`     | ported  | -            | fix(app): make bash output selectable (#15378)                                                                                                  |
| `46d678fce`     | ported  | -            | chore: generate                                                                                                                                 |
| `a3bdb974b`     | ported  | -            | chore(app): deps                                                                                                                                |
| `7f851da15`     | ported  | -            | chore(console): i18n sync (#15360)                                                                                                              |
| `1f1f36aac`     | ported  | -            | chore: update nix node_modules hashes                                                                                                           |
| `d2a8f44c2`     | ported  | -            | doc: opencode go                                                                                                                                |
| `2eb1d4cb9`     | skipped | -            | doc: go                                                                                                                                         |
| `0b8c1f1f7`     | skipped | -            | docs: Update OpenCode Go subscription and usage details (#15415)                                                                                |
| `267d2c82d`     | skipped | -            | chore: cleanup                                                                                                                                  |
| `2a2082233`     | ported  | -            | fix(app): display skill name in skill tool call (#15413)                                                                                        |
| `971bd3051`     | ported  | -            | fix(app): fallback to synthetic icon for unknown provider IDs (#15295)                                                                          |
| `e1e18c7ab`     | skipped | -            | chore(docs): i18n sync (#15417)                                                                                                                 |
| `114eb4244`     | skipped | -            | docs: fix broken config imports in translated documentation                                                                                     |
| `cec16dfe9`     | skipped | -            | feat(core): add WorkspaceContext (#15409)                                                                                                       |
| `fcd733e3d`     | ported  | -            | chore: generate                                                                                                                                 |
| `3ee1653f4`     | skipped | -            | feat(core): add workspace_id to `session` table (#15410)                                                                                        |
| `b88e8e0e0`     | ported  | -            | chore: generate                                                                                                                                 |
| `4d968ebd6`     | skipped | -            | docs(ecosystem): add opencode-vibeguard (#15464)                                                                                                |
| `38704acac`     | skipped | -            | chore: generate                                                                                                                                 |
| `c4c0b23bf`     | ported  | -            | fix: kill orphaned MCP child processes and expose OPENCODE_PID on shu… (#15516)                                                                 |
| `438610aa6`     | ported  | -            | fix(app): show proper usage limit errors (#15496)                                                                                               |
| `f5eade1d2`     | ported  | -            | fix(i18n): polish turkish translations (#15491)                                                                                                 |
| `c8866e60b`     | ported  | -            | fix(app): make provider icon resolved id reactive (#15583)                                                                                      |
| `b15fb2119`     | ported  | -            | feat(app): add compact ui (#15578)                                                                                                              |
| `6b7e6bde4`     | skipped | -            | fix(opencode): show human-readable message for HTML error responses (#15407)                                                                    |
| `90270c615`     | skipped | -            | feat(tui): improve task tool display with subagent keybind hints and spinner animations (#15607)                                                |
| `ae0f69e1f`     | skipped | -            | doc: add zen deprecated models                                                                                                                  |
| `c0483affa`     | ported  | -            | perf(session): faster session switching via windowed rendering and staged timeline (#15474)                                                     |
| `d1938a472`     | ported  | -            | chore: generate                                                                                                                                 |
| `a692e6fdd`     | ported  | -            | desktop: use correct download link in finalize-latest-json                                                                                      |
| `cf7885516`     | ported  | -            | Revert "fix(i18n): polish turkish translations" (#15656)                                                                                        |
| `b1bfecb71`     | ported  | -            | desktop: fix latest.json finalizer                                                                                                              |
| `7bfbb1fcf`     | ported  | -            | fix: project ID conflict, and update on same session id (#15596)                                                                                |
| `be20f865a`     | skipped | -            | fix: recover from 413 Request Entity Too Large via auto-compaction (#14707)                                                                     |
| `4b9e19f72`     | skipped | -            | chore: generate                                                                                                                                 |
| `bf2cc3aa2`     | ported  | -            | feat(app): show which messages are queued (#15587)                                                                                              |
| `51e600019`     | ported  | -            | core: keep review header buttons visible when scroll thumb shows                                                                                |
| `4c2aa4ab9`     | ported  | -            | ui: widen scroll thumb hit area                                                                                                                 |
| `d60696ded`     | ported  | -            | ui: tighten scroll thumb and review padding                                                                                                     |
| `633a3ba03`     | ported  | -            | ui: avoid session review header clipping                                                                                                        |
| `0a3a3216d`     | ported  | -            | ui: move session review bottom padding                                                                                                          |
| `8176bafc5`     | ported  | -            | chore(app): solidjs refactoring (#13399)                                                                                                        |
| `1cd77b107`     | skipped | -            | chore: fix docs sync permissions                                                                                                                |
| `78069369e`     | ported  | -            | fix(app): default auto-respond to false                                                                                                         |
| `9d7852b5c`     | ported  | -            | Animation Smorgasbord (#15637)                                                                                                                  |
| `b5dc6e670`     | ported  | -            | chore: generate                                                                                                                                 |
| `98c75be7e`     | ported  | -            | chore: update nix node_modules hashes                                                                                                           |
| `fd6f7133c`     | ported  | -            | fix(opencode): clone part data in Bus event to preserve token values (#15780)                                                                   |
| `96d6fb78d`     | skipped | -            | fix(provider): forward metadata options to cloudflare-ai-gateway provider (#15619)                                                              |
| `e41b53504`     | skipped | -            | chore: generate                                                                                                                                 |
| `7e3e85ba5`     | skipped | -            | fix(opencode): avoid gemini combiner schema sibling injection (#15318)                                                                          |
| `9f150b077`     | skipped | -            | chore: generate                                                                                                                                 |
| `6aa4928e9`     | ported  | -            | wip: zen                                                                                                                                        |
| `881ca8643`     | ported  | -            | chore: generate                                                                                                                                 |
| `1233ebcce`     | ported  | -            | wip: zen                                                                                                                                        |
| `b985ea344`     | ported  | -            | wip: zen                                                                                                                                        |
| `6deb27e85`     | skipped | -            | zen: docs                                                                                                                                       |
| `48412f75a`     | ported  | -            | chore: nix flake update for bun 1.3.10 (#15648)                                                                                                 |
| `18850c4f9`     | skipped | -            | fix(opencode): disable session navigation commands when no parent session (#15762)                                                              |
| `5e8742f43`     | ported  | -            | fix(app): timeline jank                                                                                                                         |
| `e4af1bb42`     | ported  | -            | fix(app): timeline jank                                                                                                                         |
| `1e2da6016`     | ported  | -            | chore: fix test                                                                                                                                 |
| `7305fc044`     | ported  | -            | chore: cleanup                                                                                                                                  |
| `356b5d460`     | ported  | -            | fix(app): stabilize project close navigation (#15817)                                                                                           |
| `cbf057048`     | ported  | -            | fix: update Turkish translations (#15835)                                                                                                       |
| `70b6a0523`     | skipped | -            | chore: generate                                                                                                                                 |
| `da82d4035`     | skipped | -            | chore: tr glossary                                                                                                                              |
| `fa45422bf`     | ported  | -            | chore: cleanup                                                                                                                                  |
| `10c325810`     | ported  | -            | fix(app): tighten up header elements                                                                                                            |
| `fd4d3094b`     | ported  | -            | fix(app): timeline jank                                                                                                                         |
| `c2091acd8`     | skipped | -            | wip: zen                                                                                                                                        |
| `b751bd037`     | skipped | -            | docs(i18n): sync locale docs from english changes                                                                                               |
| `3310c25dd`     | skipped | -            | Upgrade opentui to v0.1.86 and activate markdown renderable by default (#14974)                                                                 |
| `6f90c3d73`     | ported  | -            | chore: update nix node_modules hashes                                                                                                           |
| `70c6fcfbb`     | ported  | -            | chore: cleanup                                                                                                                                  |
| `9d427c1ef`     | ported  | -            | fix(app): defer diff rendering                                                                                                                  |
| `502dbb65f`     | ported  | -            | fix(app): defer diff rendering                                                                                                                  |
| `3c8ce4ab9`     | ported  | -            | feat(console): add /go landing page                                                                                                             |
| `b1c166edf`     | ported  | -            | chore(console): add Go to nav                                                                                                                   |
| `1663c11f4`     | skipped | -            | wip: zen                                                                                                                                        |
| `74ebb4147`     | ported  | -            | fix(auth): normalize trailing slashes in auth login URLs (#15874)                                                                               |
| `c2f5abe75`     | ported  | -            | chore(console): move Enterprise after Go                                                                                                        |
| `d80334b2b`     | ported  | -            | chore(console): update /go hero copy                                                                                                            |
| `12f4315d9`     | ported  | -            | chore(console): trim /go model logos                                                                                                            |
| `e3a787a7a`     | skipped | -            | tui: use arrow indicator for active tool execution (#15887)                                                                                     |
| `c78e7e1a2`     | skipped | -            | tui: show pending toolcall count instead of generic 'Running...' message                                                                        |
| `c4ffd93ca`     | skipped | -            | tui: replace curved arrow with straight arrow for better terminal compatibility                                                                 |
| `e66d829d1`     | ported  | -            | release: v1.2.16                                                                                                                                |
| `9a4292726`     | skipped | -            | revert: undo turbo typecheck dependency change from #14828 (#15902)                                                                             |
| `109ea1709`     | ported  | -            | fix: `run --attach` agent validation (#11812)                                                                                                   |
| `e79d41c70`     | skipped | -            | docs(bash): clarify output capture guidance (#15928)                                                                                            |
| `7f37acdaa`     | skipped | -            | feat(core): rework workspace integration and adaptor interface (#15895)                                                                         |
| `2a0be8316`     | ported  | -            | chore: generate                                                                                                                                 |
| `3ebebe0a9`     | skipped | -            | fix(process): prevent orphaned opencode subprocesses on shutdown (#15924)                                                                       |
| `e4f0825c5`     | ported  | -            | zen: fix aws bedrock header                                                                                                                     |
| `5cf235fa6`     | ported  | -            | desktop: add electron version (#15663)                                                                                                          |
| `5dcf3301e`     | ported  | -            | chore: update nix node_modules hashes                                                                                                           |
| `db3eddc51`     | ported  | -            | ui: rely on task part href instead of onClick handler (#15978)                                                                                  |
| `850fd9419`     | skipped | -            | fix(docs): update dead opencode-daytona ecosystem link (#15979)                                                                                 |
| `a2d3d62db`     | ported  | -            | chore(console): move login to end on zen/go                                                                                                     |
| `0541d756a`     | skipped | -            | docs(i18n): sync locale docs from english changes                                                                                               |
| `e8f67ddbc`     | ported  | -            | chore(console): update /go hero body                                                                                                            |
| `9909f9404`     | ported  | -            | chore(console): hide Go nav item on /go                                                                                                         |
| `570956191`     | ported  | -            | chore(console): refine /go hero and pricing copy                                                                                                |
| `e44cdaf88`     | ported  | -            | chore(console): use Go ornate logo on /go                                                                                                       |
| `0a2aa8688`     | ported  | -            | chore(console): switch /go page to go.\* i18n keys                                                                                              |
| `d7569a562`     | ported  | -            | fix(app): terminal tab close                                                                                                                    |
| `eb7185673`     | skipped | -            | docs: send Go landing page links to Go docs                                                                                                     |
| `dd4ad5f2c`     | ported  | -            | chore(console): edit copy                                                                                                                       |
| `2ccf21de9`     | ported  | -            | fix(app): loading session should be scrolled to the bottom                                                                                      |
| `ad5633810`     | ported  | -            | chore(console): update copy                                                                                                                     |
| `e482405cd`     | ported  | -            | fix(app): remove diff lines from sessions in sidebar                                                                                            |
| `64b21135f`     | ported  | -            | fix(app): delay dock animation on session load                                                                                                  |
| `a69742ccb`     | ported  | -            | fix(app): remove blur from todos                                                                                                                |
| `18cad1064`     | skipped | -            | show scrollbar by default (#15282)                                                                                                              |
| `e3267413c`     | ported  | -            | remove build from typecheck                                                                                                                     |
| `faf501200`     | ported  | -            | ci: only publish electron on beta                                                                                                               |
| `1b0d65f80`     | ported  | -            | ci: remove electron beta requirement                                                                                                            |
| `715b844c2`     | ported  | -            | release: v1.2.17                                                                                                                                |
| `7c215c0d0`     | skipped | -            | docs: replace Go landing page video with interactive limits graph                                                                               |
| `61795d794`     | skipped | -            | docs: clarify Go models in FAQ answer                                                                                                           |
| `d94c51640`     | skipped | -            | docs: update Go privacy copy for global hosting                                                                                                 |
| `c6187ee40`     | skipped | -            | docs: de-link Go testimonials and swap Zen→Go                                                                                                   |
| `ca5a7378d`     | skipped | -            | docs: localize Go graph and testimonial copy                                                                                                    |
| `b42a63b88`     | skipped | -            | docs: make Go hero CTA translatable with pricing emphasis                                                                                       |
| `22fcde926`     | ported  | -            | tui: reduce excessive spacing in go route layout to improve visual balance                                                                      |
| `e9de2505f`     | ported  | -            | Merge branch 'dev' into go-page                                                                                                                 |
| `744c38cc7`     | ported  | -            | tui: clarify which models are available in Go subscription                                                                                      |
| `0f1f55a24`     | ported  | -            | tui: show Go request limits per 5-hour session                                                                                                  |
| `de6a6af5a`     | ported  | -            | tweak(ui): remove section                                                                                                                       |
| `b7198c28c`     | ported  | -            | tweak(ui): darker text                                                                                                                          |
| `6f2327174`     | ported  | -            | chore(ui): remove quotes                                                                                                                        |
| `40fc40642`     | ported  | -            | ci: make tsgo available for pre-push typechecks                                                                                                 |
| `29dbfc25e`     | skipped | -            | docs: Add opencode-sentry-monitor to ecosystem documentation (#16037)                                                                           |
| `22a4c5a77`     | skipped | -            | docs(i18n): sync locale docs from english changes                                                                                               |
| `0b825ca38`     | skipped | -            | docs: redesign Go pricing graph with horizontal bars and inline request labels                                                                  |
| `6cbb1ef1c`     | ported  | -            | wip: Make bar colors in limit graph customizable via CSS variables for consistent theming across the go route visualization                     |
| `f8685a4d5`     | ported  | -            | tui: clarify free tier includes Big Pickle and promotional requests on Go pricing page                                                          |
| `cd3a09c6a`     | ported  | -            | tui: clearer graph labels and responsive layout for usage visualization                                                                         |
| `67fa7903c`     | ported  | -            | tui: prevent Go pricing graph from overflowing on medium screens by constraining width and moving axis labels outside SVG for sharper rendering |
| `218330aec`     | ported  | -            | Merge branch 'go-page' into dev                                                                                                                 |
| `45ac20b8a`     | ported  | -            | fix(core): handle SIGHUP and kill process (#16057)                                                                                              |
| `27447bab2`     | ported  | -            | wip: zen                                                                                                                                        |
| `7f7e62242`     | skipped | -            | dont let dax touch the ui (#16060)                                                                                                              |
| `324230806`     | ported  | -            | chore: update turborepo (#16061)                                                                                                                |
| `85ff05670`     | ported  | -            | zen: update go page                                                                                                                             |
| `f363904fe`     | skipped | -            | feat(opencode): Adding options to auth login to skip questions (#14470)                                                                         |
| `7948de161`     | ported  | -            | app: prefer using useLocation instead of window.location (#15989)                                                                               |
| `6ddd13c6a`     | ported  | -            | chore: update nix node_modules hashes                                                                                                           |
| `6531cfc52`     | ported  | -            | desktop-electon: handle latest version update check properly                                                                                    |
| `4e26b0aec`     | ported  | -            | desktop: new-session deeplink (#15322)                                                                                                          |
| `161734fb9`     | ported  | -            | desktop: remove unnecessary macOS entitlements (#16161)                                                                                         |
| `a60e715fc`     | ported  | -            | fix(app): improve agent selection logic passing in configured models and variants correctly (#16072)                                            |
| `62909e917`     | ported  | -            | chore: generate                                                                                                                                 |
| `27baa2d65`     | ported  | -            | refactor(desktop): improve error handling and translation in server error formatting (#16171)                                                   |
| `2bb3dc585`     | ported  | -            | fix(app): no delay on tooltip close                                                                                                             |
| `3448118be`     | ported  | -            | fix(app): mod+f always opens search                                                                                                             |
| `0e5edef51`     | ported  | -            | chore(console): go page i18n                                                                                                                    |
| `5f40bd42f`     | ported  | -            | fix(app): icon jiggle                                                                                                                           |
| `07348d14a`     | ported  | -            | fix(app): preserve question dock state across session switches (#16173)                                                                         |
| `8cbe7b4a0`     | ported  | -            | fix(app): file icon stability                                                                                                                   |
| `6c9ae5ce9`     | ported  | -            | fix(app): file path truncation in session turn                                                                                                  |
| `6f9e5335d`     | ported  | -            | fix(app): file icon stability                                                                                                                   |
| `4c185c70f`     | ported  | -            | fix(app): provider settings consistency                                                                                                         |
| `1a420a1a7`     | ported  | -            | fix(app): websearch and codesearch tool rendering                                                                                               |
| `152df2428`     | ported  | -            | fix(app): stale read error                                                                                                                      |
| `a3d4ea0de`     | ported  | -            | fix(app): locale error                                                                                                                          |
| `7665b8e30`     | ported  | -            | fix(app): stale keyed show errors                                                                                                               |
| `d802e2838`     | ported  | -            | update sdk package.json                                                                                                                         |
| `bb37e908a`     | ported  | -            | ci: remove unused publishConfig that was breaking npm publishing                                                                                |
| `9cccaa693`     | ported  | -            | chore(app): ghostty-web fork                                                                                                                    |
| `4da199697`     | skipped | -            | feat(tui): add onClick handler to InlineTool and Task components (#16187)                                                                       |
| `9507b0eac`     | ported  | -            | chore: update nix node_modules hashes                                                                                                           |
| `2c58964a6`     | ported  | -            | release: v1.2.18                                                                                                                                |
| `0638e49b0`     | skipped | -            | zen: gpt5.4                                                                                                                                     |
| `e3b6d84b5`     | skipped | -            | docs(i18n): sync locale docs from english changes                                                                                               |
| `2ba1ecabc`     | ported  | -            | fix(app): load tab on open file                                                                                                                 |
| `76cdc668e`     | skipped | -            | fix(console): follow-up for #13108 docs/en routing and locale cookie sync (#13608)                                                              |
| `80c36c788`     | skipped | -            | zen: gpt5.3 codex spark                                                                                                                         |
| `a6978167a`     | skipped | -            | ci: fix                                                                                                                                         |
| `adaee6636`     | skipped | -            | zen: gpt 5.4 pro                                                                                                                                |
| `39691e517`     | ported  | -            | tui: remove keyboard shortcut tooltips from new session and new workspace buttons in the sidebar                                                |
| `cf425d114`     | ported  | -            | fix(app): stale show (#16236)                                                                                                                   |
| `3ebba02d0`     | skipped | -            | refactor: replace Bun.sleep with node timers (#15013)                                                                                           |
| `6e89d3e59`     | skipped | -            | refactor: replace Bun.write/file with Filesystem utilities in snapshot                                                                          |
| `dad248832`     | skipped | -            | refactor: replace Bun.write with Filesystem.write in config files                                                                               |
| `a9bf1c050`     | skipped | -            | refactor: replace Bun.hash with Hash.fast using xxhash3-xxh64                                                                                   |
| `ae5c9ed3d`     | skipped | -            | refactor: replace Bun.stdin.text with Node.js stream reading                                                                                    |
| `7e2809836`     | skipped | -            | refactor: use node:stream/consumers for stdin reading                                                                                           |
| `6733a5a82`     | ported  | -            | fix: use sha1 for hash instead of unsupported xxhash3-xxh64                                                                                     |
| `bf35a865b`     | skipped | -            | refactor: replace Bun.connect with net.createConnection                                                                                         |
| `d68afcaa5`     | skipped | -            | refactor: replace Bun.stderr and Bun.color with Node.js equivalents                                                                             |
| `46d7d2fdc`     | skipped | -            | feat: add "gpt-5.4" to codex allowed models list (#16274)                                                                                       |
| `cb411248b`     | ported  | -            | release: v1.2.19                                                                                                                                |
| `74effa8ee`     | skipped | -            | refactor(opencode): replace Bun.which with npm which (#15012)                                                                                   |
| `c04da45be`     | ported  | -            | chore: update nix node_modules hashes                                                                                                           |
| `aec6ca71f`     | ported  | -            | fix(git): stop leaking fsmonitor daemons e.g. 60GB+ of commited memory after running tests (#16249)                                             |
| `326c70184`     | skipped | -            | fix: restore Bun stdin reads for prompt input (#16300)                                                                                          |
| `6c7d968c4`     | ported  | -            | release: v1.2.20                                                                                                                                |
| `b7605add5`     | ported  | -            | fix(app): enable auto-accept keybind regardless of permission config (#16259)                                                                   |
| `d4d1292a0`     | ported  | -            | chore: generate                                                                                                                                 |
| `eb9eb5e33`     | skipped | -            | feat: Add Vietnamese README and update all language navigation links … (#16322)                                                                 |
| `f64bb9125`     | ported  | -            | fix(app): add english to locale matchers (#16280)                                                                                               |
| `e1cf761d2`     | skipped | -            | chore: generate                                                                                                                                 |
