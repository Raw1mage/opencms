# Refactor Processed Commit Ledger (2026-02-10)

用途：記錄已從 `origin/dev` 處理過的 commit，供下次比對時直接忽略。

## Status 定義

- `ported`: 已手動移植（可能非逐字 cherry-pick）
- `integrated`: 已整合（通常為多個 upstream commit 合併進單一本地 commit）
- `skipped`: 明確跳過（不適用 cms）

## 已處理（本輪）

| Upstream Commit | Status     | Local Commit | Note                                         |
| --------------- | ---------- | ------------ | -------------------------------------------- |
| `7249b87bf`     | integrated | `8a9bda3c8`  | Skill URL discovery RFC                      |
| `266de27a0`     | integrated | `8a9bda3c8`  | Skill discovery 基礎邏輯                     |
| `c35bd3982`     | integrated | `8a9bda3c8`  | Skill 下載/載入流程整合                      |
| `17e62b050`     | integrated | `8a9bda3c8`  | `.agents/skills` 掃描                        |
| `397532962`     | integrated | `8a9bda3c8`  | Skill prompting/permissions 關聯整合         |
| `a68fedd4a`     | integrated | `8a9bda3c8`  | Skill 目錄白名單調整                         |
| `f15755684`     | ported     | `7cb0ad2b9`  | variant scope to model                       |
| `a25cd2da7`     | ported     | `a5017be00`  | gpt-5 reasoning summary / small options 路徑 |
| `b942e0b4d`     | ported     | `a5017be00`  | Bedrock double-prefix 修復                   |
| `ca5e85d6e`     | ported     | `a5017be00`  | Anthropic on Bedrock prompt caching          |
| `d1d744749`     | ported     | `a5017be00`  | provider transform / model switch 兼容修復   |
| `43354eeab`     | ported     | `a5017be00`  | Copilot system message/string 兼容           |
| `3741516fe`     | ported     | `a5017be00`  | Gemini nested array schema 修復              |
| `3adeed8f9`     | ported     | `a5017be00`  | non-object schema strip properties           |
| `39a504773`     | ported     | `a5017be00`  | provider headers from config                 |
| `0c32afbc3`     | ported     | `a5017be00`  | snake_case `budget_tokens`                   |
| `bd9d7b322`     | ported     | `a5017be00`  | session title generation smallOptions        |
| `683d234d8`     | ported     | `350b3a02a`  | dialog esc hover highlight                   |
| `449c5b44b`     | ported     | `350b3a02a`  | restore footer in session view               |
| `40ebc3490`     | ported     | `350b3a02a`  | running spinner for bash tool                |

## 已確認跳過

| Upstream Commit | Status  | Reason                                 |
| --------------- | ------- | -------------------------------------- |
| `d52ee41b3`     | skipped | `nix/hashes.json`，非 cms 核心執行路徑 |

## 下次比對建議流程

1. 先讀本檔，建立忽略清單（`processed + skipped`）。
2. 比對 `origin/dev` 新增 commit 時，排除清單中的 hash。
3. 若遇到「語義已處理但 hash 不同」情況，在本檔追加一行 mapping。

---

最後更新：2026-02-10
