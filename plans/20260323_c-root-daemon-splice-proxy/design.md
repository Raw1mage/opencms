# Design

## Context
- C root gateway (`daemon/opencode-gateway.c`, ~998 行) 是 daemonization 的 privileged edge：PAM auth、public TCP port、fork+setuid+exec、splice proxy。
- 前一輪 hardening（Session 3）修復了 JWT claim validation 與 identity routing 的 demo path，這些修改作為有效基線保留。
- 但前一輪**未識別**事件迴圈架構、HTTP 協議處理、connection lifecycle、splice 正確性等結構性問題。
- 本次 plan 的職責是為這些結構性問題定義修復方案，使 build mode 可直接執行。

## Goals / Non-Goals
**Goals:**
- 修復 event loop 的 blocking I/O 問題（PAM + recv）
- 修復 HTTP request parsing 的 TCP 分段處理
- 修復 epoll fd 辨識與 connection lifecycle 管理
- 強化 JWT secret 持久化、login rate limiting
- 評估並處理 WSL2 環境適配
- 保留前一輪 JWT claim validation 與 identity routing 基線

**Non-Goals:**
- 不把 gateway 改成 application-layer reverse proxy（保持 L4 splice）
- 不重寫整個 daemonization 架構
- 不改動 TUI / webapp UI
- 不在本 plan 中改 code（plan mode only）

## Decisions

### DD-1: Event loop non-blocking 策略 — thread-per-auth
PAM 認證是 inherently blocking 的（呼叫 PAM library）。選項：
- **A) 每個 login request spawn 一個短命 thread 處理 PAM**（選定）
- B) fork 子進程處理 PAM（overhead 更大）
- C) 用 async PAM wrapper（不存在成熟的 async PAM library）

理由：pthread 在 C 中成熟且 overhead 低。PAM auth 是低頻操作（login 不是每個 request 都觸發），thread-per-auth 不會造成 thread 爆炸。Gateway 的 epoll loop 保持 single-thread，只有 PAM path 進 thread。

### DD-2: HTTP request buffering — per-connection state machine
- Accept 後的 fd 設為 non-blocking，加入 epoll
- 為每個「尚未完成 HTTP parse」的連線維護一個 read buffer（per-fd state）
- 每次 EPOLLIN 讀取可用 bytes，累積直到偵測到 `\r\n\r\n`
- 超過 buffer 上限或 timeout → 回 400/408 → close
- Header 完成後才進入 JWT check / login / splice 路徑

### DD-3: epoll fd 辨識 — tagged pointer 或 wrapper struct
現有問題：client_fd 和 daemon_fd 共用 `data.ptr = Connection*`，無法分辨來源。

方案：為每個 epoll-monitored fd 建立一個小 struct：
```c
typedef struct {
    Connection *conn;
    int         is_daemon; /* 0 = client side, 1 = daemon side */
} EpollCtx;
```
`epoll_event.data.ptr = &epoll_ctx`。事件觸發時直接知道方向，只做單方向 splice。

### DD-4: Connection lifecycle 修復
- `close_conn()` 先 `EPOLL_CTL_DEL` 再 `close()`
- `g_nconns` 在 `close_conn()` 中遞減
- 引入 `closed` flag：`close_conn()` 設 flag → 同一輪 epoll 後續事件 check flag → skip
- Connection slot 採 free-list（`next_free` index），避免每次 O(n) scan

### DD-5: JWT secret 持久化 — file-backed
- Gateway 啟動時嘗試讀取 `/run/opencode-gateway/jwt.key`（root-owned, mode 0600）
- 若不存在，生成新 secret 並寫入
- 若存在，載入後驗證長度
- Gateway restart → 載入同一 secret → 既有 JWT 仍有效
- Secret rotation：可透過刪除檔案 + restart gateway 觸發

### DD-6: Login rate limiting — per-source IP sliding window
- 維護 per-IP 的 failed attempt counter（小 hash table）
- 閾值：5 次失敗 / 60 秒 → 後續 request 直接回 429，不進 PAM
- 成功登入 → 清除該 IP 的計數器
- 簡化設計：不需持久化，gateway restart 後計數器重置可接受

### DD-7: WSL2 環境適配
- 前一輪 hardening 移除了 `/tmp/opencode-<uid>/` fallback
- 在 WSL2 上 `/run/user/<uid>/` 通常不存在（除非手動啟用 systemd）
- **決定**：恢復 fallback 路徑邏輯，但以顯式環境偵測為前提：
  1. 先檢查 `/run/user/<uid>/` 是否存在且為該 uid 所有
  2. 若不存在，使用 `$XDG_RUNTIME_DIR`（若已設定）
  3. 若都不可用，使用 `/tmp/opencode-<uid>/`（gateway 負責 mkdir + chmod 700）
  4. 在 log 中明確記錄使用的路徑，不靜默 fallback
- PAM 在 WSL2 上的行為：需在 build mode 實際測試。若 PAM 不可用，gateway 應明確報錯而非 crash。

### DD-8: OPENCODE_BIN 帶空格的安全處理
- 現有 `strchr(g_opencode_bin, ' ')` → `sh -c` 路徑在 setuid 之後執行 shell，稀釋安全邊界
- **決定**：改為 `execvp` + 拆分 argv（在 setuid 之前 parse 好 argv array），不走 shell
- 若 `OPENCODE_BIN` 的格式不可 parse（如包含 shell-specific syntax），fail fast 並 log 錯誤

### DD-9: Keep-alive + splice 安全分析（已解決）
- splice proxy 是 per-identity 建立的：client_fd ↔ daemon_fd 的綁定在 splice 開始時就確定
- HTTP/1.1 keep-alive 的後續 request 天然走同一 splice，不會路由到其他 daemon
- 真正的風險是 cookie theft / session fixation，這是 TLS + HttpOnly + SameSite 的範疇，不在 gateway splice 層處理
- **結論**：splice 層不需要額外的 per-request JWT re-validation。此問題在 design 中記錄為已分析，不產生 task。

### DD-10: 前一輪基線保留
- JWT claim validation（`jwt_verify` 中的 `sub` + `exp` + `getpwnam`）已實作，保留
- Identity routing（`find_or_create_daemon(username)` + uid 比對）已實作，保留
- Daemon lifecycle（adopt-from-discovery + spawn + wait-for-ready）已實作，保留
- 這些不需要重做，但需在 build mode 中一併通過 runtime verification

## Data / State / Control Flow

### Request Lifecycle（修復後目標狀態）

```
Browser → TCP :1080
  → epoll: EPOLLIN on listen_fd
    → accept4() → new client_fd (non-blocking)
    → allocate PendingRequest (read buffer + state)
    → register client_fd to epoll with PendingRequest*

  → epoll: EPOLLIN on pending client_fd
    → read into buffer, accumulate
    → if header complete:
      → parse HTTP request
      → if POST /auth/login:
        → spawn auth thread (PAM + JWT sign)
        → thread completion: send response, close fd
      → if has valid JWT:
        → jwt_verify() → username + uid
        → find_or_create_daemon(username)
        → ensure_daemon_running(d)
        → connect_unix(d->socket_path)
        → start_splice_proxy(client_fd, daemon_fd)
        → forward buffered initial request to daemon_fd
        → register both fds to epoll with EpollCtx*
      → else: serve login page or 401

  → epoll: EPOLLIN on splice client_fd (EpollCtx.is_daemon=0)
    → splice client_fd → pipe → daemon_fd

  → epoll: EPOLLIN on splice daemon_fd (EpollCtx.is_daemon=1)
    → splice daemon_fd → pipe → client_fd

  → epoll: EPOLLHUP|EPOLLERR on any splice fd
    → EPOLL_CTL_DEL both fds → close both → free slot → g_nconns--
```

### State Types

```
PendingRequest {
    int fd;
    char buf[8192];
    size_t buf_len;
    time_t accept_time; /* for timeout */
}

EpollCtx {
    enum { EPOLL_LISTEN, EPOLL_PENDING, EPOLL_SPLICE_CLIENT, EPOLL_SPLICE_DAEMON } type;
    union {
        PendingRequest *pending;
        Connection *conn;
    };
}
```

## Risks / Trade-offs
- **Thread-per-auth** 引入 pthread 依賴與 thread-safety 考量。但 PAM thread 不需要存取 epoll state（只需 fd + response），風險可控。
- **Per-fd buffer** 增加記憶體使用。但 `MAX_CONNS=1024` × 8KB = 8MB，可接受。
- **JWT secret file** 增加一個 root-owned 檔案的管理需求。但比每次重啟失效的體驗好得多。
- **WSL2 fallback 路徑**：恢復 `/tmp` fallback 可能被視為「新增 fallback」，但這是 environment adaptation 而非 behavior fallback。需使用者確認此決定。
- **execvp 拆分 argv**：需要在 fork 前 parse `OPENCODE_BIN`，增加一點複雜度。但消除了 shell injection 風險。

## Critical Files
- `daemon/opencode-gateway.c`
- `plans/20260323_c-root-daemon-splice-proxy/implementation-spec.md`
- `plans/20260323_c-root-daemon-splice-proxy/tasks.md`
- `docs/events/event_20260319_daemonization.md`
- `specs/architecture.md`
