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

## 下次比對建議流程

1. 先讀本檔，建立忽略清單（`processed + skipped`）。
2. 比對 `origin/dev` 新增 commit 時，排除清單中的 hash。
3. 若遇到「語義已處理但 hash 不同」情況，在本檔追加一行 mapping。

---

最後更新：2026-02-10
