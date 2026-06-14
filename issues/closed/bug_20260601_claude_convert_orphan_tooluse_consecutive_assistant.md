# Bug: claude convertPrompt 只剝 trailing assistant,未清「連續 assistant / 孤兒 tool_use / 不完整 assistant」→ 畸形對話送上游

- **Date**: 2026-06-01
- **Severity**: Medium-High(畸形 message 結構送 Anthropic → 預期回 HTTP 400「roles must alternate」/「tool_use without tool_result」。timeout 殘骸累積後每輪重送,會反覆炸 400 或加劇上游異常。獨立於下方的「上游靜默 stall」report,但常同源於同一個 timeout 殘骸)
- **Component**: `packages/provider-claude/src/convert.ts`（`convertPrompt`：MessageV2 → Anthropic messages 序列化）
- **Status**: CLOSED — Claude tool-use repair/salvage work covered the malformed prompt chain.

---

## 1. 症狀
長 session（尤其經歷過 stream timeout 的）送出的 prompt，message 序列出現:
- **連續多個 `assistant` 訊息**（中間沒有 user/tool_result 分隔）。
- **孤兒 `tool_use`**（assistant 發了 tool_use,但沒有對應 `tool_result` 的 tool/user 訊息跟在後面）。
- **不完整 assistant**（`finish=null`,上次 hang 沒收尾留下）。

## 2. 證據（2026-06-01,ses_18d7f02eeffeppnzk3alvUWtlS）
DB message 結構（時間順,由舊到新）:
```
assistant  tool-calls
assistant  tool-calls   ← 連續 assistant,中間無 tool_result
assistant  tool-calls   ← 連續
assistant  stop
user
assistant  stop
user
assistant  (finish=null) ← 不完整
```
`diag.preLLM` 顯示送出的 prompt `msgsLen:13`,tail 含上述畸形片段。

## 3. Root cause（程式碼層確認）
`convertPrompt`（convert.ts:60-186）逐則轉換 user/assistant/tool,**不合併連續同 role**;唯一的清理是結尾:
```ts
// convert.ts:180
while (messages.length > 0 && messages[messages.length - 1]!.role === "assistant") {
  messages.pop(); droppedTrailingAssistants++
}
```
→ **只剝「結尾」的 assistant**。對以下情況無能為力:
- 中間的連續 assistant（Anthropic 要求 user/assistant 交替）。
- 孤兒 tool_use（Anthropic 要求每個 tool_use 後接 tool_result）。
- 中間的不完整 assistant。

> **§3 caveat（誠實）**: 畸形對話**通常** → Anthropic 回乾淨 **HTTP 400**（被 `provider.ts:276 if(!response.ok) throw "Anthropic API error 400"` surface）。但 ses_18d7f02e 觀察到的是 **240s 靜默 hang，非 400**——400-vs-hang 對不上。因此**這個 gap 是確定存在的獨立 bug,但「它造成那次 hang」未證實**（hang 另見 `bug_20260601_claude_upstream_stall_silent_timeout.md`）。本 report 聚焦「序列化未 sanitize 畸形結構」本身,該修。

## 4. 提議修法（convert.ts 強化）
在 `convertPrompt` 收尾前,加一個 **sanitize pass**,讓輸出對 Anthropic 一定合法:
1. **合併連續同 role 訊息**（兩個相鄰 assistant → 合成一個 assistant，content blocks 串接;相鄰 user/tool 同理）。
2. **孤兒 tool_use 處理**：assistant 的 tool_use 若後面沒有對應 `tool_result` → 要嘛補一個合成的 `tool_result`（content 標記「[tool result missing — turn interrupted]」),要嘛連同該 tool_use 一起 drop。**Anthropic 嚴格要求配對,不能留孤兒。**
3. **不完整 assistant（空 content / 無 signature 的 thinking / 空 tool_use input）**：drop 或補全。
4. 維持現有 trailing-assistant strip 作為最後保險。
5. **Loud signal**（比照現有 droppedTrailingAssistants）：回報 merged/dropped 計數,別 silent。

## 5. 驗收
- 單測:餵「連續 assistant」「孤兒 tool_use」「不完整 assistant」的 prompt → 斷言輸出 roles 交替、tool_use 全配對、無不完整。
- 既有 trailing-strip 測試維持綠。
- 真實:把 ses_18d7f02e（污染 session）的 history 餵過 → 確認輸出對 Anthropic 合法(不會 400)。

## 6. Related
- `issues/bug_20260529_claude_assistant_prefill_400.md`（trailing assistant → 400,本 bug 的前身,只修了 trailing）。
- `bug_20260601_claude_session_poisoned_by_failed_turn.md`（殘骸的**來源** = timeout 後沒清 session 狀態;本 report 是「送之前 sanitize」,那份是「失敗後 repair session」,兩條互補）。
