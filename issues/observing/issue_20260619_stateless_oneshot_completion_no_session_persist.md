# BR: 提供「不落地一次性 completion」路徑，讓借用對話層的外部服務不必 create+delete session

Date: 2026-06-19
Scope: opencode daemon — session/message API、對話層對外借用介面（bare agent passthrough）
Status: OBSERVING — Option A 已落地並部署驗證。endpoint `POST /api/v2/completion`（stateless 直呼 LLM.stream，零落地）已在 main（commit 58dcb6573 + merge 0c95e9dbd）；本 session 再修兩段 live-blocking bug：(a) `llm.ts:452/458` `isSubagentSession`/`resolveParentSessionID` 的 `Session.get` 對 ephemeral session 拋 `Storage.NotFoundError` → 加 `.catch(() => undefined)`；(b) `completion.ts` stream 無 timeout 會 hang daemon → 加 120s wall-clock timeout+abort+clearTimeout，timeout 重分類 PROVIDER_ERROR。rewire `app.ts` completion route。restart_self 部署後 live 三測通過（PONG 200 / json_schema 200 / 壞 model 400），session 數 100→100 零落地。
Observing since: 2026-06-19
Exit → closed/: soak 數日 cecelearn 持續呼叫無 daemon-hang / NotFoundError 復發、session store 不堆積；且 cecelearn 端已移除 create+dispose 治標。
  - [DONE 2026-06-19] cecelearn 端已遷移：opencodeBareChatProvider 改單步 POST /api/v2/completion，移除 disposeSession()+create+finally。live 驗證 chat ok / session 數 100→100 零落地。cecelearn issue: observing/issue_20260619_migrate_to_stateless_completion_endpoint.md。
  - [PENDING] soak 數日無復發。
Regress → open: 再現 NotFoundError / daemon hang / session 落地，且查得新 root cause。
Severity: medium（功能正確，但污染 userhome 的 project session store，且每輪多兩個 daemon round-trip）

## Summary

外部服務（cecelearn 小雞老師 web app）借用同機 opencode daemon 的對話層跑無狀態的
intent 分類：每一輪把完整對話 `messages[]` 重新帶入、要一次結構化 JSON 回覆、**不需要
任何持久對話歷史**。但 daemon 目前對外暴露的最小單位是「session」——要拿一次 completion
必須 `POST /api/v2/session` 開一個落地 session，再 `POST /:id/message`。

後果：每一輪小朋友對話都在 daemon 的 session store（`~/.local/share/opencode/sessions`、
sqlite）落地一個 `cecelearn-小雞老師` session，並出現在 `pkcs12` userhome 的 project
session list。這是純服務端一次性中介資料，不該成為使用者可見的 session。

回報者已先用 best-effort「用完即刪」治標（見下「Current workaround」），但這是反模式：

- 每輪多 2 個 daemon round-trip（create + delete）。
- DELETE 比 create 慢（清 95 個歷史殘留時，單次 DELETE 數百 ms，批次清理會逾時）。
- create 成功但 delete 失敗（daemon 重啟、timeout）就漏一個 → 仍會慢慢堆積。
- 本質上是「先污染再打掃」，而非「不污染」。

## Motivation / 為何需要

對話歷史在這類用法下是**呼叫方無狀態持有**的（每次請求帶完整 `messages[]`）。daemon 端的
session 持久層（storage、list、workflow state、continuation ledger）對這條路徑是純負擔：
不需要被列出、不需要被 resume、不需要 autonomous continuation、不需要被 compaction。

需要的只是：給定 `{system, messages/parts, model, format(json_schema)}` → 跑一次 LLM →
回 parts/structured output → 結束，**不寫任何 session/message row、不進 list、不發
session 級 Bus 事件**。

## Proposed solutions（擇一，由 opencode 端定奪）

### Option A（首選）：新增無狀態 completion endpoint

新增類似 `POST /api/v2/completion`（或 `/api/v2/session/oneshot`）：

- 入參：`{ agent?, system, parts[] | messages[], model{providerId,modelID,accountId?}, format? }`
  —— 對齊現有 `POST /:sessionID/message` 的 body 子集，去掉 sessionID。
- 行為：走與現有 message 相同的 provider / rotation / layer-zeroing / json_schema 管線，
  但**不建立 Session.Info、不寫 message/part storage、不進 `Session.listGlobal`、
  不發 session 級 PartUpdated/SessionUpdated Bus 事件**（或只發一個 ephemeral completion 事件）。
- 回傳：與 message 回應同形狀的 `parts[]`（含 StructuredOutput tool part / text parts），
  讓既有解析端零改動。
- 帳號與 rotation：照現有 message 路徑（帳號池或釘 accountId），保持成本歸屬與 quota 行為一致。

優點：徹底不落地，對外語義最乾淨；呼叫端從「create→message→delete」三步變一步。

### Option B（次選）：ephemeral / hidden session 旗標

`POST /api/v2/session` 與 `Session.create` 增一個 `ephemeral: true`（或 `persist: false` /
`listable: false`）旗標：

- 標記後的 session **不寫入會被 `session.list` / `listGlobal` 撈到的索引**（或標 `hidden`
  讓 list 預設過濾），且閒置後由 daemon GC，呼叫端無須顯式 DELETE。
- 對既有 create+message 流程改動最小，但 session 概念仍存在（只是不可見、自動回收）。

優點：改面小、相容；缺點：仍建立了 session 實體，只是隱藏 + 自動回收，不如 A 乾淨。

## 從 cecelearn 消費端立場：最省事的用法長怎樣

（這節是 cecelearn 作為消費方直接講「怎樣的介面我接起來最省事」，給 opencode 端定形用。
強烈傾向 Option A——不要再有 session 概念漏到我這邊。）

**理想：一次 HTTP request 進、一次 response 出，無生命週期管理。** 我手上有的就是
`{完整對話 messages[]、要釘的 model/account、要的 json_schema}`，我要的就是一段結構化回覆。
中間任何「先建一個東西、用完要記得拆」的步驟，對我都是純負擔——我不該需要持有 sessionId、
不該需要 try/finally 收尾、不該需要關心 daemon 重啟時我有沒有漏刪。

### 想要的 request（單一 POST，UDS 同機）

```
POST /api/v2/completion
{
  "agent": "bare",                      // 沿用既有 bare passthrough（layer-zeroing 清人格）
  "system": "<小雞老師 system prompt>",
  "parts": [{ "type": "text", "text": "<把對話渲染成的單一 prompt>" }],
  "model": { "providerId": "claude-cli", "modelID": "claude-opus-4-8", "accountId": "<可選>" },
  "format": { "type": "json_schema", "schema": { /* INTENT_JSON_SCHEMA */ } }
}
```

—— 注意這跟我現在送的 `POST /:sessionID/message` body **幾乎一字不差**，只是把
sessionID 從 URL 拿掉。對我來說遷移成本＝刪掉 create、刪掉 dispose、把 message 的
URL 換成 `/completion`。其餘 provider 設定、parts 解析全部不動。

### 想要的 response（與 message 同形狀，讓我零改解析）

````
200 { "parts": [ { "type": "tool", "tool": "StructuredOutput", "state": { "output": {...} } },
                 { "type": "text", "text": "...```json ...```" } ] }
````

我端已經有「優先抓 StructuredOutput tool part，抓不到再從 text parts 撈 ```json fence」
的解析（claude-cli 軟性結構化的現實）。只要 `parts[]`形狀跟現在 message 回應一致，
我這段`extractStructuredJson` 一行都不用改。

### 對我最關鍵的三件事（按重要性）

1. **呼叫後 `GET /api/v2/session` 數量不變。** 這是整個 BR 的初衷——我的對話不該變成
   pkcs12 userhome 的可見 project session。成功、LLM 失敗、daemon 內部錯，都不准落地。
2. **不要把任何清理責任丟回給我。** 不要「建了一個 ephemeral session、但要我呼叫 DELETE
   或設 TTL」。我要的是 fire-and-forget；GC 是 daemon 的事。（這也是我偏好 A 而非 B 的原因：
   B 仍要我相信 daemon 的自動回收，A 根本沒東西要回收。）
3. **失敗碼要能讓我區分「可掉接 vs 不可掉接」。** 我有 cascade 邏輯：bare 連線/daemon
   錯/rate-limit/抽不到 JSON → 掉接 Gemini；但使用者輸入問題（BAD_REQUEST）不掉接。
   只要 response 能讓我分辨「上游可用性失敗」與「請求本身有問題」，cascade 就接得上。

### 不需要、請別為我加的東西

- 不需要 streaming（我要的是一次拿完整結構化結果，SSE 對 intent 分類無意義）。
- 不需要 session resume / continuation / autonomous / compaction（這條路徑天生無狀態）。
- 不需要回給我 sessionId / messageId / 任何要我保管的 handle。
- 不需要把這次 completion 記進任何 list / 歷史 / telemetry-as-session（帳號級 quota 計費
  照舊即可，但不要產生「一個 session」這個可見實體）。

一句話：**把現在的 `POST /:sessionID/message` 去掉 sessionID、去掉落地，就是我要的全部。**

## Acceptance Criteria

- 存在一條對外路徑，可用 `{system, messages/parts, model, format}` 取得一次結構化 completion，
  **過程中 `GET /api/v2/session` 的結果數量不增加**（不論成功或 LLM 失敗）。
- 該路徑與現有 message 路徑共用 provider / rotation / 帳號歸屬 / json_schema 行為（不另立一套）。
- 回應形狀讓現有 `opencodeBareChatProvider` 的 parts 解析（StructuredOutput tool part →
  text fence fallback）零改動或極小改動即可接上。
- 失敗語義明確（daemon error / rate-limit / provider 錯）可被呼叫端區分，維持 cascade 掉接邏輯。
- 回歸測試：呼叫該路徑 N 次後，session 計數不變、storage 無新 row。

## Evidence

- 回報前 daemon session store 內 `cecelearn-小雞老師` 堆積達 95 個（`GET /api/v2/session`
  篩 `title=="cecelearn-小雞老師"`），全為一次性 intent 分類殘留。
- 呼叫端程式：`~/projects/cecelearn/webapp/backend/src/providers/opencodeBareChatProvider.ts`
  `chat()` 內 `POST /api/v2/session {title:'cecelearn-小雞老師'}` → `POST /:id/message`
  （`agent:'bare'`, `format:{type:'json_schema'}`, 釘 model）。該 provider 自身註解即寫明
  「後端 provider 目前無狀態（每次 chat() 拿完整 messages[]），開一個一次性 bare session。
  session 重用屬日後優化。」——印證這條路徑不需要 session 持久層。

## Current workaround（cecelearn 端，治標，待本 BR 落地後移除）

`opencodeBareChatProvider` 已加 `disposeSession()` + `chat()` 的 `finally` best-effort
`DELETE /api/v2/session/:id`（commit 於 cecelearn repo，event log
`cecelearn/event_2026-06-19_*`）。本 BR 在 daemon 端落地 Option A/B 後，呼叫端可回到單步、
移除 dispose 邏輯。

## Related daemon code anchors（供實作者定位，非授權改動）

- `packages/opencode/src/server/routes/session.ts`：`POST /` (create)、`POST /:sessionID/message`、
  `GET /`（list，`Session.listGlobal`）、`DELETE /:sessionID`。
- `packages/opencode/src/session/index.ts`：`Session.create` / `update` / storage 寫入路徑。
- `packages/opencode/src/session/storage/*`：sqlite / legacy 落地層（一次性路徑要繞過）。
