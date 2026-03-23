# Implementation Spec

## Goal
- 將 C root daemon splice proxy 從 prototype hardening 成可驗收的 daemon gateway，補齊 JWT claims 驗證、per-user identity routing、daemon lifecycle 契約、attach 行為一致性與 runtime verification。

## Scope
### IN
- 更新 daemon hardening 的 plan artifacts，使其與現有 code evidence 一致。
- 在 build mode 中修補 `daemon/opencode-gateway.c` 的 JWT / routing / lifecycle 缺口。
- 在 build mode 中同步 event / architecture 文件，反映 hardening 後的真實狀態。
- 建立可操作的驗證矩陣，區分 compile、single-user runtime、multi-user isolation、SSE/WS forwarding。

### OUT
- 更換整體 daemonization 架構。
- 重做前端 UI 或 provider/account unrelated refactor。
- 自動 formalize 進任何 `specs/` feature root。
- 任何未在本計畫中列出的額外 fallback 機制。

## Assumptions
- `daemon/opencode-gateway.c` 仍是 root gateway 的唯一實作入口。
- 現有 per-user daemon discovery-first 設計（`daemon.json` + Unix socket）維持不變。
- TUI attach 的最終行為已定為 explicit auto-spawn：找不到 daemon 時顯式 spawn、等待 readiness、成功後 attach；失敗或逾時則報錯。
- Linux + PAM + gcc toolchain 仍是此功能的唯一目標環境。

## Current Known Gaps
- 現有 gateway JWT verify 邏輯仍屬 prototype：程式內留有 `TODO`，目前尚未完成完整 decode / claim parse / expiration enforcement。
- 現況 JWT issuance evidence 顯示 payload 只有 `sub` 與 `exp`；`uid` 尚未被寫入 token，因此 target claim contract 與 current issuance reality 之間仍有落差需要在 build 前明確處理。
- 現有 authenticated routing 仍有 demo 痕跡：後續請求路由尚未達到「verified identity → exact per-user daemon」的契約強度。
- TUI `--attach` 契約已在本 plan 鎖定為 explicit auto-spawn，但舊 spec、event、architecture 仍需在後續同步移除 fail-fast 漂移。
- Runtime verification 目前只有 compile 與局部證據，尚未形成完整 single-user / multi-user / SSE / WebSocket 驗證矩陣。
- event / architecture 文件需要在真正 hardening 完成後重新同步，避免延續「prototype 已完成」敘事。

## Stop Gates
- 若 build mode 發現 JWT claim source（payload structure / issuance fields）與現有後端實作不相容，需停下重新規劃 auth contract。
- 若 build mode 無法在不擴大 auth surface 的前提下，從現況 `sub`/`exp` issuance 安全收斂到 target contract（例如補 `uid` claim 或以 `sub` 反查 uid），需停下重新規劃，不可臨時發明 fallback identity source。
- 若 build mode 發現現有 attach implementation 與 explicit auto-spawn 契約衝突且無法以小幅修改收斂，需停下重新規劃，不可自行退回 fail-fast 或其他 fallback。
- 若 runtime verification 需要額外多使用者環境或 root/systemd 權限而目前不可得，需把該部分標記為 deferred evidence，不可假裝完成。
- 若 hardening 需要新增 architecture-changing 行為（例如改變 gateway / daemon 邊界），需回到 planning mode。

## Critical Files
- `daemon/opencode-gateway.c`
- `docs/events/event_20260319_daemonization.md`
- `specs/architecture.md`
- `plans/20260323_c-root-daemon-splice-proxy/proposal.md`
- `plans/20260323_c-root-daemon-splice-proxy/spec.md`
- `plans/20260323_c-root-daemon-splice-proxy/design.md`
- `plans/20260323_c-root-daemon-splice-proxy/tasks.md`
- `plans/20260323_c-root-daemon-splice-proxy/handoff.md`

## Structured Execution Phases
- **Phase 0 — Planner refinement and contract lock**：先把 JWT claim contract、routing key、explicit auto-spawn attach 行為、verification matrix 與 prototype-vs-verified wording 全部寫定；此 phase 不改程式。
- **Phase 1 — Rewrite hardening contract in code-facing terms**：把 planner 已鎖定的契約轉成精確 implementation slices，確認 adopt/spawn lifecycle、stale cleanup、error paths 的邊界。
- **Phase 2 — Implement gateway hardening slices**：依 tasks 修補 `daemon/opencode-gateway.c` 的 JWT validation、identity routing、lifecycle/error paths，並在必要時同步相關啟動/文件路徑。
- **Phase 3 — Validate and sync documentation**：執行 compile 與可得 runtime 驗證、更新 event 與 architecture docs、記錄 deferred evidence。

## Validation
- **Layer V1 — Static Compile**：`gcc -O2 -Wall -D_GNU_SOURCE -o daemon/opencode-gateway daemon/opencode-gateway.c -lpam -lpam_misc -lcrypto`
- **Layer V2 — Static Contract Review**：針對 `daemon/opencode-gateway.c` 與相關 auth flow 做 targeted review，確認不存在 `g_daemons[0]` 或等效 first-available routing，並確認 JWT issuance/validation contract 已一致：token 內有哪些 claims、validation 端如何取出 identity、是否以 `sub` 反查 uid 或改為簽發 `uid`。
- **Layer V3 — Single-user Runtime**：login → issue JWT → subsequent authenticated HTTP request routed to the same user daemon。
- **Layer V4 — Streaming Runtime**：SSE forwarding works through splice proxy；WebSocket upgrade/streaming path behaves as byte-transparent forwarding。
- **Layer V5 — Multi-user Isolation**：若環境可得，alice / bob 各自登入並驗證 request 只到自己的 daemon。
- **Layer V6 — Deferred Evidence Rules**：若 V4/V5 因權限或環境限制無法完成，必須在 event / architecture sync 中明確標註 deferred evidence、缺少的前置條件與未覆蓋風險。
- **Layer V7 — Documentation Sync**：`docs/events/...` 與 `specs/architecture.md` 必須記錄 hardening 結果與 `Architecture Sync: Verified` or updated evidence。

## Handoff
- Build agent must read this spec first.
- Build agent must read companion artifacts before coding.
- Build agent must materialize runtime todo from tasks.md.
- Build agent must preserve fail-fast / explicit-decision posture and must not add fallback routing.
