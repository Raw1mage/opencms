# Invariants: session-poll-cache

## Cross-cut Guarantees

### I-1: Cache never serves stale data beyond TTL

任何 `GET /api/v2/session/{id}[/message]` 回應的 body，必為以下三者之一的產物：

1. 距離最後一次 `MessageV2.Event.*` / `Session.Event.*`（對應 sessionID）之後的磁碟讀取（miss 路徑）；
2. 快取條目，且條目 `createdAt` 以來未發生任何上述事件（in-process 同步送達）；
3. 快取條目，且條目年齡 ≤ `session_cache_ttl_sec`（即使事件意外遺失，TTL 兜底）。

**Enforcement point**：
- `session-cache.ts get()` 回傳前檢查 TTL
- 事件訂閱者 call `invalidate(sessionID)`（同一 tick 內完成）
- 驗證：TV-3 + TV-13

### I-2: Bus bridge coverage

任何會產生 `MessageV2.Event.*` 或 `Session.Event.Updated/Deleted/Created` 的寫入路徑（無論哪個程序），其事件**必須**能到達 daemon 程序的本地 bus。

**Enforcement point**：
- Worker 程序透過 `publishBridgedEvent`（task.ts:371-409）轉發
- Tasks 2.1 必須盤點所有寫入路徑，若有遺漏必須補進 bridge 或記錄於 `handoff.md` stop-gate
- 驗證：AC-3（integration test 以 worker 真實寫入觸發）

### I-3: 無靜默降級（AGENTS.md 第一條）

以下狀況**必須**伴隨結構化 log（warn 或 error）：

- cache 初始化時 `Bus.subscribeGlobal` 失敗
- tweaks.cfg 解析失敗（key 格式錯）
- rate-limit middleware 因無法識別使用者而 bypass
- cache loader 內部 throw
- cache-health stats 讀取失敗

**Enforcement point**：
- errors.md 的每條 entry 都要求對應 log 行
- 測試 TV-4、TV-12 專門驗證 log 輸出

### I-4: ETag 強型別 version counter 單調遞增

對任何 sessionID `S`，其 version counter `v(S)` 必須滿足：

- 初始值 = 0
- 任何 `MessageV2.Event.*` 或 `Session.Event.Updated/Created` 對 `S` 發生 → `v(S) += 1`
- `Session.Event.Deleted` 對 `S` 發生 → 計數器條目移除；下次訪問視為 0
- 不存在讓 `v(S)` 減少或重複的路徑

**Enforcement point**：
- counter 的 ++ 僅出現在單一事件 handler 內
- 單元測試驗 counter 嚴格遞增

### I-5: Rate-limit key 不洩漏敏感 URL 參數

Rate-limit bucket key 必須使用 **routePattern**（例如 `/api/v2/session/:id`），**不**得使用帶 sessionID 的原始 URL。

**理由**：
- 每個 sessionID 各自一桶會實質關閉 rate-limit（user 每次打不同 session）
- Key 放進 log 時不應帶實際 sessionID（routePattern 即可）

**Enforcement point**：
- `rate-limit.ts` 禁止把 `c.req.path` 直接當 key；必須用 hono matched pattern
- Code review 時檢查

### I-6: Cache 關閉時不留殘骸

若 `session_cache_enabled=0`：

- 快取條目不被建立
- version counter 不更新
- `/cache/health` 仍可讀（`entries=0`，`subscriptionAlive=false` OR 顯示 `enabled=false`）

**Enforcement point**：
- `session-cache.ts get()` 於 module 頂部檢查 enabled flag；false → 直接 loader
- 測試 AC-6

### I-7: 內部程序間 HTTP 流量不被 rate-limit

當 opencode daemon 的內部元件（worker、scheduler、subagent）透過 HTTP 呼叫本 daemon 時，**不應**被 rate-limit。

識別方式：`hostname === "opencode.internal"` 或 loopback + 已帶有內部 header（詳設計時決定）。

**Enforcement point**：
- `rate-limit.ts` 豁免清單 const
- 任一新內部元件上線時必須驗證其請求會命中豁免

### I-8: 304 回應不重送 body

`304 Not Modified` 回應必須：

- 回傳空 body（不含 JSON）
- 仍帶 `ETag` header
- 不執行 `Session.get / Session.messages` 磁碟讀取（即 ETag 比對只用 version counter）

**Enforcement point**：
- `routes/session.ts` 的 304 分支在 handler 早期 short-circuit
- 測試 TV-5

## 破壞 Invariant 的後果

| Invariant | 若破壞會怎樣 |
|---|---|
| I-1 | 前端顯示舊訊息，使用者感到「訊息沒出現」 |
| I-2 | Cache 永遠不失效，使用者永遠看舊資料 |
| I-3 | daemon 偷偷降級；ops 無從診斷；違反 AGENTS.md |
| I-4 | ETag 失效；304 不再觸發；CPU 又回來 |
| I-5 | Rate-limit 實質關閉；不能防 polling |
| I-6 | 關閉 cache 還留有側效應；debug 困難 |
| I-7 | 內部 subagent 被自己的 daemon 擋；系統自傷 |
| I-8 | 304 還在序列化 body；省下的成本為零 |
