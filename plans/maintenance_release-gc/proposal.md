# Proposal: maintenance/release-gc

## Why

- 預定 release 前夕，repo 累積多輪重構/branding 變更/superseded feature 殘留物。
- 死碼會增加 Claude / opencode runtime 的 context tax、誤導未來 maintainer、放大 bug surface。
- 「做夢模式」慢掃 + 分類清單 + 可逆 commit 切片，比一次性大清理更安全也更有效率。
- 此 plan 作為 Phase 0 (分類盤點) 與 Phase 1+ (分類執行) 的單一追蹤點，每個分類各自 atomic revertible。

## Original Requirement Wording (Baseline)

- "在release前夕我想對opencms整個repo做一個garbage collection。應該有不少dead code可以收一收"
- "用做夢模式慢慢掃。先建立清理分類清單，再以可追溯可逆方式執行"

## Requirement Revision History

- 2026-05-12: initial draft created via plan-init.ts
- 2026-05-12: 填入分類清單草案 (C1-C7) + 執行契約

## Effective Requirement Description

1. **Phase 0 — 分類盤點**：以做夢模式（slow scan，不急著動 code）逐類掃描 repo，產出 evidence 清單，登記到 tasks.md 對應分類底下；每個 evidence 至少含 `path:line` 或 symbol 名稱。
2. **Phase 1+ — 分類執行**：以分類為單位執行刪除/重構，每個分類獨立 commit，commit message 含 `chore(gc/<cN>): ...` 與還原指令；驗證步驟（typecheck / test / build）跑完才進下一類。
3. **可追溯**：每個 commit 附上其對應 evidence 出處（spec 內的 tasks.md 行號 + spec_record_event）。
4. **可逆**：每個分類為 atomic revert 單位；不跨分類混 commit；submodule 異動單獨 commit (per feedback_submodule_always_commit)。

## Scope

### IN

- opencode primary repo (`/home/pkcs12/projects/opencode`)
- packages/* 內所有 TS/JS source、admin webapp、TUI、CLI
- 根目錄 config / scripts / docs（限「明顯已死」的內容）
- package.json `dependencies` / `devDependencies` 中未使用條目

### OUT

- opencode-beta worktree（單獨 release cadence）
- 任何活躍的 plan/spec 目錄（/plans/, /specs/）—— 文件即使「未被 code 引用」也屬 KB 資產
- runtime data (`~/.config/opencode/`, `~/.local/share/opencode/`)
- 第三方 submodule 內部（refs/*）—— 只動 pointer，不動 submodule 內容
- 任何需要 design-level 決策的重構（例：provider refactor、planner skill 完整淘汰）→ 另開 plan

## Non-Goals

- 不做行為變更（行為一致是 release 前提）
- 不調整公開 API / CLI 介面
- 不做 rebrand 全量替換（opencms 遷移有獨立 plan）
- 不做 lint/format 全 repo sweep（noise too high；視需要單獨 PR）

## Constraints

- 每個分類執行前必須通過 typecheck + 既有 test suite；失敗時 revert 該分類 commit。
- 任何「看起來像死、實際是 lazy load / dynamic import / 跨 package consumer」的疑似 false positive，必須在 evidence 欄位標記 `SUSPECT` 並保留人工 review。
- knip / ts-prune 設定檔需把所有 entry points 列齊（packages/opencode CLI、TUI、admin webapp、plugin loader、MCP servers）以避免誤判。
- 不可使用 `git add -A` / `git add .`（per default policy）；逐檔加。
- 不可 `--no-verify`、不可 force push。

## What Changes

- 新增 `knip.json` 或 `knip.jsonc`（若 repo 還沒有），列齊 entrypoints
- 移除 Phase 0 盤點確認的死碼 / 未用 deps / superseded feature 殘留
- 更新 spec 內 events/ 留執行紀錄

## Capabilities

### New Capabilities

- 一份 repo-level dead code 盤點清單（tasks.md 內），release 後可作為下一輪 GC 基線

### Modified Capabilities

- 無行為變更

## Impact

- bundle size / install size 預期下降
- `bunx knip` / `ts-prune` 之後可作為 CI gate 候選
- 部分歷史 MEMORY 條目可降級為 archived（superseded feature 已實際移除）

## Categories (cleanup taxonomy — Phase 0 grid)

每個分類在 tasks.md 內有對應 `## Cn …` 區塊，盤點時把 evidence 寫到對應分類下。

| ID | 名稱 | 風險 | 工具 | 預期規模 |
|---|---|---|---|---|
| C1 | 機械死碼（未用 export / unreachable） | 低 | knip / ts-prune | 大 |
| C2 | 未使用 dependencies | 低 | knip --dependencies / depcheck | 中 |
| C3 | Superseded features（per MEMORY） | 中 | 人工 grep + memory cross-ref | 中 |
| C4 | Commented-out blocks / `// removed` 殘留 | 低 | grep `// removed`、大區塊註解 | 小-中 |
| C5 | Rebrand opencode→opencms 雙寫殘骸 | 中 | grep `OpenCode` user-facing strings | 中 |
| C6 | Legacy `~/.local/share/opencode/` migration code | 中 | grep `Global.Path.data` legacy 分支 | 小 |
| C7 | Deprecated planner skill 殘留 (`plan-init.ts` etc.) | 高 | 確認 /plans/ 為空 + grep callers | 小 |

風險定義：
- 低 = mechanical，工具可證
- 中 = 需 cross-ref MEMORY / git log 判斷
- 高 = 跨系統依賴或需先決條件（e.g. C7 需先確認沒有 active legacy plan）

執行順序（建議）：C1 → C2 → C4 → C6 → C5 → C3 → C7（低→高、機械→語意→歷史）。
