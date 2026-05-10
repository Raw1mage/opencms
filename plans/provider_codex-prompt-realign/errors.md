# Errors: provider_codex-prompt-realign

## Error Catalogue

| Code | Title | Severity | Stage |
|---|---|---|---|
| E1 | Persona file missing or stale | fatal | A.1 |
| E2 | Model-specific prompt md missing | warn (fall back to default.md) | B.4 |
| E3 | Fragment id collision | fatal | A.2 |
| E4 | instructions byte drift mid-session | warn (record event) | A.3 / runtime |
| E5 | prompt_cache_key includes accountId | unit-test failure | A.4 |
| E6 | Server rejects previous_response_id after upgrade | runtime, mitigated by chain reset | A.5 |
| E7 | Subagent identity drift | unit-test / regression | A.2 / B.5 |
| E8 | Plugin transform breaks under narrowed scope | warn + docs | A.3 / B.5 |
| E9 | Cache key TTL expiry vs rotation cooldown | observation only | not in scope |

## Failure modes & contracts

### E1 — Persona file missing or stale

**符號**: Bundled `prompt/codex.txt` 或 template `templates/prompts/drivers/codex.txt` 不存在 / hash 不等於上游 default.md。

**Contract**:
- `SystemPrompt.provider(model)` 必須能 fall through 到 internal `PROMPT_CODEX` const（仍是上游 default.md 內容，build-time `include_str!` 等價）
- 若 internal const 也壞，**fail-loud**（throw）。AGENTS.md 第一條：no silent fallback

**Mitigation**:
- 編譯期 assert `PROMPT_CODEX` 不為空、長度合理
- Smoke test 開機讀一次 `prompt/codex.txt`，比對 hash

### E2 — Model-specific prompt md missing (Stage B.4)

**符號**: model.api.id 對應的 `<slug>_prompt.md` 在 `packages/opencode/src/session/prompt/codex/` 找不到。

**Contract**:
- `SystemPrompt.provider(model)` 走明確 fallback 到 default.md，**並 log.warn**（DD-2 + AGENTS.md no-silent-fallback rule）
- log 訊息必須含 `modelId` 與「fell back to default.md」

**Mitigation**:
- Build-time 對照表檢查（CI lint）
- Runtime warn 不致命，但要可觀測

### E3 — Fragment id collision

**符號**: 兩個 fragment producer 寫同一個 `id` 進 FragmentRegistry。

**Contract**:
- Registry 收到 collision 時**throw**（不 silent overwrite，避免「晚註冊覆蓋早註冊」的隱性 bug）
- Error 訊息含 collision 的 id 與兩個 producer 的 source label

**Mitigation**:
- id 命名規範：`<category>:<name>`（e.g. `agents_md:global`, `skill:plan-builder`）
- 單元測試 cover collision case

### E4 — instructions byte drift mid-session

**符號**: 同 session 同 driver 的兩 turn `instructions` byte 不一致（hash 變了）。

**Contract**:
- `recordSystemBlockHash` 紀錄每 turn instructions hash
- 連續兩 turn hash 不同**且**沒有 model switch / driver change → emit `system.instructions.drift` event 到 runtime event log
- 漂移時不 hard fail（先觀察），但必須留證據

**Mitigation**:
- 先做 dry-run dump 比對（這條 plan 已經做過了：兩 turn hash `c1672b17e7...` 一致）
- Plugin transform 不可注入 timestamp / counter / 任何 per-turn 動態

### E5 — `prompt_cache_key` accidentally includes accountId

**符號**: outbound request 的 `prompt_cache_key` 含 `codex-` / accountId 字樣。

**Contract**:
- 單元測試覆蓋兩個帳號的 request，斷言 key 一致
- Runtime telemetry log key 的 SHA256 prefix；多帳號跨 turn 比對

**Mitigation**:
- DD-6 改動定一條 unit test，CI 必過

### E6 — Server rejects previous_response_id after upgrade

**符號**: 升級到新 wire 結構後，舊 active session 的下一個 request 收到 server 4xx 「invalid previous_response_id」或 chain reset 錯誤。

**Contract**:
- Daemon 啟動偵測 legacy continuation state（disk persisted with old key shape, or schema marker 不匹配） → broadcast `resetWsSession(sessionId)` 給每個 active codex session（DD-9）
- 第一次新 wire 請求必須是 `delta=false hasPrevResp=false`，server 回新 response_id 後才開始 delta

**Mitigation**:
- Stage A.5 task 明確涵蓋
- e2e test 模擬升級場景

### E7 — Subagent identity drift

**符號**: subagent session 的 `RoleIdentity` 渲染成 `Current Role: Main Agent`。

**Contract**:
- `RoleIdentity.body()` 從 `session.parentID` 判定（同 May 9 之前的邏輯來源）
- 單元測試覆蓋 main / subagent 兩種

**Mitigation**:
- TV8 test vector 斷言

### E8 — Plugin transform breaks under narrowed scope

**符號**: existing plugin 期待對 system[]（多元素陣列）操作；新架構 system[] 只剩 driver 一個元素，plugin 行為改變或拋錯。

**Contract**:
- 保留 `experimental.chat.system.transform` hook，input 變窄為 `system: [driverText]`
- 新增 `experimental.chat.context.fragment.transform` 給需要對 fragment list 操作的 plugin 用
- 升級 docs 寫清楚兩個 hook 的責任邊界

**Mitigation**:
- 升級時掃 plugin manifest，warn 用 system.transform 的 plugin 「行為窄化，請評估遷移到 fragment.transform」

### E9 — Cache key TTL expiry vs rotation cooldown

**符號**: rotation 太頻繁，OpenAI 端 5min cache TTL 還沒回到該帳號就被搶走，cache_read 持續低。

**Contract**:
- 不在本 plan 處理（rotation cooldown 是另一條治理線）
- 但 telemetry 要能區分「cache miss 因 TTL」vs「cache miss 因 wire 結構壞」

**Mitigation**:
- Stage A.5 smoke test 在 single-account 場景跑（避免 rotation 干擾）
- 日後 telemetry 補 `cache_miss_cause` 分類

## Error precedence

升級期間的錯誤優先序（高到低）：

1. **E1 (persona missing)** — 直接 build fail，不該到 runtime
2. **E6 (chain reset)** — Stage A.5 必過，否則 Stage A.3 不能 ship
3. **E5 (cache_key drift)** — DD-6 unit test 必過
4. **E4 (instructions drift)** — 觀察為主，留證據
5. **E3 (fragment collision)** — Registry 階段就攔
6. **E7 (subagent identity)** — Subagent regression test 必過
7. **E8 (plugin)** — docs + 升級提示
8. **E2 (model-specific md fallback)** — Stage B.4 範圍
9. **E9 (cache TTL)** — 監測，不直接修
