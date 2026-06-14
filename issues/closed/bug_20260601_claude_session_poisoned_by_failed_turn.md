# Bug: stream timeout/失敗 turn 在 session 留下不完整 assistant + 孤兒 tool_use → 後續每輪被污染（死亡螺旋,需失敗後 repair + /heal）

- **Date**: 2026-06-01
- **Severity**: High(一次失敗 turn 污染整個 session,之後「跑一跑又停」反覆撞牆,使用者只能棄用該 session。觀察到跨帳號重現 → 是 session 狀態問題,非帳號/上游普遍性)
- **Component**:
  - 失敗 turn 的 session 狀態收尾（stream abort / timeout 後,留在 SQLite 的 assistant message + parts）
  - 缺少「失敗後結構修復」與 user-invokable `/heal`
- **Status**: CLOSED — fail-fast/watchdog/tool-use repair and compaction replay fixes covered the main failure chain.

---

## 1. 症狀
某 session 撞過一次 stream timeout 後,**之後每一輪都容易再卡/再失敗**,「跑一跑又停止」。換帳號無效 → **是該 session 本身被污染**(對照:同期另一個乾淨 session ses_1886854b「對答如流」)。

## 2. 證據（2026-06-01,ses_18d7f02eeffeppnzk3alvUWtlS）
- timeout 那輪留下一個 **`finish=null` 的 assistant message**(沒收尾)。
- history 累積出**連續多個 assistant-tool_use 訊息,中間缺 tool_result** = 孤兒 tool_use(assistant 發了 tool_use,turn 在工具執行/回填前就死,tool_result 永遠沒補上)。
- 這份污染 history **每輪都被重新組進 prompt 送出**。

## 3. Root cause（機制鏈,§3 hang 段為假設）
1. turn 在 LLM stream 階段 timeout/abort。
2. **失敗收尾沒有清掉**:不完整 assistant 留著、已發出的 tool_use 沒有對應 tool_result。
3. 下一輪 `filterCompacted` 組 context 時把這份畸形 history 一起帶上。
4. （**假設,未經 wire 證實**)畸形/殘骸 history 讓上游更容易 stall/choke → 又 timeout → 又留殘骸 → **螺旋**。
   - 註:序列化層的 sanitize gap 見 `bug_20260601_claude_convert_orphan_tooluse_consecutive_assistant.md`;本 report 是「**失敗後就該把 session 狀態修乾淨**」,那份是「**送之前再 sanitize 一次**」——兩道防線。

## 4. 為什麼今天的 context 修法救不了
- 今天部署的 supersede projection / 中性 anchor 修的是 **anchor 的「權威/過時」(語意層)**。
- 這是 **message 結構層損壞**（role 配對、不完整 turn）——**supersede 框架管不到**。
- 這正是當初設計但未建的 **/heal（force-ai-heal,強制重生乾淨 anchor/結構)** 的場景。

## 5. 提議修法（兩層）

### 5A. 失敗 turn 的原子收尾（runtime,治本）
turn abort/timeout 時,**在落地前**:
- 若該 assistant 有未配對的 tool_use → 補一個合成 `tool_result`（「[interrupted — no result]」）使其配對,或回滾整個不完整 assistant message。
- 不完整 assistant（finish=null、空 content）→ 標記 / 移除,別讓它進下一輪 context。
- 確保 session 永遠停在「user/tool 結尾、tool_use 全配對」的合法狀態。

### 5B. `/heal`（user-invokable,治標 + 救已污染的）
- 對已污染的 session,user 敲 `/heal` → LLM 重生一份乾淨可工作的 anchor + 把結構修正常,覆蓋污染歷史。
- 定位:dev/ops 自救 crutch（穩定後該趨近 dead code）。設計見 plan `context_claude-refactor` DD-18/22 與 ideas 筆記。

## 6. 立即止血（給使用者）
**污染的 session 別再 grind,直接開新 session**——5A 修好前,在壞掉的歷史上繼續只會延續螺旋。

## 7. Related
- `bug_20260601_claude_convert_orphan_tooluse_consecutive_assistant.md`（送之前 sanitize,互補的第二道防線）
- `bug_20260601_claude_upstream_stall_silent_timeout.md`（hang 本身的成因仍未明,需 wire）
- plan `context_claude-refactor`（/heal 設計、DoD = raw-claude 穩定度、self-rescue 趨近 dead code）
