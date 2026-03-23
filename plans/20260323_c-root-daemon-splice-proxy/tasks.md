# Tasks

## Baseline Status
- 前一輪 Session 3 hardening 的 JWT claim validation、identity routing、daemon lifecycle 修改已在 code 中，作為有效基線保留。
- 本 task tree 從結構性 gap analysis 結果出發，涵蓋前一輪未識別的所有問題。
- 前一輪的 Phase 0-2 / Phase 4 成果視為 baseline，不重列為 task。

---

## Phase 1: Event Loop Architecture Fix (REQ-1, REQ-2)

- [ ] 1.1 Refactor accept path to non-blocking: accept4() → set non-blocking → register to epoll with PendingRequest context → return to loop (不在 accept path 中 recv 或 PAM)
- [ ] 1.2 Implement PendingRequest struct: per-connection read buffer (8KB) + buf_len + accept_time
- [ ] 1.3 Implement buffered HTTP accumulation: EPOLLIN on pending fd → read append → check `\r\n\r\n` → if complete, proceed to routing; if timeout (30s) or oversize → 408/400 → close
- [ ] 1.4 Implement thread-per-auth PAM: POST /auth/login → spawn pthread → PAM auth in thread → result via eventfd/pipe → main loop reads result → send response → close fd
- [ ] 1.5 Verify: epoll loop 在 PAM auth 期間持續 accept 和 splice 其他連線

## Phase 2: epoll & Connection Lifecycle Fix (REQ-3, REQ-4)

- [ ] 2.1 Define EpollCtx tagged struct: `{ enum type, union { PendingRequest*, Connection* } }` — 每個 epoll fd 都有 typed context
- [ ] 2.2 Refactor epoll registration: listen fd / pending fd / splice client fd / splice daemon fd 各用不同 EpollCtx type
- [ ] 2.3 Refactor splice event handling: epoll 事件根據 EpollCtx.type 只做觸發方向的 splice，不做雙向嘗試
- [ ] 2.4 Fix close_conn(): 先 EPOLL_CTL_DEL 兩個 fd，再 close，再遞減 g_nconns
- [ ] 2.5 Add closed flag to Connection: close_conn() set flag → 同一輪 epoll 事件 check flag → skip
- [ ] 2.6 Verify: 建立 + 關閉 100 個連線後 g_nconns == 0，無 fd leak

## Phase 3: Security Hardening (REQ-5, REQ-6, REQ-10.2)

- [ ] 3.1 Implement JWT secret file persistence: 啟動讀 `/run/opencode-gateway/jwt.key`（configurable via `OPENCODE_JWT_KEY_PATH`）；不存在則 RAND_bytes + write；存在則 load + validate length
- [ ] 3.2 Implement login rate limiting: per-IP hash table, 5 failures / 60s → 429, successful login clears counter
- [ ] 3.3 Refactor OPENCODE_BIN exec: fork 前 parse 成 argv array → child 用 execvp → 移除 sh -c path
- [ ] 3.4 Verify: gateway restart 後既有 JWT cookie 仍可通過驗證；6 次快速 failed login 觸發 429

## Phase 4: Environment Adaptation (REQ-10) — STOP GATE: 需使用者確認 WSL2 fallback 策略

- [ ] 4.1 Implement runtime path detection: check `/run/user/<uid>/` → `$XDG_RUNTIME_DIR` → `/tmp/opencode-<uid>/` (mkdir 700) → log selected path
- [ ] 4.2 Implement PAM availability check: 啟動時 probe PAM service → 若不可用，log error 並提供 guidance
- [ ] 4.3 Verify: 在 WSL2 環境下（無 /run/user/）gateway 正確使用 fallback path 且 log 記錄路徑選擇

## Phase 5: Verification Matrix

- [ ] 5.1 V1 — Compile: `gcc -O2 -Wall -Werror -D_GNU_SOURCE -o gateway opencode-gateway.c -lpam -lpam_misc -lcrypto -lpthread`
- [ ] 5.2 V2 — Static review: 確認無 blocking call in epoll loop、無 close without EPOLL_CTL_DEL、無 sh -c in child、JWT claim validation 完整
- [ ] 5.3 V3 — Single-user runtime: login → JWT issue → authenticated HTTP → correct daemon → response
- [ ] 5.4 V4 — SSE forwarding: SSE stream through splice proxy 持續推送 events
- [ ] 5.5 V5 — WebSocket: WebSocket upgrade + bidirectional streaming through splice
- [ ] 5.6 V6 — Multi-user isolation: alice + bob 各自 login，request 只到自己的 daemon（若多使用者環境可得）
- [ ] 5.7 V7 — Stress: 併發 login + splice 不 deadlock、不 leak、rate limiter 正常運作
- [ ] 5.8 V8 — WSL2: 在 WSL2 環境下完成 V1-V3
- [ ] 5.9 Record deferred evidence: 若 V4-V7 因環境限制無法完成，明確記錄缺少前置條件與未覆蓋風險

## Phase 6: Documentation Sync

- [ ] 6.1 Update `docs/events/event_20260319_daemonization.md`: 記錄結構性修復 session 的 scope、decisions、issues、verification
- [ ] 6.2 Update `specs/architecture.md`: 反映修復後的 gateway 架構（event loop model、EpollCtx、PendingRequest、thread-per-auth、JWT persistence、rate limiting、WSL2 adaptation）
- [ ] 6.3 Mark Architecture Sync in event Validation block
