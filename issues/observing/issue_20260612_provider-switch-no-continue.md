# 切換 provider 後無法接續工作（provider-switch compaction loop）

- **狀態**: OBSERVING — Fix A 已 commit 並部署。BR 原記「修改在 working tree、未部署」已過時：fix 經 provider-switch-suite 併入 main（`b95e737d9` feat(session): Phase 0 — anchorProviderId guard stops provider-switch loop，已在 HEAD），本 session 多次 `webctl.sh restart` 從 HEAD 重建 → 已部署（binary 含 `anchor-already-rebased`）。`identity-change.ts` 新增 `anchorProviderId` 守衛（head compaction anchor 已帶 incoming provider 時抑制切換，回 `kind:none, reason:anchor-already-rebased`，只動 provider 維度、不碰 account cache-key），`prompt.ts` lastAssistantIdentity 回掃計算 head-anchor provider 並傳入。Fix B 判定為 A 的 cascade、無獨立缺陷（snapshot/replay 既有邏輯正確，既有測試守住）。驗證：`identity-change.test.ts` 12 案全綠。Observing since 2026-06-15。**Exit → closed/**：真實「claude-cli→codex 切換後第一則訊息即由 codex 回覆、無 5×壓縮循環」live e2e 由使用者確認，soak 無復發。**Regress → open**：切 SS provider 後再現 provider-switched 壓縮循環 / codex telemetry 0。詳見 `docs/events/event_20260612_provider-switch-compaction-loop.md`。
- **回報 session**: `ses_146e9ad43ffeZbCTA7MTgZP8BD`（silent-wizard，title「查最新br」）
- **發生時間**: 2026-06-12 ~22:35–22:36（+08:00）
- **daemon build**: `0.0.0-main-202606121437`（session 建立於 `202606112328`，有 version drift 警告，但實際執行碼＝daemon＝current HEAD）
- **切換目標**: `claude-cli / claude-fable-5` → `codex / gpt-5.5`（account `codex-subscription-business-thesmart-cc`，已認證存在）

## 症狀

把 provider 從 claude-cli 切到 codex 後，每次送出訊息都「沒有反應」，無法接續對話。最後使用者只能 `manual_interrupt`。

## 證據（來自持久化狀態）

1. `session/.../info.json` → `execution = { providerId: "codex", modelID: "gpt-5.5", ... }`（切換確實寫入）。
2. `execution.recentEvents` 結尾連續 **5 筆** `{ kind: "compaction", compaction: { observed: "provider-switched", kind: "narrative", success: true } }`，時間 22:35:47 / 22:36:00 / 22:36:05 / 22:36:17 / 22:36:55 → 5 次送出各觸發一次 provider-switch 壓縮。
3. `session_runtime_event` 全 session **997 筆 `llm.prompt.telemetry` 全部 `providerId=claude-cli`，codex 0 筆**。`llm.prompt.telemetry` 在 prompt 組裝階段（真正打 provider 之前）發出 → 代表 **codex 的 prompt 從未被組裝**，壓縮完就靜默退出，沒有跑到 codex turn。

## 根因（兩段相互加乘）

### A. 壓縮 anchor 沒有 `finish` → 身分偵測永遠 latch 不到新 provider

- `compaction.ts` `writeAnchorFromBody`（約 758–782）寫入的壓縮 anchor assistant 訊息帶 `providerId = 新 provider(codex)`，但**沒有設定 `finish` 欄位**。
- `prompt.ts` 的 `lastAssistantIdentity`（約 1765–1775）只接受 `info.role === "assistant" && info.finish` 的訊息當「前一身分」。它會**跳過沒有 finish 的 codex anchor**，往回找到上一個真正完成的 claude-cli turn。
- 於是 `detectIdentityChange`（`identity-change.ts:81`）每次都得到 `prior=claude-cli vs incoming=codex` → `provider-changed` → 再壓縮一次。**新 provider 永遠無法成為「前一身分」，re-detection 無限循環。**

### B. provider-switch 壓縮後，codex turn 沒有真正執行（silent exit）

- prompt.ts:1877–1886 與 compaction.ts:3028+ 的註解已知這條路徑的危險：`INJECT_CONTINUE['provider-switched'] = false`，若沒有把未回答的 user message replay 到 anchor 之後，runloop 會 `loop:no_user_after_compaction` **靜默退出**。
- 本 session 的 codex telemetry 為 0 → 壓縮後並未進到 codex 的 prompt 組裝，符合 silent-exit 失敗模式。即使 A 修好，第一個 codex turn 仍必須能真正跑起來，否則 latch 不到 finish、循環照樣持續。

A 讓問題**無法自我修復**（每次重送都整段重壓、churn context），B 讓問題**一開始就沒有任何 codex 回應**。

## 建議修法（待確認後實作；屬 identity-change + compaction 連續性，scarred core，需配測試）

1. **A**：`lastAssistantIdentity` 的回掃，遇到 compaction anchor（`mode==="compaction"` / `summary===true`）時，視為「已 rebase 到該 anchor 的 providerId」，用它當 prior identity（anchor 不是 server response，對 codex `previous_response_id` cache-key 無副作用）。如此即使 codex 尚未完成，也只會重試 codex turn，而不會反覆 re-detect provider switch。
2. **B**：確保 provider-switch 壓縮後，replay 的未回答 user message 會驅動一個真正的 codex turn（沿用既有 snapshot/replay 機制），不要 `loop:no_user_after_compaction` 靜默退出。

## 補充

- codex account 存在且已認證（`accounts.json` 含 `codex-subscription-business-thesmart-cc`），排除「未登入」。
- 切到 codex 屬 SS provider（有 server-side chain），與 claude-cli（full-retransmit，無 server chain）的 takeover 行為不同；`shouldCompactOnTakeover(codex)=true` 才會走到壓縮分支。
