# Refactor Processed Commit Ledger (2026-02-10)

用途：記錄已從 `origin/dev` 處理過的 commit，供下次比對時直接忽略。

## Status 定義

- `ported`: 已手動移植（可能非逐字 cherry-pick）
- `integrated`: 已整合（通常為多個 upstream commit 合併進單一本地 commit）
- `skipped`: 明確跳過（不適用 cms）

## 已處理（本輪）

| Upstream Commit | Status     | Local Commit | Note                                              |
| --------------- | ---------- | ------------ | ------------------------------------------------- |
| `7249b87bf`     | integrated | `8a9bda3c8`  | Skill URL discovery RFC                           |
| `266de27a0`     | integrated | `8a9bda3c8`  | Skill discovery 基礎邏輯                          |
| `c35bd3982`     | integrated | `8a9bda3c8`  | Skill 下載/載入流程整合                           |
| `17e62b050`     | integrated | `8a9bda3c8`  | `.agents/skills` 掃描                             |
| `397532962`     | integrated | `8a9bda3c8`  | Skill prompting/permissions 關聯整合              |
| `a68fedd4a`     | integrated | `8a9bda3c8`  | Skill 目錄白名單調整                              |
| `f15755684`     | ported     | `7cb0ad2b9`  | variant scope to model                            |
| `a25cd2da7`     | ported     | `a5017be00`  | gpt-5 reasoning summary / small options 路徑      |
| `b942e0b4d`     | ported     | `a5017be00`  | Bedrock double-prefix 修復                        |
| `ca5e85d6e`     | ported     | `a5017be00`  | Anthropic on Bedrock prompt caching               |
| `d1d744749`     | ported     | `a5017be00`  | provider transform / model switch 兼容修復        |
| `43354eeab`     | ported     | `a5017be00`  | Copilot system message/string 兼容                |
| `3741516fe`     | ported     | `a5017be00`  | Gemini nested array schema 修復                   |
| `3adeed8f9`     | ported     | `a5017be00`  | non-object schema strip properties                |
| `39a504773`     | ported     | `a5017be00`  | provider headers from config                      |
| `0c32afbc3`     | ported     | `a5017be00`  | snake_case `budget_tokens`                        |
| `bd9d7b322`     | ported     | `a5017be00`  | session title generation smallOptions             |
| `683d234d8`     | ported     | `350b3a02a`  | dialog esc hover highlight                        |
| `449c5b44b`     | ported     | `350b3a02a`  | restore footer in session view                    |
| `40ebc3490`     | ported     | `350b3a02a`  | running spinner for bash tool                     |
| `56b340b5d`     | ported     | `a0f4faf89`  | ACP file write creates file when missing          |
| `56a752092`     | ported     | `cca0efac2`  | Homebrew upgrade fix（保留 cms 禁用 autoupgrade） |
| `949f61075`     | ported     | `cf167cf14`  | App 新增 Cmd+[/] session history keybind          |
| `056d0c119`     | ported     | `db764b3f5`  | TUI queued message 使用 sender color              |
| `832902c8e`     | ported     | `1a41c453d`  | invalid model 選擇時發布 session.error            |
| `3d6fb29f0`     | ported     | `ca43e4ac9`  | desktop linux_display module 修復                 |
| `9824370f8`     | ported     | `194cab290`  | UI session-turn 防禦性處理                        |
| `19809e768`     | ported     | `22769ed59`  | app max width 版面修復                            |

## 已整批同步（透過 merge origin/dev）

以下 tail commits 已在 `d276822c0` 合併進 `cms`：

- `7bca3fbf1` (web docs generate)
- `e5ec2f999` (nix hashes)
- `110f6804f` (nix hashes)
- `a84bdd7cd` (app workspace fix)
- `83708c295` (console cleanup)
- `39c5da440` (docs links)
- `ba740eaef` (console locale routing)
- `3dc720ff9` (web locale routing)
- `d9b4535d6` (acp generate)

## 已確認跳過

| Upstream Commit | Status  | Reason                                          |
| --------------- | ------- | ----------------------------------------------- |
| `d52ee41b3`     | skipped | `nix/hashes.json`，非 cms 核心執行路徑          |
| `371e106fa`     | skipped | cleanup 與後續 `19809e768` 同區域，已由後者覆蓋 |

## 已處理（round2: origin/dev delta）

| Upstream Commit | Status     | Local Commit | Note                                               |
| --------------- | ---------- | ------------ | -------------------------------------------------- |
| `63cd76341`     | skipped    | -            | Revert 版本字樣；cms 保留 TUI 版本可觀測性         |
| `32394b699`     | skipped    | -            | Revert ESC hover；cms 保留既有互動樣式             |
| `12262862c`     | skipped    | -            | Revert connected providers；cms 多帳號情境保留提示 |
| `31f893f8c`     | integrated | `17fdf9329`  | 手動移植語義到 `scripts/beta.ts`（PR number 排序） |
| `439e7ec1f`     | skipped    | -            | `.github/VOUCHED.td` 治理檔，非 runtime            |
| `20cf3fc67`     | skipped    | -            | `.github/workflows` CI 調整，非 cms runtime        |
| `705200e19`     | skipped    | -            | `packages/web` docs generated                      |
| `85fa8abd5`     | skipped    | -            | `packages/web` docs translations                   |
| `3118cab2d`     | skipped    | -            | vouch/trust 管理流程，非 cms runtime               |
| `371e106fa`     | skipped    | -            | app cleanup 已被已移植修復覆蓋                     |
| `389afef33`     | skipped    | -            | `packages/web` docs generated                      |
| `274bb948e`     | skipped    | -            | locale markdown docs 修正                          |

## 下次比對建議流程

1. 先讀本檔，建立忽略清單（`processed + skipped`）。
2. 比對 `origin/dev` 新增 commit 時，排除清單中的 hash。
3. 若遇到「語義已處理但 hash 不同」情況，在本檔追加一行 mapping。

---

最後更新：2026-02-10

## 已處理（Round 3 - origin/dev delta (2026-02-10) @ 2026-02-10T14:42:02.716Z）

| Upstream Commit | Status | Local Commit | Note |
| --------------- | ------ | ------------ | ---- |
| `4a73d51acd6cc2610fa962a424a6d7049520f560` | integrated | - | fix(app): workspace reset issues - behavioral-fix, medium risk, score 2 |
| `83853cc5e6f5b3d262403692f96e370661312aaf` | integrated | - | fix(app): new session in workspace choosing wrong workspace - behavioral-fix, low risk, score 3 |
| `2bccfd7462ea75be5c5c98a21d7dfaf518e7611d` | integrated | - | chore: fix norwegian i18n issues - infra, low risk, score 2 |
| `0732ab3393f8870ac582db1e07e3e21843c22659` | integrated | - | fix: absolute paths for sidebar session navigation - behavioral-fix, low risk, score 3 |
| `87795384de062abad50f86775e4803e4a23d51fc` | skipped | - | chore: fix typos and GitHub capitalization - touches protected prompt files, medium risk, score 1 |
| `19ad7ad80916836560ce9903b58a02be63ea4715` | integrated | - | chore: fix test - infra, low risk, score 2 |
| `4c4e30cd714d316f44d99b91f846e2be666a26db` | skipped | - | fix(docs): locale translations - docs only, low value for cms branch, score -2 |
| `c607c01fb9acc72d2d041fb6eb9d4dff0f49814f` | integrated | - | chore: fix e2e tests - infra, low risk, score 2 |
| `18b6257119b8abe27d9c76369b69dbfc4d6e028b` | skipped | - | chore: generate - auto-generated docs, low value for cms branch, score -2 |
| `65c966928393a2a7b03af267e8d3279d3370440c` | integrated | - | test(e2e): redo & undo test - feature test, low risk, score 2 |
| `1e03a55acdb1e80b747d0604d698f4cbef97ace1` | integrated | - | fix(app): persist defensiveness - behavioral-fix, low risk, score 3 |
