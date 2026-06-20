# Spec: subagent_cwd_pathloss_hang

## Purpose

確保 orchestrator dispatch 的 subagent worker 永遠在正確的 project root 啟動、prompt 帶 working-directory 錨點，並在「忙但無進展」時被可靠終止——消除 daemon cwd ≠ repo root 時的 path-loss 跳針 hang。

## Requirements

### Requirement: Worker 以 project root 為 cwd 啟動 (RC-1, Fix A)

#### Scenario: daemon cwd ≠ repo root 時 dispatch subagent
- **GIVEN** daemon 由 systemd 啟動，process cwd = `/`
- **AND** orchestrator 透過 `task` tool dispatch 一個 coding subagent
- **WHEN** `spawnWorker()` 以 `Bun.spawn(buildWorkerCmd(), {...})` 啟動 worker
- **THEN** spawn options 帶 `cwd: capturedDirectory`（= 捕獲自 `Instance.directory` 的 project root）
- **AND** worker 進程的 `process.cwd()` 等於 project root（非 `/`）
- **AND** worker `bootstrap(process.cwd())` 解析的 `Instance.directory` 為 project root
- **AND** worker 的 workspace-relative path 工具（read/glob/grep）正確解析到 repo 內檔案

#### Scenario: Instance.directory 在 spawn 時缺失
- **GIVEN** `spawnWorker()` 被呼叫
- **WHEN** `capturedDirectory`（= `Instance.directory`）為 `undefined`
- **THEN** 系統 **fail loud**（throw clear error），禁止 silent fallback 到 `/` 或 `process.cwd()`（AGENTS rule 11）

### Requirement: Subagent prompt 帶絕對 working-directory 錨點 (RC-2, Fix B)

#### Scenario: 組裝 subagent system prompt
- **GIVEN** 一個 subagent（coding/explore/review/testing）的 system prompt 正在組裝
- **WHEN** preload context（`getPreloadParts`）被產生
- **THEN** preload 輸出含絕對 working-directory 區塊，標頭如 `Working directory (workspace root): <abs path>`，source 自 `Instance.directory`
- **AND** 此區塊 **同時** 出現在 main agent 與 subagent 的 preface（非 `<env>` block 的 subagent-gated 路徑）
- **AND** subagent 從 prompt 即可得知 repo root 絕對路徑，不再只有 bare filename 列表

### Requirement: Busy-but-no-progress worker 被終止 (RC-3, Fix C, 雙層)

#### Scenario: worker 連續無進展（watchdog 層）
- **GIVEN** 一個 worker 持續 tool-call（CPU/IO liveness 正常）
- **AND** 連續 M（≥5）次 tool 呼叫全 error 或全 identical-signature output
- **WHEN** proc-watchdog 掃描 worker 狀態
- **THEN** watchdog 判定 no-progress 並 reap worker
- **AND** finish reason 為 `no_progress_timeout`

#### Scenario: worker 自身 runloop 偵測無進展（detector 層）
- **GIVEN** 一個 runloop（orchestrator 或 subagent 自身）
- **AND** ≥N（≥6）輪 tool-active 但 `mutatedPerTurn` 全 false（零 file mutation）
- **AND** 伴隨 repeated tool-error / identical-result signature
- **WHEN** paralysis detector 評估該 runloop
- **THEN** detector 觸發 no-progress paralysis 判定（**與 preface 相似度無關**）
- **AND** 注入對應 nudge 文案促使脫離跳針

#### Scenario: 合法的「讀多檔再大改」不誤殺
- **GIVEN** 一個 worker 前段全 read（offset 遞增 / 不同檔，output signature 多樣）
- **AND** 尚未開始 mutation
- **WHEN** paralysis detector 評估
- **THEN** detector **不** 觸發（因 N 足夠大且需 repeated error/identical-result 同時成立）

## Acceptance Checks

- [x] daemon cwd=`/` 下 live coding subagent `pwd` = repo root（runtime 實測 ses_11fc0f348ffe4PRdQRgMR2d7Sp）
- [x] subagent context 含 `Working directory (workspace root): <repo root>` 錨點（runtime 實測）
- [x] 相對路徑檔案讀取正確 resolve 到 repo root（runtime 實測）
- [x] no-progress detector 單元測試通過（pure function）
- [x] watchdog 模擬連續 error tool-result → reap → `no_progress_timeout`
- [x] 既有 paralysis 測試不回歸；typecheck pass
- [x] `Instance.directory` undefined 時 fail loud（無 silent fallback）
