# Refactor Plan: 2026-02-26 (origin/dev → cms, origin_dev_delta_20260227_round63)

Date: 2026-02-26
Status: WAITING_APPROVAL

## Summary

- Upstream pending (raw): 591 commits
- Excluded by processed ledger: 455 commits
- Commits for this round: 136 commits

## Policy Guardrails

- Execution mode: rewrite-only refactor-port.
- Forbidden: `git cherry-pick`, `git merge`, or direct upstream patch transplant.
- Allowed: analyze behavior intent, then re-implement on cms architecture and validate.

## Actions

| Commit | Logical Type | Value Score | Risk | Decision | Notes |
| :----- | :----------- | :---------- | :--- | :------- | :---- |
| `ae98be83b` | protocol | 1/0/0/1=2 | low | ported | fix(desktop): restore settings header mask |
| `63a469d0c` | feature | 1/0/0/1=2 | low | ported | tweak(ui): refine session feed spacing |
| `8b99ac651` | feature | 1/0/0/1=2 | low | ported | tweak(ui): tone down reasoning emphasis |
| `8d781b08c` | feature | 1/0/0/1=2 | low | ported | tweak(ui): adjust session feed spacing |
| `1a329ba47` | ux | 0/0/0/-1=-1 | high | skipped | fix: issue from structuredClone addition by using unwrap (#14359) |
| `1eb6caa3c` | feature | 1/0/0/1=2 | low | ported | release: v1.2.9 |
| `04a634a80` | feature | 1/0/0/1=2 | low | ported | test: merge test files into a single file (#14366) |
| `443214871` | feature | 1/0/0/1=2 | low | ported | sdk: build to dist/ instead of dist/src (#14383) |
| `296250f1b` | feature | 1/0/0/1=2 | low | ported | release: v1.2.10 |
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
| `888b12338` | feature | 1/0/0/0=1 | medium | skipped | feat: ACP - stream bash output and synthetic pending events (#14079) |
| `ef7f222d8` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `79254c102` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(test): normalize git excludesFile path for Windows (#14893) |
| `a292eddeb` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(test): harden preload cleanup against Windows EBUSY (#14895) |
| `06f25c78f` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(test): use path.sep in discovery test for cross-platform path matching (#14905) |
| `3d379c20c` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(test): replace Unix-only assumptions with cross-platform alternatives (#14906) |
| `36197f5ff` | behavioral-fix | 1/1/0/0=2 | medium | ported | fix(win32): add 50ms tolerance for NTFS mtime fuzziness in FileTime assert (#14907) |
| `32417774c` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(test): replace structuredClone with spread for process.env (#14908) |
| `e27d3d5d4` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): remove filetree tooltips |
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
| `de2bc2567` | feature | 1/0/0/1=2 | low | ported | release: v1.2.14 |
| `5e5823ed8` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `e48c1ccf0` | infra | 1/0/0/1=2 | low | ported | chore(workflows): label vouched users and restrict vouch managers (#15075) |
| `286992269` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): correct Copilot provider description in i18n files (#15071) |
| `45191ad14` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): keyboard navigation previous/next message (#15047) |
| `7afa48b4e` | feature | 1/0/0/1=2 | low | ported | tweak(ui): keep reasoning inline code subdued in dark mode |
| `b368181ac` | infra | 1/0/0/1=2 | low | ported | chore: move glossary |
| `1172fa418` | feature | 1/0/0/1=2 | low | ported | wip: zen go |
| `9d29d692c` | ux | 0/0/0/-1=-1 | high | skipped | split tui/server config (#13968) |
| `4551282a4` | infra | 1/0/0/1=2 | low | ported | chore: generate |
| `444178e07` | docs | -1/-1/-1/1=-2 | low | skipped | fix(docs): update schema URL in share configuration examples across multiple languages (#15114) |
| `b8337cddc` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): permissions and questions from child sessions (#15105) |
| `c4ea11fef` | feature | 1/0/0/1=2 | low | ported | wip: zen |
| `392a6d993` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(desktop): remove interactive shell flag from sidecar spawn to prevent hang on macOS (#15136) |
| `aae75b3cf` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): middle-click tab close in scrollable tab bar (#15081) |
| `fce811b52` | behavioral-fix | 1/1/0/1=3 | low | ported | fix: most segfaults on windows with Bun v1.3.10 stable (#15181) |
| `799b2623c` | feature | 1/0/0/1=2 | low | ported | release: v1.2.15 |
| `6b021658a` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): open in powershell (#15112) |
| `bb8a1718a` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(desktop): restore shell path env for desktop sidecar (#15211) |
| `7453e78b3` | ux | 0/0/0/-1=-1 | high | skipped | feat: opencode go provider list (#15203) |
| `05ac0a73e` | behavioral-fix | 1/1/0/1=3 | low | ported | fix(app): simplify review layout (#14953) |
| `b4d0090e0` | infra | 1/0/0/1=2 | low | ported | chore: fix flaky test |
| `96ca0de3b` | feature | 1/0/0/1=2 | low | ported | wip: zen |

## Execution Queue

1. [ ] Confirm high-risk items (ported vs skipped).
2. [ ] Refactor-port selected items by behavior reimplementation (no cherry-pick/merge).
3. [ ] Update ledger with final status mapping.

## Mapping to Ledger

| Upstream Commit | Status | Local Commit | Note |
| :-------------- | :----- | :----------- | :--- |
| `ae98be83b` | ported | - | fix(desktop): restore settings header mask |
| `63a469d0c` | ported | - | tweak(ui): refine session feed spacing |
| `8b99ac651` | ported | - | tweak(ui): tone down reasoning emphasis |
| `8d781b08c` | ported | - | tweak(ui): adjust session feed spacing |
| `1a329ba47` | skipped | - | fix: issue from structuredClone addition by using unwrap (#14359) |
| `1eb6caa3c` | ported | - | release: v1.2.9 |
| `04a634a80` | ported | - | test: merge test files into a single file (#14366) |
| `443214871` | ported | - | sdk: build to dist/ instead of dist/src (#14383) |
| `296250f1b` | ported | - | release: v1.2.10 |
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
| `888b12338` | skipped | - | feat: ACP - stream bash output and synthetic pending events (#14079) |
| `ef7f222d8` | ported | - | chore: generate |
| `79254c102` | ported | - | fix(test): normalize git excludesFile path for Windows (#14893) |
| `a292eddeb` | ported | - | fix(test): harden preload cleanup against Windows EBUSY (#14895) |
| `06f25c78f` | ported | - | fix(test): use path.sep in discovery test for cross-platform path matching (#14905) |
| `3d379c20c` | ported | - | fix(test): replace Unix-only assumptions with cross-platform alternatives (#14906) |
| `36197f5ff` | ported | - | fix(win32): add 50ms tolerance for NTFS mtime fuzziness in FileTime assert (#14907) |
| `32417774c` | ported | - | fix(test): replace structuredClone with spread for process.env (#14908) |
| `e27d3d5d4` | ported | - | fix(app): remove filetree tooltips |
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
| `de2bc2567` | ported | - | release: v1.2.14 |
| `5e5823ed8` | ported | - | chore: generate |
| `e48c1ccf0` | ported | - | chore(workflows): label vouched users and restrict vouch managers (#15075) |
| `286992269` | ported | - | fix(app): correct Copilot provider description in i18n files (#15071) |
| `45191ad14` | ported | - | fix(app): keyboard navigation previous/next message (#15047) |
| `7afa48b4e` | ported | - | tweak(ui): keep reasoning inline code subdued in dark mode |
| `b368181ac` | ported | - | chore: move glossary |
| `1172fa418` | ported | - | wip: zen go |
| `9d29d692c` | skipped | - | split tui/server config (#13968) |
| `4551282a4` | ported | - | chore: generate |
| `444178e07` | skipped | - | fix(docs): update schema URL in share configuration examples across multiple languages (#15114) |
| `b8337cddc` | ported | - | fix(app): permissions and questions from child sessions (#15105) |
| `c4ea11fef` | ported | - | wip: zen |
| `392a6d993` | ported | - | fix(desktop): remove interactive shell flag from sidecar spawn to prevent hang on macOS (#15136) |
| `aae75b3cf` | ported | - | fix(app): middle-click tab close in scrollable tab bar (#15081) |
| `fce811b52` | ported | - | fix: most segfaults on windows with Bun v1.3.10 stable (#15181) |
| `799b2623c` | ported | - | release: v1.2.15 |
| `6b021658a` | ported | - | fix(app): open in powershell (#15112) |
| `bb8a1718a` | ported | - | fix(desktop): restore shell path env for desktop sidecar (#15211) |
| `7453e78b3` | skipped | - | feat: opencode go provider list (#15203) |
| `05ac0a73e` | ported | - | fix(app): simplify review layout (#14953) |
| `b4d0090e0` | ported | - | chore: fix flaky test |
| `96ca0de3b` | ported | - | wip: zen |
