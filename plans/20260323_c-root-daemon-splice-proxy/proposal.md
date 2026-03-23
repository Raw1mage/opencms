# Proposal

## Why
- 現有 daemonization 架構理念正確：C root gateway 承接 PAM / privileged edge，per-user daemon 承接 opencode backend，達成最小特權與使用者隔離。
- 然而 `daemon/opencode-gateway.c` 目前僅為通過編譯的 prototype，**核心資料路徑從未經 runtime 驗證**。
- 前一輪 hardening（Session 3）只處理了 JWT claim 驗證與 routing demo path 移除等表面缺口，**未識別 event loop 架構、HTTP 協議處理、connection 生命週期、splice proxy 正確性等結構性問題**。
- 本次工作目標：對 gateway prototype 做完整 gap analysis，將所有已識別的結構性問題納入計畫，產出可驅動 build mode 的 execution contract。

## Original Requirement Wording (Baseline)
- "plan根本還沒做完，不該現在急著上線測試。請盤點plan，把沒做完的做完"

## Requirement Revision History
- 2026-03-23 R1：先分析既有 daemonization 文件與 `daemon/opencode-gateway.c` 的落差。
- 2026-03-23 R2：確認設計原意維持不變，不推翻 root gateway + per-user daemon 架構。
- 2026-03-23 R3：本次只規劃 hardening / spec rewrite / execution plan，不在 plan mode 直接實作 gateway 修補。
- 2026-03-23 R4：`--attach` 契約定稿為 explicit auto-spawn。
- 2026-03-23 R5：JWT contract 補充 current issuance reality：`sub` + `exp`，uid 由 `sub` → `getpwnam()` 反查。
- 2026-03-23 R6：驗證矩陣分層記錄。
- **2026-03-23 R7：盤點發現前一輪 hardening 跳過了真正的 gap analysis。計畫需補齊以下結構性問題的識別與修復規劃：event loop blocking I/O、HTTP request parsing robustness、epoll fd 辨識、connection lifecycle management、splice proxy 正確性、JWT secret 持久化、WSL2 環境適配、安全邊界審查。**

## Effective Requirement Description
1. 保留 daemonization 的核心架構：C root gateway + per-user opencode daemon + TUI attach / Web proxy 共用 backend。
2. **完成前一輪缺失的結構性 gap analysis**，涵蓋 event loop、HTTP parsing、connection lifecycle、splice correctness、security surface、environment compatibility。
3. 將所有 gap 轉成可執行的 hardening tasks，明確定義 requirements、risks、verification。
4. 讓後續 build mode 可以依據本計畫直接執行實作與驗證。

## Scope
### IN
- 結構性程式碼審計：event loop 架構、HTTP request 處理、epoll/splice 正確性、connection lifecycle
- 安全面審計：JWT secret 持久化、keep-alive bypass、login rate limiting、setuid + sh -c 邊界
- 環境適配評估：WSL2 `/run/user/` 可用性、PAM 行為、單使用者 vs 多使用者模型
- 重寫所有 plan artifacts（proposal / spec / design / impl-spec / tasks / diagrams / handoff）
- 為 build mode 定義 stop gates、validation matrix、documentation sync

### OUT
- 直接修改 `daemon/opencode-gateway.c` 或其他 runtime code（plan mode 不改程式）
- 在 plan mode 內執行 build / test / deploy
- 重做整個 daemonization 架構或改變核心理念
- 自動 formalize 到 `specs/` feature root

## Non-Goals
- 不把 root gateway 改成其他語言或移除 C implementation
- 不改動 web UI / TUI UI
- 不處理與 daemon hardening 無直接關聯的 provider/account 改版

## Constraints
- 維持「最小特權、明確邊界、單一 per-user backend 真相來源」架構原則
- 禁止新增 silent fallback
- web runtime 遵守 `./webctl.sh dev-start|dev-refresh` 單一入口原則
- 規劃必須反映現有 code evidence，不假設不存在的能力已完成

## What Changes (vs Previous Plan Revision)
- 前一輪計畫只識別了「JWT claim 不完整」「routing 走 demo path」「文件漂移」三類表面缺口
- **本次補齊的結構性問題清單**：

| 問題 | 類別 | 嚴重度 |
|---|---|---|
| Event loop 被 blocking `recv()` + PAM auth 卡死 | 架構 | 致命 |
| 單次 `recv()` 假設完整 HTTP request（TCP 分段未處理） | 協議 | 致命 |
| epoll 無法分辨 client_fd vs daemon_fd（同一 `data.ptr`） | 架構 | 高 |
| Connection lifecycle：`g_nconns` 只增不減、無 `EPOLL_CTL_DEL`、use-after-close | 資源 | 高 |
| splice proxy 建立後不再驗證 JWT（HTTP/1.1 keep-alive bypass） | 安全 | 高 |
| JWT secret 每次 gateway 重啟重新生成（所有 session 失效） | 可用性 | 中 |
| 無 login 速率限制（PAM brute-force 無防護） | 安全 | 中 |
| WSL2 環境：`/run/user/` 可能不存在、PAM 行為不一定正常 | 環境 | 中 |
| `OPENCODE_BIN` 帶空格走 `sh -c` 稀釋 setuid 安全邊界 | 安全 | 中 |

## Capabilities
### New Capabilities
- 完整結構性 gap analysis：涵蓋 event loop / protocol / lifecycle / security / environment
- 可執行 hardening execution contract：每個 gap 都有對應 task、risk、validation
- 分層 verification matrix：compile → static → single-user → streaming → multi-user

### Modified Capabilities
- 從「prototype hardening 表面修補」升級為「結構性修復 + hardening」
- 前一輪已完成的 JWT claim validation 與 identity routing 修改視為有效基線，不回退

## Impact
- 影響 `daemon/opencode-gateway.c` 的架構層修改方向（event loop 重構、HTTP buffering、epoll 重設計）
- 影響 verification matrix 的深度與前置條件
- 影響 build mode 的工作量估計（從「小幅修補」升級為「結構性修復」）
- 影響 `docs/events/` 與 `specs/architecture.md` 的後續同步範圍
