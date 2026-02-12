# Refactor Plan: 2026-02-12 (origin/dev → HEAD, claude_code_submodule_sync_20260212)

Date: 2026-02-12
Status: DONE

## Summary

- Upstream pending (raw): 31 commits
- Excluded by processed ledger: 0 commits
- Commits for this round: 31 commits

## Actions

| Commit      | Logical Type   | Value Score   | Risk   | Decision   | Notes                                                                                                                         |
| :---------- | :------------- | :------------ | :----- | :--------- | :---------------------------------------------------------------------------------------------------------------------------- |
| `81b5a6a08` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app):workspace reset (#13170)                                                                                             |
| `8f56ed5b8` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                               |
| `fbabce112` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): translations                                                                                                        |
| `6b30e0b75` | docs           | 1/-1/-1/1=0   | low    | skipped    | chore: update docs sync workflow                                                                                              |
| `e3471526f` | feature        | 1/0/0/1=2     | low    | integrated | add square logo variants to brand page                                                                                        |
| `6b4d617df` | feature        | 1/0/0/0=1     | medium | skipped    | feat: adjust read tool so that it can handle dirs too (#13090)                                                                |
| `006d673ed` | feature        | 1/0/0/0=1     | medium | skipped    | tweak: make read tool offset 1 indexed instead of 0 to avoid confusion that could be caused by line #s being 1 based (#13198) |
| `e2a33f75e` | infra          | 1/0/0/1=2     | low    | integrated | Update VOUCHED list                                                                                                           |
| `8c7b35ad0` | feature        | 1/0/0/0=1     | medium | skipped    | tweak: compaction check (#13214)                                                                                              |
| `125727d09` | feature        | 1/0/0/1=2     | low    | integrated | upgrade opentui to 0.1.79 (#13036)                                                                                            |
| `264dd213f` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                         |
| `c856f875a` | infra          | 1/0/0/1=2     | low    | integrated | chore: upgrade bun to 1.3.9 (#13223)                                                                                          |
| `8577eb8ec` | infra          | 1/0/0/1=2     | low    | integrated | chore: update nix node_modules hashes                                                                                         |
| `3befd0c6c` | feature        | 1/0/0/0=1     | medium | skipped    | tweak: use promise all for mcp listTools calls (#13229)                                                                       |
| `8eea53a41` | docs           | -1/-1/-1/1=-2 | low    | skipped    | docs(ar): second-pass localization cleanup                                                                                    |
| `aea68c386` | docs           | -1/-1/-1/1=-2 | low    | skipped    | fix(docs): locale translations for nav elements and headings                                                                  |
| `81ca2df6a` | behavioral-fix | 1/1/0/1=3     | low    | integrated | fix(app): guard randomUUID in insecure browser contexts (#13237)                                                              |
| `bf5a01edd` | feature        | 0/0/0/-1=-1   | high   | skipped    | feat(opencode): Venice Add automatic variant generation for Venice models (#12106)                                            |
| `135f8ffb2` | ux             | 0/0/0/-1=-1   | high   | skipped    | feat(tui): add toggle to hide session header (#13244)                                                                         |
| `5bdf1c4b9` | infra          | 1/0/0/1=2     | low    | integrated | Update VOUCHED list                                                                                                           |
| `ad2087094` | feature        | 0/0/0/-1=-1   | high   | skipped    | support custom api url per model                                                                                              |
| `66780195d` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                               |
| `e269788a8` | feature        | 0/0/0/-1=-1   | high   | skipped    | feat: support claude agent SDK-style structured outputs in the OpenCode SDK (#8161)                                           |
| `f6e7aefa7` | infra          | 1/0/0/1=2     | low    | integrated | chore: generate                                                                                                               |
| `8f9742d98` | ux             | 0/0/0/-1=-1   | high   | skipped    | fix(win32): use ffi to get around bun raw input/ctrl+c issues (#13052)                                                        |
| `03de51bd3` | feature        | 1/0/0/1=2     | low    | integrated | release: v1.1.60                                                                                                              |
| `d86f24b6b` | feature        | 1/0/0/1=2     | low    | integrated | zen: return cost                                                                                                              |
| `624dd94b5` | feature        | 1/0/0/0=1     | medium | skipped    | tweak: tool outputs to be more llm friendly (#13269)                                                                          |
| `1413d77b1` | feature        | 1/0/0/1=2     | low    | integrated | desktop: sqlite migration progress bar (#13294)                                                                               |
| `0eaeb4588` | feature        | 1/0/0/1=2     | low    | integrated | Testing SignPath Integration (#13308)                                                                                         |
| `fa97475ee` | infra          | 1/0/0/1=2     | low    | integrated | ci: move test-sigining policy                                                                                                 |

## Execution Queue

1. [ ] Confirm high-risk items (ported vs skipped).
2. [ ] Integrate low/medium-risk high-value items.
3. [ ] Update ledger with final status mapping.

## Mapping to Ledger

| Upstream Commit | Status     | Local Commit | Note                                                                                                                          |
| :-------------- | :--------- | :----------- | :---------------------------------------------------------------------------------------------------------------------------- |
| `81b5a6a08`     | integrated | -            | fix(app):workspace reset (#13170)                                                                                             |
| `8f56ed5b8`     | integrated | -            | chore: generate                                                                                                               |
| `fbabce112`     | integrated | -            | fix(app): translations                                                                                                        |
| `6b30e0b75`     | skipped    | -            | chore: update docs sync workflow                                                                                              |
| `e3471526f`     | integrated | -            | add square logo variants to brand page                                                                                        |
| `6b4d617df`     | skipped    | -            | feat: adjust read tool so that it can handle dirs too (#13090)                                                                |
| `006d673ed`     | skipped    | -            | tweak: make read tool offset 1 indexed instead of 0 to avoid confusion that could be caused by line #s being 1 based (#13198) |
| `e2a33f75e`     | integrated | -            | Update VOUCHED list                                                                                                           |
| `8c7b35ad0`     | skipped    | -            | tweak: compaction check (#13214)                                                                                              |
| `125727d09`     | integrated | -            | upgrade opentui to 0.1.79 (#13036)                                                                                            |
| `264dd213f`     | integrated | -            | chore: update nix node_modules hashes                                                                                         |
| `c856f875a`     | integrated | -            | chore: upgrade bun to 1.3.9 (#13223)                                                                                          |
| `8577eb8ec`     | integrated | -            | chore: update nix node_modules hashes                                                                                         |
| `3befd0c6c`     | skipped    | -            | tweak: use promise all for mcp listTools calls (#13229)                                                                       |
| `8eea53a41`     | skipped    | -            | docs(ar): second-pass localization cleanup                                                                                    |
| `aea68c386`     | skipped    | -            | fix(docs): locale translations for nav elements and headings                                                                  |
| `81ca2df6a`     | integrated | -            | fix(app): guard randomUUID in insecure browser contexts (#13237)                                                              |
| `bf5a01edd`     | skipped    | -            | feat(opencode): Venice Add automatic variant generation for Venice models (#12106)                                            |
| `135f8ffb2`     | skipped    | -            | feat(tui): add toggle to hide session header (#13244)                                                                         |
| `5bdf1c4b9`     | integrated | -            | Update VOUCHED list                                                                                                           |
| `ad2087094`     | skipped    | -            | support custom api url per model                                                                                              |
| `66780195d`     | integrated | -            | chore: generate                                                                                                               |
| `e269788a8`     | skipped    | -            | feat: support claude agent SDK-style structured outputs in the OpenCode SDK (#8161)                                           |
| `f6e7aefa7`     | integrated | -            | chore: generate                                                                                                               |
| `8f9742d98`     | skipped    | -            | fix(win32): use ffi to get around bun raw input/ctrl+c issues (#13052)                                                        |
| `03de51bd3`     | integrated | -            | release: v1.1.60                                                                                                              |
| `d86f24b6b`     | integrated | -            | zen: return cost                                                                                                              |
| `624dd94b5`     | skipped    | -            | tweak: tool outputs to be more llm friendly (#13269)                                                                          |
| `1413d77b1`     | integrated | -            | desktop: sqlite migration progress bar (#13294)                                                                               |
| `0eaeb4588`     | integrated | -            | Testing SignPath Integration (#13308)                                                                                         |
| `fa97475ee`     | integrated | -            | ci: move test-sigining policy                                                                                                 |
