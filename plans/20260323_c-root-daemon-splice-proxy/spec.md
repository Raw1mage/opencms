# Spec

## Purpose
- 將 C root gateway splice proxy 從僅通過編譯的 prototype，收斂為結構健全、可驗收的 daemonization gateway。涵蓋 event loop 架構修復、HTTP 協議正確性、connection lifecycle、splice proxy 正確性、安全強化與環境適配。

## Requirements

---

### REQ-1: Gateway event loop SHALL NOT block on individual request handling

Gateway 的 epoll event loop 是所有連線的共享基礎設施。任何單一請求的處理不得阻塞整個 loop。

#### Scenario 1.1: PAM authentication does not block the event loop
- **GIVEN** gateway 正在服務多個併發連線
- **WHEN** 一個使用者提交 login 表單觸發 PAM 認證
- **THEN** PAM 認證過程不得阻塞其他連線的 accept / splice / close 處理
- **Evidence**: 現有 `handle_auth_login()` 直接在 accept path 呼叫 `pam_authenticate_user()`，是 blocking call（`opencode-gateway.c:764`）

#### Scenario 1.2: Initial HTTP request reading does not block the event loop
- **GIVEN** gateway 正在服務多個併發連線
- **WHEN** 一個新連線的 HTTP request 尚未完整到達
- **THEN** gateway 不得在 `recv()` 上阻塞等待，應能繼續處理其他 epoll 事件
- **Evidence**: 現有 `handle_new_connection()` 對剛 accept 的 fd 直接做 blocking `recv()`（`opencode-gateway.c:799`）

---

### REQ-2: Gateway SHALL handle partial and multi-packet HTTP requests

TCP 是 stream protocol，一個 HTTP request 可能分多段到達。Gateway 必須正確組裝完整 request 後再進行 parse。

#### Scenario 2.1: Partial HTTP request is buffered until complete
- **GIVEN** browser 發送一個 HTTP request
- **WHEN** request 被 TCP 分成多個 segment 到達
- **THEN** gateway 緩衝片段直到收到完整的 header（`\r\n\r\n`），再進行解析
- **Evidence**: 現有邏輯只做一次 `recv()` 就直接 `parse_request()`（`opencode-gateway.c:799-804`），truncated request 會被靜默丟棄

#### Scenario 2.2: Oversized or malformed request is rejected explicitly
- **GIVEN** client 發送超過 buffer 容量或格式錯誤的 request
- **WHEN** gateway 偵測到此情況
- **THEN** gateway 回傳明確的 HTTP error response（400/413），不靜默關閉連線

---

### REQ-3: Gateway epoll SHALL distinguish event source per fd

每個被監控的 fd 在 epoll 事件觸發時，必須能明確識別其來源與方向，避免不必要的 syscall 或對已關閉 fd 的操作。

#### Scenario 3.1: Splice proxy event identifies direction without ambiguity
- **GIVEN** client_fd 和 daemon_fd 都已註冊到 epoll
- **WHEN** 其中一個 fd 有資料可讀
- **THEN** epoll event 能直接判斷是 client→daemon 還是 daemon→client 方向，不需要兩個方向都嘗試 splice
- **Evidence**: 現有實作 client_fd 和 daemon_fd 用同一個 `data.ptr = c`（`opencode-gateway.c:637-640`），每次事件做雙倍 splice 嘗試

---

### REQ-4: Connection lifecycle SHALL be bounded and leak-free

每個 connection 從建立到關閉，所有相關資源（fd、pipe、epoll 註冊、slot）都必須正確清理。

#### Scenario 4.1: Connection close properly deregisters from epoll
- **GIVEN** splice proxy 連線正在運作
- **WHEN** 任一端關閉或出錯
- **THEN** 相關 fd 先從 epoll 移除（`EPOLL_CTL_DEL`），再 close fd，再釋放 connection slot
- **Evidence**: 現有 `close_conn()` 直接 close fd，不做 `EPOLL_CTL_DEL`（`opencode-gateway.c:605-612`）

#### Scenario 4.2: Connection counter tracks actual active connections
- **GIVEN** connections 被建立和關閉
- **WHEN** 查詢當前連線數
- **THEN** `g_nconns` 反映真實的 active connection 數量
- **Evidence**: `g_nconns` 在 `start_splice_proxy` 中遞增但在 `close_conn` 中未遞減（`opencode-gateway.c:642` vs `605-612`）

#### Scenario 4.3: In-flight epoll events do not access freed connections
- **GIVEN** 一輪 `epoll_wait` 返回多個事件
- **WHEN** 處理事件 A 導致 connection 被 close
- **THEN** 同一輪中針對同一 connection 的後續事件 B 不得存取已關閉的資源

---

### REQ-5: JWT secret SHALL survive gateway restart

使用者登入取得的 JWT 不應因 gateway 進程重啟而全部失效。

#### Scenario 5.1: JWT issued before restart remains valid after restart
- **GIVEN** 使用者已登入並持有 JWT cookie
- **WHEN** gateway 被重啟（如 webctl.sh dev-refresh）
- **THEN** 使用者不需重新登入，existing JWT 仍可通過驗證
- **Evidence**: 現有 JWT secret 由 `RAND_bytes()` 在每次啟動時隨機生成（`opencode-gateway.c:882`）

---

### REQ-6: Gateway SHALL enforce login rate limiting

防止對 PAM 認證端點的暴力破解攻擊。

#### Scenario 6.1: Repeated failed login attempts are throttled
- **GIVEN** 攻擊者對 `/auth/login` 發送大量請求
- **WHEN** 短時間內來自同一來源的失敗次數超過閾值
- **THEN** gateway 延遲或拒絕後續認證嘗試

---

### REQ-7: Gateway SHALL validate JWT claims before proxying (retained from previous plan)

已在前一輪 hardening 實作，作為基線保留。

#### Scenario 7.1: Valid JWT routes to the correct user daemon
- **GIVEN** 使用者已透過 PAM 登入並持有合法 JWT cookie
- **WHEN** browser 建立新的 HTTP/SSE/WebSocket 連線
- **THEN** gateway 驗證 `sub` + `exp`，以 `sub` → `getpwnam()` 反查 uid，路由到對應 per-user daemon

#### Scenario 7.2: Expired or malformed JWT fails fast
- **GIVEN** request 攜帶過期、缺 claim、簽章錯誤或 decode 失敗的 JWT
- **WHEN** gateway 嘗試驗證 cookie
- **THEN** 回傳 401 / 303 redirect to login，不建立 splice proxy，不 fallback

---

### REQ-8: Gateway SHALL route by authenticated user identity (retained)

已在前一輪 hardening 實作，作為基線保留。

#### Scenario 8.1: Two logged-in users remain isolated
- **GIVEN** alice 與 bob 各自擁有獨立 per-user daemon
- **WHEN** alice 攜帶 alice 的 JWT 發出請求
- **THEN** gateway 只連到 alice 的 daemon socket

---

### REQ-9: Gateway SHALL make daemon lifecycle observable and bounded (retained + reinforced)

#### Scenario 9.1: Stale discovery or socket is rejected
- 行為同前一輪定義，保留

#### Scenario 9.2: Child daemon startup timeout surfaces failure
- 行為同前一輪定義，保留

---

### REQ-10: Environment compatibility SHALL be assessed and handled

Gateway 必須在目標部署環境（包含 WSL2）中可正確運作，或明確拒絕不支援的環境。

#### Scenario 10.1: Missing `/run/user/<uid>/` is handled gracefully
- **GIVEN** 系統未提供 `/run/user/<uid>/`（如 WSL2 無 systemd-logind）
- **WHEN** gateway 嘗試建立或讀取 daemon socket / discovery file
- **THEN** gateway 使用已定義的 fallback 路徑（如 `/tmp/opencode-<uid>/`）或明確報錯
- **Note**: 前一輪 hardening 移除了 `/tmp` fallback。需決定是恢復還是報錯。

#### Scenario 10.2: OPENCODE_BIN with spaces does not weaken privilege boundary
- **GIVEN** `OPENCODE_BIN` 環境變數包含空格（如 source repo 的 bun 指令）
- **WHEN** gateway fork+setuid 後需要 exec per-user daemon
- **THEN** exec 路徑不得走 `sh -c`（避免 shell 注入風險），或以安全方式處理

---

### REQ-11: Splice proxy SHALL correctly handle HTTP/1.1 connection semantics

splice proxy 作為 L4 byte-stream forwarder，必須在 HTTP/1.1 keep-alive 語義下正確運作。

#### Scenario 11.1: Keep-alive connection isolation
- **GIVEN** splice proxy 已建立且 initial request 已轉發
- **WHEN** 同一 TCP 連線上的後續 HTTP request 到達
- **THEN** 這些 request 繼續被轉發到同一 per-user daemon（splice 的正常行為），且不存在跨使用者路由風險
- **Note**: 因 splice proxy 是 per-identity 建立的，後續 keep-alive request 天然綁定同一 daemon。真正的風險是 cookie 被竊取或 session fixation，不是 splice 層的問題。需在 design 中明確此分析。

## Acceptance Checks
- Event loop 在 PAM auth 期間不阻塞其他連線（REQ-1）
- HTTP request 可處理分段到達（REQ-2）
- epoll 事件可分辨來源 fd（REQ-3）
- Connection 資源完整清理且計數正確（REQ-4）
- JWT secret 跨 gateway 重啟有效（REQ-5）
- Login 端點有速率限制（REQ-6）
- JWT claim validation 正確（REQ-7，baseline）
- Identity routing 正確（REQ-8，baseline）
- Daemon lifecycle 可觀測且有界（REQ-9，baseline + reinforced）
- WSL2 環境可正確運作或明確拒絕（REQ-10）
- Keep-alive 語義下無跨使用者風險（REQ-11）
- 驗證矩陣區分 compile / static / single-user / streaming / multi-user（REQ-7 scenario note）
