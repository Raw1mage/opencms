# Refactor Plan: 2026-02-25 (origin/dev → cms, origin_dev_round15_rewrite_scan)

Date: 2026-02-25
Status: WAITING_APPROVAL

## Summary

- Upstream pending (raw): 574 commits
- Excluded by processed ledger: 29 commits
- Commits for this round: 545 commits

## Policy Guardrails

- Execution mode: rewrite-only refactor-port.
- Forbidden: `git cherry-pick`, `git merge`, or direct upstream patch transplant.
- Allowed: analyze behavior intent, then re-implement on cms architecture and validate.

## Actions

| Commit | Logical Type | Value Score | Risk | Decision | Notes |
| :----- | :----------- | :---------- | :--- | :------- | :---- |
| `81b5a6a08` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app):workspace reset (#13170) |
| `8f56ed5b8` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `fbabce112` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): translations |
| `6b30e0b75` | docs | 1/-1/-1/1=0 | low | skipped | chore: update docs sync workflow |
| `e3471526f` | feature | 1/0/0/1=2 | low | ported | add square logo variants to brand page |
| `e2a33f75e` | infra | 1/0/0/1=2 | low | ported | Update VOUCHED list |
| `125727d09` | feature | 1/0/0/1=2 | low | ported | upgrade opentui to 0.1.79 (#13036) |
| `264dd213f` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `c856f875a` | infra | 1/0/0/1=2 | low | ported | chore: upgrade bun to 1.3.9 (#13223) |
| `8577eb8ec` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `8eea53a41` | docs | -1/-1/-1/1=-2 | low | skipped | docs(ar): second-pass localization cleanup |
| `aea68c386` | docs | -1/-1/-1/1=-2 | low | skipped | fix(docs): locale translations for nav elements and headings |
| `81ca2df6a` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): guard randomUUID in insecure browser contexts (#13237) |
| `bf5a01edd` | feature | 0/0/0/-1=-1 | high | skipped | feat(opencode): Venice Add automatic variant generation for Venice models (#12106) |
| `135f8ffb2` | ux | 0/0/0/-1=-1 | high | skipped | feat(tui): add toggle to hide session header (#13244) |
| `5bdf1c4b9` | infra | 1/0/0/1=2 | low | ported | Update VOUCHED list |
| `ad2087094` | feature | 0/0/0/-1=-1 | high | skipped | support custom api url per model |
| `66780195d` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `e269788a8` | feature | 0/0/0/-1=-1 | high | skipped | feat: support claude agent SDK-style structured outputs in the OpenCode SDK  (#8161) |
| `f6e7aefa7` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `8f9742d98` | ux | 0/0/0/-1=-1 | high | skipped | fix(win32): use ffi to get around bun raw input/ctrl+c issues (#13052) |
| `03de51bd3` | feature | 1/0/0/1=2 | low | ported | release: v1.1.60 |
| `d86f24b6b` | feature | 1/0/0/1=2 | low | ported | zen: return cost |
| `1413d77b1` | feature | 1/0/0/1=2 | low | ported | desktop: sqlite migration progress bar (#13294) |
| `0eaeb4588` | feature | 1/0/0/1=2 | low | ported | Testing SignPath Integration (#13308) |
| `fa97475ee` | infra | 1/0/0/1=2 | low | ported | ci: move test-sigining policy |
| `5f421883a` | infra | 1/0/0/1=2 | low | ported | chore: style loading screen |
| `ecb274273` | feature | 1/0/0/1=2 | low | ported | wip(ui): diff virtualization (#12693) |
| `9f9f0fb8e` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `d72314708` | infra | 1/0/0/1=2 | low | ported | feat: update to not post comment on workflows when no duplicates found (#13238) |
| `d82d22b2d` | feature | 1/0/0/1=2 | low | ported | wip: zen |
| `a11556505` | feature | 0/0/0/-1=-1 | high | skipped | core: allow model configurations without npm/api provider details |
| `892bb7526` | feature | 1/0/0/1=2 | low | ported | release: v1.1.61 |
| `85df10671` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `ae811ad8d` | feature | 1/0/0/1=2 | low | ported | wip: zen |
| `ff4414bb1` | infra | 1/0/0/1=2 | low | ported | chore: refactor packages/app files (#13236) |
| `ed472d8a6` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): more defensive session context metrics |
| `a82ca8600` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): more defensive code component |
| `658bf6fa5` | docs | -1/-1/-1/1=-2 | low | skipped | zen: minimax m2.5 |
| `59a323e9a` | docs | -1/-1/-1/1=-2 | low | skipped | wip: zen |
| `ecab692ca` | docs | -1/-1/-1/1=-2 | low | skipped | fix(docs): correct `format` attribute in `StructuredOutputs` (#13340) |
| `2db618dea` | behavioral-fix | 1/1/0/1=3 | low | ported | fix: downgrade bun to 1.3.5 (#13347) |
| `847e06f9e` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `789705ea9` | docs | -1/-1/-1/1=-2 | low | skipped | ignore: document test fixtures for agents |
| `da952135c` | feature | 1/0/0/1=2 | low | ported | chore(app): refactor for better solidjs hygiene (#13344) |
| `0771e3a8b` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): preserve undo history for plain-text paste (#13351) |
| `ff0abacf4` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): project icons unloading |
| `aaee5fb68` | feature | 1/0/0/1=2 | low | ported | release: v1.1.62 |
| `ac018e3a3` | feature | 1/0/0/1=2 | low | ported | release: v1.1.63 |
| `958320f9c` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): remote http server connections |
| `50f208d69` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): suggestion active state broken |
| `3696d1ded` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `81c623f26` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `e9b9a62fe` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `7ccf223c8` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `70303d0b4` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `ff3b174c4` | protocol | 1/0/0/1=2 | low | ported | fix(app): normalize oauth error messages |
| `4e0f509e7` | feature | 1/0/0/1=2 | low | ported | feat(app): option to turn off sound effects |
| `548608b7a` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(app): terminal pty isolation |
| `11dd281c9` | docs | -1/-1/-1/1=-2 | low | skipped | docs: update STACKIT provider documentation with typo fix (#13357) |
| `20dcff1e2` | docs | -1/-1/-1/1=-2 | low | skipped | chore: generate |
| `c0814da78` | ux | 0/0/0/-1=-1 | high | skipped | do not open console on error (#13374) |
| `a8f288452` | ux | 0/0/0/-1=-1 | high | skipped | feat: windows selection behavior, manual ctrl+c (#13315) |
| `4018c863e` | behavioral-fix | 1/1/0/1=3 | low | ported | fix: baseline CPU detection (#13371) |
| `445e0d767` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `93eee0daf` | behavioral-fix | 0/1/0/-1=0 | high | skipped | fix: look for recent model in fallback in cli (#12582) |
| `d475fd613` | infra | 0/0/0/-1=-1 | high | skipped | chore: generate |
| `f66624fe6` | infra | 1/0/0/0=1 | medium | skipped | chore: cleanup flag code (#13389) |
| `29671c139` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix: token substitution in OPENCODE_CONFIG_CONTENT (#13384) |
| `76db21867` | feature | 1/0/0/1=2 | low | ported | release: v1.1.64 |
| `adb0c4d4f` | feature | 1/0/0/1=2 | low | ported | desktop: only show loading window if sqlite migration is necessary |
| `0303c29e3` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): failed to create store |
| `8da5fd0a6` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(app): worktree delete |
| `b525c03d2` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `7f95cc64c` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): prompt input quirks |
| `c9719dff7` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): notification should navigate to session |
| `dec304a27` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): emoji as avatar |
| `e0f1c3c20` | feature | 1/0/0/1=2 | low | ported | cleanup desktop loading page |
| `fb7b2f6b4` | feature | 1/0/0/1=2 | low | ported | feat(app): toggle all provider models |
| `dd296f703` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): reconnect event stream on disconnect |
| `b06afd657` | infra | 1/0/0/1=2 | low | ported | ci: remove signpath policy |
| `1fb6c0b5b` | feature | 1/0/0/0=1 | medium | ported | Revert "fix: token substitution in OPENCODE_CONFIG_CONTENT" (#13429) |
| `34ebe814d` | feature | 1/0/0/1=2 | low | ported | release: v1.1.65 |
| `0d90a22f9` | feature | 0/0/0/-1=-1 | high | skipped | feat: update some ai sdk packages and uuse adaptive reasoning for opus 4.6 on vertex/bedrock/anthropic (#13439) |
| `b8ee88212` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `ebb907d64` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(desktop): performance optimization for showing large diff & files  (#13460) |
| `9f20e0d14` | docs | 1/-1/-1/1=0 | low | skipped | fix(web): sync docs locale cookie on alias redirects (#13109) |
| `ebe5a2b74` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): remount SDK/sync tree when server URL changes (#13437) |
| `b1764b2ff` | docs | -1/-1/-1/1=-2 | low | skipped | docs: Fix zh-cn translation mistake in tools.mdx (#13407) |
| `f991a6c0b` | docs | -1/-1/-1/1=-2 | low | skipped | chore: generate |
| `e242fe19e` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(web): use prompt_async endpoint to avoid timeout over VPN/tunnel (#12749) |
| `1c71604e0` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): terminal resize |
| `4f51c0912` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `b8848cfae` | docs | -1/-1/-1/1=-2 | low | skipped | docs(ko): polish Korean phrasing in acp, agents, config, and custom-tools docs (#13446) |
| `88e2eb541` | docs | -1/-1/-1/1=-2 | low | skipped | docs: add pacman installation option for Arch Linux alongside AUR (#13293) |
| `bc1fd0633` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(test): move timeout config to CLI flag (#13494) |
| `72c09e1dc` | docs | -1/-1/-1/1=-2 | low | skipped | fix: standardize zh-CN docs character set and terminology (#13500) |
| `d30e91738` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(ui): support cmd-click links in inline code (#12552) |
| `6d95f0d14` | ux | 0/0/0/-1=-1 | high | skipped | sqlite again (#10597) |
| `afb04ed5d` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `7d4687277` | feature | 1/0/0/1=2 | low | ported | desktop: remote OPENCODE_SQLITE env (#13545) |
| `d0dcffefa` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `0b9e929f6` | feature | 1/0/0/1=2 | low | ported | desktop: fix rust |
| `ffc000de8` | feature | 1/0/0/1=2 | low | ported | release: v1.2.0 |
| `1e25df21a` | feature | 1/0/0/1=2 | low | ported | zen: minimax m2.5 & glm5 |
| `cd775a286` | feature | 1/0/0/1=2 | low | ported | release: v1.2.1 |
| `ed439b205` | infra | 1/0/0/1=2 | low | ported | ci: test-signing signpath policy |
| `df3203d2d` | infra | 1/0/0/1=2 | low | ported | ci: move signpath policy |
| `ef205c366` | feature | 1/0/0/1=2 | low | ported | bump vertex ai packages (#13625) |
| `759ec104b` | behavioral-fix | 0/1/0/-1=0 | high | skipped | fix vercel gateway variants (#13541) |
| `306fc7707` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `68bb8ce1d` | feature | 1/0/0/0=1 | medium | skipped | core: filter sessions at database level to improve session list loading performance |
| `3b6b3e6fc` | feature | 1/0/0/1=2 | low | ported | release: v1.2.2 |
| `933a491ad` | behavioral-fix | 0/1/0/-1=0 | high | skipped | fix: ensure vercel variants pass amazon models under bedrock key (#13631) |
| `575f2cf2a` | infra | 1/0/0/1=2 | low | ported | chore: bump nixpkgs to get bun 1.3.9 (#13302) |
| `839c5cda1` | behavioral-fix | 0/1/0/-1=0 | high | skipped | fix: ensure anthropic models on OR also have variant support (#13498) |
| `7911cb62a` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `c190f5f61` | feature | 1/0/0/1=2 | low | ported | release: v1.2.3 |
| `460a87f35` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): stack overflow in filetree (#13667) |
| `85b5f5b70` | feature | 1/0/0/1=2 | low | ported | feat(app): clear notifications action (#13668) |
| `2bab5e8c3` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix: derive all IDs from file paths during json migration |
| `b5c8bd342` | feature | 1/0/0/1=2 | low | ported | test: add tests for path-derived IDs in json migration |
| `45f005037` | feature | 1/0/0/0=1 | medium | skipped | core: add db command for database inspection and querying |
| `d1482e148` | feature | 1/0/0/1=2 | low | ported | release: v1.2.4 |
| `985c2a3d1` | feature | 1/0/0/1=2 | low | ported | feat: Add GeistMono Nerd Font to available mono font options (#13720) |
| `3aaa34be1` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(desktop): focus window after update/relaunch (#13701) |
| `376112172` | docs | -1/-1/-1/1=-2 | low | skipped | docs: add Ukrainian README translation (#13697) |
| `878ddc6a0` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): keybind [shift+tab] (#13695) |
| `3c85cf4fa` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): only navigate prompt history at input boundaries (#13690) |
| `cf50a289d` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(desktop): issue viewing new files opened from the file tree (#13689) |
| `3a3aa300b` | feature | 1/0/0/1=2 | low | ported | feat(app): localize "free usage exceeded" error & "Add credits" clickable link (#13652) |
| `62a24c2dd` | feature | 1/0/0/1=2 | low | ported | release: v1.2.5 |
| `9b23130ac` | feature | 1/0/0/0=1 | medium | skipped | feat(opencode): add `cljfmt` formatter support for Clojure files (#13426) |
| `d9363da9e` | docs | -1/-1/-1/1=-2 | low | skipped | fix(website): correct zh-CN translation of proprietary terms in zen.mdx (#13734) |
| `21e077800` | docs | -1/-1/-1/1=-2 | low | skipped | chore: generate |
| `920255e8c` | feature | 1/0/0/1=2 | low | ported | desktop: use process-wrap instead of manual job object (#13431) |
| `afd0716cb` | feature | 0/0/0/-1=-1 | high | skipped | feat(opencode): Add Venice support in temperature, topP, topK and smallOption (#13553) |
| `60807846a` | ux | 1/0/0/1=2 | low | ported | fix(desktop): normalize Linux Wayland/X11 backend and decoration policy (#13143) |
| `f7708efa5` | feature | 0/0/0/-1=-1 | high | skipped | feat: add openai-compatible endpoint support for google-vertex provider (#10303) |
| `089ab9def` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `1d041c886` | behavioral-fix | 0/1/0/-1=0 | high | skipped | fix: google vertex var priority (#13816) |
| `3ebf27aab` | docs | -1/-1/-1/1=-2 | low | skipped | fix(docs): correct critical translation errors in Russian zen page (#13830) |
| `b055f973d` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `bb30e0685` | ux | 0/0/0/-1=-1 | high | skipped | fix (tui): Inaccurate tips (#13845) |
| `ef979ccfa` | protocol | 1/0/0/1=2 | low | ported | fix: bump GitLab provider and auth plugin for mid-session token refresh (#13850) |
| `8c1af9b44` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `5cc1d6097` | ux | 0/0/0/-1=-1 | high | skipped | feat(cli): add --continue and --fork flags to attach command (#13879) |
| `fdad823ed` | feature | 1/0/0/0=1 | medium | skipped | feat(cli): add db migrate command for JSON to SQLite migration (#13874) |
| `ae6e85b2a` | feature | 1/0/0/1=2 | low | ported | ignore: rm random comment on opencode.jsonc |
| `16332a858` | ux | 0/0/0/-1=-1 | high | skipped | fix(tui): make use of server dir path for file references in prompts (#13781) |
| `160ba295a` | feature | 1/0/0/0=1 | medium | skipped | feat(opencode): add `dfmt` formatter support for D language files (#13867) |
| `d8c25bfeb` | feature | 1/0/0/1=2 | low | ported | release: v1.2.6 |
| `b0afdf6ea` | feature | 1/0/0/0=1 | medium | skipped | feat(cli): add session delete command (#13571) |
| `9d3c81a68` | feature | 1/0/0/0=1 | medium | skipped | feat(acp): add opt-in flag for question tool (#13562) |
| `a580fb47d` | feature | 1/0/0/0=1 | medium | skipped | tweak: drop ids from attachments in tools, assign them in prompt.ts instead (#13890) |
| `d93cefd47` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(website): fix site in safari 18 (#13894) |
| `916361198` | infra | 1/0/0/1=2 | low | ported | ci: fixed apt cache not working in publish.yml (#13897) |
| `0e669b601` | infra | 1/0/0/1=2 | low | ported | ci: use `useblacksmith/stickydisk` on linux runners only (#13909) |
| `e35a4131d` | feature | 1/0/0/0=1 | medium | skipped | core: keep message part order stable when files resolve asynchronously (#13915) |
| `422609722` | infra | 1/0/0/1=2 | low | ported | ci: fixed Rust cache for 'cargo install' in publish.yml (#13907) |
| `ea2d089db` | infra | 1/0/0/1=2 | low | ported | ci: fixed missing if condition (#13934) |
| `d338bd528` | feature | 1/0/0/1=2 | low | ported | Hide server CLI on windows (#13936) |
| `ace63b3dd` | docs | -1/-1/-1/1=-2 | low | skipped | zen: glm 5 free |
| `a93a1b93e` | feature | 1/0/0/1=2 | low | ported | wip: zen |
| `ed4e4843c` | infra | 1/0/0/1=2 | low | ported | ci: update triage workflow (#13944) |
| `0186a8506` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): keep Escape handling local to prompt input on macOS desktop (#13963) |
| `8d0a303af` | docs | -1/-1/-1/1=-2 | low | skipped | docs(ko): improve Korean translation accuracy and clarity in Zen docs (#13951) |
| `4fd3141ab` | docs | -1/-1/-1/1=-2 | low | skipped | docs: improve zh-cn and zh-tw documentation translations (#13942) |
| `6e984378d` | docs | -1/-1/-1/1=-2 | low | skipped | fix(docs): correct reversed meaning in Korean plugins logging section (#13945) |
| `4eed55973` | docs | -1/-1/-1/1=-2 | low | skipped | chore: generate |
| `07947bab7` | ux | 0/0/0/-1=-1 | high | skipped | tweak(tui): new session banner with logo and details (#13970) |
| `3dfbb7059` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(app): recover state after sse reconnect and harden sse streams (#13973) |
| `10985671a` | feature | 1/0/0/1=2 | low | ported | feat(app): session timeline/turn rework (#13196) |
| `277c68d8e` | infra | 1/0/0/1=2 | low | ported | chore: app polish (#13976) |
| `e273a31e7` | feature | 1/0/0/1=2 | low | ported | tweak(ui): icon button spacing |
| `703d63474` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `9b1d7047d` | feature | 1/0/0/1=2 | low | ported | tweak(app): keep file tree toggle visible |
| `0cb11c241` | feature | 1/0/0/1=2 | low | ported | tweak(app): reduce titlebar right padding |
| `d31e9cff6` | feature | 1/0/0/1=2 | low | ported | tweak(app): use weak borders in titlebar actions |
| `a8669aba8` | ux | 1/0/0/1=2 | low | ported | tweak(app): match titlebar active bg to hover |
| `8fcfbd697` | feature | 1/0/0/1=2 | low | ported | tweak(app): align titlebar search text size |
| `ce0844273` | feature | 1/0/0/1=2 | low | ported | tweak(ui): center titlebar search and soften keybind |
| `98f3ff627` | feature | 1/0/0/1=2 | low | ported | tweak(app): refine titlebar search and open padding |
| `8e243c650` | feature | 1/0/0/1=2 | low | ported | tweak(app): tighten titlebar action padding |
| `222b6cda9` | feature | 1/0/0/1=2 | low | ported | tweak(ui): update magnifying-glass icon |
| `4d5e86d8a` | feature | 1/0/0/1=2 | low | ported | feat(desktop): more e2e tests (#13975) |
| `7ed449974` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `5a3e0ef13` | ux | 1/0/0/1=2 | low | ported | tweak(ui): show user message meta on hover |
| `2cac84882` | feature | 1/0/0/1=2 | low | ported | tweak(ui): use provider catalog names |
| `14684d8e7` | ux | 1/0/0/1=2 | low | ported | tweak(ui): refine user message hover meta |
| `57a5d5fd3` | ux | 1/0/0/1=2 | low | ported | tweak(ui): show assistant response meta on hover |
| `1d78100f6` | feature | 1/0/0/1=2 | low | ported | tweak(ui): allow full-width user message meta |
| `652a77655` | feature | 1/0/0/1=2 | low | ported | ui: add clearer 'Copy response' tooltip label for text parts |
| `adfbfe350` | feature | 1/0/0/1=2 | low | ported | tui: increase prompt mode toggle height for better clickability |
| `d055c1cad` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(desktop): avoid sidecar health-check timeout on shell startup (#13925) |
| `46739ca7c` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): ui flashing when switching tabs (#13978) |
| `df59d1412` | behavioral-fix | 1/1/0/1=3 | low | ported | fix: Homepage video section layout shift (#13987) |
| `47435f6e1` | behavioral-fix | 0/1/0/-1=0 | high | skipped | fix: don't fetch models.dev on completion (#13997) |
| `ea96f898c` | infra | 1/0/0/1=2 | low | ported | ci: rm remap for jlongster since he is in org now (#14000) |
| `b784c923a` | ux | 0/0/0/-1=-1 | high | skipped | tweak(ui): bump button heights and align permission prompt layout |
| `2c17a980f` | feature | 1/0/0/1=2 | low | ported | refactor(ui): extract dock prompt shell |
| `bd3d1413f` | feature | 1/0/0/1=2 | low | ported | tui: add warning icon to permission requests for better visibility |
| `26f835cdd` | feature | 1/0/0/1=2 | low | ported | tweak(ui): icon-interactive-base color change dark mode |
| `a69b339ba` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(ui): use icon-strong-base for active titlebar icon buttons |
| `0bc1dcbe1` | feature | 1/0/0/1=2 | low | ported | tweak(ui): update icon transparency |
| `ce7484b4f` | feature | 1/0/0/1=2 | low | ported | tui: fix share button text styling to use consistent 12px regular font weight |
| `a685e7a80` | ux | 1/0/0/1=2 | low | ported | tui: show monochrome file icons by default in tree view, revealing colors on hover to reduce visual clutter and help users focus on code content |
| `737990356` | feature | 1/0/0/1=2 | low | ported | tui: improve modified file visibility and button spacing |
| `4025b655a` | feature | 1/0/0/1=2 | low | ported | desktop: replicate tauri-plugin-shell logic (#13986) |
| `20f43372f` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): terminal disconnect and resync (#14004) |
| `3a505b269` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): virtualizer getting wrong scroll root |
| `7a66ec6bc` | docs | -1/-1/-1/1=-2 | low | skipped | zen: sonnet 4.6 |
| `bab3124e8` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): prompt input quirks |
| `92912219d` | feature | 1/0/0/1=2 | low | ported | tui: simplify prompt mode toggle icon colors via CSS and tighten message timeline padding |
| `2a2437bf2` | infra | 1/0/0/0=1 | medium | skipped | chore: generate |
| `d327a2b1c` | feature | 1/0/0/1=2 | low | ported | chore(app): use radio group in prompt input (#14025) |
| `26c7b240b` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `e345b89ce` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): better tool call batching |
| `cb88fe26a` | infra | 1/0/0/0=1 | medium | skipped | chore: add missing newline (#13992) |
| `3b9758062` | feature | 1/0/0/0=1 | medium | skipped | tweak: ensure read tool uses fs/promises for all paths (#14027) |
| `bad394cd4` | infra | 1/0/0/1=2 | low | ported | chore: remove leftover patch (#13749) |
| `5512231ca` | ux | 0/0/0/-1=-1 | high | skipped | fix(tui): style scrollbox for permission and sidebar (#12752) |
| `ad3c19283` | ux | 0/0/0/-1=-1 | high | skipped | tui: exit cleanly without hanging after session ends |
| `bca793d06` | docs | -1/-1/-1/1=-2 | low | skipped | ci: ensure triage adds acp label (#14039) |
| `a344a766f` | docs | -1/-1/-1/1=-2 | low | skipped | chore: generate |
| `c56f4aa5d` | feature | 1/0/0/0=1 | medium | skipped | refactor: simplify redundant ternary in updateMessage (#13954) |
| `ad92181fa` | feature | 0/0/0/-1=-1 | high | skipped | feat: add Kilo as a native provider (#13765) |
| `572a037e5` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `0ca75544a` | behavioral-fix | 0/1/0/-1=0 | high | skipped | fix: dont autoload kilo (#14052) |
| `1109a282e` | infra | 1/0/0/1=2 | low | ported | ci: add nix-eval workflow for cross-platform flake evaluation (#12175) |
| `e96f6385c` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(opencode): fix Clojure syntax highlighting (#13453) |
| `6eb043aed` | infra | 1/0/1/1=3 | low | ported | ci: allow commits on top of beta PRs (#11924) |
| `5aeb30534` | feature | 1/0/0/1=2 | low | ported | desktop: temporarily disable wsl |
| `6cd3a5902` | feature | 1/0/0/1=2 | low | ported | desktop: cleanup |
| `3394402ae` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `cc86a64bb` | feature | 1/0/0/1=2 | low | ported | tui: simplify mode toggle icon styling |
| `c34ad7223` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `fbe9669c5` | ux | 1/0/0/1=2 | low | ported | fix: use group-hover for file tree icon color swap at all nesting levels |
| `e132dd2c7` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `e4b548fa7` | docs | -1/-1/-1/1=-2 | low | skipped | docs: add policy about AI-generated security reports |
| `00c238777` | infra | 1/0/0/1=2 | low | ported | chore: cleanup (#14113) |
| `2611c35ac` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): lower threshold for diff hiding |
| `1bb857417` | feature | 1/0/0/1=2 | low | ported | app: refactor server management backend (#13813) |
| `6b29896a3` | feature | 1/0/0/0=1 | medium | skipped | feat: Add centralized filesystem module for Bun.file migration (#14117) |
| `3aaf29b69` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `4a5823562` | feature | 1/0/0/1=2 | low | ported | desktop: fix isLocal |
| `f8904e397` | feature | 1/0/0/1=2 | low | ported | desktop: handle sidecar key in projectsKey |
| `d27dbfe06` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(cli): session list --max-count not honored, shows too few sessions (#14162) |
| `83b7d8e04` | feature | 1/0/0/1=2 | low | ported | feat: GitLab Duo - bump gitlab-ai-provider to 3.6.0 (adds Sonnet 4.6) (#14115) |
| `fc1addb8f` | docs | -1/-1/-1/1=-2 | low | skipped | ignore: tweak contributing md (#14168) |
| `38572b817` | feature | 1/0/0/0=1 | medium | skipped | feat: add Julia language server support (#14129) |
| `37b24f487` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate index.ts from Bun.file() to Filesystem module (#14160) |
| `91a3ee642` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `3d189b42a` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate file/ripgrep.ts from Bun.file()/Bun.write() to Filesystem module (#14159) |
| `a5c15a23e` | feature | 1/0/0/0=1 | medium | skipped | core: allow readJson to be called without explicit type parameter |
| `472d01fba` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate cli/cmd/run.ts from Bun.file() to Filesystem/stat modules (#14155) |
| `b714bb21d` | infra | 1/0/0/1=2 | low | ported | ci: switch to standard GitHub cache action for Bun dependencies |
| `a500eaa2d` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate format/formatter.ts from Bun.file() to Filesystem module (#14153) |
| `82a323ef7` | feature | 1/0/0/1=2 | low | ported | refactor: migrate cli/cmd/github.ts from Bun.write() to Filesystem module (#14154) |
| `ef155f376` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate file/index.ts from Bun.file() to Filesystem module (#14152) |
| `8f4a72c57` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate config/markdown.ts from Bun.file() to Filesystem module (#14151) |
| `e0e8b9438` | feature | 1/0/0/1=2 | low | ported | refactor: migrate uninstall.ts from Bun.file()/Bun.write() to Filesystem module (#14150) |
| `c88ff3c08` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/bun/index.ts from Bun.file()/Bun.write() to Filesystem module (#14147) |
| `eb3f33769` | ux | 0/0/0/-1=-1 | high | skipped | refactor: migrate clipboard.ts from Bun.file() to Filesystem module (#14148) |
| `5638b782c` | ux | 0/0/0/-1=-1 | high | skipped | refactor: migrate editor.ts from Bun.file()/Bun.write() to Filesystem module (#14149) |
| `d447b7694` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(github): emit PROMPT_TOO_LARGE error on context overflow (#14166) |
| `3f60a6c2a` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `ef14f64f9` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `8408e4702` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `72c12d59a` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `be2e6f192` | ux | 0/0/0/-1=-1 | high | skipped | fix(opencode): update pasteImage to only increment count when the previous attachment is an image too (#14173) |
| `8bf06cbcc` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/global/index.ts from Bun.file() to Filesystem module (#14146) |
| `24a984132` | feature | 1/0/0/1=2 | low | ported | zen: update sst version |
| `c6bd32000` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `42aa28d51` | infra | 1/0/0/1=2 | low | ported | chore: cleanup (#14181) |
| `1133d87be` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `de25703e9` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(app): terminal cross-talk (#14184) |
| `1aa18c6cd` | feature | 1/0/0/0=1 | medium | skipped | feat(plugin): pass sessionID and callID to shell.env hook input (#13662) |
| `2d7c9c969` | infra | 1/0/0/0=1 | medium | skipped | chore: generate |
| `d6331cf79` | feature | 1/0/0/1=2 | low | ported | Update colors.css |
| `12016c8eb` | feature | 1/0/0/1=2 | low | ported | oc-2 theme init |
| `5d69f0028` | feature | 1/0/0/1=2 | low | ported | button style tweaks |
| `24ce49d9d` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(ui): add previous smoke colors |
| `0888c0237` | feature | 1/0/0/1=2 | low | ported | tweak(ui): file tree background color |
| `9110e6a2a` | feature | 1/0/0/1=2 | low | ported | tweak(ui): share button border |
| `f20c0bffd` | feature | 1/0/0/1=2 | low | ported | tweak(ui): unify titlebar expanded button background |
| `e5d52e4eb` | feature | 1/0/0/1=2 | low | ported | tweak(ui): align pill tabs pressed background |
| `4db2d9485` | feature | 1/0/0/1=2 | low | ported | tweak(ui): shrink filetree tab height |
| `087390803` | feature | 1/0/0/1=2 | low | ported | tweak(ui): theme color updates |
| `1f9be63e9` | feature | 1/0/0/1=2 | low | ported | tweak(ui): use weak border and base icon color for secondary |
| `6d69ad557` | feature | 1/0/0/1=2 | low | ported | tweak(ui): update oc-2 secondary button colors |
| `bcca253de` | ux | 1/0/0/1=2 | low | ported | tweak(ui): hover and active styles for title bar buttons |
| `3690cafeb` | ux | 1/0/0/1=2 | low | ported | tweak(ui): hover and active styles for title bar buttons |
| `4e959849f` | ux | 1/0/0/1=2 | low | ported | tweak(ui): hover and active styles for filetree tabs |
| `09286ccae` | feature | 1/0/0/1=2 | low | ported | tweak(ui): oc-2 theme updates |
| `2f5676106` | feature | 1/0/0/1=2 | low | ported | tweak(ui): expanded color state on titlebar buttons |
| `db4ff8957` | feature | 1/0/0/1=2 | low | ported | Update oc-2.json |
| `1ed4a9823` | feature | 1/0/0/1=2 | low | ported | tweak(ui): remove pressed transition for secondary buttons |
| `431f5347a` | feature | 1/0/0/1=2 | low | ported | tweak(ui): search button style |
| `c7a79f187` | feature | 1/0/0/1=2 | low | ported | Update icon-button.css |
| `e42cc8511` | feature | 1/0/0/1=2 | low | ported | Update oc-2.json |
| `d730d8be0` | feature | 1/0/0/1=2 | low | ported | tweak(ui): shrink review diff style toggle |
| `1571246ba` | feature | 1/0/0/1=2 | low | ported | tweak(ui): use default cursor for segmented control |
| `1b67339e4` | feature | 1/0/0/1=2 | low | ported | Update radio-group.css |
| `06b2304a5` | feature | 1/0/0/1=2 | low | ported | tweak(ui): override for the radio group in the review |
| `31e964e7c` | feature | 1/0/0/1=2 | low | ported | Update oc-2.json |
| `bb6d1d502` | ux | 1/0/0/1=2 | low | ported | tweak(ui): adjust review diff style hover radius |
| `47b4de353` | protocol | 1/0/0/1=2 | low | ported | tweak(ui): tighten review header action spacing |
| `ba919fb61` | feature | 1/0/0/1=2 | low | ported | tweak(ui): shrink review expand/collapse width |
| `50923f06f` | feature | 1/0/0/1=2 | low | ported | tweak(ui): remove pressed scale for secondary buttons |
| `d8a4a125c` | feature | 1/0/0/1=2 | low | ported | Update oc-2.json |
| `7faa8cb11` | feature | 1/0/0/1=2 | low | ported | tweak(ui): reduce review panel padding |
| `dec782754` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `c71f4d484` | feature | 1/0/0/1=2 | low | ported | Update oc-2.json |
| `d5971e2da` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/cli/cmd/import.ts from Bun.file() to Filesystem module (#14143) |
| `898bcdec8` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/cli/cmd/agent.ts from Bun.file()/Bun.write() to Filesystem module (#14142) |
| `3cde93bf2` | protocol | 1/0/0/0=1 | medium | skipped | refactor: migrate src/auth/index.ts from Bun.file()/Bun.write() to Filesystem module (#14140) |
| `a2469d933` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/acp/agent.ts from Bun.file() to Filesystem module (#14139) |
| `e37a9081a` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/cli/cmd/session.ts from Bun.file() to statSync (#14144) |
| `a4b36a72a` | feature | 1/0/0/1=2 | low | ported | refactor: migrate src/file/time.ts from Bun.file() to stat (#14141) |
| `ec7c72da3` | feature | 1/0/0/1=2 | low | ported | tweak(ui): restyle reasoning blocks |
| `2589eb207` | feature | 1/0/0/1=2 | low | ported | tweak(app): shorten prompt mode toggle tooltips |
| `cfea5c73d` | feature | 1/0/0/1=2 | low | ported | tweak(app): delay prompt mode toggle tooltip |
| `d366a1430` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/lsp/server.ts from Bun.file()/Bun.write() to Filesystem module (#14138) |
| `87c16374a` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(lsp): use HashiCorp releases API for installing terraform-ls (#14200) |
| `7033b4d0a` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(win32): Sidecar spawning a window (#14197) |
| `639d1dd8f` | infra | 1/0/0/1=2 | low | ported | chore: add compliance checks for issues and PRs with recheck on edit (#14170) |
| `b90967936` | docs | -1/-1/-1/1=-2 | low | skipped | chore: generate |
| `b75a89776` | feature | 1/0/0/1=2 | low | ported | refactor: migrate src/lsp/client.ts from Bun.file() to Filesystem module (#14137) |
| `97520c827` | feature | 0/0/0/-1=-1 | high | skipped | refactor: migrate src/provider/models.ts from Bun.file()/Bun.write() to Filesystem module (#14131) |
| `48dfa45a9` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/util/log.ts from Bun.file() to Node.js fs module (#14136) |
| `6fb4f2a7a` | ux | 0/0/0/-1=-1 | high | skipped | refactor: migrate src/cli/cmd/tui/thread.ts from Bun.file() to Filesystem module (#14135) |
| `5d12eb952` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/shell/shell.ts from Bun.file() to statSync (#14134) |
| `359360ad8` | feature | 0/0/0/-1=-1 | high | skipped | refactor: migrate src/provider/provider.ts from Bun.file() to Filesystem module (#14132) |
| `ae398539c` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/session/instruction.ts from Bun.file() to Filesystem module (#14130) |
| `5fe237a3f` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/skill/discovery.ts from Bun.file()/Bun.write() to Filesystem module (#14133) |
| `088eac9d4` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix: opencode run crashing, and show errored tool calls in output (#14206) |
| `c16207488` | infra | 1/0/0/1=2 | low | ported | chore: skip PR standards checks for PRs created before Feb 18 2026 6PM EST (#14208) |
| `57b63ea83` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/session/prompt.ts from Bun.file() to Filesystem/stat modules (#14128) |
| `a8347c376` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/storage/db.ts from Bun.file() to statSync (#14124) |
| `9e6cb8910` | protocol | 1/0/0/0=1 | medium | skipped | refactor: migrate src/mcp/auth.ts from Bun.file()/Bun.write() to Filesystem module (#14125) |
| `819d09e64` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/storage/json-migration.ts from Bun.file() to Filesystem module (#14123) |
| `a624871cc` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/storage/storage.ts from Bun.file()/Bun.write() to Filesystem module (#14122) |
| `bd52ce564` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate remaining tool files from Bun.file() to Filesystem/stat modules (#14121) |
| `270b807cd` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/tool/edit.ts from Bun.file() to Filesystem module (#14120) |
| `36bc07a5a` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/tool/write.ts from Bun.file() to Filesystem module (#14119) |
| `14c098941` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/tool/read.ts from Bun.file() to Filesystem module (#14118) |
| `ba53c56a2` | feature | 1/0/0/1=2 | low | ported | tweak(ui): combine diffs in review into one group |
| `9c7629ce6` | feature | 1/0/0/1=2 | low | ported | Update oc-2.json |
| `4a8bdc3c7` | feature | 1/0/0/1=2 | low | ported | tweak(ui): group edited files list styling |
| `fd61be407` | feature | 1/0/0/1=2 | low | ported | tweak(ui): show added diff counts in review |
| `a30105126` | feature | 1/0/0/1=2 | low | ported | tweak(ui): tighten review diff file info gap |
| `40f00ccc1` | feature | 1/0/0/1=2 | low | ported | tweak(ui): use chevron icons for review diff rows |
| `44049540b` | feature | 1/0/0/1=2 | low | ported | tweak(ui): add open-file tooltip icon |
| `3d0f24067` | feature | 1/0/0/1=2 | low | ported | tweak(app): tighten prompt dock padding |
| `5d8664c13` | feature | 1/0/0/1=2 | low | ported | tweak(app): adjust session turn horizontal padding |
| `6042785c5` | feature | 1/0/0/1=2 | low | ported | tweak(ui): rtl-truncate edited file paths |
| `802ccd378` | feature | 1/0/0/1=2 | low | ported | tweak(ui): rotate collapsible chevron icon |
| `3a07dd8d9` | feature | 1/0/0/0=1 | medium | skipped | refactor: migrate src/project/project.ts from Bun.file() to Filesystem/stat modules (#14126) |
| `568eccb4c` | ux | -1/0/0/-1=-2 | high | skipped | Revert: all refactor commits migrating from Bun.file() to Filesystem module |
| `d62045553` | feature | 1/0/0/1=2 | low | ported | app: deduplicate allServers list |
| `11a37834c` | ux | 0/0/0/-1=-1 | high | skipped | tui: ensure onExit callback fires after terminal output is written |
| `3a416f6f3` | feature | 1/0/0/1=2 | low | ported | sdk: fix nested exports transformation in publish script |
| `189347314` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix: token substitution in OPENCODE_CONFIG_CONTENT (alternate take) (#14047) |
| `4b878f6ae` | infra | 1/0/0/0=1 | medium | skipped | chore: generate |
| `308e50083` | protocol | 0/0/0/-1=-1 | high | skipped | tweak: bake in the aws and google auth pkgs (#14241) |
| `c7b35342d` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `d07f09925` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(app): terminal rework (#14217) |
| `885d71636` | feature | 1/0/0/1=2 | low | ported | desktop: fetch defaultServer at top level |
| `d2d5f3c04` | feature | 1/0/0/1=2 | low | ported | app: fix typecheck |
| `38f7071da` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `8ebdbe0ea` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(core): text files missclassified as binary |
| `338393c01` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): accordion styles |
| `0fcba68d4` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `02a949506` | ux | 0/0/0/-1=-1 | high | skipped | Remove use of Bun.file (#14215) |
| `08a2d002b` | docs | -1/-1/-1/1=-2 | low | skipped | zen: gemini 3.1 pro |
| `6b8902e8b` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): navigate to last session on project nav |
| `56dda4c98` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `3c21735b3` | ux | 0/0/0/-1=-1 | high | skipped | refactor: migrate from Bun.Glob to npm glob package |
| `f2858a42b` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `50883cc1e` | feature | 1/0/0/1=2 | low | ported | app: make localhost urls work in isLocal |
| `af72010e9` | ux | -1/0/0/-1=-2 | high | skipped | Revert "refactor: migrate from Bun.Glob to npm glob package" |
| `850402f09` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `91f8dd5f5` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `5364ab74a` | feature | 0/0/0/-1=-1 | high | skipped | tweak: add support for medium reasoning w/ gemini 3.1 (#14316) |
| `7e35d0c61` | feature | 0/0/0/-1=-1 | high | skipped | core: bump ai sdk packages for google, google vertex, anthropic, bedrock, and provider utils (#14318) |
| `cb8b74d3f` | ux | 0/0/0/-1=-1 | high | skipped | refactor: migrate from Bun.Glob to npm glob package (#14317) |
| `8b9964879` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `00c079868` | feature | 1/0/0/1=2 | low | ported | test: fix discovery test to boot up server instead of relying on 3rd party (#14327) |
| `1867f1aca` | docs | -1/-1/-1/1=-2 | low | skipped | chore: generate |
| `b64d0768b` | docs | -1/-1/-1/1=-2 | low | skipped | docs(ko): improve wording in ecosystem, enterprise, formatters, and github docs (#14220) |
| `190d2957e` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(core): normalize file.status paths relative to instance dir (#14207) |
| `3d9f6c0fe` | feature | 1/0/0/1=2 | low | ported | feat(i18n): update Japanese translations to WSL integration (#13160) |
| `7fb2081dc` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `7729c6d89` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `40a939f5f` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `f8dad0ae1` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(app): terminal issues (#14329) |
| `49cc872c4` | infra | 1/0/0/1=2 | low | ported | chore: refactor composer/dock components (#14328) |
| `c76a81434` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `1a1437e78` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(github): action branch detection and 422 handling (#14322) |
| `04cf2b826` | feature | 1/0/0/1=2 | low | ported | release: v1.2.7 |
| `dd011e879` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): clear todos on abort |
| `7a42ecddd` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `824ab4cec` | ux | 0/0/0/-1=-1 | high | skipped | feat(tui): add custom tool and mcp call responses visible and collapsable (#10649) |
| `193013a44` | feature | 0/0/0/-1=-1 | high | skipped | feat(opencode): support adaptive thinking for claude sonnet 4.6 (#14283) |
| `686dd330a` | infra | 0/0/0/-1=-1 | high | skipped | chore: generate |
| `fca016648` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): black screen on launch with sidecar server |
| `f2090b26c` | feature | 1/0/0/1=2 | low | ported | release: v1.2.8 |
| `cb5a0de42` | protocol | 1/0/0/1=2 | low | ported | core: remove User-Agent header assertion from LLM test to fix failing test |
| `d32dd4d7f` | docs | 1/-1/-1/1=0 | low | skipped | docs: update providers layout and Windows sidebar label |
| `ae50f24c0` | docs | -1/-1/-1/1=-2 | low | skipped | fix(web): correct config import path in Korean enterprise docs |
| `01d518708` | feature | 0/0/0/-1=-1 | high | skipped | remove unnecessary deep clones from session loop and LLM stream (#14354) |
| `8ad60b1ec` | ux | 0/0/0/-1=-1 | high | skipped | Use structuredClone instead of remeda's clone (#14351) |
| `d2d7a37bc` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix: add missing id/sessionID/messageID to MCP tool attachments (#14345) |
| `998c8bf3a` | ux | 1/0/0/1=2 | low | ported | tweak(ui): stabilize collapsible chevron hover |
| `a3181d5fb` | feature | 1/0/0/1=2 | low | ported | tweak(ui): nudge edited files chevron |
| `ae98be83b` | protocol | 1/0/0/1=2 | low | ported | fix(desktop): restore settings header mask |
| `63a469d0c` | feature | 1/0/0/1=2 | low | ported | tweak(ui): refine session feed spacing |
| `8b99ac651` | feature | 1/0/0/1=2 | low | ported | tweak(ui): tone down reasoning emphasis |
| `8d781b08c` | feature | 1/0/0/1=2 | low | ported | tweak(ui): adjust session feed spacing |
| `1a329ba47` | ux | 0/0/0/-1=-1 | high | skipped | fix: issue from structuredClone addition by using unwrap (#14359) |
| `1eb6caa3c` | feature | 1/0/0/1=2 | low | ported | release: v1.2.9 |
| `04a634a80` | feature | 1/0/0/1=2 | low | ported | test: merge test files into a single file (#14366) |
| `d86c10816` | docs | -1/-1/-1/1=-2 | low | skipped | docs: clarify tool name collision precedence (#14313) |
| `1c2416b6d` | feature | 1/0/0/1=2 | low | ported | desktop: don't spawn sidecar if default is localhost server |
| `443214871` | feature | 1/0/0/1=2 | low | ported | sdk: build to dist/ instead of dist/src (#14383) |
| `296250f1b` | feature | 1/0/0/1=2 | low | ported | release: v1.2.10 |
| `a04e4e81f` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `93615bef2` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(cli): missing plugin deps cause TUI to black screen (#14432) |
| `7e1051af0` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(ui): show full turn duration in assistant meta (#14378) |
| `ac0b37a7b` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(snapshot): respect info exclude in snapshot staging (#13495) |
| `1de12604c` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(ui): preserve url slashes for root workspace (#14294) |
| `241059302` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(github): support variant in github action and opencode github run (#14431) |
| `7e0e35af3` | docs | -1/-1/-1/1=-2 | low | skipped | chore: update agent |
| `4e9ef3ecc` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(app): terminal issues (#14435) |
| `7e681b0bc` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): large text pasted into prompt-input causes main thread lock |
| `7419ebc87` | feature | 1/0/0/0=1 | medium | skipped | feat: add list sessions for all sessions (experimental) (#14038) |
| `7867ba441` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `92ab4217c` | feature | 1/0/0/1=2 | low | ported | desktop: bring back -i in sidecar arguments |
| `ce17f9dd9` | feature | 1/0/1/1=3 | low | ported | desktop: publish betas to separate repo (#14376) |
| `9c5bbba6e` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): patch tool renders like edit tool |
| `c79f1a72d` | feature | 1/0/0/1=2 | low | ported | cache platform binary in postinstall for faster startup (#14396) |
| `1ffed2fa6` | feature | 1/0/0/1=2 | low | skipped | Revert "cache platform binary in postinstall for faster startup" (#14457) |
| `0ce61c817` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): stay pinned with auto-scroll on todos/questions/perms |
| `2a904ec56` | feature | 1/0/0/1=2 | low | ported | feat(app): show/hide reasoning summaries |
| `1e48d7fe8` | feature | 1/0/0/1=2 | low | ported | zen: gpt safety_identifier |
| `fe89bedfc` | feature | 1/0/0/1=2 | low | ported | wip(app): custom scroll view |
| `c09d3dd5a` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `46361cf35` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): session review re-rendering too aggressively |
| `1d9f05e4f` | feature | 1/0/0/1=2 | low | ported | cache platform binary in postinstall for faster startup (#14467) |
| `950df3de1` | infra | 1/0/0/1=2 | low | ported | ci: temporarily disable assigning of issues to rekram1-node (#14486) |
| `ce2763720` | ux | 1/0/0/1=2 | low | ported | fix(app): better sound effect disabling ux |
| `58ad4359d` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `f07e87720` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): remove double-border in share button |
| `5a1aca918` | docs | -1/-1/-1/1=-2 | low | skipped | docs: add Bangla README translation (#14331) |
| `d0ce2950e` | docs | -1/-1/-1/1=-2 | low | skipped | chore: generate |
| `e77b2cfd6` | feature | 1/0/0/1=2 | low | ported | wip: zen lite |
| `b75a27d43` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `6d58d899f` | behavioral-fix | 1/1/0/1=3 | low | ported | fix: e2e test outdated |
| `206d81e02` | feature | 1/0/0/1=2 | low | ported | desktop: beta icon |
| `c45ab712d` | docs | -1/-1/-1/1=-2 | low | skipped | chore: locale specific glossaries |
| `dbf2c4586` | docs | 1/-1/-1/1=0 | low | skipped | chore: updated locale glossaries and docs sync workflow |
| `a41c81dcd` | docs | -1/-1/-1/1=-2 | low | skipped | docs(ko): improve wording in gitlab, ide, index, keybinds, and lsp docs (#14517) |
| `13616e345` | infra | 1/0/0/1=2 | low | ported | Update VOUCHED list |
| `b16f7b426` | docs | -1/-1/-1/1=-2 | low | skipped | docs(tui): correct typo in TUI documentation (#14604) |
| `e70d2b27d` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(app): terminal issues |
| `aaf8317c8` | feature | 1/0/0/1=2 | low | ported | feat(app): feed customization options |
| `eb64ce08b` | infra | 1/0/0/1=2 | low | ported | Update VOUCHED list |
| `a74fedd23` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(desktop): change detection on Windows, especially Cygwin (#13659) |
| `faa63227a` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `a4ed020a9` | feature | 1/0/0/1=2 | low | ported | upgrade opentui to v0.1.81 (#14605) |
| `ab75ef814` | infra | 1/0/0/1=2 | low | ported | chore: update nix node_modules hashes |
| `0042a0705` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix: Windows path support and canonicalization (#13671) |
| `ee754c46f` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(win32): normalize paths at permission boundaries (#14738) |
| `5712cff5c` | feature | 1/0/0/1=2 | low | ported | zen: track session in usage |
| `5596775c3` | feature | 1/0/0/1=2 | low | ported | zen: display session in usage |
| `a5a70fa05` | feature | 1/0/0/1=2 | low | ported | wip: zen lite |
| `d3ecc5a0d` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `9f4fc5b72` | feature | 1/0/0/0=1 | medium | ported | Revert "fix(app): terminal issues" |
| `8e9644796` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): correct inverted chevron direction in todo list (#14628) |
| `3b5b21a91` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): duplicate markdown |
| `8f2d8dd47` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): duplicate markdown |
| `24c63914b` | infra | 1/0/0/1=2 | low | ported | fix: update workflows for better automation (#14809) |
| `ad5f0816a` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(cicd): flakey typecheck (#14828) |
| `34495a70d` | behavioral-fix | 1/1/1/1=4 | low | ported | fix(win32): scripts/turbo commands would not run (#14829) |
| `284251ad6` | feature | 1/0/0/1=2 | low | ported | zen: display BYOK cost |
| `0a9119691` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(win32): e2e sometimes fails because windows is weird and sometimes ipv6 (#14833) |
| `0269f39a1` | infra | 1/0/0/1=2 | low | ported | ci: add Windows to unit test matrix (#14836) |
| `ae190038f` | infra | 1/0/0/1=2 | low | ported | ci: use bun baseline build to avoid segfaults (#14839) |
| `cf5cfb48c` | feature | 1/0/0/1=2 | low | ported | upgrade to bun 1.3.10 canary and force baseline builds always (#14843) |
| `eda71373b` | feature | 1/0/0/1=2 | low | ported | app: wait for loadFile before opening file tab |
| `cda2af258` | feature | 1/0/0/1=2 | low | ported | wip: zen lite |
| `fb6d201ee` | feature | 1/0/0/1=2 | low | ported | wip: zen lite |
| `744059a00` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `a592bd968` | behavioral-fix | 1/1/0/1=3 | low | ported | fix: update createOpenReviewFile test to match new call order (#14881) |
| `de796d9a0` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(test): use path.join for cross-platform glob test assertions (#14837) |
| `3201a7d34` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(win32): add bun prefix to console app build scripts (#14884) |
| `659068942` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(win32): handle CRLF line endings in markdown frontmatter parsing (#14886) |
| `13cabae29` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(win32): add git flags for snapshot operations and fix tests for cross-platform (#14890) |
| `888b12338` | feature | 1/0/0/0=1 | medium | skipped | feat: ACP - stream bash output and synthetic pending events (#14079) |
| `ef7f222d8` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `79254c102` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(test): normalize git excludesFile path for Windows (#14893) |
| `a292eddeb` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(test): harden preload cleanup against Windows EBUSY (#14895) |
| `1af3e9e55` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(win32): fix plugin resolution with createRequire fallback (#14898) |
| `1a0639e5b` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(win32): normalize backslash paths in config rel() and file ignore (#14903) |
| `06f25c78f` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(test): use path.sep in discovery test for cross-platform path matching (#14905) |
| `3d379c20c` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(test): replace Unix-only assumptions with cross-platform alternatives (#14906) |
| `36197f5ff` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(win32): add 50ms tolerance for NTFS mtime fuzziness in FileTime assert (#14907) |
| `32417774c` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(test): replace structuredClone with spread for process.env (#14908) |
| `e27d3d5d4` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): remove filetree tooltips |
| `2cee94767` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix: ACP both live and load share synthetic pending status preceeding… (#14916) |
| `082f0cc12` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): preserve native path separators in file path helpers (#14912) |
| `c92913e96` | infra | 1/0/0/1=2 | low | ported | chore: cleanup |
| `519058963` | feature | 1/0/0/1=2 | low | ported | zen: remove alpha models from models endpoint |
| `cc02476ea` | feature | 1/0/0/1=2 | low | ported | refactor: replace error handling with serverErrorMessage utility and checks for if error is ConfigInvalidError (#14685) |
| `0d0d0578e` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `c6d8e7624` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): on cancel comment unhighlight lines (#14103) |
| `f8cfb697b` | feature | 1/0/0/1=2 | low | ported | zen: restrict alpha models to admin workspaces |
| `68cf011fd` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): ignore stale part deltas |
| `2a87860c0` | docs | -1/-1/-1/1=-2 | low | skipped | zen: gpt 5.3 codex |
| `2c00eb60b` | feature | 1/0/0/0=1 | medium | skipped | feat(core): add workspace-serve command (experimental) (#14960) |
| `29ddd5508` | feature | 1/0/0/1=2 | low | ported | release: v1.2.11 |
| `814c1d398` | ux | 0/0/0/-1=-1 | high | skipped | refactor: migrate Bun.spawn to Process utility with timeout and cleanup (#14448) |
| `fa559b038` | feature | 1/0/0/0=1 | medium | skipped | core: temporarily disable plan enter tool to prevent unintended mode switches during task execution |
| `637059a51` | ux | 0/0/0/-1=-1 | high | skipped | feat: show LSP errors for apply_patch tool (#14715) |
| `a487f11a3` | infra | 1/0/1/1=3 | low | ported | ci: auto-resolve merge conflicts in beta sync using opencode |
| `0b3fb5d46` | infra | 1/0/1/1=3 | low | ported | ci: specify opencode/kimi-k2.5 model in beta script to ensure consistent PR processing |
| `6af7ddf03` | infra | 1/0/1/1=3 | low | ported | ci: switch beta script to gpt-5.3-codex for improved code generation quality |
| `76b60f377` | docs | -1/-1/-1/1=-2 | low | skipped | desktop: make readme more accurate |
| `6fc550629` | feature | 1/0/0/1=2 | low | ported | zen: go |
| `d00d98d56` | feature | 1/0/0/1=2 | low | ported | wip: zen go |
| `1172ebe69` | feature | 1/0/0/1=2 | low | ported | wip: zen go |
| `5d5f2cfee` | feature | 1/0/0/1=2 | low | ported | wip: zen go |
| `d7500b25b` | feature | 1/0/0/1=2 | low | ported | zen: go |
| `fc6e7934b` | feature | 1/0/0/1=2 | low | ported | feat(desktop): enhance Windows app resolution and UI loading states (#13320) |
| `3c6c74457` | feature | 1/0/0/0=1 | medium | skipped | sync |
| `561f9f5f0` | ux | 0/0/0/-1=-1 | high | skipped | opencode go copy |
| `d848c9b6a` | feature | 1/0/0/1=2 | low | ported | release: v1.2.13 |
| `79b5ce58e` | feature | 1/0/0/0=1 | medium | skipped | feat(core): add message delete endpoint (#14417) |
| `de2bc2567` | feature | 1/0/0/1=2 | low | ported | release: v1.2.14 |
| `5e5823ed8` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `e48c1ccf0` | infra | 1/0/0/1=2 | low | ported | chore(workflows): label vouched users and restrict vouch managers (#15075) |
| `286992269` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): correct Copilot provider description in i18n files (#15071) |
| `45191ad14` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): keyboard navigation previous/next message (#15047) |
| `7afa48b4e` | feature | 1/0/0/1=2 | low | ported | tweak(ui): keep reasoning inline code subdued in dark mode |

## Execution Queue

1. [ ] Confirm high-risk items (ported vs skipped).
2. [ ] Refactor-port selected items by behavior reimplementation (no cherry-pick/merge).
3. [ ] Update ledger with final status mapping.

## Mapping to Ledger

| Upstream Commit | Status | Local Commit | Note |
| :-------------- | :----- | :----------- | :--- |
| `81b5a6a08` | ported | - | fix(app):workspace reset (#13170) |
| `8f56ed5b8` | ported | - | chore: generate |
| `fbabce112` | ported | - | fix(app): translations |
| `6b30e0b75` | skipped | - | chore: update docs sync workflow |
| `e3471526f` | ported | - | add square logo variants to brand page |
| `e2a33f75e` | ported | - | Update VOUCHED list |
| `125727d09` | ported | - | upgrade opentui to 0.1.79 (#13036) |
| `264dd213f` | ported | - | chore: update nix node_modules hashes |
| `c856f875a` | ported | - | chore: upgrade bun to 1.3.9 (#13223) |
| `8577eb8ec` | ported | - | chore: update nix node_modules hashes |
| `8eea53a41` | skipped | - | docs(ar): second-pass localization cleanup |
| `aea68c386` | skipped | - | fix(docs): locale translations for nav elements and headings |
| `81ca2df6a` | ported | - | fix(app): guard randomUUID in insecure browser contexts (#13237) |
| `bf5a01edd` | skipped | - | feat(opencode): Venice Add automatic variant generation for Venice models (#12106) |
| `135f8ffb2` | skipped | - | feat(tui): add toggle to hide session header (#13244) |
| `5bdf1c4b9` | ported | - | Update VOUCHED list |
| `ad2087094` | skipped | - | support custom api url per model |
| `66780195d` | ported | - | chore: generate |
| `e269788a8` | skipped | - | feat: support claude agent SDK-style structured outputs in the OpenCode SDK  (#8161) |
| `f6e7aefa7` | ported | - | chore: generate |
| `8f9742d98` | skipped | - | fix(win32): use ffi to get around bun raw input/ctrl+c issues (#13052) |
| `03de51bd3` | ported | - | release: v1.1.60 |
| `d86f24b6b` | ported | - | zen: return cost |
| `1413d77b1` | ported | - | desktop: sqlite migration progress bar (#13294) |
| `0eaeb4588` | ported | - | Testing SignPath Integration (#13308) |
| `fa97475ee` | ported | - | ci: move test-sigining policy |
| `5f421883a` | ported | - | chore: style loading screen |
| `ecb274273` | ported | - | wip(ui): diff virtualization (#12693) |
| `9f9f0fb8e` | ported | - | chore: update nix node_modules hashes |
| `d72314708` | ported | - | feat: update to not post comment on workflows when no duplicates found (#13238) |
| `d82d22b2d` | ported | - | wip: zen |
| `a11556505` | skipped | - | core: allow model configurations without npm/api provider details |
| `892bb7526` | ported | - | release: v1.1.61 |
| `85df10671` | ported | - | chore: generate |
| `ae811ad8d` | ported | - | wip: zen |
| `ff4414bb1` | ported | - | chore: refactor packages/app files (#13236) |
| `ed472d8a6` | ported | - | fix(app): more defensive session context metrics |
| `a82ca8600` | ported | - | fix(app): more defensive code component |
| `658bf6fa5` | skipped | - | zen: minimax m2.5 |
| `59a323e9a` | skipped | - | wip: zen |
| `ecab692ca` | skipped | - | fix(docs): correct `format` attribute in `StructuredOutputs` (#13340) |
| `2db618dea` | ported | - | fix: downgrade bun to 1.3.5 (#13347) |
| `847e06f9e` | ported | - | chore: update nix node_modules hashes |
| `789705ea9` | skipped | - | ignore: document test fixtures for agents |
| `da952135c` | ported | - | chore(app): refactor for better solidjs hygiene (#13344) |
| `0771e3a8b` | ported | - | fix(app): preserve undo history for plain-text paste (#13351) |
| `ff0abacf4` | ported | - | fix(app): project icons unloading |
| `aaee5fb68` | ported | - | release: v1.1.62 |
| `ac018e3a3` | ported | - | release: v1.1.63 |
| `958320f9c` | ported | - | fix(app): remote http server connections |
| `50f208d69` | ported | - | fix(app): suggestion active state broken |
| `3696d1ded` | ported | - | chore: cleanup |
| `81c623f26` | ported | - | chore: cleanup |
| `e9b9a62fe` | ported | - | chore: cleanup |
| `7ccf223c8` | ported | - | chore: cleanup |
| `70303d0b4` | ported | - | chore: cleanup |
| `ff3b174c4` | ported | - | fix(app): normalize oauth error messages |
| `4e0f509e7` | ported | - | feat(app): option to turn off sound effects |
| `548608b7a` | ported | - | fix(app): terminal pty isolation |
| `11dd281c9` | skipped | - | docs: update STACKIT provider documentation with typo fix (#13357) |
| `20dcff1e2` | skipped | - | chore: generate |
| `c0814da78` | skipped | - | do not open console on error (#13374) |
| `a8f288452` | skipped | - | feat: windows selection behavior, manual ctrl+c (#13315) |
| `4018c863e` | ported | - | fix: baseline CPU detection (#13371) |
| `445e0d767` | ported | - | chore: update nix node_modules hashes |
| `93eee0daf` | skipped | - | fix: look for recent model in fallback in cli (#12582) |
| `d475fd613` | skipped | - | chore: generate |
| `f66624fe6` | skipped | - | chore: cleanup flag code (#13389) |
| `29671c139` | ported | - | fix: token substitution in OPENCODE_CONFIG_CONTENT (#13384) |
| `76db21867` | ported | - | release: v1.1.64 |
| `adb0c4d4f` | ported | - | desktop: only show loading window if sqlite migration is necessary |
| `0303c29e3` | ported | - | fix(app): failed to create store |
| `8da5fd0a6` | ported | - | fix(app): worktree delete |
| `b525c03d2` | ported | - | chore: cleanup |
| `7f95cc64c` | ported | - | fix(app): prompt input quirks |
| `c9719dff7` | ported | - | fix(app): notification should navigate to session |
| `dec304a27` | ported | - | fix(app): emoji as avatar |
| `e0f1c3c20` | ported | - | cleanup desktop loading page |
| `fb7b2f6b4` | ported | - | feat(app): toggle all provider models |
| `dd296f703` | ported | - | fix(app): reconnect event stream on disconnect |
| `b06afd657` | ported | - | ci: remove signpath policy |
| `1fb6c0b5b` | ported | - | Revert "fix: token substitution in OPENCODE_CONFIG_CONTENT" (#13429) |
| `34ebe814d` | ported | - | release: v1.1.65 |
| `0d90a22f9` | skipped | - | feat: update some ai sdk packages and uuse adaptive reasoning for opus 4.6 on vertex/bedrock/anthropic (#13439) |
| `b8ee88212` | ported | - | chore: update nix node_modules hashes |
| `ebb907d64` | ported | - | fix(desktop): performance optimization for showing large diff & files  (#13460) |
| `9f20e0d14` | skipped | - | fix(web): sync docs locale cookie on alias redirects (#13109) |
| `ebe5a2b74` | ported | - | fix(app): remount SDK/sync tree when server URL changes (#13437) |
| `b1764b2ff` | skipped | - | docs: Fix zh-cn translation mistake in tools.mdx (#13407) |
| `f991a6c0b` | skipped | - | chore: generate |
| `e242fe19e` | ported | - | fix(web): use prompt_async endpoint to avoid timeout over VPN/tunnel (#12749) |
| `1c71604e0` | ported | - | fix(app): terminal resize |
| `4f51c0912` | ported | - | chore: cleanup |
| `b8848cfae` | skipped | - | docs(ko): polish Korean phrasing in acp, agents, config, and custom-tools docs (#13446) |
| `88e2eb541` | skipped | - | docs: add pacman installation option for Arch Linux alongside AUR (#13293) |
| `bc1fd0633` | ported | - | fix(test): move timeout config to CLI flag (#13494) |
| `72c09e1dc` | skipped | - | fix: standardize zh-CN docs character set and terminology (#13500) |
| `d30e91738` | ported | - | fix(ui): support cmd-click links in inline code (#12552) |
| `6d95f0d14` | skipped | - | sqlite again (#10597) |
| `afb04ed5d` | ported | - | chore: generate |
| `7d4687277` | ported | - | desktop: remote OPENCODE_SQLITE env (#13545) |
| `d0dcffefa` | ported | - | chore: update nix node_modules hashes |
| `0b9e929f6` | ported | - | desktop: fix rust |
| `ffc000de8` | ported | - | release: v1.2.0 |
| `1e25df21a` | ported | - | zen: minimax m2.5 & glm5 |
| `cd775a286` | ported | - | release: v1.2.1 |
| `ed439b205` | ported | - | ci: test-signing signpath policy |
| `df3203d2d` | ported | - | ci: move signpath policy |
| `ef205c366` | ported | - | bump vertex ai packages (#13625) |
| `759ec104b` | skipped | - | fix vercel gateway variants (#13541) |
| `306fc7707` | ported | - | chore: update nix node_modules hashes |
| `68bb8ce1d` | skipped | - | core: filter sessions at database level to improve session list loading performance |
| `3b6b3e6fc` | ported | - | release: v1.2.2 |
| `933a491ad` | skipped | - | fix: ensure vercel variants pass amazon models under bedrock key (#13631) |
| `575f2cf2a` | ported | - | chore: bump nixpkgs to get bun 1.3.9 (#13302) |
| `839c5cda1` | skipped | - | fix: ensure anthropic models on OR also have variant support (#13498) |
| `7911cb62a` | ported | - | chore: update nix node_modules hashes |
| `c190f5f61` | ported | - | release: v1.2.3 |
| `460a87f35` | ported | - | fix(app): stack overflow in filetree (#13667) |
| `85b5f5b70` | ported | - | feat(app): clear notifications action (#13668) |
| `2bab5e8c3` | ported | - | fix: derive all IDs from file paths during json migration |
| `b5c8bd342` | ported | - | test: add tests for path-derived IDs in json migration |
| `45f005037` | skipped | - | core: add db command for database inspection and querying |
| `d1482e148` | ported | - | release: v1.2.4 |
| `985c2a3d1` | ported | - | feat: Add GeistMono Nerd Font to available mono font options (#13720) |
| `3aaa34be1` | ported | - | fix(desktop): focus window after update/relaunch (#13701) |
| `376112172` | skipped | - | docs: add Ukrainian README translation (#13697) |
| `878ddc6a0` | ported | - | fix(app): keybind [shift+tab] (#13695) |
| `3c85cf4fa` | ported | - | fix(app): only navigate prompt history at input boundaries (#13690) |
| `cf50a289d` | ported | - | fix(desktop): issue viewing new files opened from the file tree (#13689) |
| `3a3aa300b` | ported | - | feat(app): localize "free usage exceeded" error & "Add credits" clickable link (#13652) |
| `62a24c2dd` | ported | - | release: v1.2.5 |
| `9b23130ac` | skipped | - | feat(opencode): add `cljfmt` formatter support for Clojure files (#13426) |
| `d9363da9e` | skipped | - | fix(website): correct zh-CN translation of proprietary terms in zen.mdx (#13734) |
| `21e077800` | skipped | - | chore: generate |
| `920255e8c` | ported | - | desktop: use process-wrap instead of manual job object (#13431) |
| `afd0716cb` | skipped | - | feat(opencode): Add Venice support in temperature, topP, topK and smallOption (#13553) |
| `60807846a` | ported | - | fix(desktop): normalize Linux Wayland/X11 backend and decoration policy (#13143) |
| `f7708efa5` | skipped | - | feat: add openai-compatible endpoint support for google-vertex provider (#10303) |
| `089ab9def` | ported | - | chore: generate |
| `1d041c886` | skipped | - | fix: google vertex var priority (#13816) |
| `3ebf27aab` | skipped | - | fix(docs): correct critical translation errors in Russian zen page (#13830) |
| `b055f973d` | ported | - | chore: cleanup |
| `bb30e0685` | skipped | - | fix (tui): Inaccurate tips (#13845) |
| `ef979ccfa` | ported | - | fix: bump GitLab provider and auth plugin for mid-session token refresh (#13850) |
| `8c1af9b44` | ported | - | chore: update nix node_modules hashes |
| `5cc1d6097` | skipped | - | feat(cli): add --continue and --fork flags to attach command (#13879) |
| `fdad823ed` | skipped | - | feat(cli): add db migrate command for JSON to SQLite migration (#13874) |
| `ae6e85b2a` | ported | - | ignore: rm random comment on opencode.jsonc |
| `16332a858` | skipped | - | fix(tui): make use of server dir path for file references in prompts (#13781) |
| `160ba295a` | skipped | - | feat(opencode): add `dfmt` formatter support for D language files (#13867) |
| `d8c25bfeb` | ported | - | release: v1.2.6 |
| `b0afdf6ea` | skipped | - | feat(cli): add session delete command (#13571) |
| `9d3c81a68` | skipped | - | feat(acp): add opt-in flag for question tool (#13562) |
| `a580fb47d` | skipped | - | tweak: drop ids from attachments in tools, assign them in prompt.ts instead (#13890) |
| `d93cefd47` | ported | - | fix(website): fix site in safari 18 (#13894) |
| `916361198` | ported | - | ci: fixed apt cache not working in publish.yml (#13897) |
| `0e669b601` | ported | - | ci: use `useblacksmith/stickydisk` on linux runners only (#13909) |
| `e35a4131d` | skipped | - | core: keep message part order stable when files resolve asynchronously (#13915) |
| `422609722` | ported | - | ci: fixed Rust cache for 'cargo install' in publish.yml (#13907) |
| `ea2d089db` | ported | - | ci: fixed missing if condition (#13934) |
| `d338bd528` | ported | - | Hide server CLI on windows (#13936) |
| `ace63b3dd` | skipped | - | zen: glm 5 free |
| `a93a1b93e` | ported | - | wip: zen |
| `ed4e4843c` | ported | - | ci: update triage workflow (#13944) |
| `0186a8506` | ported | - | fix(app): keep Escape handling local to prompt input on macOS desktop (#13963) |
| `8d0a303af` | skipped | - | docs(ko): improve Korean translation accuracy and clarity in Zen docs (#13951) |
| `4fd3141ab` | skipped | - | docs: improve zh-cn and zh-tw documentation translations (#13942) |
| `6e984378d` | skipped | - | fix(docs): correct reversed meaning in Korean plugins logging section (#13945) |
| `4eed55973` | skipped | - | chore: generate |
| `07947bab7` | skipped | - | tweak(tui): new session banner with logo and details (#13970) |
| `3dfbb7059` | ported | - | fix(app): recover state after sse reconnect and harden sse streams (#13973) |
| `10985671a` | ported | - | feat(app): session timeline/turn rework (#13196) |
| `277c68d8e` | ported | - | chore: app polish (#13976) |
| `e273a31e7` | ported | - | tweak(ui): icon button spacing |
| `703d63474` | ported | - | chore: generate |
| `9b1d7047d` | ported | - | tweak(app): keep file tree toggle visible |
| `0cb11c241` | ported | - | tweak(app): reduce titlebar right padding |
| `d31e9cff6` | ported | - | tweak(app): use weak borders in titlebar actions |
| `a8669aba8` | ported | - | tweak(app): match titlebar active bg to hover |
| `8fcfbd697` | ported | - | tweak(app): align titlebar search text size |
| `ce0844273` | ported | - | tweak(ui): center titlebar search and soften keybind |
| `98f3ff627` | ported | - | tweak(app): refine titlebar search and open padding |
| `8e243c650` | ported | - | tweak(app): tighten titlebar action padding |
| `222b6cda9` | ported | - | tweak(ui): update magnifying-glass icon |
| `4d5e86d8a` | ported | - | feat(desktop): more e2e tests (#13975) |
| `7ed449974` | ported | - | chore: generate |
| `5a3e0ef13` | ported | - | tweak(ui): show user message meta on hover |
| `2cac84882` | ported | - | tweak(ui): use provider catalog names |
| `14684d8e7` | ported | - | tweak(ui): refine user message hover meta |
| `57a5d5fd3` | ported | - | tweak(ui): show assistant response meta on hover |
| `1d78100f6` | ported | - | tweak(ui): allow full-width user message meta |
| `652a77655` | ported | - | ui: add clearer 'Copy response' tooltip label for text parts |
| `adfbfe350` | ported | - | tui: increase prompt mode toggle height for better clickability |
| `d055c1cad` | ported | - | fix(desktop): avoid sidecar health-check timeout on shell startup (#13925) |
| `46739ca7c` | ported | - | fix(app): ui flashing when switching tabs (#13978) |
| `df59d1412` | ported | - | fix: Homepage video section layout shift (#13987) |
| `47435f6e1` | skipped | - | fix: don't fetch models.dev on completion (#13997) |
| `ea96f898c` | ported | - | ci: rm remap for jlongster since he is in org now (#14000) |
| `b784c923a` | skipped | - | tweak(ui): bump button heights and align permission prompt layout |
| `2c17a980f` | ported | - | refactor(ui): extract dock prompt shell |
| `bd3d1413f` | ported | - | tui: add warning icon to permission requests for better visibility |
| `26f835cdd` | ported | - | tweak(ui): icon-interactive-base color change dark mode |
| `a69b339ba` | ported | - | fix(ui): use icon-strong-base for active titlebar icon buttons |
| `0bc1dcbe1` | ported | - | tweak(ui): update icon transparency |
| `ce7484b4f` | ported | - | tui: fix share button text styling to use consistent 12px regular font weight |
| `a685e7a80` | ported | - | tui: show monochrome file icons by default in tree view, revealing colors on hover to reduce visual clutter and help users focus on code content |
| `737990356` | ported | - | tui: improve modified file visibility and button spacing |
| `4025b655a` | ported | - | desktop: replicate tauri-plugin-shell logic (#13986) |
| `20f43372f` | ported | - | fix(app): terminal disconnect and resync (#14004) |
| `3a505b269` | ported | - | fix(app): virtualizer getting wrong scroll root |
| `7a66ec6bc` | skipped | - | zen: sonnet 4.6 |
| `bab3124e8` | ported | - | fix(app): prompt input quirks |
| `92912219d` | ported | - | tui: simplify prompt mode toggle icon colors via CSS and tighten message timeline padding |
| `2a2437bf2` | skipped | - | chore: generate |
| `d327a2b1c` | ported | - | chore(app): use radio group in prompt input (#14025) |
| `26c7b240b` | ported | - | chore: cleanup |
| `e345b89ce` | ported | - | fix(app): better tool call batching |
| `cb88fe26a` | skipped | - | chore: add missing newline (#13992) |
| `3b9758062` | skipped | - | tweak: ensure read tool uses fs/promises for all paths (#14027) |
| `bad394cd4` | ported | - | chore: remove leftover patch (#13749) |
| `5512231ca` | skipped | - | fix(tui): style scrollbox for permission and sidebar (#12752) |
| `ad3c19283` | skipped | - | tui: exit cleanly without hanging after session ends |
| `bca793d06` | skipped | - | ci: ensure triage adds acp label (#14039) |
| `a344a766f` | skipped | - | chore: generate |
| `c56f4aa5d` | skipped | - | refactor: simplify redundant ternary in updateMessage (#13954) |
| `ad92181fa` | skipped | - | feat: add Kilo as a native provider (#13765) |
| `572a037e5` | ported | - | chore: generate |
| `0ca75544a` | skipped | - | fix: dont autoload kilo (#14052) |
| `1109a282e` | ported | - | ci: add nix-eval workflow for cross-platform flake evaluation (#12175) |
| `e96f6385c` | ported | - | fix(opencode): fix Clojure syntax highlighting (#13453) |
| `6eb043aed` | ported | - | ci: allow commits on top of beta PRs (#11924) |
| `5aeb30534` | ported | - | desktop: temporarily disable wsl |
| `6cd3a5902` | ported | - | desktop: cleanup |
| `3394402ae` | ported | - | chore: cleanup |
| `cc86a64bb` | ported | - | tui: simplify mode toggle icon styling |
| `c34ad7223` | ported | - | chore: cleanup |
| `fbe9669c5` | ported | - | fix: use group-hover for file tree icon color swap at all nesting levels |
| `e132dd2c7` | ported | - | chore: cleanup |
| `e4b548fa7` | skipped | - | docs: add policy about AI-generated security reports |
| `00c238777` | ported | - | chore: cleanup (#14113) |
| `2611c35ac` | ported | - | fix(app): lower threshold for diff hiding |
| `1bb857417` | ported | - | app: refactor server management backend (#13813) |
| `6b29896a3` | skipped | - | feat: Add centralized filesystem module for Bun.file migration (#14117) |
| `3aaf29b69` | ported | - | chore: update nix node_modules hashes |
| `4a5823562` | ported | - | desktop: fix isLocal |
| `f8904e397` | ported | - | desktop: handle sidecar key in projectsKey |
| `d27dbfe06` | ported | - | fix(cli): session list --max-count not honored, shows too few sessions (#14162) |
| `83b7d8e04` | ported | - | feat: GitLab Duo - bump gitlab-ai-provider to 3.6.0 (adds Sonnet 4.6) (#14115) |
| `fc1addb8f` | skipped | - | ignore: tweak contributing md (#14168) |
| `38572b817` | skipped | - | feat: add Julia language server support (#14129) |
| `37b24f487` | skipped | - | refactor: migrate index.ts from Bun.file() to Filesystem module (#14160) |
| `91a3ee642` | ported | - | chore: update nix node_modules hashes |
| `3d189b42a` | skipped | - | refactor: migrate file/ripgrep.ts from Bun.file()/Bun.write() to Filesystem module (#14159) |
| `a5c15a23e` | skipped | - | core: allow readJson to be called without explicit type parameter |
| `472d01fba` | skipped | - | refactor: migrate cli/cmd/run.ts from Bun.file() to Filesystem/stat modules (#14155) |
| `b714bb21d` | ported | - | ci: switch to standard GitHub cache action for Bun dependencies |
| `a500eaa2d` | skipped | - | refactor: migrate format/formatter.ts from Bun.file() to Filesystem module (#14153) |
| `82a323ef7` | ported | - | refactor: migrate cli/cmd/github.ts from Bun.write() to Filesystem module (#14154) |
| `ef155f376` | skipped | - | refactor: migrate file/index.ts from Bun.file() to Filesystem module (#14152) |
| `8f4a72c57` | skipped | - | refactor: migrate config/markdown.ts from Bun.file() to Filesystem module (#14151) |
| `e0e8b9438` | ported | - | refactor: migrate uninstall.ts from Bun.file()/Bun.write() to Filesystem module (#14150) |
| `c88ff3c08` | skipped | - | refactor: migrate src/bun/index.ts from Bun.file()/Bun.write() to Filesystem module (#14147) |
| `eb3f33769` | skipped | - | refactor: migrate clipboard.ts from Bun.file() to Filesystem module (#14148) |
| `5638b782c` | skipped | - | refactor: migrate editor.ts from Bun.file()/Bun.write() to Filesystem module (#14149) |
| `d447b7694` | ported | - | fix(github): emit PROMPT_TOO_LARGE error on context overflow (#14166) |
| `3f60a6c2a` | ported | - | chore: cleanup |
| `ef14f64f9` | ported | - | chore: cleanup |
| `8408e4702` | ported | - | chore: cleanup |
| `72c12d59a` | ported | - | chore: cleanup |
| `be2e6f192` | skipped | - | fix(opencode): update pasteImage to only increment count when the previous attachment is an image too (#14173) |
| `8bf06cbcc` | skipped | - | refactor: migrate src/global/index.ts from Bun.file() to Filesystem module (#14146) |
| `24a984132` | ported | - | zen: update sst version |
| `c6bd32000` | ported | - | chore: update nix node_modules hashes |
| `42aa28d51` | ported | - | chore: cleanup (#14181) |
| `1133d87be` | ported | - | chore: cleanup |
| `de25703e9` | ported | - | fix(app): terminal cross-talk (#14184) |
| `1aa18c6cd` | skipped | - | feat(plugin): pass sessionID and callID to shell.env hook input (#13662) |
| `2d7c9c969` | skipped | - | chore: generate |
| `d6331cf79` | ported | - | Update colors.css |
| `12016c8eb` | ported | - | oc-2 theme init |
| `5d69f0028` | ported | - | button style tweaks |
| `24ce49d9d` | ported | - | fix(ui): add previous smoke colors |
| `0888c0237` | ported | - | tweak(ui): file tree background color |
| `9110e6a2a` | ported | - | tweak(ui): share button border |
| `f20c0bffd` | ported | - | tweak(ui): unify titlebar expanded button background |
| `e5d52e4eb` | ported | - | tweak(ui): align pill tabs pressed background |
| `4db2d9485` | ported | - | tweak(ui): shrink filetree tab height |
| `087390803` | ported | - | tweak(ui): theme color updates |
| `1f9be63e9` | ported | - | tweak(ui): use weak border and base icon color for secondary |
| `6d69ad557` | ported | - | tweak(ui): update oc-2 secondary button colors |
| `bcca253de` | ported | - | tweak(ui): hover and active styles for title bar buttons |
| `3690cafeb` | ported | - | tweak(ui): hover and active styles for title bar buttons |
| `4e959849f` | ported | - | tweak(ui): hover and active styles for filetree tabs |
| `09286ccae` | ported | - | tweak(ui): oc-2 theme updates |
| `2f5676106` | ported | - | tweak(ui): expanded color state on titlebar buttons |
| `db4ff8957` | ported | - | Update oc-2.json |
| `1ed4a9823` | ported | - | tweak(ui): remove pressed transition for secondary buttons |
| `431f5347a` | ported | - | tweak(ui): search button style |
| `c7a79f187` | ported | - | Update icon-button.css |
| `e42cc8511` | ported | - | Update oc-2.json |
| `d730d8be0` | ported | - | tweak(ui): shrink review diff style toggle |
| `1571246ba` | ported | - | tweak(ui): use default cursor for segmented control |
| `1b67339e4` | ported | - | Update radio-group.css |
| `06b2304a5` | ported | - | tweak(ui): override for the radio group in the review |
| `31e964e7c` | ported | - | Update oc-2.json |
| `bb6d1d502` | ported | - | tweak(ui): adjust review diff style hover radius |
| `47b4de353` | ported | - | tweak(ui): tighten review header action spacing |
| `ba919fb61` | ported | - | tweak(ui): shrink review expand/collapse width |
| `50923f06f` | ported | - | tweak(ui): remove pressed scale for secondary buttons |
| `d8a4a125c` | ported | - | Update oc-2.json |
| `7faa8cb11` | ported | - | tweak(ui): reduce review panel padding |
| `dec782754` | ported | - | chore: generate |
| `c71f4d484` | ported | - | Update oc-2.json |
| `d5971e2da` | skipped | - | refactor: migrate src/cli/cmd/import.ts from Bun.file() to Filesystem module (#14143) |
| `898bcdec8` | skipped | - | refactor: migrate src/cli/cmd/agent.ts from Bun.file()/Bun.write() to Filesystem module (#14142) |
| `3cde93bf2` | skipped | - | refactor: migrate src/auth/index.ts from Bun.file()/Bun.write() to Filesystem module (#14140) |
| `a2469d933` | skipped | - | refactor: migrate src/acp/agent.ts from Bun.file() to Filesystem module (#14139) |
| `e37a9081a` | skipped | - | refactor: migrate src/cli/cmd/session.ts from Bun.file() to statSync (#14144) |
| `a4b36a72a` | ported | - | refactor: migrate src/file/time.ts from Bun.file() to stat (#14141) |
| `ec7c72da3` | ported | - | tweak(ui): restyle reasoning blocks |
| `2589eb207` | ported | - | tweak(app): shorten prompt mode toggle tooltips |
| `cfea5c73d` | ported | - | tweak(app): delay prompt mode toggle tooltip |
| `d366a1430` | skipped | - | refactor: migrate src/lsp/server.ts from Bun.file()/Bun.write() to Filesystem module (#14138) |
| `87c16374a` | ported | - | fix(lsp): use HashiCorp releases API for installing terraform-ls (#14200) |
| `7033b4d0a` | ported | - | fix(win32): Sidecar spawning a window (#14197) |
| `639d1dd8f` | ported | - | chore: add compliance checks for issues and PRs with recheck on edit (#14170) |
| `b90967936` | skipped | - | chore: generate |
| `b75a89776` | ported | - | refactor: migrate src/lsp/client.ts from Bun.file() to Filesystem module (#14137) |
| `97520c827` | skipped | - | refactor: migrate src/provider/models.ts from Bun.file()/Bun.write() to Filesystem module (#14131) |
| `48dfa45a9` | skipped | - | refactor: migrate src/util/log.ts from Bun.file() to Node.js fs module (#14136) |
| `6fb4f2a7a` | skipped | - | refactor: migrate src/cli/cmd/tui/thread.ts from Bun.file() to Filesystem module (#14135) |
| `5d12eb952` | skipped | - | refactor: migrate src/shell/shell.ts from Bun.file() to statSync (#14134) |
| `359360ad8` | skipped | - | refactor: migrate src/provider/provider.ts from Bun.file() to Filesystem module (#14132) |
| `ae398539c` | skipped | - | refactor: migrate src/session/instruction.ts from Bun.file() to Filesystem module (#14130) |
| `5fe237a3f` | skipped | - | refactor: migrate src/skill/discovery.ts from Bun.file()/Bun.write() to Filesystem module (#14133) |
| `088eac9d4` | ported | - | fix: opencode run crashing, and show errored tool calls in output (#14206) |
| `c16207488` | ported | - | chore: skip PR standards checks for PRs created before Feb 18 2026 6PM EST (#14208) |
| `57b63ea83` | skipped | - | refactor: migrate src/session/prompt.ts from Bun.file() to Filesystem/stat modules (#14128) |
| `a8347c376` | skipped | - | refactor: migrate src/storage/db.ts from Bun.file() to statSync (#14124) |
| `9e6cb8910` | skipped | - | refactor: migrate src/mcp/auth.ts from Bun.file()/Bun.write() to Filesystem module (#14125) |
| `819d09e64` | skipped | - | refactor: migrate src/storage/json-migration.ts from Bun.file() to Filesystem module (#14123) |
| `a624871cc` | skipped | - | refactor: migrate src/storage/storage.ts from Bun.file()/Bun.write() to Filesystem module (#14122) |
| `bd52ce564` | skipped | - | refactor: migrate remaining tool files from Bun.file() to Filesystem/stat modules (#14121) |
| `270b807cd` | skipped | - | refactor: migrate src/tool/edit.ts from Bun.file() to Filesystem module (#14120) |
| `36bc07a5a` | skipped | - | refactor: migrate src/tool/write.ts from Bun.file() to Filesystem module (#14119) |
| `14c098941` | skipped | - | refactor: migrate src/tool/read.ts from Bun.file() to Filesystem module (#14118) |
| `ba53c56a2` | ported | - | tweak(ui): combine diffs in review into one group |
| `9c7629ce6` | ported | - | Update oc-2.json |
| `4a8bdc3c7` | ported | - | tweak(ui): group edited files list styling |
| `fd61be407` | ported | - | tweak(ui): show added diff counts in review |
| `a30105126` | ported | - | tweak(ui): tighten review diff file info gap |
| `40f00ccc1` | ported | - | tweak(ui): use chevron icons for review diff rows |
| `44049540b` | ported | - | tweak(ui): add open-file tooltip icon |
| `3d0f24067` | ported | - | tweak(app): tighten prompt dock padding |
| `5d8664c13` | ported | - | tweak(app): adjust session turn horizontal padding |
| `6042785c5` | ported | - | tweak(ui): rtl-truncate edited file paths |
| `802ccd378` | ported | - | tweak(ui): rotate collapsible chevron icon |
| `3a07dd8d9` | skipped | - | refactor: migrate src/project/project.ts from Bun.file() to Filesystem/stat modules (#14126) |
| `568eccb4c` | skipped | - | Revert: all refactor commits migrating from Bun.file() to Filesystem module |
| `d62045553` | ported | - | app: deduplicate allServers list |
| `11a37834c` | skipped | - | tui: ensure onExit callback fires after terminal output is written |
| `3a416f6f3` | ported | - | sdk: fix nested exports transformation in publish script |
| `189347314` | ported | - | fix: token substitution in OPENCODE_CONFIG_CONTENT (alternate take) (#14047) |
| `4b878f6ae` | skipped | - | chore: generate |
| `308e50083` | skipped | - | tweak: bake in the aws and google auth pkgs (#14241) |
| `c7b35342d` | ported | - | chore: update nix node_modules hashes |
| `d07f09925` | ported | - | fix(app): terminal rework (#14217) |
| `885d71636` | ported | - | desktop: fetch defaultServer at top level |
| `d2d5f3c04` | ported | - | app: fix typecheck |
| `38f7071da` | ported | - | chore: cleanup |
| `8ebdbe0ea` | ported | - | fix(core): text files missclassified as binary |
| `338393c01` | ported | - | fix(app): accordion styles |
| `0fcba68d4` | ported | - | chore: cleanup |
| `02a949506` | skipped | - | Remove use of Bun.file (#14215) |
| `08a2d002b` | skipped | - | zen: gemini 3.1 pro |
| `6b8902e8b` | ported | - | fix(app): navigate to last session on project nav |
| `56dda4c98` | ported | - | chore: cleanup |
| `3c21735b3` | skipped | - | refactor: migrate from Bun.Glob to npm glob package |
| `f2858a42b` | ported | - | chore: cleanup |
| `50883cc1e` | ported | - | app: make localhost urls work in isLocal |
| `af72010e9` | skipped | - | Revert "refactor: migrate from Bun.Glob to npm glob package" |
| `850402f09` | ported | - | chore: update nix node_modules hashes |
| `91f8dd5f5` | ported | - | chore: update nix node_modules hashes |
| `5364ab74a` | skipped | - | tweak: add support for medium reasoning w/ gemini 3.1 (#14316) |
| `7e35d0c61` | skipped | - | core: bump ai sdk packages for google, google vertex, anthropic, bedrock, and provider utils (#14318) |
| `cb8b74d3f` | skipped | - | refactor: migrate from Bun.Glob to npm glob package (#14317) |
| `8b9964879` | ported | - | chore: update nix node_modules hashes |
| `00c079868` | ported | - | test: fix discovery test to boot up server instead of relying on 3rd party (#14327) |
| `1867f1aca` | skipped | - | chore: generate |
| `b64d0768b` | skipped | - | docs(ko): improve wording in ecosystem, enterprise, formatters, and github docs (#14220) |
| `190d2957e` | ported | - | fix(core): normalize file.status paths relative to instance dir (#14207) |
| `3d9f6c0fe` | ported | - | feat(i18n): update Japanese translations to WSL integration (#13160) |
| `7fb2081dc` | ported | - | chore: cleanup |
| `7729c6d89` | ported | - | chore: cleanup |
| `40a939f5f` | ported | - | chore: cleanup |
| `f8dad0ae1` | ported | - | fix(app): terminal issues (#14329) |
| `49cc872c4` | ported | - | chore: refactor composer/dock components (#14328) |
| `c76a81434` | ported | - | chore: cleanup |
| `1a1437e78` | ported | - | fix(github): action branch detection and 422 handling (#14322) |
| `04cf2b826` | ported | - | release: v1.2.7 |
| `dd011e879` | ported | - | fix(app): clear todos on abort |
| `7a42ecddd` | ported | - | chore: cleanup |
| `824ab4cec` | skipped | - | feat(tui): add custom tool and mcp call responses visible and collapsable (#10649) |
| `193013a44` | skipped | - | feat(opencode): support adaptive thinking for claude sonnet 4.6 (#14283) |
| `686dd330a` | skipped | - | chore: generate |
| `fca016648` | ported | - | fix(app): black screen on launch with sidecar server |
| `f2090b26c` | ported | - | release: v1.2.8 |
| `cb5a0de42` | ported | - | core: remove User-Agent header assertion from LLM test to fix failing test |
| `d32dd4d7f` | skipped | - | docs: update providers layout and Windows sidebar label |
| `ae50f24c0` | skipped | - | fix(web): correct config import path in Korean enterprise docs |
| `01d518708` | skipped | - | remove unnecessary deep clones from session loop and LLM stream (#14354) |
| `8ad60b1ec` | skipped | - | Use structuredClone instead of remeda's clone (#14351) |
| `d2d7a37bc` | ported | - | fix: add missing id/sessionID/messageID to MCP tool attachments (#14345) |
| `998c8bf3a` | ported | - | tweak(ui): stabilize collapsible chevron hover |
| `a3181d5fb` | ported | - | tweak(ui): nudge edited files chevron |
| `ae98be83b` | ported | - | fix(desktop): restore settings header mask |
| `63a469d0c` | ported | - | tweak(ui): refine session feed spacing |
| `8b99ac651` | ported | - | tweak(ui): tone down reasoning emphasis |
| `8d781b08c` | ported | - | tweak(ui): adjust session feed spacing |
| `1a329ba47` | skipped | - | fix: issue from structuredClone addition by using unwrap (#14359) |
| `1eb6caa3c` | ported | - | release: v1.2.9 |
| `04a634a80` | ported | - | test: merge test files into a single file (#14366) |
| `d86c10816` | skipped | - | docs: clarify tool name collision precedence (#14313) |
| `1c2416b6d` | ported | - | desktop: don't spawn sidecar if default is localhost server |
| `443214871` | ported | - | sdk: build to dist/ instead of dist/src (#14383) |
| `296250f1b` | ported | - | release: v1.2.10 |
| `a04e4e81f` | ported | - | chore: cleanup |
| `93615bef2` | ported | - | fix(cli): missing plugin deps cause TUI to black screen (#14432) |
| `7e1051af0` | ported | - | fix(ui): show full turn duration in assistant meta (#14378) |
| `ac0b37a7b` | ported | - | fix(snapshot): respect info exclude in snapshot staging (#13495) |
| `1de12604c` | ported | - | fix(ui): preserve url slashes for root workspace (#14294) |
| `241059302` | ported | - | fix(github): support variant in github action and opencode github run (#14431) |
| `7e0e35af3` | skipped | - | chore: update agent |
| `4e9ef3ecc` | ported | - | fix(app): terminal issues (#14435) |
| `7e681b0bc` | ported | - | fix(app): large text pasted into prompt-input causes main thread lock |
| `7419ebc87` | skipped | - | feat: add list sessions for all sessions (experimental) (#14038) |
| `7867ba441` | ported | - | chore: generate |
| `92ab4217c` | ported | - | desktop: bring back -i in sidecar arguments |
| `ce17f9dd9` | ported | - | desktop: publish betas to separate repo (#14376) |
| `9c5bbba6e` | ported | - | fix(app): patch tool renders like edit tool |
| `c79f1a72d` | ported | - | cache platform binary in postinstall for faster startup (#14396) |
| `1ffed2fa6` | skipped | - | Revert "cache platform binary in postinstall for faster startup" (#14457) |
| `0ce61c817` | ported | - | fix(app): stay pinned with auto-scroll on todos/questions/perms |
| `2a904ec56` | ported | - | feat(app): show/hide reasoning summaries |
| `1e48d7fe8` | ported | - | zen: gpt safety_identifier |
| `fe89bedfc` | ported | - | wip(app): custom scroll view |
| `c09d3dd5a` | ported | - | chore: cleanup |
| `46361cf35` | ported | - | fix(app): session review re-rendering too aggressively |
| `1d9f05e4f` | ported | - | cache platform binary in postinstall for faster startup (#14467) |
| `950df3de1` | ported | - | ci: temporarily disable assigning of issues to rekram1-node (#14486) |
| `ce2763720` | ported | - | fix(app): better sound effect disabling ux |
| `58ad4359d` | ported | - | chore: cleanup |
| `f07e87720` | ported | - | fix(app): remove double-border in share button |
| `5a1aca918` | skipped | - | docs: add Bangla README translation (#14331) |
| `d0ce2950e` | skipped | - | chore: generate |
| `e77b2cfd6` | ported | - | wip: zen lite |
| `b75a27d43` | ported | - | chore: cleanup |
| `6d58d899f` | ported | - | fix: e2e test outdated |
| `206d81e02` | ported | - | desktop: beta icon |
| `c45ab712d` | skipped | - | chore: locale specific glossaries |
| `dbf2c4586` | skipped | - | chore: updated locale glossaries and docs sync workflow |
| `a41c81dcd` | skipped | - | docs(ko): improve wording in gitlab, ide, index, keybinds, and lsp docs (#14517) |
| `13616e345` | ported | - | Update VOUCHED list |
| `b16f7b426` | skipped | - | docs(tui): correct typo in TUI documentation (#14604) |
| `e70d2b27d` | ported | - | fix(app): terminal issues |
| `aaf8317c8` | ported | - | feat(app): feed customization options |
| `eb64ce08b` | ported | - | Update VOUCHED list |
| `a74fedd23` | ported | - | fix(desktop): change detection on Windows, especially Cygwin (#13659) |
| `faa63227a` | ported | - | chore: generate |
| `a4ed020a9` | ported | - | upgrade opentui to v0.1.81 (#14605) |
| `ab75ef814` | ported | - | chore: update nix node_modules hashes |
| `0042a0705` | ported | - | fix: Windows path support and canonicalization (#13671) |
| `ee754c46f` | ported | - | fix(win32): normalize paths at permission boundaries (#14738) |
| `5712cff5c` | ported | - | zen: track session in usage |
| `5596775c3` | ported | - | zen: display session in usage |
| `a5a70fa05` | ported | - | wip: zen lite |
| `d3ecc5a0d` | ported | - | chore: generate |
| `9f4fc5b72` | ported | - | Revert "fix(app): terminal issues" |
| `8e9644796` | ported | - | fix(app): correct inverted chevron direction in todo list (#14628) |
| `3b5b21a91` | ported | - | fix(app): duplicate markdown |
| `8f2d8dd47` | ported | - | fix(app): duplicate markdown |
| `24c63914b` | ported | - | fix: update workflows for better automation (#14809) |
| `ad5f0816a` | ported | - | fix(cicd): flakey typecheck (#14828) |
| `34495a70d` | ported | - | fix(win32): scripts/turbo commands would not run (#14829) |
| `284251ad6` | ported | - | zen: display BYOK cost |
| `0a9119691` | ported | - | fix(win32): e2e sometimes fails because windows is weird and sometimes ipv6 (#14833) |
| `0269f39a1` | ported | - | ci: add Windows to unit test matrix (#14836) |
| `ae190038f` | ported | - | ci: use bun baseline build to avoid segfaults (#14839) |
| `cf5cfb48c` | ported | - | upgrade to bun 1.3.10 canary and force baseline builds always (#14843) |
| `eda71373b` | ported | - | app: wait for loadFile before opening file tab |
| `cda2af258` | ported | - | wip: zen lite |
| `fb6d201ee` | ported | - | wip: zen lite |
| `744059a00` | ported | - | chore: generate |
| `a592bd968` | ported | - | fix: update createOpenReviewFile test to match new call order (#14881) |
| `de796d9a0` | ported | - | fix(test): use path.join for cross-platform glob test assertions (#14837) |
| `3201a7d34` | ported | - | fix(win32): add bun prefix to console app build scripts (#14884) |
| `659068942` | ported | - | fix(win32): handle CRLF line endings in markdown frontmatter parsing (#14886) |
| `13cabae29` | ported | - | fix(win32): add git flags for snapshot operations and fix tests for cross-platform (#14890) |
| `888b12338` | skipped | - | feat: ACP - stream bash output and synthetic pending events (#14079) |
| `ef7f222d8` | ported | - | chore: generate |
| `79254c102` | ported | - | fix(test): normalize git excludesFile path for Windows (#14893) |
| `a292eddeb` | ported | - | fix(test): harden preload cleanup against Windows EBUSY (#14895) |
| `1af3e9e55` | ported | - | fix(win32): fix plugin resolution with createRequire fallback (#14898) |
| `1a0639e5b` | ported | - | fix(win32): normalize backslash paths in config rel() and file ignore (#14903) |
| `06f25c78f` | ported | - | fix(test): use path.sep in discovery test for cross-platform path matching (#14905) |
| `3d379c20c` | ported | - | fix(test): replace Unix-only assumptions with cross-platform alternatives (#14906) |
| `36197f5ff` | ported | - | fix(win32): add 50ms tolerance for NTFS mtime fuzziness in FileTime assert (#14907) |
| `32417774c` | ported | - | fix(test): replace structuredClone with spread for process.env (#14908) |
| `e27d3d5d4` | ported | - | fix(app): remove filetree tooltips |
| `2cee94767` | ported | - | fix: ACP both live and load share synthetic pending status preceeding… (#14916) |
| `082f0cc12` | ported | - | fix(app): preserve native path separators in file path helpers (#14912) |
| `c92913e96` | ported | - | chore: cleanup |
| `519058963` | ported | - | zen: remove alpha models from models endpoint |
| `cc02476ea` | ported | - | refactor: replace error handling with serverErrorMessage utility and checks for if error is ConfigInvalidError (#14685) |
| `0d0d0578e` | ported | - | chore: generate |
| `c6d8e7624` | ported | - | fix(app): on cancel comment unhighlight lines (#14103) |
| `f8cfb697b` | ported | - | zen: restrict alpha models to admin workspaces |
| `68cf011fd` | ported | - | fix(app): ignore stale part deltas |
| `2a87860c0` | skipped | - | zen: gpt 5.3 codex |
| `2c00eb60b` | skipped | - | feat(core): add workspace-serve command (experimental) (#14960) |
| `29ddd5508` | ported | - | release: v1.2.11 |
| `814c1d398` | skipped | - | refactor: migrate Bun.spawn to Process utility with timeout and cleanup (#14448) |
| `fa559b038` | skipped | - | core: temporarily disable plan enter tool to prevent unintended mode switches during task execution |
| `637059a51` | skipped | - | feat: show LSP errors for apply_patch tool (#14715) |
| `a487f11a3` | ported | - | ci: auto-resolve merge conflicts in beta sync using opencode |
| `0b3fb5d46` | ported | - | ci: specify opencode/kimi-k2.5 model in beta script to ensure consistent PR processing |
| `6af7ddf03` | ported | - | ci: switch beta script to gpt-5.3-codex for improved code generation quality |
| `76b60f377` | skipped | - | desktop: make readme more accurate |
| `6fc550629` | ported | - | zen: go |
| `d00d98d56` | ported | - | wip: zen go |
| `1172ebe69` | ported | - | wip: zen go |
| `5d5f2cfee` | ported | - | wip: zen go |
| `d7500b25b` | ported | - | zen: go |
| `fc6e7934b` | ported | - | feat(desktop): enhance Windows app resolution and UI loading states (#13320) |
| `3c6c74457` | skipped | - | sync |
| `561f9f5f0` | skipped | - | opencode go copy |
| `d848c9b6a` | ported | - | release: v1.2.13 |
| `79b5ce58e` | skipped | - | feat(core): add message delete endpoint (#14417) |
| `de2bc2567` | ported | - | release: v1.2.14 |
| `5e5823ed8` | ported | - | chore: generate |
| `e48c1ccf0` | ported | - | chore(workflows): label vouched users and restrict vouch managers (#15075) |
| `286992269` | ported | - | fix(app): correct Copilot provider description in i18n files (#15071) |
| `45191ad14` | ported | - | fix(app): keyboard navigation previous/next message (#15047) |
| `7afa48b4e` | ported | - | tweak(ui): keep reasoning inline code subdued in dark mode |
