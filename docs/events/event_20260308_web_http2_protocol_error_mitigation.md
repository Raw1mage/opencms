# Event: Web HTTP2 Protocol Error Mitigation

Date: 2026-03-08
Status: Done

## 1. 需求

- 調查 web console 中 `/global/event` 與 `/provider` 的 `ERR_HTTP2_PROTOCOL_ERROR 200 (OK)`。
- 優先降低 reverse proxy / HTTP2 / SSE 相容性風險。
- 保持 web runtime 正常、避免引入新的登入或串流回歸。

## 2. 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/opencode/src/server/routes/global.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/server/app.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/server/routes/provider.ts`

### OUT

- Nginx / Synology 系統層配置直接修改
- frontend 功能改版
- 非 web runtime 的其他通訊路徑

## 3. 任務清單

- [x] 盤點 `/global/event`、`/provider` 與 SSE/server headers 現況
- [x] 建立 event 與 checkpoints
- [x] 實作 HTTP2/SSE 風險緩解
- [x] 驗證 health / endpoint / webctl runtime
- [x] 記錄 validation 與 architecture sync

## 4. Debug Checkpoints

### Baseline

- 症狀：browser console 顯示 `/global/event`、`/provider` `net::ERR_HTTP2_PROTOCOL_ERROR 200 (OK)`。
- 觀察：runtime health 正常；直接 `curl` 端點可回應，較像 proxy / HTTP2 / SSE framing 相容性問題，而非路由不存在。
- 現況：`global/event` 與 `/event` 均使用 `streamSSE`，但未顯式補 `X-Accel-Buffering: no` / `Cache-Control: no-transform` 等 proxy-friendly headers。

### Execution

- 對 SSE 路由顯式補 proxy-friendly response headers。
- 對 `/provider` 額外補 no-store/no-transform headers，降低代理中途處理差異。
- 保持 API 契約不變，只調整 operational headers 與 write robustness。
- `packages/opencode/src/server/routes/global.ts`：對 `/global/event` 補 `Cache-Control: no-cache, no-store, must-revalidate, no-transform`、`Pragma: no-cache`、`X-Accel-Buffering: no`、`Connection: keep-alive`，並把首個 `writeSSE` 改為 `await`。
- `packages/opencode/src/server/app.ts`：對根路徑 `/event` 套用相同 SSE proxy-friendly headers，並把首個 `writeSSE` 改為 `await`。
- `packages/opencode/src/server/routes/provider.ts`：對 `/provider` 補 `Cache-Control: no-store, no-transform` 與 `Pragma: no-cache`。

### Validation

- `bun x tsc -p packages/opencode/tsconfig.json --noEmit` ✅
- `./webctl.sh dev-start` ✅
- `./webctl.sh status` ✅ `{"healthy":true,"version":"local"}`
- `curl -s http://localhost:1080/api/v2/global/health` ✅ `{"healthy":true,"version":"local"}`
- 說明：因目前 web auth 開啟，未在 CLI 直接取得 authenticated SSE session；本次以 code-path/header 緩解 + runtime health 驗證為主。
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅增補 web server response headers 與 SSE operational robustness，未改變模組拓撲與系統架構。
