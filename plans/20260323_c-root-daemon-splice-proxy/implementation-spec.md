# Implementation Spec

## Goal
- 將 C root daemon splice proxy 從僅通過編譯的 prototype 修復為結構健全的 gateway。修復 event loop blocking、HTTP parsing、connection lifecycle、epoll 辨識；強化 JWT persistence、login rate limiting；處理 WSL2 環境適配。

## Scope
### IN
- Event loop 架構重構：non-blocking accept path + thread-per-auth PAM
- HTTP request buffering：per-connection state machine，處理 TCP 分段
- epoll fd 辨識：tagged EpollCtx struct
- Connection lifecycle 修復：EPOLL_CTL_DEL + counter + closed flag
- JWT secret file-backed persistence
- Login rate limiting（per-IP sliding window）
- WSL2 environment detection + runtime path fallback
- OPENCODE_BIN argv parsing（消除 sh -c）
- 前一輪基線保留（JWT claim validation、identity routing、daemon lifecycle）
- Runtime verification matrix 執行
- Documentation sync

### OUT
- 更換整體 daemonization 架構
- Application-layer HTTP parsing / reverse proxy（保持 L4 splice）
- 前端 UI 或 provider/account 改動
- 自動 formalize 到 `specs/` feature root
- 任何未在本計畫中列出的 silent fallback

## Assumptions
- `daemon/opencode-gateway.c` 仍是 root gateway 的唯一實作入口
- Linux + PAM + gcc + pthread 是目標 toolchain
- 前一輪 hardening 的 JWT verify / identity routing / lifecycle 修改作為有效基線
- WSL2 是其中一個部署目標（單使用者環境）

## Current Known Gaps（結構性）

| Gap | Ref | 嚴重度 | Code Evidence |
|---|---|---|---|
| Event loop blocked by PAM + recv | REQ-1 | 致命 | L764, L799 |
| Single recv() assumes complete HTTP | REQ-2 | 致命 | L799-804 |
| epoll can't distinguish fd source | REQ-3 | 高 | L637-640 |
| Connection lifecycle leaks | REQ-4 | 高 | L605-612, L642 |
| JWT secret volatile on restart | REQ-5 | 中 | L882 |
| No login rate limiting | REQ-6 | 中 | — |
| WSL2 /run/user/ may not exist | REQ-10 | 中 | — |
| OPENCODE_BIN sh -c after setuid | REQ-10.2 | 中 | L569-574 |

## Stop Gates
1. 若 thread-per-auth 模型在實際 PAM 使用中引入不可控的 thread-safety 問題，停下重新評估（改用 fork-per-auth）
2. 若 HTTP buffering state machine 的複雜度超過可控範圍，停下評估是否改用 lightweight HTTP parser library
3. 若 WSL2 fallback 路徑方案需使用者確認（恢復 `/tmp` 路徑 vs 強制要求 `/run/user/`），在 Phase 4 前取得決策
4. 若 runtime verification 需要額外多使用者環境或 root/systemd 權限而不可得，標記 deferred evidence
5. 若任何修改會改變 gateway / per-user daemon 邊界，回到 planning mode

## Critical Files
- `daemon/opencode-gateway.c`
- `docs/events/event_20260319_daemonization.md`
- `specs/architecture.md`
- `plans/20260323_c-root-daemon-splice-proxy/tasks.md`

## Structured Execution Phases

### Phase 1 — Event Loop Architecture Fix (REQ-1, REQ-2)
**Objective**: 消除 event loop 中的 blocking I/O

1.1 **Non-blocking accept path**: accept 後的 fd 設為 non-blocking，不在 accept path 中做 `recv()` 或 PAM
1.2 **Per-connection read buffer**: 新增 `PendingRequest` struct，為每個尚未完成 HTTP parse 的連線維護 read buffer
1.3 **Buffered HTTP accumulation**: 每次 EPOLLIN 讀取可用 bytes，累積到 `\r\n\r\n`，超時或超大 → 回 error → close
1.4 **Thread-per-auth PAM**: POST `/auth/login` 時 spawn `pthread` 做 PAM 認證。thread 完成後將結果交回主 loop（pipe or eventfd 通知）
1.5 **Accept path 驗證**: 確認 epoll loop 在 PAM 期間不阻塞

### Phase 2 — epoll & Connection Lifecycle Fix (REQ-3, REQ-4)
**Objective**: 消除 fd 辨識歧義與資源洩漏

2.1 **EpollCtx tagged struct**: 建立 `EpollCtx`，每個 epoll-registered fd 都有自己的 context（type + conn/pending pointer）
2.2 **EPOLL_CTL_DEL before close**: `close_conn()` 先移除 epoll 註冊
2.3 **g_nconns 雙向追蹤**: close 時遞減
2.4 **Closed flag guard**: 防止同一輪 epoll 事件存取已關閉 connection
2.5 **Connection slot management**: 考慮 free-list 或保持現有 scan（MAX_CONNS=1024 足夠小）
2.6 **splice 單方向化**: epoll 事件只做觸發方向的 splice，不做雙向嘗試

### Phase 3 — Security Hardening (REQ-5, REQ-6, REQ-10.2)
**Objective**: 強化 JWT 持久化、login 防護、exec 安全

3.1 **JWT secret file**: 啟動時讀/寫 `/run/opencode-gateway/jwt.key`（或 configurable path）
3.2 **Login rate limiting**: per-IP failed counter，閾值 5/60s → 429
3.3 **OPENCODE_BIN argv splitting**: 在 fork 前 parse 成 argv array，child 用 `execvp`，不走 `sh -c`

### Phase 4 — Environment Adaptation (REQ-10)
**Objective**: 確保 WSL2 可正確運作

4.1 **Runtime path detection**: 偵測 `/run/user/<uid>/` 可用性，fallback 到 `$XDG_RUNTIME_DIR` 或 `/tmp/opencode-<uid>/`
4.2 **PAM availability check**: 若 PAM 服務不可用，啟動時明確報錯
4.3 **Log 路徑一致性**: daemon 各路徑選擇均記錄到 log

### Phase 5 — Verification Matrix
**Objective**: 分層驗證所有修復與基線功能

- **V1 — Compile**: `gcc -O2 -Wall -Werror -D_GNU_SOURCE -lpam -lpam_misc -lcrypto -lpthread`
- **V2 — Static review**: 確認無 blocking call in epoll loop、無 close without EPOLL_CTL_DEL、無 sh -c in child
- **V3 — Single-user runtime**: login → JWT → authenticated request → daemon → response
- **V4 — Streaming**: SSE forwarding through splice proxy、WebSocket upgrade 透傳
- **V5 — Multi-user isolation**: alice / bob 各自 login 且 request 隔離（若環境可得）
- **V6 — Stress**: 併發 login + splice 不 deadlock / 不 leak connection slot
- **V7 — WSL2**: 在 WSL2 環境下完成 V1-V3（V4-V5 可能需 deferred）
- **V8 — Deferred evidence**: 若 V4/V5/V6 因環境限制無法完成，明確記錄缺少的前置條件

### Phase 6 — Documentation Sync
**Objective**: 同步 event log 與 architecture

6.1 更新 `docs/events/event_20260319_daemonization.md`：記錄結構性修復的決策與驗證證據
6.2 更新 `specs/architecture.md`：反映修復後的 gateway 架構（event loop model、connection lifecycle、security features）
6.3 在 event Validation 區塊標註 Architecture Sync 結果

## Validation
- 每個 Phase 完成後都有對應的驗證步驟（見 tasks.md）
- Verification matrix V1-V8 是 Phase 5 的細項
- Documentation sync 是 completion gate 的必要條件

## Handoff
- Build agent must read this spec first
- Build agent must read design.md for decisions DD-1 through DD-10
- Build agent must materialize tasks.md into runtime todos
- Build agent must preserve fail-fast / explicit-decision posture
- Build agent must not add silent fallback
- **WSL2 fallback path（DD-7）需在 Phase 4 前取得使用者確認**
