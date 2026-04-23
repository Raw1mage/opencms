# Proposal: subagent-quota-safety-gate

> **Scope pivot (2026-04-23, v2)**: 原本目標是「給 AI 觀測眼睛」，但使用者指出 `SYSTEM.md` 已有的 5% wrap-up 規則在現實中根本不生效 — subagent 燒爆額度仍是主要事故模式。主角從「AI 自律觀測 tool」改為 **runtime 強制 gate**；觀測 tool 降級為支援性功能（主 agent 全景、subagent 自查 — 但不依賴它來防 burn）。下面 Scope / Capabilities 已依 v2 重寫；v1 相關段落保留在 Revision History 供追溯。

## Why

過去事故模式一再重複：subagent 被 task tool 生出來執行一項工作，它自己沒有「我該停」的感官，就一路打 provider 直到把當前帳號的 5H window 榨乾。rotation 不會插手，因為 subagent 的 session 已有 pinned `execution.accountId`，rotation 預設尊重 pin 不動它。

我們之前試過兩條路都沒成功：
1. **純文字規則**（SYSTEM.md 寫「剩 5% 要 wrap up」）— AI 看規則的執行率低，context 一滿就漂走
2. **給 AI 觀測 tool**（本 spec v1 原計畫）— 假設 AI 看到數字會自律。現實中 subagent 不會在中途主動查，而且即使查到了也傾向「再一個 tool call 就好」

結論：**這件事不能靠 AI 自律**。必須由 runtime 在 subagent 發出 provider request 的路徑上硬攔，超過門檻就強制結束這個 subagent，把手邊進度以 SharedContext + 結構化摘要回傳給 parent。

同時，觀測 tool 仍然有價值 — 但用途從「防 burn」轉成「全景觀測 / 主 agent 看看整體狀況 / subagent 在 gate 觸發之前的早期感知」。它不是這個 spec 的主線。

## Original Requirement Wording (Baseline)

- v1（2026-04-23 初始）：「一直以來subagent一直沒有能力自己去留意用量狀況。我覺得應該要寫一個system-manager-quota tool來幫助AI」
- v2 pivot（2026-04-23 同日）：「我現在覺得應該讓runtime硬編碼去干涉subagent的工作。在小於5%的時候叫停並return sharedcontext」

## Requirement Revision History

- 2026-04-23: initial draft created via plan-init.ts
- 2026-04-23: 使用者確認「純觀測、不含 force_rotate 寫入面」（v1）
- 2026-04-23: 使用者澄清 tool 形狀 — 單一 tool 自動偵測當前 provider/model/account 並分派；目前僅 codex/openai 有實作（v1）
- 2026-04-23: 三項 v1 設計方向：(a) description 帶 heuristic, (b) `cachedAt` + `ageSeconds`, (c) 以當次 inflight account 為準
- 2026-04-23: 勘查發現 `get_system_status` 已暴露 rotation / codex 5H+WK usage 等，方案 C 雙軌（v1 結尾）
- **2026-04-23 v2 pivot**: 使用者指出 v1 的「AI 自律觀測」路線和既有 SYSTEM.md 5% 規則一樣注定失敗。主線改為 **runtime 強制 quota gate**；觀測 tool 降為支援性功能
- 2026-04-23: 四項 v2 設計方向確認：
  - 門檻：**哪個 window 先到 5% 就攔**（5H 或 weekly）
  - 攔截點：**tool-call 邊界**（subagent 每輪 tool-call 結束後檢查，粒度夠且成本低）
  - Handover 形式：**SharedContext + runtime 自動產的結構化摘要**（非 LLM 臨終生成 — 不信任 LLM 臨終寫字的穩定度）
  - 適用範圍：**只攔 task tool spawn 的 subagent**（root session 不攔；parent 的 UI 連續性 > 防 burn）

## Effective Requirement Description

### 主線：Runtime Quota Safety Gate

1. 在 subagent 的 runtime 執行迴圈中插入一道 **pre-dispatch quota gate**：每輪 tool-call 完成、準備發下一次 provider request 前，runtime 讀取當前 pinned account 的 quota cache，若 5H 或 weekly 任一低於 5% → **強制中止這個 subagent**
2. 中止路徑：runtime 以「quota-gate-trip」為 CancelReason 結束 subagent 的 runloop，**不**讓 subagent 的 LLM 再多一次機會
3. Handover：runtime 把 subagent 當下的 SharedContext 加上一段 **runtime 自動產的結構化摘要**（已完成 tool-calls / 讀過的檔 / 最近 N 則 message 摘錄）送回 parent；parent 的 task tool 回傳值包含這兩段
4. 適用範圍：task tool spawn 出來的 subagent（非 root session）。Root session / parent / 其他來源的 session 不在 gate 範圍內
5. Gate 行為可關：`/etc/opencode/tweaks.cfg` 提供 `subagent.quota_gate_enabled` 與 `subagent.quota_gate_threshold_percent`（預設 5）

### 支援線：觀測 tools（原 v1 內容，保留但降級）

6. 新增 `system-manager:get_my_current_usage`（主 agent 或早期 subagent 自查用，非 gate 依賴）
7. 擴充 `system-manager:get_system_status` 區分 `selectedAccount` vs `currentInflightAccount`，usage 帶 `cachedAt` / `ageSeconds`
8. 引入 `AccountQuotaProbe` provider-boundary 介面（gate 和觀測 tool 共用同一個 quota 來源）

## Scope

### IN
- **(v2 主線)** subagent runtime 迴圈的 pre-dispatch quota gate（5% 門檻、tool-call 邊界、強制中止、SharedContext + 結構化摘要 handover）
- **(v2 主線)** 結構化摘要生成器（非 LLM；runtime 從 subagent tool-call 歷史與 SharedContext 掃出「已完成動作 / 讀過的檔 / 最近發現 / 未完成項」）
- **(v2 主線)** `tweaks.cfg` 開關 + 門檻（避免意外把整個 subagent 體系鎖死）
- **(v1 支援)** `get_my_current_usage` MCP tool
- **(v1 支援)** `get_system_status` 擴充（`currentInflightAccount`, `cachedAt`, `ageSeconds`）
- **(v1 支援)** `AccountQuotaProbe` provider 介面 + codex 實作 + quota-cache.json TTL 機制（gate 與 tool 共用）

### OUT
- 任何 `force_rotate` / `mark_exhausted` 類的寫入 tool（v1 就明確排除）
- rotation3d 本身的重構（request-gated → background ticker 屬 `process-liveness-contract`）
- Root session / parent 的 quota gate（v2 明確排除 — 使用者體驗優先）
- 前端顯示 quota 的 UI

## Non-Goals

- 不依賴 AI 自律 — 主線 gate 是 runtime 強制，不是給 AI 的 hint
- 不解決 2026-04-23 subagent-hang IPC 真因（屬 `process-liveness-contract`）
- 不做 subagent 內部 rotation / 重新 pin 新帳號（換帳號繼續跑）— 這動到 rotation 契約太廣，先用「終止 + 摘要回 parent」解；未來 parent 可以決定要不要用新帳號重啟
- 結構化摘要不追求 LLM-品質 — 它是 runtime 自動產的、fact-based 清單，不是 narrative；目的是讓 parent 有明確標籤，不是寫好看

## Constraints

- 必須跟現有 rotation3d / account manager 的資料來源對齊，不另建獨立 cache
- 「禁止靜默 fallback」：gate 判斷不到 quota 時（cache 從未填過、provider 不支援），**預設放行**並在 log 留下明確 warning（不能因為查不到而誤殺 subagent）— 這是明知的 trade-off，log 要顯眼讓使用者發現
- 遵守 `feedback_provider_boundary.md`：gate 邏輯不得內嵌 provider-specific 判斷；所有差異由 `AccountQuotaProbe` 吸收
- Read-only 保證：gate 本身不改 rotation 狀態、不改 accounts.json；只讀 cache + 呼叫 cancel(subagent, reason="quota-gate-trip")
- Gate trip 不能把 parent 的對話也弄壞 — 必須以正常 task-tool-result 路徑回到 parent

## What Changes

- `packages/opencode/src/tool/task.ts` — subagent runloop 加 quota gate check
- `packages/opencode/src/session/` — 結構化摘要生成器；cancel reason 擴充
- `packages/opencode/src/account/` 新增 `quota-probe.ts`（gate 與 MCP tool 共用）
- `~/.config/opencode/quota-cache.json` 新 cache 檔（gate 與 tool 共用）
- `packages/mcp/system-manager/src/index.ts` 新增 `get_my_current_usage`、擴充 `get_system_status`
- `packages/opencode/src/mcp/index.ts` bridge 自動注入 sessionID（觀測 tool 用）
- `/etc/opencode/tweaks.cfg` 新增 `subagent.quota_gate_enabled`、`subagent.quota_gate_threshold_percent`、`quota.cache_ttl_seconds`
- Prompt layer / enablement 同步（觀測 tool 預設啟用）

## Capabilities

### New Capabilities
- **Runtime-enforced quota safety gate for subagents**：不再依賴 AI 自律，5% 門檻由 runtime 硬攔
- **Structured quota-trip handover**：parent 收到的不只是「subagent 中止了」，而是 SharedContext + 一份明確的「已做 / 未做 / 關鍵檔案」清單
- `get_my_current_usage`：支援性觀測 tool
- Tool description 層的 heuristic 引導（支援線）

### Modified Capabilities
- Task tool 的回傳路徑：多一個「quota-gate-trip」結果型別
- `get_system_status`：區分 `selectedAccount` vs `currentInflightAccount`，usage 帶新鮮度
- Subagent cancel reason 集合：加 `quota-gate-trip`

## Impact

- Runtime：task tool + session cancel 路徑、新 quota probe 模組、新 summary 生成器
- Prompt：enablement + SYSTEM.md（觀測 tool 宣告 + parent 端告知「你的 subagent 可能因 quota 被 runtime 終止」）
- 設定：tweaks.cfg 新增三個 knob
- 文件：`docs/events/` 紀錄本次 pivot；`specs/architecture.md` 補充 subagent quota gate 段落
- **不影響**既有 rotation3d 自動策略、既有 429 處理路徑、root session 行為
