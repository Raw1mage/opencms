# Event: Daemon startup performance + orphan recovery overhaul

## 背景

test/session-continuation-fix 分支 merge 到 main 後，daemon 啟動異常慢（CPU 爆、登入被踢回首頁、restart 花超過一分鐘）。逐一排查發現多個疊加的性能問題。

## 問題清單與修復

### 1. Orphan scan 全表掃描燒 CPU

- **根因**：`scanOrphanToolParts()` 遍歷全部 2063 sessions × 全部 messages × 全部 parts，每次 daemon 啟動都跑
- **修法**：改用 `running-tasks.json` registry，task dispatch 時寫入、結束時移除。daemon 重啟只讀 registry（通常 0 筆）
- **複雜度**：O(all sessions) → O(in-flight tasks)
- **Commit**：`5ce3a265f`

### 2. Gateway 缺少 OPENCODE_LAUNCH_MODE

- **根因**：C gateway fork daemon child 時沒傳 `OPENCODE_LAUNCH_MODE` env，`web.ts` guard 直接 exit(1)
- **修法**：gateway.c 加 `setenv("OPENCODE_LAUNCH_MODE", "systemd", 1)`；web.ts 同時接受 `OPENCODE_USER_DAEMON_MODE=1`
- **Commit**：`55081aefe`

### 3. 廢棄 plugin 靜默 fallback 浪費 4.5 秒

- **根因**：`opencode.json` 殘留兩個已被 internal plugin 取代的外部 plugin（`opencode-gemini-auth`、`opencode-openai-codex-auth-multi`），plugin loader 用 bare `continue` 跳過（違反 AGENTS.md 第一條），但 `Config.waitForDependencies()` 在 skip 之前就觸發了 `bun install`
- **修法**：過濾移到 `waitForDependencies` 之前；每個跳過的 legacy plugin 加 `log.warn`
- **Commit**：`55081aefe`

### 4. TUI import 在 headless 命令導致 bun deadlock

- **根因**：`index.ts` top-level `await import("./cli/cmd/tui/attach")` 拉入整個 ink/React tree，在 bun 1.3.x + WSL2 環境下 deadlock（多線程 `openat()` 同一文件互鎖）
- **修法**：serve/web 命令跳過 TUI module import
- **Commit**：`86621fe85`

### 5. Gateway blocking 等 daemon 導致白畫面

- **根因**：gateway `ensure_daemon_running()` 同步等待 daemon ready（最多 15 秒），期間 HTTP response 完全卡住，瀏覽器只看到白畫面
- **修法**：cold start + page request 時先回 loading page（spinner + 進度文字），JS polling `/api/v2/global/health`，daemon ready 後自動跳轉
- **Commit**：`86621fe85`

### 6. `bun build --compile` 失敗

- **根因**：4 個 dead `import "opentui-spinner/solid"`（package 已刪但 import 殘留）；`SkillLayerRegistry` top-level `Bus.subscribe` 在 bundle 裡因 module init order 不同導致 `Instance.state` undefined
- **修法**：刪除 dead imports；defer Bus.subscribe 到首次 `recordLoaded` 呼叫
- **Commit**：`63465f68b`

### 7. restart 每次強制重編 frontend（~1 分鐘）

- **根因**：`do_restart` 寫死 `do_reload --force`，跳過 `_frontend_needs_build()` 檢查
- **修法**：移除 `--force`，讓 smart change-detection 正常運作
- **Commit**：`e65bcef1d`

### 8. vite build 輸出刷屏

- **根因**：幾百行 per-file gzip size 直接 dump 到 stdout
- **修法**：`| tail -1` 只留 summary 行
- **Commit**：`bda66b182`

## 效果

| 指標 | 修復前 | 修復後 |
|------|--------|--------|
| daemon cold start (dev) | 20s+ (deadlock/timeout) | ~5s (loading page 即時回應) |
| daemon cold start (binary) | N/A (build 壞) | 1.5s warm / 3.5s cold |
| Plugin.init | 4.5s | 150ms |
| `webctl.sh restart` | >60s | <1s |
| orphan recovery | O(2063 sessions) | O(0~5 entries) |

## 涉及檔案

- `packages/opencode/src/tool/task.ts` — running-task registry
- `packages/opencode/src/project/bootstrap.ts` — orphan recovery 入口
- `packages/opencode/src/plugin/index.ts` — legacy plugin 過濾 + warn
- `packages/opencode/src/cli/cmd/web.ts` — LAUNCH_MODE guard
- `packages/opencode/src/index.ts` — TUI import skip for headless
- `packages/opencode/src/session/skill-layer-registry.ts` — defer Bus.subscribe
- `packages/opencode/src/cli/cmd/tui/component/*.tsx` — dead import cleanup
- `daemon/opencode-gateway.c` — LAUNCH_MODE env + loading page
- `webctl.sh` — restart --force removal + vite output suppression

## 教訓

1. **AGENTS.md 第一條的價值**：plugin loader 的 silent `continue` 讓 4.5 秒的浪費藏了好幾個月。有 `log.warn` 第一天就會被發現。
2. **Top-level side effects 在 bundle 裡是地雷**：`Bus.subscribe` 放在 module scope，dev mode 沒問題但 compiled binary 因 init order 改變而 crash。
3. **全表掃描不可接受**：即使是 "一次性" 的 orphan recovery，2000+ sessions 的 I/O 成本在 WSL2 上足以讓 daemon 啟動燒 CPU 數分鐘。
