# Tasks: codex-fingerprint-alignment

執行順序：Phase 1 → Phase 3 → beta 驗證 → fetch-back → Phase 2 → Phase 4。每個 phase 跑完就可以 stop gate（除非使用者進入 autorun / build_mode）。

## 1. Phase 1 — WS transport inline fingerprint hotfix

- [x] 1.1 開 XDG 白名單備份（依 AGENTS.md 新規則，只備關鍵設定檔）：
  ```bash
  BAK=~/.config/opencode.bak-$(date +%Y%m%d-%H%M)-codex-fingerprint
  mkdir -p "$BAK"
  for f in accounts.json opencode.json managed-apps.json gauth.json mcp.json mcp-auth.json \
           openai-codex-accounts.json models.json providers.json AGENTS.md; do
    [ -f ~/.config/opencode/"$f" ] && cp -a ~/.config/opencode/"$f" "$BAK"/
  done
  [ -f ~/.local/share/opencode/accounts.json ] && cp -a ~/.local/share/opencode/accounts.json "$BAK"/accounts.json.legacy-share
  ls -la "$BAK"  # 驗證 accounts.json 存在
  ```
  本 spec 不動 state/data 層，故**不擴大備份**（依新規則的例外條款）。
- [x] 1.2 建 beta worktree + branch：依 `beta-workflow` skill 建 `beta/codex-fingerprint-alignment`
- [x] 1.3 在 `packages/opencode-codex-provider/src/transport-ws.ts:460-466` inline 補 `User-Agent`，值用 `buildCodexUserAgent()`（透過 provider factory options.userAgent 注入；caller = provider.ts:187）
- [x] 1.4 同一 header 區塊把 `chatgpt-account-id`（lowercase）改為 `ChatGPT-Account-Id`（TitleCase）
- [x] 1.5 新增 `transport-ws.test.ts`：7 個 case 覆蓋 TitleCase / UA present / UA omitted / originator prefix 對齊 / Authorization+originator+OpenAI-Beta 永送 / turn-state flow / no-accountId。另 export helper `buildWsUpgradeHeaders` 為 Phase 2 整併預留 seam
- [x] 1.6 跑 `bun test packages/opencode-codex-provider` 全綠（43 pass / 0 fail / 97 expect）
- [x] 1.7 ~~beta daemon 啟動跑對話抓 log~~ — 改採 fetch-back 策略：Phase 1 code 從 `beta/codex-fingerprint-alignment` 拉進 `test/codex-fingerprint-alignment`，實際 header 驗證延到 §3 beta soak（unit test 已覆蓋 header 邏輯；真流量 1st-party 比例只能靠 OpenAI 官網後台人工觀察）
- [x] 1.8 Phase 1 slice summary 寫入 `docs/events/event_20260424_codex_fingerprint_phase1.md`

## 2. Phase 3 — refs/codex submodule 同步 + CODEX_CLI_VERSION

- [x] 2.1 `git -C refs/codex fetch --tags`（執行於 main，取得 rust-v0.125.0-alpha.* / rust-v0.125.0-alpha.3 新 tag）
- [x] 2.2 盤點 diff：6 個 commit 覆蓋 AuthProvider 重構 / rollout tracing / AgentIdentity net-zero / CF cookie / guardian
- [x] 2.3 判斷 diff 影響：**No blocker** — 無新必要 header / body；CF cookie 列 follow-up。記錄於 `docs/events/event_20260424_codex_upstream_diff.md`
- [x] 2.4 `git -C refs/codex checkout rust-v0.125.0-alpha.1`（主 repo 在 commit `57cde900a` 已執行；beta submodule 已同步）
- [x] 2.5 main 已 `git add refs/codex` 並 commit（`57cde900a`）
- [x] 2.6 `CODEX_CLI_VERSION = "0.125.0-alpha.1"` — commit `c8ac6f7ec` on `beta/codex-fingerprint-alignment`
- [x] 2.7 `bun test packages/opencode-codex-provider`：43 pass / 0 fail
- [x] 2.8 ~~daemon 重啟跑對話~~ — 改採 fetch-back + beta soak 策略（同 1.7）

## 3. Beta soak + fetch-back (Phase 1+3 驗收)

- [ ] 3.1 beta daemon 連續跑真實對話負載 ≥ 30 分鐘（需涵蓋 WS + HTTP fallback 兩種路徑）
- [ ] 3.2 **operator 手動查看 OpenAI 官網後台**：第一次觀察第三方判定比例
- [ ] 3.3 間隔後再跑一輪負載
- [ ] 3.4 **operator 手動查看 OpenAI 官網後台**：第二次觀察第三方判定比例
- [ ] 3.5 驗收判定（零容忍）：
  - 連續兩次 **= 0%** → 通過，進 3.6
  - > 0% → **stop**，先完成 Phase 2+4 再二次 soak；Phase 1+3+2+4 全做完仍 > 0% 則另開 follow-up spec 處理 TLS/JA3 / Cloudflare cookie 層
- [ ] 3.6 fetch-back Phase 1+3 的變更回 `main`
- [ ] 3.7 在 main 的 `docs/events/event_<YYYYMMDD>_codex_fingerprint_merged.md` 留一則完成紀錄

## 4. Phase 2 — 統一 header builder 入口

- [ ] 4.1 擴充 `packages/opencode-codex-provider/src/headers.ts` 的 `BuildHeadersOptions`：加 `isWebSocket?: boolean`，`userAgent` 改為強烈建議（Phase 4 可再加 `conversationId`）
- [ ] 4.2 修改 `buildHeaders()` 實作：依 `isWebSocket` 分支（WS 加 `OpenAI-Beta`、略 `Content-Type`；HTTP 加 `Content-Type`，Phase 4 再加 `Accept`）
- [ ] 4.3 修改 `transport-ws.ts` 連線前的 header 組裝：刪 inline 組裝，改呼叫 `buildHeaders({ ..., isWebSocket: true, userAgent: this.options.userAgent })`
- [ ] 4.4 新增 `packages/opencode-codex-provider/src/transport-ws.test.ts`：快照 WS header 集合（只做結構性斷言：欄位存在 + 值格式，不做 byte-by-byte 比對）
- [ ] 4.5 既有 `headers.test.ts`、`provider.test.ts` 不能回歸
- [ ] 4.6 `bun test packages/opencode-codex-provider` 全綠
- [ ] 4.7 beta worktree regression：重啟 daemon，跑對話驗證 WS/HTTP 路徑仍正常

## 5. Phase 4 — x-client-request-id + Accept

- [ ] 5.1 擴充 `BuildHeadersOptions`：加 `conversationId?: string`
- [ ] 5.2 `buildHeaders()`：若 `conversationId` 存在，加 header `x-client-request-id = conversationId`（WS + HTTP 皆加）
- [ ] 5.3 `buildHeaders()`：當 `isWebSocket=false` 時加 `Accept: text/event-stream`
- [ ] 5.4 `provider.ts` 呼叫站（HTTP fallback）傳入 `conversationId`（從 `this.window.conversationId`）
- [ ] 5.5 `transport-ws.ts`（Phase 2 後的呼叫站）同步傳入 `conversationId`
- [ ] 5.6 擴充 `headers.test.ts` 覆蓋新欄位
- [ ] 5.7 `bun test packages/opencode-codex-provider` 全綠
- [ ] 5.8 beta 二次 soak（視需要；非必要）
- [ ] 5.9 fetch-back Phase 2+4 回 `main`
- [ ] 5.10 slice summary + final event log 寫入 `docs/events/`

## 6. Promote + close

- [ ] 6.1 所有 phase tasks.md 勾完
- [ ] 6.2 `plan-validate.ts` 對 `verified` 狀態 PASS
- [ ] 6.3 `plan-promote.ts --to verified`
- [ ] 6.4 待 fetch-back 確認後 `plan-promote.ts --to living`
- [ ] 6.5 更新 `specs/architecture.md` 若有結構性描述需同步
