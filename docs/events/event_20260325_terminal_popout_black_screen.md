# 2026-03-25 Terminal Popout Black Screen — Full RCA

## 需求
修正 terminal popout 在手機/PC 瀏覽器中顯示黑屏的問題。

## 範圍
### IN
- Gateway JWT lifecycle 與 auth enforcement
- Terminal WebSocket 連線死循環
- SPA auth gate 與 gateway auth 端點對齊
- Debug log 清理

### OUT
- 不重構 terminal lifecycle
- 不新增 fallback mechanism

## Root Cause Analysis（完整鏈路）

### 觸發條件
`webctl.sh dev-refresh` 執行 `systemctl restart opencode-gateway` → gateway process 重啟。

### 問題鏈

| # | 問題 | Root Cause | 修復 |
|---|---|---|---|
| 1 | JWT key 遺失 | Gateway JWT key 存在 `/run/` tmpfs，restart 後重新生成 → 所有瀏覽器 JWT 失效 | JWT key 移至 `/var/lib/opencode-gateway/jwt.key`（StateDirectory persistent） |
| 2 | API/WS 無 JWT 回應錯誤 | Gateway 對無 JWT 的 `/api/*` `/pty/*` 請求回傳 200 login HTML 而非 401 JSON → SPA 無法解析 | Gateway `route_complete_request()` 新增 API/WS 路徑偵測，回傳 401 JSON |
| 3 | SPA 無法重新登入 | SPA login 走 `/global/auth/login`（JSON API），但該路徑被 gateway 的 JWT check 擋住 | Gateway 新增 SPA auth 端點處理（`/global/auth/session`, `/global/auth/login`, `/global/auth/logout`），在 JWT check 之前直接回應 |
| 4 | Terminal WebSocket 死循環 | `onConnectError → clone() → POST /api/v2/pty → WebSocket fail → onConnectError` 無限循環 → bash process 堆積 → SIGILL crash | `terminal.clone()` 加 3 秒 rate limit |
| 5 | Clone 後 Terminal 不 remount | `<Show when={selectedPTY()}>` 未加 `keyed` → PTY 替換後 Terminal 不 remount | 加 `keyed` 屬性 |
| 6 | **Fork fd leak — bun 繼承 listen socket** | Gateway `fork()` 後子程序未關閉 `g_listen_fd`、`g_epoll_fd`，bun daemon 繼承 port 1080 listen fd → kernel 隨機將連線分派至 bun 而非 gateway → WebSocket 永遠失敗 | (a) 子程序 exec 前 `close()` 所有 gateway fd (b) 創建時加 `SOCK_CLOEXEC` / `EPOLL_CLOEXEC` (c) webctl.sh 啟動前清除所有佔用 port 的 stale process |

### 關鍵觀察
- Terminal shell 的 PAM 身份來自 daemon（gateway PAM auth 成功後以該 user 身份啟動），**不是** terminal 端的問題
- 根本原因鏈：JWT key 遺失 → SPA 無法 re-auth → 但即使修復 auth，**fork fd leak 才是 WebSocket 最終失敗的根因**——bun 繼承 listen socket 導致 gateway splice proxy 無法建立

## 修改檔案

### `daemon/opencode-gateway.c`
- JWT key path: `/run/` → `/var/lib/opencode-gateway/jwt.key`（persistent）
- JWT verify 失敗: 回傳 401 + `Set-Cookie: oc_jwt=; Max-Age=0` header
- 新增 SPA auth 端點（在 JWT check 之前）:
  - `GET /global/auth/session` → `{"enabled":true,"authenticated":false}`
  - `POST /global/auth/login` → PAM auth → Set-Cookie + JSON response
  - `POST /global/auth/logout` → 清除 cookie
- API/WS fallback: `/api/*` `/pty/*` 無 JWT → 401 JSON 而非 200 login HTML
- `send_login_success_ex()`: 支援 JSON API mode（Set-Cookie header + JSON body）
- `submit_auth_job_ex()`: 支援 `is_json_api` flag
- `drain_auth_completions()`: PAM 失敗時依 `is_json_api` 回傳 JSON 或 HTML redirect
- **Fork fd leak 修復**: listen socket 加 `SOCK_CLOEXEC`，epoll 加 `EPOLL_CLOEXEC`，子程序 exec 前顯式 `close(g_listen_fd/g_epoll_fd/g_auth_eventfd)`
- `/global/auth/session` 回傳 `{"enabled":false,"authenticated":true}`（gateway 模式下抑制 SPA AuthGate）
- `authorizedFetch` 401 + gateway 模式 → `window.location.replace("/")` 導向 gateway PAM 登入頁

### `daemon/opencode-gateway.service`
- 加 `StateDirectory=opencode-gateway`

### `packages/app/src/pages/session/terminal-popout.tsx`
- `<Show when={selectedPTY()}>` 加 `keyed`

### `packages/app/src/context/terminal.tsx`
- `clone()` 加 3 秒 rate limit（`lastCloneAt` meta）

### `packages/app/src/components/terminal.tsx`
- 移除所有 `[TERM-DEBUG]` / `[PTY CLIENT]` debug logs

## Validation

### Gateway Auth Endpoints（curl 驗證）
- [x] `GET /api/v2/global/health` → 200 JSON（不需 auth）
- [x] `GET /api/v2/global/event` 無 JWT → **401** `{"error":"unauthorized"}`
- [x] `GET /global/auth/session` 無 JWT → 200 `{"enabled":true,"authenticated":false}`
- [x] `POST /global/auth/login` bad creds → **401** `{"error":"Invalid username or password"}`
- [x] Gateway compile: zero warnings

### Fork Fd Leak 修復驗證
- [x] Gateway compile: zero warnings (`-Wall -Wextra -Werror`)
- [x] Gateway restart 後 `ss -tlnp :1080` 僅顯示 `opencode-gateway`（無 bun）
- [x] `SOCK_CLOEXEC` 設於 `g_listen_fd`，`EPOLL_CLOEXEC` 設於 `g_epoll_fd`
- [x] 子程序 exec 前顯式 close 三個 gateway fd

### Build
- [x] Gateway 編譯通過
- [x] Frontend build 通過
- [x] `dev-refresh` 完成（gateway 使用 persistent JWT key）

### Architecture Sync
- Gateway auth flow 為新增功能（SPA auth 端點），不影響既有模組邊界或資料流
- Terminal clone rate limit 為防禦性修改，不影響狀態機
- Architecture Sync: Verified (No doc changes needed — gateway auth is deployment-level, not in specs/architecture.md scope)

### `webctl.sh`
- `kill_existing()`: 改為殺死**所有**佔用 port 的 PID（不只第一個），防止繼承 fd 的 bun 殘留
- Gateway 啟動前新增 stale port 清除邏輯

### Nginx Reverse Proxy WebSocket（NAS 端）

| # | 問題 | Root Cause | 修復 |
|---|---|---|---|
| 7 | cms.thesmart.cc terminal WebSocket 失敗，crm.sob.com.tw 正常 | Synology DSM nginx reverse proxy 預設不傳遞 `Upgrade` / `Connection` headers → nginx 將 `Connection: Upgrade` 改寫為 `Connection: close` → WebSocket handshake 失敗 | 直接編輯 `server.ReverseProxy.conf`，在 cms server block 的 `location /` 內注入 `proxy_set_header Upgrade $http_upgrade` + `proxy_set_header Connection "upgrade"` |

#### 關鍵發現

- **`user.conf` 機制在當前 DSM 版本無效**：`/usr/local/etc/nginx/conf.d/<UUID>/user.conf` 雖然是網路上廣泛記載的 Synology 持久化方式，但當前 NAS 的 `server.ReverseProxy.conf` **沒有** `include conf.d/<UUID>/*` 指令，user.conf 完全不會被載入
- **crm.sob.com.tw 的做法**：直接在 `server.ReverseProxy.conf` 的 `location /` 內手動添加 WebSocket headers（Method A）
- **注意**：此修改會在 DSM UI 編輯任何 reverse proxy 設定時被覆蓋，需重新 patch
- 完整方法已記錄為 skill：`~/projects/skills/synology_nginx/SKILL.md`

#### 驗證
- [x] `nginx -t` 通過
- [x] `nginx -s reload` 成功
- [x] `nginx -T` 確認 cms.thesmart.cc 有 Upgrade/Connection headers
- [x] cms.thesmart.cc terminal WebSocket 連線正常

## 狀態

**CLOSED** — 所有問題已修復並驗證。

## 後續
- Synology DSM 若重新生成 nginx config（如 UI 修改 reverse proxy），需重新 patch WebSocket headers
- 瀏覽器需重新登入以取得新 JWT（一次性操作）
- 登入後所有 API/WebSocket 通過 gateway proxy 到 daemon → terminal 可用
