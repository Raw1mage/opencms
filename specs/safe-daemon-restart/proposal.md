# Proposal: safe-daemon-restart

## Why

- 2026-04-20 incident: webapp 上的 AI agent 透過 `execute_command` / Bash 執行 `webctl.sh dev-start`，等於 daemon 自己生兄弟 daemon。新舊 daemon 與 gateway lifecycle 脫鉤，舊的變成 orphan（pid 31934），持有 gateway flock。後續每次 gateway spawn 都被擋，15s timeout 後清 JWT 把使用者踢回登入頁，直到人工 `kill` 才解。
- 問題會**重複發生**：只要 AI 再自殺式重啟，orphan 再次出現。
- 根本設計缺陷：(a) daemon 生命週期的唯一控制者應該是 gateway，daemon 不該 fork/exec 自己或兄弟；(b) 即便有 orphan，gateway 自己要能自癒，而不是死循環。

## Original Requirement Wording (Baseline)

- 「製造 orphan 的原因是 webapp 上的 agent 執行了一次自殺式重啟。這個你必須把 system-manager tool 設計好，讓 AI 能安全的把自己重啟。」
- 「如果 `/run/user/1000/` 是登入後一定要用到的檔案資料夾，那就應該讓合法登入成功的使用者確保能有這個資料夾可使用，不管它因為什麼原因消失，都應該自動重建。」

## Requirement Revision History

- 2026-04-20: initial draft created via plan-init.ts; context from live incident debugging session

## Effective Requirement Description

1. **AI 安全自重啟**：提供一個正式的 MCP tool（`system-manager:restart_self` 或同義），讓 AI 要求 gateway 幫它重啟，而不是 AI 自己 fork/exec。daemon 從此不該有生兄弟/自殺的能力。
2. **Gateway 自癒**：無論 orphan 從何而來，gateway 必須能偵測 flock/socket 衝突並清理，不再死循環踢登入。
3. **Runtime 目錄保證**：合法登入成功後，socket 父目錄（`/run/user/<uid>/opencode/`）必須自動存在；被清掉也要自動重建。

## Scope

### IN
- 新增 `system-manager:restart_self` MCP tool 契約與實作
- Gateway C 程式：
  - spawn 前確保 socket 父目錄存在（`mkdir -p` 並 `chown` 給目標 uid）
  - Adopt 失敗時偵測 flock 持有者 PID，若健在但無法 adopt → SIGTERM → waitpid → SIGKILL → 重 spawn
  - 提供 admin endpoint 讓 system-manager tool 呼叫，觸發 graceful restart
- Daemon 端禁止路徑：
  - 明確禁止從 daemon context 呼叫 `webctl.sh dev-start` / `dev-refresh`
  - `execute_command` 加入 denylist（或改走 gateway endpoint）
- AGENTS.md 補一條「AI 禁止自行 spawn daemon」

### OUT
- Gateway 完全重寫（只補自癒邏輯）
- Daemon 主程式架構重構
- 前端登入流程改動（JWT 還是照舊清）
- 其他 tmpfiles 清理策略（只保 opencode 相關目錄）

## Non-Goals

- 不做跨使用者的 daemon 隔離強化（已有 onboarding 處理）
- 不處理 daemon 啟動失敗的長期重試/backoff 策略（目前 1 次 15s timeout 即可）
- 不引入 systemd per-user unit（維持 gateway-managed lifecycle）

## Constraints

- Gateway 是 C 程式（`daemon/opencode-gateway.c`），改動必須符合現有事件循環 + setuid 模型
- MCP tool 契約要能從 AI 側以 JWT 呼叫 gateway，不能繞過 auth
- 不能在 daemon 自己處理重啟請求（不然會踩到自己斷腳的問題）——必須 gateway 接手
- tmpfs (`/run/user/<uid>`) 可能在 WSL 重啟或 idle logout 後消失，方案要抗這種情境

## What Changes

- `daemon/opencode-gateway.c`：新增 (i) socket 父目錄自動建立、(ii) flock holder 偵測 + 清理、(iii) `/api/v2/global/restart-self` admin endpoint
- `packages/mcp/system-manager/src/index.ts`：新增 `restart_self` tool；`execute_command` 加 denylist
- `AGENTS.md`：補「daemon 不得自行 spawn/kill daemon」原則
- `docs/events/event_2026-04-20_daemon-orphan.md`：事件記錄與修法總結

## Capabilities

### New Capabilities
- `system-manager:restart_self`: AI 向 gateway 請求 graceful 重啟當前 daemon
- Gateway self-healing: 偵測 flock orphan 並主動清理
- Gateway runtime-dir guarantee: 每次 spawn 前 `mkdir -p` socket 父目錄

### Modified Capabilities
- `execute_command`: 加 denylist，禁止 `webctl.sh`、`kill` 針對 daemon pid、`bun ... serve --unix-socket`
- Daemon spawn path: adopt 失敗不再直接 spawn，先清理潛在 orphan

## Impact

- 使用者：登入不再被莫名踢出；AI 重啟行為變透明且可追蹤（event log）
- AI agents：少一條自殺式路徑，但獲得正式的 `restart_self` 契約
- 運維：gateway log 從 "waitpid ECHILD loop" 變成 "detected orphan, killed, respawned"，除錯更直觀
- Docs: `AGENTS.md` 多一條禁令；`specs/architecture.md` 可能要加一小節描述 daemon lifecycle authority
