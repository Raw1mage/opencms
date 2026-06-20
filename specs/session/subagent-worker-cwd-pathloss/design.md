# Design: subagent_cwd_pathloss_hang

## Context

orchestrator 透過 `task` tool dispatch subagent 時，由 `spawnWorker()`（`packages/opencode/src/tool/task.ts:835`）以 `Bun.spawn(buildWorkerCmd(), {...})` 啟動一個 long-lived worker 進程。worker 進程跑 `session worker` 子命令（`packages/opencode/src/cli/cmd/session.ts:184`），用 `bootstrap(process.cwd(), …)`（session.ts:195）建立 `Instance`。worker 的所有檔案工具（read/glob/grep）以 `Instance.directory` / cwd 為錨點解析 workspace-relative path。

當 daemon 由 systemd 啟動（cwd=`/`），worker 繼承 `/`，path 全失。watchdog（task.ts:2158 起的 proc-scan）與 paralysis Detector D（`prompt.ts:detectPrefaceParalysis` line 537）都漏接 busy-but-no-progress。

## Goals / Non-Goals

### Goals

- worker 進程以正確 project root 為 cwd 啟動，path 解析回到 repo。
- subagent driver prompt 帶 working-directory 錨點。
- watchdog + paralysis detector 能在「忙但無進展」時終止。

### Non-Goals

- 不重寫既有 idle reap / parent watchdog / Detector A–D 主邏輯。
- 不解決所有 perseveration 類別，僅 BR 點到的 busy-but-no-progress。

## Decisions

- **DD-1**（RC-1, Fix A）：在 `spawnWorker()` 的 `Bun.spawn` options 加 `cwd: capturedDirectory`。`capturedDirectory = Instance.directory`（task.ts:840）已在 spawn 時捕獲；若為 undefined 必須 **fail loud**（throw，不得 silent 落到 `/` 或 `process.cwd()`），符合 AGENTS.md rule 11 禁止 silent fallback。

- **DD-2**（RC-1, Fix A worker 側）：worker `session worker` handler 目前用 `bootstrap(process.cwd())`（session.ts:195）。加了 DD-1 的 spawn cwd 後，worker 的 `process.cwd()` 即為 project root，`bootstrap(process.cwd())` 自然正確，**不需** worker 端額外傳 directory。保留 `bootstrap(process.cwd())` 但驗證：daemon spawn 時 worker `process.cwd()` 確實等於 parent `Instance.directory`。worker file logger 已記錄 `cwd`（session.ts:192），可作驗證證據。

- **DD-3**（RC-2, Fix B）：在 `coding.txt` 注入 working-directory 區塊。決定**靜態 placeholder vs 執行期注入**：driver prompt 是靜態檔，無法在檔內插 runtime 值。改為在組裝 subagent system prompt 的程式碼處（與 main agent `<env>` block 同一注入點）追加一段 worker `<env>`，source 自 `Instance.directory`。需定位 main agent `<env>` 的組裝點並沿用。explore/review/testing driver 同步。

- **DD-4**（RC-3, Fix C 第一層 watchdog）：在 proc-scan watchdog（task.ts:2158+）獨立於 CPU/IO liveness，新增 no-progress 訊號。判定來源：worker 透過 stdout event bridge 回報的 tool-result 事件。連續 M（建議 5）次 tool 呼叫全 error 或全 identical-signature output → reap，finish 值用既有 watchdog B/C 風格的合成值 `no_progress_timeout`（task.ts:2184 註解已預留此名）。需確認 bridge 事件是否帶足夠 tool-result 簽章資訊。

- **DD-5**（RC-3, Fix C 第二層 detector）：新增 paralysis detector 路徑（與 Detector D 並列於 prompt.ts:2691 區段），偵測「≥N 輪 tool-active 但 mutatedPerTurn 全 false 且 repeated tool-error / identical-result signature」，**與 preface 相似度無關**。複用既有 `PARALYSIS_PROGRESS_TOOLS`（prompt.ts:451）判定 mutation、既有 jaccard/bigram 工具判定 output signature。此 detector orchestrator 與 subagent 共用同一 runloop，兩端皆受益。

- **DD-6**：兩層機制取「先觸發者勝」——watchdog（task.ts，parent 端、proc-level）與 detector（prompt.ts，worker 自身 runloop）互補：detector 讓 worker 自我終止（較快、較精準），watchdog 是 parent 端最後防線（worker 完全失控時）。不互相依賴。

## Risks / Trade-offs

- **R1**：DD-1 若 `Instance.directory` 在某些 spawn 路徑確實合法為 undefined（如非 HTTP-request 觸發），fail loud 會破壞既有流程。緩解：先 grep 所有 spawnWorker 呼叫點確認 Instance context 必存在；不存在則改在更上層補 Instance.provide。
- **R2**：DD-4 依賴 stdout bridge 事件帶 tool-result 簽章。若 bridge 不轉發 tool-level 細節，watchdog 無法判斷 no-progress。緩解：若 bridge 資訊不足，DD-4 降級為「依賴 DD-5 detector + 既有 CPU/IO watchdog」，並在 tasks.md 標記。
- **R3**：DD-5 誤殺合法的「讀多檔再大改」工作（前段全 read、無 mutation）。緩解：N 設足夠大（建議 ≥6），且需「repeated error / identical-result」同時成立，純多樣化 read（offset 遞增、不同檔）不觸發。
- **R4**：driver prompt 改動需同步 `templates/**`。緩解：Phase B 收尾檢查 template 鏡像。

## Critical Files

- `packages/opencode/src/tool/task.ts` — spawnWorker (835)、Bun.spawn (842)、capturedDirectory (840)、proc-watchdog (2158+)、TERMINAL_FINISHES (2192)。
- `packages/opencode/src/cli/cmd/session.ts` — SessionWorkerCommand (184)、bootstrap(process.cwd()) (195)、worker file logger cwd (192)。
- `packages/opencode/src/agent/prompt/coding.txt` — driver prompt (line 31 absolute-path 提示)。
- `packages/opencode/src/session/prompt.ts` — Detector D / detectPrefaceParalysis (537)、PARALYSIS_PROGRESS_TOOLS (451)、detector wiring (2691+)、selectParalysisNudge (467)。
- subagent system-prompt 組裝點（待 Phase B 定位 main agent `<env>` block 來源）。

## Validation Plan

- **Fix A**：daemon cwd=`/` 啟動，dispatch coding subagent，worker file logger 應記 `cwd=<repo root>`，target file read 成功。
- **Fix B**：dump subagent system prompt，確認含 working-directory `<env>` 區塊且值為 repo root。
- **Fix C**：detector 單元測試（複用 detectPrefaceParalysis 測試風格，pure function）；watchdog 以模擬連續 error tool-result 驗證 reap → `no_progress_timeout`。
- 既有測試：`prompt.ts` paralysis 相關測試不回歸。
