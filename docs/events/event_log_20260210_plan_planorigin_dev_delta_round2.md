# Refactor Plan: 2026-02-10 (origin/dev → cms, round2)

Date: 2026-02-10
Status: DONE

## Summary

- Upstream pending (`HEAD..origin/dev`): 19 commits
- Already processed by ledger (exclude): 7 commits
- New commits to decide this round: 12 commits
- Strategy: **Mixed** (manual review for protected TUI/provider paths, selective skip/integrate for docs/CI)

## Already Processed (from ledger, excluded)

| Commit      | Existing status | Note                              |
| ----------- | --------------- | --------------------------------- |
| `56a752092` | ported          | Homebrew upgrade fix              |
| `949f61075` | ported          | App Cmd+[/] keybind               |
| `056d0c119` | ported          | TUI queued sender color           |
| `832902c8e` | ported          | invalid model emits session.error |
| `3d6fb29f0` | ported          | desktop linux_display fix         |
| `9824370f8` | ported          | UI defensive update               |
| `19809e768` | ported          | app max width fix                 |

## Commit Triage (new 12)

| Commit                                                    | Risk   | Area                                                       | Proposed action                         | Reason                                                                       |
| --------------------------------------------------------- | ------ | ---------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| `63cd76341` Revert session header version/status dialog   | High   | `packages/opencode/src/cli/cmd/tui/**`                     | **Manual port OR skip (user decision)** | Protected TUI path; upstream is a revert and may conflict with cms custom UX |
| `32394b699` Revert esc hover highlight                    | High   | `packages/opencode/src/cli/cmd/tui/**`                     | **Manual port OR skip (user decision)** | Reverts behavior previously ported in cms (`683d234d8`)                      |
| `12262862c` Revert connected providers in /connect dialog | High   | `dialog-provider.tsx`                                      | **Manual review first (user decision)** | Affects provider presentation; cms has provider split/custom account model   |
| `31f893f8c` ci: sort beta PRs                             | Medium | `script/beta.ts`                                           | integrate (cherry-pick likely clean)    | tooling-only script, low runtime risk                                        |
| `439e7ec1f` Update VOUCHED list                           | Low    | `.github/`                                                 | skip                                    | repo policy/docs only                                                        |
| `20cf3fc67` ci recap + vouch auth                         | Low    | `.github/workflows/**`                                     | skip                                    | CI workflow only                                                             |
| `705200e19` chore: generate                               | Low    | `packages/web/docs`                                        | skip (unless web docs sync needed)      | generated docs translations                                                  |
| `85fa8abd5` fix(docs): translations                       | Low    | `packages/web/docs`                                        | skip (unless web docs sync needed)      | docs locale updates                                                          |
| `3118cab2d` vouch/trust management                        | Low    | `.github/**`, `CONTRIBUTING.md`                            | skip                                    | governance/workflow; not cms runtime                                         |
| `371e106fa` chore: cleanup                                | Low    | `packages/app/src/components/session/session-new-view.tsx` | skip                                    | already superseded by `19809e768` ported in ledger                           |
| `389afef33` chore: generate                               | Low    | `packages/web/docs`                                        | skip (unless web docs sync needed)      | generated docs                                                               |
| `274bb948e` fix(docs): locale markdown issues             | Low    | `packages/web/docs`                                        | skip (unless web docs sync needed)      | docs formatting only                                                         |

## High-risk Reverts: 邏輯本質與 CMS 價值評估

1. `63cd76341`（移除 TUI header/status 版本字樣）
   - 本質：**UI 資訊密度調整**（移除 `v{Installation.VERSION}` 顯示）。
   - 現況：cms 目前在 header/status/sidebar/home 都有版本曝光，對 debug 與 issue 回報有實務價值。
   - CMS 價值判斷：**保留版本顯示較有價值**，建議 `skip` upstream revert。

2. `32394b699`（移除 dialog ESC hover highlight）
   - 本質：**交互視覺回退**（刪除 hover 高亮，回到純文字 `esc`）。
   - 現況：cms 已 port 該 UX，且與目前互動風格一致，不涉及 provider/account/rotation 核心邏輯。
   - CMS 價值判斷：偏 UX 偏好，不影響核心；建議 **預設 skip**，除非你想對齊 upstream 極簡視覺。

3. `12262862c`（移除 /connect 已連線 provider 提示）
   - 本質：**資訊揭露回退**（刪除 `provider_next.connected` 與 `Connected` footer）。
   - 現況：cms 有多 provider/多帳號與 provider split；在 connect dialog 顯示「已連線」可降低重複綁定與操作成本。
   - CMS 價值判斷：對 cms 的多帳號情境是正向訊號，建議 **skip revert**，保留 connected 提示。

> 綜合建議：三個 high-risk revert 先全部標記 `skipped`，維持 cms 現行 UX 與可觀測性。

## Execution Queue (after approval)

1. [x] High-risk decision gate (`63cd76341`, `32394b699`, `12262862c`)：結論皆為 skip（保留 cms 現有 UX 與可觀測性）。
2. [x] Integrated `31f893f8c` semantic change by manual port to `scripts/beta.ts`（同等行為：PR number 排序）。
3. [x] Record outcomes into `docs/events/refactor_processed_commits_20260210.md`.

## Verification Matrix

- If any TUI/provider commit is applied:
  - Run focused tests for `packages/opencode` TUI/session/provider paths.
- If only tooling/docs changes are applied:
  - Run `bun run lint` + targeted typecheck for touched package(s).
- Before finish:
  - `bun turbo typecheck`

## Rollback Plan

- Each applied commit uses isolated local commit(s).
- On regression, revert only the last applied batch commit.
