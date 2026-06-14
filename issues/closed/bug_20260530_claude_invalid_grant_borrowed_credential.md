# Bug: claude-cli `invalid_grant` 使用中突然失效 — 完整 RCA + 偵查方法論失誤記錄

- **Date**: 2026-05-30
- **Severity**: High (生產級認證中斷；使用者工作被迫中斷重登)
- **Component**:
  - 主缺陷 = claude-cli token 生命週期 (`packages/provider-claude/src/auth.ts` · `packages/opencode/src/plugin/claude-cli/index.ts`)
  - 次缺陷 = `Account.setActive` 切帳號路徑缺 cache invalidation (`packages/opencode/src/account/index.ts`)
  - 方法論失誤 = 本次 AI 偵查過程（記錄供制度改善）
- **Status**: CLOSED — fixed by rotated-token persistence commits `ddd3cbdd5` and `bd229e302`; borrowed-credential primitive removed

---

## 1. 症狀（使用者陳述，最終校準版）

- 使用**新登入、原本好好用**的 claude 帳號。
- 對話**進行中**，訊息突然變 `invalid_grant`，要求重新登入。
- **重新登入取得新 token 後可以繼續工作。**
- 不是「一開始就壞」，是「使用中動態失效」。

## 2. Root Cause（borrowed-credential 輪替碰撞）

對應 repo 既有事件檔 `docs/events/claude_borrowed_credential_guard_20260530.md` 記載的同型缺陷：

```
opencms 與本機官方 claude CLI 共用同一 OAuth client_id
  + 帳號 credential 從 ~/.claude/.credentials.json 借來（同源 refresh token）
   ↓
Anthropic 每次 refresh 都「輪替」refresh token、作廢舊的
   ↓
官方 CLI（或另一條 refresh 路徑）先 refresh → 換到新 token、作廢 opencms 手上那顆
   ↓
opencms 的 access token 到期 → 觸發 refresh → 拿「已被作廢的舊 refresh token」
   ↓
platform.claude.com/v1/oauth/token 回 400 invalid_grant
  ("Refresh token not found or invalid")
   ↓
TokenRefreshError needsReauth=true → 強制 re-auth → 使用者被迫重登
   ↓
重登拿到全新 grant → 暫時可用（直到下次輪替再撞）
```

歷史證據（`claude_borrowed_credential_guard_20260530.md`）：同源 refresh token 被輪替分岔，opencms 手上那顆比 `~/.claude` 的早死 → 確認是共享憑證碰撞，非各自獨立 grant。

**為何「新登入也會中」**：重登當下拿到有效 grant，但只要該 credential 仍與 `~/.claude` 同源、且官方 CLI 仍在背景 refresh 輪替，下一次碰撞只是時間問題。borrowed-credential guard（`isSharedWithLocalClaude`）理應在 refresh 前擋下，但見 §3 的覆蓋漏洞。

## 3. 相關次缺陷 — `setActive` 切帳號不 invalidate model cache（grep 證據）

| 切帳號路徑 | 是否 `Provider.reset()` | 證據 |
|---|---|---|
| `Account.update`（token 變更） | **有** | `account/index.ts:586-589` `hasCredentialChange → Provider.reset()` |
| `Account.setActive`（切 active） | **無** | `account/index.ts:787-806` 只 `Bus.publish(AccountActivated)`，無 reset |
| `Bus.AccountActivated` subscriber | **無人訂閱** | 全 repo grep：定義(`bus/index.ts:53`)+publish(`account/index.ts:800`)各一處，**零 consumer** |

後果：rotation / 切帳號走 `setActive` 時，`Provider` 的 SDK/model cache（`provider.ts` `languages`/`sdk` Map，closure 捕獲舊 access/refresh）不會失效 → 後續請求可能沿用舊帳號 token。borrowed-credential guard 也只接在 `getModel` refresh 前與 `update` 路徑，**未覆蓋 setActive 切換**。

## 4. 偵查方法論失誤記錄（AI 自我檢討，供制度改善）

本次 RCA 過程 AI 連續犯三類錯，全部違反 `code-thinker` 鐵律，記錄以防再犯：

### 失誤 A — 用靜態時間戳「推論故事」當 root cause
- AI 看到 `accounts.json` 的 `activeAccount=9f012c38` 已過期，就宣稱「停在死帳號」是根因。
- **錯在**：從沒實際觀測到 claude 那次 invalid_grant 的 log；用靜態快照編因果。
- **違反**：code-thinker「沒有 checkpoint evidence 不得宣稱 root cause」。
- 使用者兩次校準（「我是新登入用得好好的」）才推翻。

### 失誤 B — 把 GitLab 噪音與 claude 混為一談
- daemon log 的 invalid_grant 洪水全部來自 `@gitlab/opencode-gitlab-auth`（token 2026-01-31 死），AI 一度誤判方向。
- 正確做法：先用 stack trace 來源（`oauth-flow.js` vs `provider-claude`）區分 provider，再下結論。

### 失誤 C — 偵查鏈節奏 + 前端可觀測性交互，造成「只宣告不動作」爭議
- session DB 原始紀錄證實：每個被使用者感知為「只宣告不動作」的 turn，**DB 裡都有 status=completed 的 toolcall**（12:04 備份+grep、12:04 讀 cache+setActive、12:06 jq 改檔）。
- 即動作有發生。但兩個因素疊加製造假象：
  1. **AI 行為**：把單一已批准動作拆成 4 個 read-only 前置 turn（備份→讀cache→讀setActive→查帳號→才改檔），節奏偏長。
  2. **可能的前端缺陷**：tool-call part 是否即時渲染到前端未經證實（無前端 checkpoint，不宣稱為 root cause）。
- 「催促→才完成」的時間相關性讓誠實的「已做完」回報看起來像敷衍——但 DB 證據顯示完成回報屬實，非謊報。

## 5. 已執行的止血（已驗證落地）

```
activeAccount = claude-cli-subscription-claude-cli-b9d6ec10  (exp 11:29, 未過期)
移除死帳號 = 9f012c38 (exp 00:25), 97f7790e (exp 02:41)
剩餘 = b9d6ec10, 17167804  (皆 expired=false, refresh 完整)
```
- 手段：`jq` 改 `~/.config/opencode/accounts.json`（daemon mtime-guard 會自動 reload，`state():143-148`）。
- 備份：`~/.config/opencode.bak-20260530-1204-claude-invalid-grant-stopbleed/`（白名單快照，僅供手動還原，AI 不主動覆蓋）。
- **注意**：止血只解「死帳號殘留」，**不解** borrowed-credential 復發。若 b9d6ec10 仍與 `~/.claude` 同源，仍會再撞。

## 6. Blast Radius

- 主缺陷：所有從 `~/.claude` 借憑證的 claude-cli 帳號，使用中隨時可能因官方 CLI 背景 refresh 輪替而 invalid_grant。
- 次缺陷：所有走 `setActive`/rotation 切帳號的請求，可能沿用 stale SDK closure 內舊 token。
- 方法論：影響 AI 偵查可信度與使用者信任。

## 7. Suggested Fix（移至新 session 正式執行）

### 主缺陷（borrowed-credential）
1. 確認當前 active 帳號 `b9d6ec10` 的 refresh token 是否 `=== ~/.claude` 的 refresh token（`isSharedWithLocalClaude`）。若是 → 引導使用者改用**自主登入**（opencms 自己 OAuth grant，與 `~/.claude` 永不相等，不受輪替碰撞）。
2. 審視 `isSharedWithLocalClaude` guard 是否真的在所有 refresh 入口前生效（`getModel` refresh 前 + `ensureValidToken`）。

### 次缺陷（setActive cache）
3. 讓 `Account.setActive` 在切帳號後呼叫 `Provider.reset()`（對齊 `Account.update` 的 `hasCredentialChange` 處理），或為 `Bus.AccountActivated` 加一個 invalidate-cache subscriber。優先順序：讓讀取方自清 > 改寫事件順序 > 加旗標（依 AGENTS.md infrastructure 紀律）。

### 方法論（流程護欄）
4. Debug 任務一律先抓**真實失敗事件的 log**（用 stack trace 來源區分 provider）再下結論，禁止用靜態快照編因果。
5. 已批准的小範圍動作，stop gate 皆不成立時，儘量同 turn 收斂施作，減少 read-only 前置 turn 製造的「拖延」假象。

## 8. Validation / 待辦

- 主缺陷 root cause：有歷史程式碼證據（`claude_borrowed_credential_guard_20260530.md` 同型），但**本次未實際抓到 claude invalid_grant 的即時 log**（log 已被重登後成功紀錄覆蓋）→ 嚴格說仍缺本次事件的 instrumentation evidence。
- 次缺陷：grep 證據確鑿（setActive 無 reset、AccountActivated 零 subscriber）。
- 止血：已 jq 驗證落地。
- 關聯檔案：
  - `docs/events/event_20260530_claude-invalid-grant-rca.md`（需修正成此 borrowed-credential 版本）
  - `docs/events/claude_borrowed_credential_guard_20260530.md`（同型歷史根因）
  - `docs/events/claude_oauth_ua_throttle_20260530.md`（相鄰 OAuth 端點問題）

## 9. 建議：開新 session 修復

本 session turn-boundary 已不穩定（使用者明確指出狀態崩掉）。正式修復應在新 session 進行，可直接讀本 report + 上述三份事件檔接續，不需重查。
