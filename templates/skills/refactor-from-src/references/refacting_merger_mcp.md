# Refacting Merger MCP 使用說明

## 目標

以 MCP tools 將 `origin/dev`（或任意外來 source/branch）變更，透過精靈導引方式評估後整併到目標 branch（通常 `cms`）。

## 啟動

```bash
bun packages/mcp/refacting-merger/src/index.ts
```

可選環境變數：

- `REFACTING_MERGER_ROOT=/absolute/repo/path`

## Tools 一覽

1. `refacting_merger_skill_index`
   - 列出本地可用 skills（含描述與路徑）。

2. `refacting_merger_skill_read`
   - 讀取指定 skill（含 SKILL.md 本文與可選 references）。
   - 建議優先讀 `refactor-from-src`。

3. `refacting_merger_daily_delta`
   - 核心分析工具。比較 `targetRef..sourceRemote/sourceBranch`。
   - 產生每個 commit 的：
     - `logicalType`
     - `valueScore` (`fit/user/ops/risk`)
     - `risk`
     - `defaultDecision` (`ported/integrated/skipped`)

4. `refacting_merger_generate_plan`
   - 依分析結果產生 `docs/events/refactor_plan_*.md` 骨架。

5. `refacting_merger_update_ledger`
   - 將最終決策 append 到 `refactor_processed_commits_*.md`。

6. `refacting_merger_wizard_hint`
   - 回傳分階段導引（analysis/planning/approval/execution/ledger）。

## Daily Catch-up（origin/dev）建議順序

1. `refacting_merger_skill_read(skillName="refactor-from-src")`
2. `refacting_merger_daily_delta(sourceRemote="origin", sourceBranch="dev", targetRef="HEAD", ledgerPath="docs/events/refactor_processed_commits_YYYYMMDD.md")`
3. `refacting_merger_generate_plan(...)`
4. 與使用者確認高風險 commit 決策
5. 執行整併
6. `refacting_merger_update_ledger(...)`

## 任意外部 source/branch

將 `sourceRemote` / `sourceBranch` 改成外部來源即可（例如 `upstream/main` 或 fork remote）。
同樣保留：先分析、後規劃、核准後再執行。
