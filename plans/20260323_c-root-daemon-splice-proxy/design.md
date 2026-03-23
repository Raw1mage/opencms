# Design

## Context
- 既有 daemonization 設計採用 C root gateway 接住 privileged edge：PAM auth、public TCP port、fork+setuid+exec、splice proxy；實際 opencode backend 由 per-user daemon 提供。
- 目前 `daemon/opencode-gateway.c` 已具備 login page、PAM、daemon registry、adopt、spawn、splice proxy 原型，但仍有 prototype 痕跡：JWT claim 驗證未完成、後續請求 routing 仍有 demo 路徑、runtime verification 缺乏完整矩陣。
- 舊 spec package 與 architecture / event 之間存在漂移，特別是 TUI `--attach` 的 fail-fast vs auto-spawn 契約。

## Goals / Non-Goals
**Goals:**
- 保留 root gateway + per-user daemon 的核心架構與安全意圖。
- 將 prototype 缺口轉成可執行 hardening backlog。
- 建立明確的 runtime 契約：JWT、identity routing、daemon lifecycle、attach behavior、verification。
- 讓 build mode 可以依 spec 直接修補 code 並驗證。

**Non-Goals:**
- 不重寫整個 daemonization 架構。
- 不把 gateway 升格為 application-layer reverse proxy。
- 不在本次 hardening 重新設計 TUI / webapp UI。

## Decisions
- **DD-1: 保留 architecture，不保留 prototype 敘事。** 本次計畫不推翻 root gateway 架構，而是修正 prototype 與文件成熟度不一致問題。
- **DD-2: 先鎖 planner contract，再談實作。** 在 JWT contract、attach 行為、verification matrix 未在 plan 中寫定前，不進行 gateway code hardening。
- **DD-3: JWT validation 以 claim-complete 為 target contract，但先尊重 current issuance reality。** 目前已知 evidence 指向 gateway 發 token 時包含 `sub` / `exp`，尚未包含 `uid`；因此 build 前必須明確決定是補簽 `uid` 還是以受控方式由 `sub` 反查 uid，不能把 `uid` 當成既存事實。
- **DD-4: Routing 以 verified identity 為唯一 key。** 禁止 first-available daemon、registry insertion order 或任何 implicit fallback。
- **DD-5: Discovery-first lifecycle 明文化。** adopt → spawn → timeout/error 是顯式流程，並要求 stale discovery/socket cleanup 可觀測。
- **DD-6: Attach 契約單一化為 explicit auto-spawn。** `opencode --attach` 找不到 daemon 時，顯式 spawn → wait for readiness → attach；若失敗則明確報錯。spec / architecture / event 不允許再保留 fail-fast 舊敘述。
- **DD-7: 驗證矩陣拆層。** compile、single-user、multi-user、SSE、WebSocket 分層驗證，避免 compile-only completion illusion。

## Data / State / Control Flow
- **Web flow**：Browser → TCP `:1080` → C gateway → login/PAM → verified JWT cookie → identity extraction → adopt-or-spawn target daemon → splice proxy → per-user opencode daemon。
- **Identity flow**：current evidence = JWT payload (`sub`,`exp`)；target contract = verified identity source capable of yielding uid/username. Planner 需先決定最小安全收斂方式（補 `uid` claim 或以 `sub` 受控反查 uid）→ gateway verify → locate daemon by uid/username → registry/discovery sync → connect Unix socket。
- **Lifecycle flow**：request enters → check registry cache → discovery adopt → stale cleanup if invalid → spawn if needed → wait for socket readiness → ready or explicit failure。
- **TUI attach flow**：TUI `--attach` → read discovery → verify contract-defined behavior on missing daemon → direct Unix socket HTTP/SSE。
- **Documentation flow**：build completion 必須同步本次 daemon hardening 對應的 event log 與 `specs/architecture.md`，註明 hardening evidence 與 architecture sync 結果。

## Risks / Trade-offs
- JWT decode/validation 改動會碰觸 auth boundary -> 需以最小修改與明確測試避免引入新的 auth bypass。
- 若目前 JWT issuance 實際上沒有 `uid` claim，過早把 `uid` 寫死進實作可能導致 plan 與 code reality 脫節 -> 先做 contract lock。
- identity-based routing 取代 demo routing 可能暴露更多 lifecycle race -> 需以 discovery-first + explicit timeout 處理。
- attach 契約改為 explicit auto-spawn 會影響部分使用者對 attach=純連線模式的預期 -> 必須在 spec 與 operator docs 中一次說清楚，並保證失敗時是顯式錯誤而非 fallback。
- multi-user runtime verification 在本機環境可能難以完整自動化 -> 需把可自動與需手動驗證分開記錄。

## Critical Files
- `daemon/opencode-gateway.c`
- `plans/20260323_c-root-daemon-splice-proxy/implementation-spec.md`
- `plans/20260323_c-root-daemon-splice-proxy/spec.md`
- `plans/20260323_c-root-daemon-splice-proxy/tasks.md`
- `docs/events/event_20260319_daemonization.md`
- `specs/architecture.md`
