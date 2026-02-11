# Refactor Plan: 2026-02-11 (origin/dev → HEAD, origin_dev_delta_20260211)

Date: 2026-02-11
Status: WAITING_APPROVAL

## Summary

- Upstream pending (raw): 75 commits
- Excluded by processed ledger: 30 commits
- Commits for this round: 45 commits

## Actions

| Commit | Logical Type | Value Score | Risk | Decision | Notes |
| :----- | :----------- | :---------- | :--- | :------- | :---- |
| `27fa9dc84` | ux | 0/0/0/-1=-1 | high | skipped | refactor: clean up dialog-model.tsx per code review (#12983) |
| `6f5dfe125` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): use agent configured variant (#12993) |
| `3929f0b5b` | behavioral-fix | 1/1/0/0=2 | medium | integrated | fix(app): terminal replay (#12991) |
| `70c794e91` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): regressions |
| `2c5760742` | docs | -1/-1/-1/1=-2 | low | skipped | chore: translator agent |
| `284b00ff2` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): don't dispose instance after reset workspace |
| `d1f5b9e91` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): memory leak with event fetch |
| `659f15aa9` | behavioral-fix | 1/1/0/0=2 | medium | integrated | fix(app): no changes in review pane |
| `7d5be1556` | feature | 1/0/0/1=2 | low | integrated | wip: zen |
| `d863a9cf4` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): global event default fetch |
| `eb2587844` | feature | 1/0/0/1=2 | low | integrated | zen: retry on 429 |
| `a3aad9c9b` | protocol | 1/0/0/1=2 | low | integrated | fix(app): include basic auth |
| `1e2f66441` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): back to platform fetch for now |
| `1d11a0adf` | feature | 1/0/0/1=2 | low | integrated | release: v1.1.54 |
| `8bdf6fa35` | behavioral-fix | 1/1/0/0=2 | medium | integrated | fix: show helpful message when free usage limit is exceeded (#13005) |
| `80220cebe` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): disable terminal transparency |
| `fc37337a3` | behavioral-fix | 1/1/0/0=2 | medium | integrated | fix(app): memory leak with platform fetch for events |
| `a0673256d` | feature | 1/0/0/1=2 | low | integrated | core: increase test timeout to 30s to prevent failures during package installation |
| `fbc41475b` | feature | 1/0/0/1=2 | low | integrated | release: v1.1.55 |
| `fd5531316` | docs | -1/-1/-1/1=-2 | low | skipped | fix(docs): locale translations |
| `55119559b` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): don't scroll code search input |
| `4f6b92978` | docs | -1/-1/-1/1=-2 | low | skipped | chore: generate |
| `92a77b72f` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): don't close sidebar on session change (#13013) |
| `8c56571ef` | feature | 1/0/0/1=2 | low | integrated | zen: log error |
| `dce4c05fa` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(desktop): open apps with executables on Windows (#13022) |
| `21475a1df` | docs | -1/-1/-1/1=-2 | low | skipped | fix(docs): invalid markdown |
| `50f3e74d0` | behavioral-fix | 1/1/0/1=3 | low | integrated | fix(app): task tool rendering |
| `1bbbd51d4` | feature | 1/0/0/1=2 | low | integrated | release: v1.1.56 |
| `66c2bb8f3` | infra | 1/0/0/1=2 | low | integrated | chore: update website stats |
| `3894c217c` | feature | 1/0/0/1=2 | low | integrated | wip: zen |
| `50c705cd2` | docs | -1/-1/-1/1=-2 | low | skipped | fix(docs): locale translations |
| `3ea58bb79` | feature | 1/0/0/1=2 | low | integrated | wip: zen |
| `7a3c775dc` | feature | 1/0/0/1=2 | low | integrated | wip: zen |
| `0afa6e03a` | feature | 1/0/0/1=2 | low | integrated | wip: zen |
| `39145b99e` | feature | 1/0/0/1=2 | low | integrated | wip: zen |
| `24556331c` | feature | 1/0/0/1=2 | low | integrated | wip: zen |
| `a90b62267` | infra | 1/0/0/1=2 | low | integrated | Update VOUCHED list |
| `53ec15a56` | behavioral-fix | 0/1/0/-1=0 | high | ported | fix(tui): improve amazon-bedrock check to include container credentials (#13037) |
| `6e9cd576e` | ux | 0/0/0/-1=-1 | high | skipped | fix(tui): default session sidebar to auto (#13046) |
| `60bdb6e9b` | feature | 1/0/0/0=1 | medium | skipped | tweak: /review prompt to look for behavior changes more explicitly (#13049) |
| `0fd6f365b` | behavioral-fix | 0/1/0/-1=0 | high | ported | fix(core): ensure compaction is more reliable, add reserve token buffer to ensure that input window has enough room to compact (#12924) |
| `c6ec2f47e` | infra | 1/0/0/1=2 | low | integrated | chore: generate |
| `8c120f2fa` | docs | 1/-1/-1/1=0 | low | skipped | docs: remove 'Migrating to 1.0' documentation section (#13076) |
| `22125d134` | feature | 1/0/0/1=2 | low | integrated | wip: zen |
| `d98bd4bd5` | behavioral-fix | 0/1/0/-1=0 | high | ported | fix: add additional context overflow cases, remove overcorrecting ones (#13077) |

## Execution Queue

1. [ ] Confirm high-risk items (ported vs skipped).
2. [ ] Integrate low/medium-risk high-value items.
3. [ ] Update ledger with final status mapping.

## Mapping to Ledger

| Upstream Commit | Status | Local Commit | Note |
| :-------------- | :----- | :----------- | :--- |
| `27fa9dc84` | skipped | - | refactor: clean up dialog-model.tsx per code review (#12983) |
| `6f5dfe125` | integrated | - | fix(app): use agent configured variant (#12993) |
| `3929f0b5b` | integrated | - | fix(app): terminal replay (#12991) |
| `70c794e91` | integrated | - | fix(app): regressions |
| `2c5760742` | skipped | - | chore: translator agent |
| `284b00ff2` | integrated | - | fix(app): don't dispose instance after reset workspace |
| `d1f5b9e91` | integrated | - | fix(app): memory leak with event fetch |
| `659f15aa9` | integrated | - | fix(app): no changes in review pane |
| `7d5be1556` | integrated | - | wip: zen |
| `d863a9cf4` | integrated | - | fix(app): global event default fetch |
| `eb2587844` | integrated | - | zen: retry on 429 |
| `a3aad9c9b` | integrated | - | fix(app): include basic auth |
| `1e2f66441` | integrated | - | fix(app): back to platform fetch for now |
| `1d11a0adf` | integrated | - | release: v1.1.54 |
| `8bdf6fa35` | integrated | - | fix: show helpful message when free usage limit is exceeded (#13005) |
| `80220cebe` | integrated | - | fix(app): disable terminal transparency |
| `fc37337a3` | integrated | - | fix(app): memory leak with platform fetch for events |
| `a0673256d` | integrated | - | core: increase test timeout to 30s to prevent failures during package installation |
| `fbc41475b` | integrated | - | release: v1.1.55 |
| `fd5531316` | skipped | - | fix(docs): locale translations |
| `55119559b` | integrated | - | fix(app): don't scroll code search input |
| `4f6b92978` | skipped | - | chore: generate |
| `92a77b72f` | integrated | - | fix(app): don't close sidebar on session change (#13013) |
| `8c56571ef` | integrated | - | zen: log error |
| `dce4c05fa` | integrated | - | fix(desktop): open apps with executables on Windows (#13022) |
| `21475a1df` | skipped | - | fix(docs): invalid markdown |
| `50f3e74d0` | integrated | - | fix(app): task tool rendering |
| `1bbbd51d4` | integrated | - | release: v1.1.56 |
| `66c2bb8f3` | integrated | - | chore: update website stats |
| `3894c217c` | integrated | - | wip: zen |
| `50c705cd2` | skipped | - | fix(docs): locale translations |
| `3ea58bb79` | integrated | - | wip: zen |
| `7a3c775dc` | integrated | - | wip: zen |
| `0afa6e03a` | integrated | - | wip: zen |
| `39145b99e` | integrated | - | wip: zen |
| `24556331c` | integrated | - | wip: zen |
| `a90b62267` | integrated | - | Update VOUCHED list |
| `53ec15a56` | ported | - | fix(tui): improve amazon-bedrock check to include container credentials (#13037) |
| `6e9cd576e` | skipped | - | fix(tui): default session sidebar to auto (#13046) |
| `60bdb6e9b` | skipped | - | tweak: /review prompt to look for behavior changes more explicitly (#13049) |
| `0fd6f365b` | ported | - | fix(core): ensure compaction is more reliable, add reserve token buffer to ensure that input window has enough room to compact (#12924) |
| `c6ec2f47e` | integrated | - | chore: generate |
| `8c120f2fa` | skipped | - | docs: remove 'Migrating to 1.0' documentation section (#13076) |
| `22125d134` | integrated | - | wip: zen |
| `d98bd4bd5` | ported | - | fix: add additional context overflow cases, remove overcorrecting ones (#13077) |
