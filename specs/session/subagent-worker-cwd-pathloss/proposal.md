# Proposal: subagent_cwd_pathloss_hang

## Why

- 在 daemon 的 cwd ≠ repo root（例如 systemd 啟動於 `/`）時，被 orchestrator dispatch 的 coding subagent 會繼承 `/` 作為 working directory。worker 的所有 workspace-relative path 解析變成 `/<path>` → 找不到檔案。
- worker 因此進入長達 21 分鐘的 path-guessing「跳針」迴圈（`find /` 120s timeout、`pwd`→`/`、反覆 glob/grep），從未讀到任何 target 檔案、從未自我終止。
- 兩道安全網都漏接：proc-watchdog 看 CPU/IO liveness（worker 一直 tool-call 所以「看似存活」），paralysis Detector D 看 preface 相似度（worker 每輪換不同 narration 所以相似度 < 0.6）。
- 影響範圍：任何 daemon cwd ≠ repo 的環境下，每一次 coding delegation 都受影響。Severity HIGH。
- 來源 BR：`issues/bug_20260619_coding_subagent_cwd_root_pathloss_unproductive_hang.md`。

## Original Requirement Wording (Baseline)

- "處理 subagent 的 issue BR 和 plan"（使用者指向上述 BR，要求修復並建立 plan）。

## Requirement Revision History

- 2026-06-19: initial draft created via plan-init.ts
- 2026-06-19: 範圍經 question 確認為 A+B+C 全包；Fix C 採 watchdog + paralysis detector 雙層機制。

## Effective Requirement Description

1. **Fix A（RC-1, REQUIRED）**：`spawnWorker` 的 `Bun.spawn` 必須以 project root 為 cwd 啟動 worker；`Instance.directory` 在 spawn 時不可為 undefined（否則 fail loud，不得 silent fallback 到 `/`）。worker 端的 `bootstrap()` 必須以實際 project root 而非 OS cwd 建立 Instance。
2. **Fix B（RC-2, REQUIRED）**：coding driver prompt（及 explore/review/testing）必須注入 `<env>`-style working-directory / repo-root 區塊，source 自同一個 `Instance.directory`，讓 prompt 與 process cwd 一致。
3. **Fix C（RC-3, RECOMMENDED, 雙層）**：補上 busy-but-no-progress 偵測——proc-watchdog 加「N 次連續 tool error / identical-signature output」reap 訊號；paralysis detector 加「≥N 輪 tool-active 但 zero file-mutation 且 repeated error/identical-result」偵測，與 preface 相似度無關。

## Scope

### IN

- `packages/opencode/src/tool/task.ts`：`spawnWorker` 傳 cwd；proc-watchdog 加 no-progress 訊號。
- `packages/opencode/src/cli/cmd/session.ts`：worker `bootstrap()` 的 directory 來源校正（確保 worker 端 Instance.directory 與 parent 傳入一致）。
- `packages/opencode/src/agent/prompt/coding.txt`（+ explore/review/testing driver prompt）：注入 working-directory `<env>` 區塊。
- `packages/opencode/src/session/prompt.ts`：新增 tool-active-but-zero-mutation paralysis detector 路徑。
- 對應的 detector / watchdog 單元測試。

### OUT

- 不重寫既有 idle reap / parent watchdog 主邏輯（只新增 no-progress 訊號）。
- 不改寫 Detector A/B/C/D 既有判定條件（只新增一條獨立路徑）。
- 不處理 BR 之外的其他 subagent issue（observing 目錄內其餘 issue 不在此 plan）。

## Non-Goals

- 不解決 orchestrator 端所有 perseveration 場景（僅補 BR 點到的 busy-but-no-progress 類別）。
- 不改 worker idle timeout / heartbeat 間隔。

## Constraints

- AGENTS.md rule 11：禁止新增 silent fallback。`Instance.directory` 缺失必須 fail loud。
- 善用既有 infrastructure（ProcessSupervisor / Instance / Bus），不得自製協調邏輯。
- 修改 driver prompt 必須同步 `templates/**` 對應檔（如存在）。

## What Changes

- worker 進程以正確 project root 啟動，path 解析回到 repo。
- coding/explore/review/testing driver prompt 帶 working-directory 錨點。
- watchdog + paralysis detector 能在「忙但無進展」時終止 worker。

## Capabilities

### New Capabilities

- busy-but-no-progress reaping：worker 連續無進展時被 watchdog/detector 終止，finish reason 明確。

### Modified Capabilities

- worker spawn：從繼承 OS cwd 改為顯式 project-root cwd。
- subagent driver prompt：新增 working-directory 環境上下文。

## Impact

- 受影響程式碼：`task.ts`、`session.ts`、`coding.txt`（+其他 driver）、`prompt.ts`。
- 受影響行為：所有 coding/explore/review/testing delegation 的 path 解析與 hang 終止。
- 文件：若改動模組邊界/狀態機需同步 `specs/architecture.md`。
