# Plan: Published Web Service Health & Lifecycle Control

## 目標

在 Published Web 卡片中為每個 route 加上：
1. **健康燈號** — 即時顯示 backend service 是否存活（綠/紅）
2. **Toggle 開關** — 可直接啟動/停止對應的 web service

## 背景

- WSL 重置後所有 web services 停止，但 gateway 的 `web_routes.conf` 還在，造成 route 指向死後端
- 目前 Published Web 卡片只顯示 route 資訊，無法看出 service 是否活著
- 各 web app 各自有 `webctl.sh`（cecelearn、linebotweb），但 lifecollection 還沒有

## 架構設計

### 資料流

```
web_registry.json  ──→  Daemon API  ──→  Frontend Dialog
(projectRoot,           (health probe     (燈號 + toggle)
 entryName,              + webctl.sh
 port, enabled)          invocation)
```

### 層次分工

| 層 | 職責 |
|---|------|
| **web_registry.json** | SSOT：每個 app 的 projectRoot、port、enabled 狀態 |
| **Daemon API** (web-route.ts) | 新增 `health` + `toggle` endpoints |
| **Frontend** (dialog-published-web.tsx) | 燈號 UI + toggle 按鈕 |

### 1. Registry 擴充 (`~/.config/web_registry.json`)

補齊所有 web apps（目前只有 cecelearn）：

```json
{
  "version": 1,
  "entries": [
    {
      "entryName": "cecelearn",
      "projectRoot": "/home/pkcs12/projects/cecelearn",
      "publicBasePath": "/cecelearn",
      "host": "127.0.0.1",
      "ports": [5173, 3014],
      "primaryPort": 5173,
      "enabled": true,
      "access": "public"
    },
    {
      "entryName": "linebot",
      "projectRoot": "/home/pkcs12/projects/linebotweb",
      "publicBasePath": "/linebot",
      "host": "127.0.0.1",
      "ports": [3015],
      "primaryPort": 3015,
      "enabled": true,
      "access": "protected"
    },
    {
      "entryName": "lifecollection",
      "projectRoot": "/home/pkcs12/projects/lifecollection/lifecollection-web",
      "publicBasePath": "/lifecollection",
      "host": "127.0.0.1",
      "ports": [8090],
      "primaryPort": 8090,
      "enabled": true,
      "access": "public"
    }
  ]
}
```

### 2. Server-side API 新增 (web-route.ts)

#### `GET /api/v2/web-route/health`

對每個 registry entry 做 TCP connect probe (timeout 2s)：

```typescript
// Response
{
  "ok": true,
  "status": {
    "cecelearn": { "alive": false, "port": 5173 },
    "linebot":   { "alive": false, "port": 3015 },
    "lifecollection": { "alive": true, "port": 8090 }
  }
}
```

實作：用 `net.createConnection` 嘗試連 host:primaryPort，連上即 alive，timeout/refused 即 dead。

#### `POST /api/v2/web-route/toggle`

```typescript
// Request
{ "entryName": "cecelearn", "action": "start" | "stop" }

// Response
{ "ok": true } | { "ok": false, "error": "..." }
```

實作：
1. 從 registry 找到 entry 的 `projectRoot`
2. 檢查 `${projectRoot}/webctl.sh` 存在
3. `spawn("bash", [webctlPath, action])` with timeout 30s
4. 若 action=start 且成功，確保 route 在 gateway 中已 publish
5. 若 action=stop 且成功，可選擇保留 route（讓 gateway 顯示 dead）或移除

### 3. Frontend UI 變更 (dialog-published-web.tsx)

#### 燈號

每個 route item 左側加一個圓點：
- `bg-emerald-500` — alive
- `bg-red-500` — dead
- `bg-zinc-500 animate-pulse` — checking

#### Toggle 按鈕

Dropdown menu 中加入：
- Service alive → "Stop service"
- Service dead → "Start service"
- 點擊後呼叫 toggle API，完成後 re-probe health

#### 自動刷新

- Dialog 開啟時自動 probe health
- Refresh 按鈕同時刷新 routes + health
- Toggle 操作後自動 re-probe（延遲 2s 讓 service 有時間啟動）

### 4. Client API 擴充 (api.ts)

新增：
```typescript
health(): Promise<Record<string, { alive: boolean; port: number }>>
toggle(entryName: string, action: "start" | "stop"): Promise<{ ok: boolean; error?: string }>
```

## 涉及檔案

| 檔案 | 變更 |
|------|------|
| `~/.config/web_registry.json` | 補齊所有 entries |
| `packages/opencode/src/server/routes/web-route.ts` | +health +toggle endpoints |
| `packages/app/src/pages/web-routes/api.ts` | +health +toggle client methods |
| `packages/app/src/components/dialog-published-web.tsx` | 燈號 UI + toggle 按鈕 |

## 設計決策

1. **Health check 在 server-side** — 避免 CORS/mixed-content 問題，且 daemon 和 backend 在同一台機器
2. **Registry 是 SSOT** — gateway routes.conf 是 registry 的衍生物，不反向推導
3. **webctl.sh 是 convention** — 每個 web app 必須有 webctl.sh 並支援 start/stop 指令
4. **Toggle 不自動移除 route** — 停止服務後 route 保留在 gateway，只是燈號變紅，方便隨時重啟

## 待確認

- [ ] lifecollection 需要補一個 webctl.sh
- [ ] registry format 變更是否需要 migration（目前 v1→v1 欄位擴充，向後相容）
