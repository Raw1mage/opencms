# Refactor Plan: 2026-02-11 (origin/dev → HEAD, origin_dev_delta_20260212)

Date: 2026-02-11
Status: WAITING_APPROVAL

## Summary

- Upstream pending (raw): 104 commits
- Excluded by processed ledger: 0 commits
- Commits for this round: 104 commits

## Actions

| Commit      | Logical Type   | Value Score   | Risk   | Decision   | Notes                                                                                                                                   |
| :---------- | :------------- | :------------ | :----- | :--------- | :-------------------------------------------------------------------------------------------------------------------------------------- |
| `274bb948e` | docs           | -1/-1/-1/1=-2 | low    | skipped    | fix(docs): locale markdown issues                                                                                                       |
| `389afef33` | docs           | -1/-1/-1/1=-2 | low    | skipped    | chore: generate                                                                                                                         |
| `19809e768` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): max widths                                                                                                                    |
| `371e106fa` | infra          | 1/0/0/1=2     | low    | integrated | chore: cleanup                                                                                                                          |
| `9824370f8` | infra          | 1/0/0/1=2     | low    | integrated | chore: more defensive                                                                                                                   |
| `3d6fb29f0` | ux             | 1/0/0/1=2     | low    | integrated | fix(desktop): correct module name for linux_display in main.rs (#12862)                                                                 |
| `832902c8e` | protocol       | 1/0/0/0=1     | medium | skipped    | fix: publish session.error event for invalid model selection (#8451)                                                                    |
| `056d0c119` | ux             | 0/0/0/-1=-1   | high   | skipped    | fix(tui): use sender color for queued messages (#12832)                                                                                 |
| `31f893f8c` | infra          | 1/0/1/1=3     | low    | integrated | ci: sort beta PRs by number for consistent display order                                                                                |
| `3118cab2d` | feature        | 1/0/0/1=2     | low    | integrated | feat: integrate vouch & stricter issue trust management system (#12640)                                                                 |
| `85fa8abd5` | docs           | -1/-1/-1/1=-2 | low    | skipped    | fix(docs): translations                                                                                                                 |
| `705200e19` | docs           | -1/-1/-1/1=-2 | low    | skipped    | chore: generate                                                                                                                         |
| `949f61075` | feature        | 1/0/0/1=2     | low    | integrated | feat(app): add Cmd+[/] keybinds for session history navigation (#12880)                                                                 |
| `20cf3fc67` | infra          | 1/0/0/1=2     | low    | integrated | ci: filter daily recaps to community-only and fix vouch workflow authentication (#12910)                                                |
| `439e7ec1f` | infra          | 1/0/0/1=2     | low    | integrated | Update VOUCHED list                                                                                                                     |
| `56a752092` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: resolve homebrew upgrade requiring multiple runs (#5375) (#10118)                                                                  |
| `12262862c` | ux             | -1/0/0/-1=-2  | high   | skipped    | Revert "feat: show connected providers in /connect dialog (#8351)"                                                                      |
| `32394b699` | ux             | -1/0/0/-1=-2  | high   | skipped    | Revert "feat(tui): highlight esc label on hover in dialog (#12383)"                                                                     |
| `63cd76341` | ux             | -1/0/0/-1=-2  | high   | skipped    | Revert "feat: add version to session header and /status dialog (#8802)"                                                                 |
| `4a73d51ac` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(app): workspace reset issues                                                                                                        |
| `83853cc5e` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): new session in workspace choosing wrong workspace                                                                             |
| `2bccfd746` | infra          | 1/0/0/1=2     | low    | integrated | chore: fix some norwegian i18n issues (#12935)                                                                                          |
| `0732ab339` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix: use absolute paths for sidebar session navigation (#12898)                                                                         |
| `87795384d` | infra          | 1/0/0/0=1     | medium | skipped    | chore: fix typos and GitHub capitalization (#12852)                                                                                     |
| `19ad7ad80` | infra          | 1/0/0/1=2     | low    | integrated | chore: fix test                                                                                                                         |
| `4c4e30cd7` | docs           | -1/-1/-1/1=-2 | low    | skipped    | fix(docs): locale translations                                                                                                          |
| `c607c01fb` | infra          | 1/0/0/1=2     | low    | integrated | chore: fix e2e tests                                                                                                                    |
| `18b625711` | docs           | -1/-1/-1/1=-2 | low    | skipped    | chore: generate                                                                                                                         |
| `65c966928` | feature        | 1/0/0/1=2     | low    | integrated | test(e2e): redo & undo test (#12974)                                                                                                    |
| `1e03a55ac` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): persist defensiveness (#12973)                                                                                                |
| `27fa9dc84` | ux             | 0/0/0/-1=-1   | high   | skipped    | refactor: clean up dialog-model.tsx per code review (#12983)                                                                            |
| `6f5dfe125` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): use agent configured variant (#12993)                                                                                         |
| `3929f0b5b` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(app): terminal replay (#12991)                                                                                                      |
| `70c794e91` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): regressions                                                                                                                   |
| `2c5760742` | docs           | -1/-1/-1/1=-2 | low    | skipped    | chore: translator agent                                                                                                                 |
| `284b00ff2` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): don't dispose instance after reset workspace                                                                                  |
| `d1f5b9e91` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): memory leak with event fetch                                                                                                  |
| `659f15aa9` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(app): no changes in review pane                                                                                                     |
| `7d5be1556` | feature        | 1/0/0/1=2     | low    | integrated | wip: zen                                                                                                                                |
| `d863a9cf4` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): global event default fetch                                                                                                    |
| `eb2587844` | feature        | 1/0/0/1=2     | low    | integrated | zen: retry on 429                                                                                                                       |
| `a3aad9c9b` | protocol       | 1/0/0/1=2     | low    | integrated | fix(app): include basic auth                                                                                                            |
| `1e2f66441` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): back to platform fetch for now                                                                                                |
| `1d11a0adf` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.1.54                                                                                                                        |
| `8bdf6fa35` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix: show helpful message when free usage limit is exceeded (#13005)                                                                    |
| `80220cebe` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): disable terminal transparency                                                                                                 |
| `fc37337a3` | behavioral-fix | 1/1/0/0=2     | medium | integrated | fix(app): memory leak with platform fetch for events                                                                                    |
| `a0673256d` | feature        | 1/0/0/1=2     | low    | integrated | core: increase test timeout to 30s to prevent failures during package installation                                                      |
| `fbc41475b` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.1.55                                                                                                                        |
| `fd5531316` | docs           | -1/-1/-1/1=-2 | low    | skipped    | fix(docs): locale translations                                                                                                          |
| `55119559b` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): don't scroll code search input                                                                                                |
| `4f6b92978` | docs           | -1/-1/-1/1=-2 | low    | skipped    | chore: generate                                                                                                                         |
| `92a77b72f` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): don't close sidebar on session change (#13013)                                                                                |
| `8c56571ef` | feature        | 1/0/0/1=2     | low    | integrated | zen: log error                                                                                                                          |
| `dce4c05fa` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(desktop): open apps with executables on Windows (#13022)                                                                            |
| `21475a1df` | docs           | -1/-1/-1/1=-2 | low    | skipped    | fix(docs): invalid markdown                                                                                                             |
| `50f3e74d0` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): task tool rendering                                                                                                           |
| `1bbbd51d4` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.1.56                                                                                                                        |
| `66c2bb8f3` | infra          | 1/0/0/1=2     | low    | integrated | chore: update website stats                                                                                                             |
| `3894c217c` | feature        | 1/0/0/1=2     | low    | integrated | wip: zen                                                                                                                                |
| `50c705cd2` | docs           | -1/-1/-1/1=-2 | low    | skipped    | fix(docs): locale translations                                                                                                          |
| `3ea58bb79` | feature        | 1/0/0/1=2     | low    | integrated | wip: zen                                                                                                                                |
| `7a3c775dc` | feature        | 1/0/0/1=2     | low    | integrated | wip: zen                                                                                                                                |
| `0afa6e03a` | feature        | 1/0/0/1=2     | low    | integrated | wip: zen                                                                                                                                |
| `39145b99e` | feature        | 1/0/0/1=2     | low    | integrated | wip: zen                                                                                                                                |
| `24556331c` | feature        | 1/0/0/1=2     | low    | integrated | wip: zen                                                                                                                                |
| `a90b62267` | infra          | 1/0/0/1=2     | low    | integrated | Update VOUCHED list                                                                                                                     |
| `53ec15a56` | behavioral-fix | 0/1/0/-1=0    | high   | ported     | fix(tui): improve amazon-bedrock check to include container credentials (#13037)                                                        |
| `6e9cd576e` | ux             | 0/0/0/-1=-1   | high   | skipped    | fix(tui): default session sidebar to auto (#13046)                                                                                      |
| `60bdb6e9b` | feature        | 1/0/0/0=1     | medium | skipped    | tweak: /review prompt to look for behavior changes more explicitly (#13049)                                                             |
| `0fd6f365b` | behavioral-fix | 0/1/0/-1=0    | high   | ported     | fix(core): ensure compaction is more reliable, add reserve token buffer to ensure that input window has enough room to compact (#12924) |
| `c6ec2f47e` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                                         |
| `8c120f2fa` | docs           | 1/-1/-1/1=0   | low    | skipped    | docs: remove 'Migrating to 1.0' documentation section (#13076)                                                                          |
| `22125d134` | feature        | 1/0/0/1=2     | low    | integrated | wip: zen                                                                                                                                |
| `d98bd4bd5` | behavioral-fix | 0/1/0/-1=0    | high   | ported     | fix: add additional context overflow cases, remove overcorrecting ones (#13077)                                                         |
| `213a87234` | feature        | 1/0/0/1=2     | low    | skipped    | feat(desktop): add WSL backend mode (#12914) — upstream reverted, skip both                                                             |
| `783888131` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(desktop): read wayland preference from store (#13081)                                                                               |
| `7e1247c42` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(desktop): server spawn resilience (#13028)                                                                                          |
| `b52399832` | docs           | 1/-1/-1/1=0   | low    | skipped    | fix(docs): avoid footer language selector truncation (#13124)                                                                           |
| `567e094e6` | docs           | -1/-1/-1/1=-2 | low    | skipped    | docs(ko): improve translations for intro, cli, and commands (#13094)                                                                    |
| `5ba4c0e02` | docs           | -1/-1/-1/1=-2 | low    | skipped    | chore: generate                                                                                                                         |
| `cf7a1b8d8` | feature        | 1/0/0/1=2     | low    | integrated | feat(desktop): enhance Windows app resolution and UI loading states (#13084)                                                            |
| `8bfd6fdba` | protocol       | 1/0/0/1=2     | low    | integrated | fix: encode non-ASCII directory paths in v1 SDK HTTP headers (#13131)                                                                   |
| `a25b2af05` | feature        | 1/0/0/1=2     | low    | integrated | desktop: use tracing for logging (#13135)                                                                                               |
| `dd1862cc2` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(web): prevent language select label truncation (#13100)                                                                             |
| `c426cb0f1` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): copy path button styles                                                                                                       |
| `ef5ec5dc2` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): terminal copy/paste                                                                                                           |
| `edcfd562a` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.1.57                                                                                                                        |
| `93957da2c` | ux             | 0/0/0/-1=-1   | high   | skipped    | fix(tui): prevent home wordmark corruption in height-constrained terminals (#13069)                                                     |
| `352a54c69` | ux             | 0/0/0/-1=-1   | high   | skipped    | feat(prompt): mode-specific input placeholders (#12388)                                                                                 |
| `7a463cd19` | ux             | 0/0/0/-1=-1   | high   | skipped    | fix(tui): keep /share available to copy existing link (#12532)                                                                          |
| `17bdb5d56` | ux             | 0/0/0/-1=-1   | high   | skipped    | fix(tui): dismiss dialogs with ctrl+c (#12884)                                                                                          |
| `7222fc0ba` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): terminal resize                                                                                                               |
| `50330820c` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(console): translations                                                                                                              |
| `8c5ba8aeb` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): terminal PTY buffer carryover                                                                                                 |
| `a52fe2824` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): notifications on child sessions                                                                                               |
| `2e8082dd2` | feature        | 1/0/0/1=2     | low    | skipped    | Revert "feat(desktop): add WSL backend mode (#12914)" — paired with 213a87234, both skipped                                             |
| `4dc363f30` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.1.58                                                                                                                        |
| `4619e9d18` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): sidebar remount                                                                                                               |
| `fc88dde63` | feature        | 1/0/0/1=2     | low    | integrated | test(app): more e2e tests (#13162)                                                                                                      |
| `eef3ae3e1` | behavioral-fix | 1/1/0/1=3     | low    | integrated | Fix/reverception (#13166)                                                                                                               |
| `f252e3234` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): translations                                                                                                                  |
| `42bea5d29` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.1.59                                                                                                                        |
| `94cb6390a` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                                         |

## Execution Queue

1. [ ] Confirm high-risk items (ported vs skipped).
2. [ ] Integrate low/medium-risk high-value items.
3. [ ] Update ledger with final status mapping.

## Mapping to Ledger

| Upstream Commit | Status     | Local Commit | Note                                                                                                                                    |
| :-------------- | :--------- | :----------- | :-------------------------------------------------------------------------------------------------------------------------------------- |
| `274bb948e`     | skipped    | -            | fix(docs): locale markdown issues                                                                                                       |
| `389afef33`     | skipped    | -            | chore: generate                                                                                                                         |
| `19809e768`     | integrated | -            | fix(app): max widths                                                                                                                    |
| `371e106fa`     | integrated | -            | chore: cleanup                                                                                                                          |
| `9824370f8`     | integrated | -            | chore: more defensive                                                                                                                   |
| `3d6fb29f0`     | integrated | -            | fix(desktop): correct module name for linux_display in main.rs (#12862)                                                                 |
| `832902c8e`     | skipped    | -            | fix: publish session.error event for invalid model selection (#8451)                                                                    |
| `056d0c119`     | skipped    | -            | fix(tui): use sender color for queued messages (#12832)                                                                                 |
| `31f893f8c`     | integrated | -            | ci: sort beta PRs by number for consistent display order                                                                                |
| `3118cab2d`     | integrated | -            | feat: integrate vouch & stricter issue trust management system (#12640)                                                                 |
| `85fa8abd5`     | skipped    | -            | fix(docs): translations                                                                                                                 |
| `705200e19`     | skipped    | -            | chore: generate                                                                                                                         |
| `949f61075`     | integrated | -            | feat(app): add Cmd+[/] keybinds for session history navigation (#12880)                                                                 |
| `20cf3fc67`     | integrated | -            | ci: filter daily recaps to community-only and fix vouch workflow authentication (#12910)                                                |
| `439e7ec1f`     | integrated | -            | Update VOUCHED list                                                                                                                     |
| `56a752092`     | integrated | -            | fix: resolve homebrew upgrade requiring multiple runs (#5375) (#10118)                                                                  |
| `12262862c`     | skipped    | -            | Revert "feat: show connected providers in /connect dialog (#8351)"                                                                      |
| `32394b699`     | skipped    | -            | Revert "feat(tui): highlight esc label on hover in dialog (#12383)"                                                                     |
| `63cd76341`     | skipped    | -            | Revert "feat: add version to session header and /status dialog (#8802)"                                                                 |
| `4a73d51ac`     | integrated | -            | fix(app): workspace reset issues                                                                                                        |
| `83853cc5e`     | integrated | -            | fix(app): new session in workspace choosing wrong workspace                                                                             |
| `2bccfd746`     | integrated | -            | chore: fix some norwegian i18n issues (#12935)                                                                                          |
| `0732ab339`     | integrated | -            | fix: use absolute paths for sidebar session navigation (#12898)                                                                         |
| `87795384d`     | skipped    | -            | chore: fix typos and GitHub capitalization (#12852)                                                                                     |
| `19ad7ad80`     | integrated | -            | chore: fix test                                                                                                                         |
| `4c4e30cd7`     | skipped    | -            | fix(docs): locale translations                                                                                                          |
| `c607c01fb`     | integrated | -            | chore: fix e2e tests                                                                                                                    |
| `18b625711`     | skipped    | -            | chore: generate                                                                                                                         |
| `65c966928`     | integrated | -            | test(e2e): redo & undo test (#12974)                                                                                                    |
| `1e03a55ac`     | integrated | -            | fix(app): persist defensiveness (#12973)                                                                                                |
| `27fa9dc84`     | skipped    | -            | refactor: clean up dialog-model.tsx per code review (#12983)                                                                            |
| `6f5dfe125`     | integrated | -            | fix(app): use agent configured variant (#12993)                                                                                         |
| `3929f0b5b`     | integrated | -            | fix(app): terminal replay (#12991)                                                                                                      |
| `70c794e91`     | integrated | -            | fix(app): regressions                                                                                                                   |
| `2c5760742`     | skipped    | -            | chore: translator agent                                                                                                                 |
| `284b00ff2`     | integrated | -            | fix(app): don't dispose instance after reset workspace                                                                                  |
| `d1f5b9e91`     | integrated | -            | fix(app): memory leak with event fetch                                                                                                  |
| `659f15aa9`     | integrated | -            | fix(app): no changes in review pane                                                                                                     |
| `7d5be1556`     | integrated | -            | wip: zen                                                                                                                                |
| `d863a9cf4`     | integrated | -            | fix(app): global event default fetch                                                                                                    |
| `eb2587844`     | integrated | -            | zen: retry on 429                                                                                                                       |
| `a3aad9c9b`     | integrated | -            | fix(app): include basic auth                                                                                                            |
| `1e2f66441`     | integrated | -            | fix(app): back to platform fetch for now                                                                                                |
| `1d11a0adf`     | integrated | -            | release: v1.1.54                                                                                                                        |
| `8bdf6fa35`     | integrated | -            | fix: show helpful message when free usage limit is exceeded (#13005)                                                                    |
| `80220cebe`     | integrated | -            | fix(app): disable terminal transparency                                                                                                 |
| `fc37337a3`     | integrated | -            | fix(app): memory leak with platform fetch for events                                                                                    |
| `a0673256d`     | integrated | -            | core: increase test timeout to 30s to prevent failures during package installation                                                      |
| `fbc41475b`     | integrated | -            | release: v1.1.55                                                                                                                        |
| `fd5531316`     | skipped    | -            | fix(docs): locale translations                                                                                                          |
| `55119559b`     | integrated | -            | fix(app): don't scroll code search input                                                                                                |
| `4f6b92978`     | skipped    | -            | chore: generate                                                                                                                         |
| `92a77b72f`     | integrated | -            | fix(app): don't close sidebar on session change (#13013)                                                                                |
| `8c56571ef`     | integrated | -            | zen: log error                                                                                                                          |
| `dce4c05fa`     | integrated | -            | fix(desktop): open apps with executables on Windows (#13022)                                                                            |
| `21475a1df`     | skipped    | -            | fix(docs): invalid markdown                                                                                                             |
| `50f3e74d0`     | integrated | -            | fix(app): task tool rendering                                                                                                           |
| `1bbbd51d4`     | integrated | -            | release: v1.1.56                                                                                                                        |
| `66c2bb8f3`     | integrated | -            | chore: update website stats                                                                                                             |
| `3894c217c`     | integrated | -            | wip: zen                                                                                                                                |
| `50c705cd2`     | skipped    | -            | fix(docs): locale translations                                                                                                          |
| `3ea58bb79`     | integrated | -            | wip: zen                                                                                                                                |
| `7a3c775dc`     | integrated | -            | wip: zen                                                                                                                                |
| `0afa6e03a`     | integrated | -            | wip: zen                                                                                                                                |
| `39145b99e`     | integrated | -            | wip: zen                                                                                                                                |
| `24556331c`     | integrated | -            | wip: zen                                                                                                                                |
| `a90b62267`     | integrated | -            | Update VOUCHED list                                                                                                                     |
| `53ec15a56`     | ported     | -            | fix(tui): improve amazon-bedrock check to include container credentials (#13037)                                                        |
| `6e9cd576e`     | skipped    | -            | fix(tui): default session sidebar to auto (#13046)                                                                                      |
| `60bdb6e9b`     | skipped    | -            | tweak: /review prompt to look for behavior changes more explicitly (#13049)                                                             |
| `0fd6f365b`     | ported     | -            | fix(core): ensure compaction is more reliable, add reserve token buffer to ensure that input window has enough room to compact (#12924) |
| `c6ec2f47e`     | integrated | -            | chore: generate                                                                                                                         |
| `8c120f2fa`     | skipped    | -            | docs: remove 'Migrating to 1.0' documentation section (#13076)                                                                          |
| `22125d134`     | integrated | -            | wip: zen                                                                                                                                |
| `d98bd4bd5`     | ported     | -            | fix: add additional context overflow cases, remove overcorrecting ones (#13077)                                                         |
| `213a87234`     | integrated | -            | feat(desktop): add WSL backend mode (#12914)                                                                                            |
| `783888131`     | integrated | -            | fix(desktop): read wayland preference from store (#13081)                                                                               |
| `7e1247c42`     | integrated | -            | fix(desktop): server spawn resilience (#13028)                                                                                          |
| `b52399832`     | skipped    | -            | fix(docs): avoid footer language selector truncation (#13124)                                                                           |
| `567e094e6`     | skipped    | -            | docs(ko): improve translations for intro, cli, and commands (#13094)                                                                    |
| `5ba4c0e02`     | skipped    | -            | chore: generate                                                                                                                         |
| `cf7a1b8d8`     | integrated | -            | feat(desktop): enhance Windows app resolution and UI loading states (#13084)                                                            |
| `8bfd6fdba`     | integrated | -            | fix: encode non-ASCII directory paths in v1 SDK HTTP headers (#13131)                                                                   |
| `a25b2af05`     | integrated | -            | desktop: use tracing for logging (#13135)                                                                                               |
| `dd1862cc2`     | integrated | -            | fix(web): prevent language select label truncation (#13100)                                                                             |
| `c426cb0f1`     | integrated | -            | fix(app): copy path button styles                                                                                                       |
| `ef5ec5dc2`     | integrated | -            | fix(app): terminal copy/paste                                                                                                           |
| `edcfd562a`     | integrated | -            | release: v1.1.57                                                                                                                        |
| `93957da2c`     | skipped    | -            | fix(tui): prevent home wordmark corruption in height-constrained terminals (#13069)                                                     |
| `352a54c69`     | skipped    | -            | feat(prompt): mode-specific input placeholders (#12388)                                                                                 |
| `7a463cd19`     | skipped    | -            | fix(tui): keep /share available to copy existing link (#12532)                                                                          |
| `17bdb5d56`     | skipped    | -            | fix(tui): dismiss dialogs with ctrl+c (#12884)                                                                                          |
| `7222fc0ba`     | integrated | -            | fix(app): terminal resize                                                                                                               |
| `50330820c`     | integrated | -            | fix(console): translations                                                                                                              |
| `8c5ba8aeb`     | integrated | -            | fix(app): terminal PTY buffer carryover                                                                                                 |
| `a52fe2824`     | integrated | -            | fix(app): notifications on child sessions                                                                                               |
| `2e8082dd2`     | skipped    | -            | Revert "feat(desktop): add WSL backend mode (#12914)"                                                                                   |
| `4dc363f30`     | integrated | -            | release: v1.1.58                                                                                                                        |
| `4619e9d18`     | integrated | -            | fix(app): sidebar remount                                                                                                               |
| `fc88dde63`     | integrated | -            | test(app): more e2e tests (#13162)                                                                                                      |
| `eef3ae3e1`     | integrated | -            | Fix/reverception (#13166)                                                                                                               |
| `f252e3234`     | integrated | -            | fix(app): translations                                                                                                                  |
| `42bea5d29`     | integrated | -            | release: v1.1.59                                                                                                                        |
| `94cb6390a`     | integrated | -            | chore: generate                                                                                                                         |
