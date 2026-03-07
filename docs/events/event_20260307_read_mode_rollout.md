# Event: read-mode rollout

Date: 2026-03-07
Status: Done

## 需求

- 將 `read-mode` 作為 cms 主線立即可用的 skill 與互動規範
- 讓 agent 能主動判斷何時進入 read-mode
- 限定 read-mode 只用在面向人類的長篇說明性輸出，不干擾 tool/build/test/git/runtime 回報

## 範圍

### IN

- `AGENTS.md`
- `templates/AGENTS.md`
- `.opencode/skills/read-mode/SKILL.md`
- `templates/skills/read-mode/SKILL.md`
- `packages/opencode/src/session/prompt/enablement.json`
- `templates/prompts/enablement.json`

### OUT

- 不修改核心 prompt runtime 程式碼
- 不修改 question tool schema
- 不強制所有回答都使用 read-mode

## 任務清單

- [x] 建立 read-mode rollout event
- [x] 定義主動觸發條件與排除條件
- [x] 新增 runtime/template skill
- [x] 更新 AGENTS / templates/AGENTS 使用規範
- [x] 更新 enablement registry
- [x] 驗證並 commit

## Debug Checkpoints

### Baseline

- 目前專案沒有 repo 交付層級的 `read-mode` skill。
- 長篇說明性回覆容易一次輸出多頁文字，不利人類依閱讀速度逐段吸收。
- 需求重點是讓 agent 在「解釋型回答」場景主動切成分段互動模式，而非縮短所有回答。

### Execution

- Added repo-delivered runtime/template skill files for `read-mode`.
- Updated project/template AGENTS guidance so the orchestrator proactively enters `read-mode` for long explanatory answers, but explicitly excludes tool/build/test/git/runtime result reporting.
- Updated runtime/template enablement registries so `read-mode` becomes discoverable as a first-class skill and routing hint for long-form explanatory response pacing.
- Refined `read-mode` behavior from "long explanatory answers" to "any human-reading explanatory output", with a default pause cadence of roughly every 20 lines and a minimal `question` prompt of `是 / 否 / custom feedback`.

### Validation

- `bun -e 'JSON.parse(...)'` 驗證 `packages/opencode/src/session/prompt/enablement.json` 與 `templates/prompts/enablement.json` 均為有效 JSON。
- `read-mode` runtime skill file 已建立於 `.opencode/skills/read-mode/SKILL.md`，template skill 已同步至 `templates/skills/read-mode/SKILL.md`。
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪僅新增互動式說明輸出規範與 skill / enablement 登錄，未改動 runtime 架構邊界或模組責任分層。
