# Refactor Plan: 2026-02-13 (origin/dev → HEAD, origin_dev_delta_20260214)

Date: 2026-02-13
Status: WAITING_APPROVAL

## Summary

- Upstream pending (raw): 109 commits
- Excluded by processed ledger: 31 commits
- Commits for this round: 78 commits

## Actions

| Commit | Logical Type | Value Score | Risk | Decision | Notes |
| :----- | :----------- | :---------- | :--- | :------- | :---- |
| `5f421883a` | infra | 1/0/0/1=2 | low | integrated | chore: style loading screen |
| `ecb274273` | feature | 1/0/0/1=2 | low | integrated | wip(ui): diff virtualization (#12693) |
| `9f9f0fb8e` | infra | 1/0/0/1=2 | low | integrated | chore: update nix node_modules hashes |
| `d72314708` | infra | 1/0/0/1=2 | low | integrated | feat: update to not post comment on workflows when no duplicates found (#13238) |
| `d82d22b2d` | feature | 1/0/0/1=2 | low | integrated | wip: zen |
| `a11556505` | feature | 0/0/0/-1=-1 | high | skipped | core: allow model configurations without npm/api provider details |
| `892bb7526` | feature | 1/0/0/1=2 | low | integrated | release: v1.1.61 |
| `85df10671` | infra | 1/0/0/1=2 | low | integrated | chore: generate |
| `ae811ad8d` | feature | 1/0/0/1=2 | low | integrated | wip: zen |
| `56ad2db02` | feature | 1/0/0/0=1 | medium | skipped | core: expose tool arguments in shell hook for plugin visibility |
| `ff4414bb1` | infra | 1/0/0/1=2 | low | integrated | chore: refactor packages/app files (#13236) |
| `ed472d8a6` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): more defensive session context metrics |
| `a82ca8600` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): more defensive code component |
| `658bf6fa5` | docs | -1/-1/-1/1=-2 | low | skipped | zen: minimax m2.5 |
| `59a323e9a` | docs | -1/-1/-1/1=-2 | low | skipped | wip: zen |
| `ecab692ca` | docs | -1/-1/-1/1=-2 | low | skipped | fix(docs): correct `format` attribute in `StructuredOutputs` (#13340) |
| `2db618dea` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix: downgrade bun to 1.3.5 (#13347) |
| `847e06f9e` | infra | 1/0/0/1=2 | low | integrated | chore: update nix node_modules hashes |
| `ba54cee55` | feature | 1/0/0/0=1 | medium | skipped | feat(tool): return image attachments from webfetch (#13331) |
| `789705ea9` | docs | -1/-1/-1/1=-2 | low | skipped | ignore: document test fixtures for agents |
| `da952135c` | feature | 1/0/0/1=2 | low | integrated | chore(app): refactor for better solidjs hygiene (#13344) |
| `0771e3a8b` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): preserve undo history for plain-text paste (#13351) |
| `ff0abacf4` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): project icons unloading |
| `aaee5fb68` | feature | 1/0/0/1=2 | low | integrated | release: v1.1.62 |
| `e6e9c15d3` | feature | 1/0/0/0=1 | medium | skipped | improve codex model list |
| `ac018e3a3` | feature | 1/0/0/1=2 | low | integrated | release: v1.1.63 |
| `d1ee4c8dc` | feature | 1/0/0/1=2 | low | integrated | test: add more test cases for project.test.ts (#13355) |
| `958320f9c` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): remote http server connections |
| `50f208d69` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): suggestion active state broken |
| `3696d1ded` | infra | 1/0/0/1=2 | low | integrated | chore: cleanup |
| `81c623f26` | infra | 1/0/0/1=2 | low | integrated | chore: cleanup |
| `e9b9a62fe` | infra | 1/0/0/1=2 | low | integrated | chore: cleanup |
| `7ccf223c8` | infra | 1/0/0/1=2 | low | integrated | chore: cleanup |
| `70303d0b4` | infra | 1/0/0/1=2 | low | integrated | chore: cleanup |
| `ff3b174c4` | protocol | 1/0/0/1=2 | low | integrated | fix(app): normalize oauth error messages |
| `4e0f509e7` | feature | 1/0/0/1=2 | low | integrated | feat(app): option to turn off sound effects |
| `548608b7a` | behavioral-fix | 1/1/0/0=2 | medium | integrated | fix(app): terminal pty isolation |
| `11dd281c9` | docs | -1/-1/-1/1=-2 | low | skipped | docs: update STACKIT provider documentation with typo fix (#13357) |
| `20dcff1e2` | docs | -1/-1/-1/1=-2 | low | skipped | chore: generate |
| `c0814da78` | ux | 0/0/0/-1=-1 | high | skipped | do not open console on error (#13374) |
| `a8f288452` | ux | 0/0/0/-1=-1 | high | skipped | feat: windows selection behavior, manual ctrl+c (#13315) |
| `4018c863e` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix: baseline CPU detection (#13371) |
| `445e0d767` | infra | 1/0/0/1=2 | low | integrated | chore: update nix node_modules hashes |
| `93eee0daf` | behavioral-fix | 0/1/0/-1=0 | high | ported | fix: look for recent model in fallback in cli (#12582) |
| `d475fd613` | infra | 0/0/0/-1=-1 | high | skipped | chore: generate |
| `f66624fe6` | infra | 1/0/0/0=1 | medium | skipped | chore: cleanup flag code (#13389) |
| `29671c139` | behavioral-fix | 1/1/0/0=2 | medium | integrated | fix: token substitution in OPENCODE_CONFIG_CONTENT (#13384) |
| `76db21867` | feature | 1/0/0/1=2 | low | integrated | release: v1.1.64 |
| `991496a75` | behavioral-fix | 1/1/0/0=2 | medium | integrated | fix: resolve ACP hanging indefinitely in thinking state on Windows (#13222) |
| `adb0c4d4f` | feature | 1/0/0/1=2 | low | integrated | desktop: only show loading window if sqlite migration is necessary |
| `0303c29e3` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): failed to create store |
| `8da5fd0a6` | behavioral-fix | 1/1/0/0=2 | medium | integrated | fix(app): worktree delete |
| `b525c03d2` | infra | 1/0/0/1=2 | low | integrated | chore: cleanup |
| `7f95cc64c` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): prompt input quirks |
| `c9719dff7` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): notification should navigate to session |
| `dec304a27` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): emoji as avatar |
| `e0f1c3c20` | feature | 1/0/0/1=2 | low | integrated | cleanup desktop loading page |
| `fb7b2f6b4` | feature | 1/0/0/1=2 | low | integrated | feat(app): toggle all provider models |
| `dd296f703` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): reconnect event stream on disconnect |
| `b06afd657` | infra | 1/0/0/1=2 | low | integrated | ci: remove signpath policy |
| `1608565c8` | feature | 1/0/0/0=1 | medium | skipped | feat(hook): add tool.definition hook for plugins to modify tool description and parameters (#4956) |
| `98aeb60a7` | behavioral-fix | 1/1/0/0=2 | medium | integrated | fix: ensure @-ing a dir uses the read tool instead of dead list tool (#13428) |
| `1fb6c0b5b` | feature | 1/0/0/0=1 | medium | skipped | Revert "fix: token substitution in OPENCODE_CONFIG_CONTENT" (#13429) |
| `34ebe814d` | feature | 1/0/0/1=2 | low | integrated | release: v1.1.65 |
| `0d90a22f9` | feature | 0/0/0/-1=-1 | high | skipped | feat: update some ai sdk packages and uuse adaptive reasoning for opus 4.6 on vertex/bedrock/anthropic (#13439) |
| `693127d38` | feature | 1/0/0/0=1 | medium | skipped | feat(cli): add --dir option to run command (#12443) |
| `b8ee88212` | infra | 1/0/0/1=2 | low | integrated | chore: update nix node_modules hashes |
| `ebb907d64` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(desktop): performance optimization for showing large diff & files  (#13460) |
| `9f20e0d14` | docs | 1/-1/-1/1=0 | low | skipped | fix(web): sync docs locale cookie on alias redirects (#13109) |
| `ebe5a2b74` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): remount SDK/sync tree when server URL changes (#13437) |
| `b1764b2ff` | docs | -1/-1/-1/1=-2 | low | skipped | docs: Fix zh-cn translation mistake in tools.mdx (#13407) |
| `f991a6c0b` | docs | -1/-1/-1/1=-2 | low | skipped | chore: generate |
| `e242fe19e` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(web): use prompt_async endpoint to avoid timeout over VPN/tunnel (#12749) |
| `1c71604e0` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): terminal resize |
| `4f51c0912` | infra | 1/0/0/1=2 | low | integrated | chore: cleanup |
| `b8848cfae` | docs | -1/-1/-1/1=-2 | low | skipped | docs(ko): polish Korean phrasing in acp, agents, config, and custom-tools docs (#13446) |
| `88e2eb541` | docs | -1/-1/-1/1=-2 | low | skipped | docs: add pacman installation option for Arch Linux alongside AUR (#13293) |
| `bc1fd0633` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(test): move timeout config to CLI flag (#13494) |

## Execution Queue

1. [ ] Confirm high-risk items (ported vs skipped).
2. [ ] Integrate low/medium-risk high-value items.
3. [ ] Update ledger with final status mapping.

## Mapping to Ledger

| Upstream Commit | Status | Local Commit | Note |
| :-------------- | :----- | :----------- | :--- |
| `5f421883a` | integrated | - | chore: style loading screen |
| `ecb274273` | integrated | - | wip(ui): diff virtualization (#12693) |
| `9f9f0fb8e` | integrated | - | chore: update nix node_modules hashes |
| `d72314708` | integrated | - | feat: update to not post comment on workflows when no duplicates found (#13238) |
| `d82d22b2d` | integrated | - | wip: zen |
| `a11556505` | skipped | - | core: allow model configurations without npm/api provider details |
| `892bb7526` | integrated | - | release: v1.1.61 |
| `85df10671` | integrated | - | chore: generate |
| `ae811ad8d` | integrated | - | wip: zen |
| `56ad2db02` | skipped | - | core: expose tool arguments in shell hook for plugin visibility |
| `ff4414bb1` | integrated | - | chore: refactor packages/app files (#13236) |
| `ed472d8a6` | integrated | - | fix(app): more defensive session context metrics |
| `a82ca8600` | integrated | - | fix(app): more defensive code component |
| `658bf6fa5` | skipped | - | zen: minimax m2.5 |
| `59a323e9a` | skipped | - | wip: zen |
| `ecab692ca` | skipped | - | fix(docs): correct `format` attribute in `StructuredOutputs` (#13340) |
| `2db618dea` | integrated | - | fix: downgrade bun to 1.3.5 (#13347) |
| `847e06f9e` | integrated | - | chore: update nix node_modules hashes |
| `ba54cee55` | skipped | - | feat(tool): return image attachments from webfetch (#13331) |
| `789705ea9` | skipped | - | ignore: document test fixtures for agents |
| `da952135c` | integrated | - | chore(app): refactor for better solidjs hygiene (#13344) |
| `0771e3a8b` | integrated | - | fix(app): preserve undo history for plain-text paste (#13351) |
| `ff0abacf4` | integrated | - | fix(app): project icons unloading |
| `aaee5fb68` | integrated | - | release: v1.1.62 |
| `e6e9c15d3` | skipped | - | improve codex model list |
| `ac018e3a3` | integrated | - | release: v1.1.63 |
| `d1ee4c8dc` | integrated | - | test: add more test cases for project.test.ts (#13355) |
| `958320f9c` | integrated | - | fix(app): remote http server connections |
| `50f208d69` | integrated | - | fix(app): suggestion active state broken |
| `3696d1ded` | integrated | - | chore: cleanup |
| `81c623f26` | integrated | - | chore: cleanup |
| `e9b9a62fe` | integrated | - | chore: cleanup |
| `7ccf223c8` | integrated | - | chore: cleanup |
| `70303d0b4` | integrated | - | chore: cleanup |
| `ff3b174c4` | integrated | - | fix(app): normalize oauth error messages |
| `4e0f509e7` | integrated | - | feat(app): option to turn off sound effects |
| `548608b7a` | integrated | - | fix(app): terminal pty isolation |
| `11dd281c9` | skipped | - | docs: update STACKIT provider documentation with typo fix (#13357) |
| `20dcff1e2` | skipped | - | chore: generate |
| `c0814da78` | skipped | - | do not open console on error (#13374) |
| `a8f288452` | skipped | - | feat: windows selection behavior, manual ctrl+c (#13315) |
| `4018c863e` | integrated | - | fix: baseline CPU detection (#13371) |
| `445e0d767` | integrated | - | chore: update nix node_modules hashes |
| `93eee0daf` | ported | - | fix: look for recent model in fallback in cli (#12582) |
| `d475fd613` | skipped | - | chore: generate |
| `f66624fe6` | skipped | - | chore: cleanup flag code (#13389) |
| `29671c139` | integrated | - | fix: token substitution in OPENCODE_CONFIG_CONTENT (#13384) |
| `76db21867` | integrated | - | release: v1.1.64 |
| `991496a75` | integrated | - | fix: resolve ACP hanging indefinitely in thinking state on Windows (#13222) |
| `adb0c4d4f` | integrated | - | desktop: only show loading window if sqlite migration is necessary |
| `0303c29e3` | integrated | - | fix(app): failed to create store |
| `8da5fd0a6` | integrated | - | fix(app): worktree delete |
| `b525c03d2` | integrated | - | chore: cleanup |
| `7f95cc64c` | integrated | - | fix(app): prompt input quirks |
| `c9719dff7` | integrated | - | fix(app): notification should navigate to session |
| `dec304a27` | integrated | - | fix(app): emoji as avatar |
| `e0f1c3c20` | integrated | - | cleanup desktop loading page |
| `fb7b2f6b4` | integrated | - | feat(app): toggle all provider models |
| `dd296f703` | integrated | - | fix(app): reconnect event stream on disconnect |
| `b06afd657` | integrated | - | ci: remove signpath policy |
| `1608565c8` | skipped | - | feat(hook): add tool.definition hook for plugins to modify tool description and parameters (#4956) |
| `98aeb60a7` | integrated | - | fix: ensure @-ing a dir uses the read tool instead of dead list tool (#13428) |
| `1fb6c0b5b` | skipped | - | Revert "fix: token substitution in OPENCODE_CONFIG_CONTENT" (#13429) |
| `34ebe814d` | integrated | - | release: v1.1.65 |
| `0d90a22f9` | skipped | - | feat: update some ai sdk packages and uuse adaptive reasoning for opus 4.6 on vertex/bedrock/anthropic (#13439) |
| `693127d38` | skipped | - | feat(cli): add --dir option to run command (#12443) |
| `b8ee88212` | integrated | - | chore: update nix node_modules hashes |
| `ebb907d64` | integrated | - | fix(desktop): performance optimization for showing large diff & files  (#13460) |
| `9f20e0d14` | skipped | - | fix(web): sync docs locale cookie on alias redirects (#13109) |
| `ebe5a2b74` | integrated | - | fix(app): remount SDK/sync tree when server URL changes (#13437) |
| `b1764b2ff` | skipped | - | docs: Fix zh-cn translation mistake in tools.mdx (#13407) |
| `f991a6c0b` | skipped | - | chore: generate |
| `e242fe19e` | integrated | - | fix(web): use prompt_async endpoint to avoid timeout over VPN/tunnel (#12749) |
| `1c71604e0` | integrated | - | fix(app): terminal resize |
| `4f51c0912` | integrated | - | chore: cleanup |
| `b8848cfae` | skipped | - | docs(ko): polish Korean phrasing in acp, agents, config, and custom-tools docs (#13446) |
| `88e2eb541` | skipped | - | docs: add pacman installation option for Arch Linux alongside AUR (#13293) |
| `bc1fd0633` | integrated | - | fix(test): move timeout config to CLI flag (#13494) |
