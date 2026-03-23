# Proposal

## Why
- 現有 daemonization 設計理念正確：以 C root gateway 承接 PAM / privileged edge，以 per-user daemon 承接實際 opencode backend，達成最小特權、使用者隔離、TUI/Web 共用狀態。
- 目前 `daemon/opencode-gateway.c` 已有 prototype，但 JWT claim 驗證、per-user 精準路由、runtime verification 與文件契約仍不完整，spec 與實作成熟度存在漂移。
- 本次工作要把 daemonization 從「概念正確但收尾不足」升級為「可驗收、可持續演進、可進入 build mode 實作」的 hardening 計畫。

## Original Requirement Wording (Baseline)
- "設計理念很好。現在針對不足的地方，規劃改版計畫。plan_enter更新specs，plan_exit實作"

## Requirement Revision History
- 2026-03-23 R1：先分析既有 daemonization 文件與 `daemon/opencode-gateway.c` 的落差。
- 2026-03-23 R2：確認設計原意維持不變，不推翻 root gateway + per-user daemon 架構。
- 2026-03-23 R3：本次只規劃 hardening / spec rewrite / execution plan，不在 plan mode 直接實作 gateway 修補。
- 2026-03-23 R4：`--attach` 契約定稿為 explicit auto-spawn，移除 fail-fast 作為最終目標契約。
- 2026-03-23 R5：JWT contract 補充 current issuance reality：現況 evidence 為 `sub` + `exp`，target contract 需明確定義 uid strategy。
- 2026-03-23 R6：在 code work 前先凍結 verification matrix，要求 compile / static review / single-user / streaming / multi-user / deferred evidence 分層記錄。

## Effective Requirement Description
1. 保留 daemonization 的核心架構：C root gateway + per-user opencode daemon + TUI attach / Web proxy 共用 backend。
2. 針對目前不足之處建立一套新的 hardening plan，明確定義需求契約、風險、驗證方式與執行 phases。
3. 讓後續 build mode 可以依據 `/plans/20260323_c-root-daemon-splice-proxy/` 直接執行實作與驗證。

## Scope
### IN
- 重寫 daemon hardening 對應的 proposal / spec / design / implementation-spec / tasks / handoff。
- 明確化 JWT validation、per-user routing、gateway lifecycle、TUI attach contract、runtime verification matrix。
- 產出 IDEF0 / GRAFCET / C4 / sequence artifacts，讓計畫具備可追溯性。
- 為後續 build mode 定義 stop gates、validation、documentation sync 要求。

### OUT
- 直接修改 `daemon/opencode-gateway.c` 或其他 runtime code。
- 在 plan mode 內執行實際 build / test / deploy。
- 重做整個 daemonization 架構或改變其核心理念。
- 自動 formalize 到任何 `specs/` feature root。

## Non-Goals
- 不把 root gateway 改成其他語言或移除 C implementation。
- 不在這次計畫中改動 web UI / TUI UI。
- 不處理與 daemon hardening 無直接關聯的 provider/account 大改版。

## Constraints
- 必須維持「最小特權、明確邊界、單一 per-user backend 真相來源」的架構原則。
- 禁止新增 silent fallback；行為改變必須是顯式契約。
- web runtime 仍必須遵守 `./webctl.sh dev-start|dev-refresh` 單一入口原則。
- 規劃必須反映現有 code evidence，而不是假設不存在的能力已完成。

## What Changes
- 將 daemonization 文件從「prototype 完成敘事」改寫為「hardening backlog + execution contract」。
- 把 JWT、routing、lifecycle、verification 轉成明確 requirement 與 task slices。
- 把 `--attach` 契約正式鎖定為 explicit auto-spawn。
- 把 JWT current reality (`sub` + `exp`) 與 target contract 分開陳述，避免過度承諾。
- 新增 diagrams 與 handoff，使 build agent 可依 artifact 直接展開實作。

## Capabilities
### New Capabilities
- Daemon hardening execution contract：可直接驅動 build mode 實作。
- Gateway verification matrix：把 compile-only、single-user runtime、multi-user isolation、SSE/WS forwarding 分開驗收。
- Traceable diagrams：以 IDEF0/GRAFCET/C4/Sequence 描述功能、狀態、元件與執行流。

### Modified Capabilities
- Existing daemonization spec package：從歷史設計文件升級為 current hardening plan。
- Event/architecture interpretation：從「Phase α 已完成」調整為「prototype landed，hardening pending」。

## Impact
- 影響 `daemon/opencode-gateway.c` 後續實作方向與驗收標準。
- 影響 `webctl.sh` / daemon coordination / TUI attach 的後續契約同步。
- 影響 `docs/events/` 與 `specs/architecture.md` 在 build mode 收尾時的同步內容。
- 影響 build mode 的 stop gates：若 JWT uid strategy 或 streaming verification 無法安全落地，必須回到 planning，而不是邊做邊猜。
