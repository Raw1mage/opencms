# Design: Session Context Control + Compaction Strategy Spec

## Context

- Session context 真正進入模型前會經過多層轉換：`SessionPrompt.runLoop()` 蒐集 session messages、注入 preload/environment/instructions；`MessageV2.toModelMessages()` 把 persisted parts 轉成 UI/Model messages；`LLM.stream()` 再疊加 provider/system prompt、enablement snapshot、identity reinforcement；最後 `ProviderTransform.message()` 再做 provider-specific normalization / caching 標記。
- Auto compaction 不是單點功能，而是由 `processor.ts` 的 usage 累計、`compaction.ts` 的 overflow 判定、`prompt.ts` 的 task queue，以及 compaction agent 的 summary generation 一起形成閉環。
- 文件治理目前主要由 `AGENTS.md` / `agent-workflow` 契約強制，`doc-coauthoring` 只是在需要時提供寫作流程；這讓文件制度規範與日常執行 prompt 邊界過度耦合。

## Goals / Non-Goals

**Goals:**

- 把現有 context-control/compaction 的資料流與 token 開銷熱點明文化。
- 為後續優化建立一個能逐步切片實作的設計地圖。
- 把文件制度優化納入同一設計視角，避免文件治理本身反向成為隱性 token 稅。

**Non-Goals:**

- 本輪不重寫 message pipeline。
- 本輪不修改 rotation fallback 設計，只在它影響 context 控制時註記風險。
- 本輪不直接設計完整新 doc skill 實作，只定義抽離方向與邊界。

## Decisions

- 以「現況建模」為第一優先，先忠實描述現有 runtime，而不是先提出理想設計。這樣後續每個優化候選才能對照真實控制點。
- 把優化議題分成三層：prompt payload 縮減、compaction threshold / summary 調整、message pipeline 去重。理由是三者風險與驗證成本不同，不應混成單一 patch。
- 文件制度優化不應再混在日常 core system prompt；日後應拆成專用 doc governance skill / docs agent 流程，由 workflow 決定何時觸發。
- Session context 節流應仿照 compaction 思維，但對象不只歷史對話，也包括高重複、低變化率的 system/policy/documentation prompt blocks。
- Context sidebar 應從單純 status 區塊進化為 context inspector，以 accordion 卡片展示 active / compacted / dormant / diff / retrieval 視角。

## Data / State / Control Flow

- **Prompt assembly path**
  1. `SessionPrompt.runLoop()` 讀取 `MessageV2.filterCompacted()` 後的 session 歷史。
  2. 注入 `getPreloadedContext()`、`SystemPrompt.environment()`、主代理時的 instruction prompts、structured output prompt。
  3. `MessageV2.toModelMessages()` 把 persisted message/parts 轉成 AI SDK messages；compaction user part 會映射成 `"What did we do so far?"`。
  4. `LLM.stream()` 再加入 provider prompt、agent prompt、dynamic session prompts、enablement snapshot、user custom system prompt、SYSTEM boundary prompt、identity reinforcement。
  5. `ProviderTransform.message()` 依 provider 做空訊息清理、toolCallId normalization、reasoning field 搬運、cache marker 注入、providerOptions key remap。

- **Overflow / compaction path**
  1. `processor.ts` 在 `finish-step` 取得 usage tokens，寫回 assistant message。
  2. `SessionCompaction.isOverflow()` 以 total/input/output/cache tokens 與 model limits 計算是否超出 usable window。
  3. 若 overflow，`prompt.ts` 建立 synthetic compaction user message 與 `compaction` part。
  4. 下一輪 loop 優先執行 `SessionCompaction.process()`，建立 summary assistant message，對既有歷史再跑一次 `processor.process()`，最後附加 synthetic continue message（若 auto）。

- **Prune path**
  1. 一般回合結束後，`prompt.ts` 會非阻塞呼叫 `SessionCompaction.prune({ sessionID })`。
  2. prune 逆序掃描較舊 assistant tool outputs；保留最近兩個 user turns 與 protected tools（目前只有 `skill`）。
  3. 若可清掉的舊 tool output 估算超過 `PRUNE_MINIMUM`，就把 `part.state.time.compacted` 寫回，後續 `toModelMessages()` 會輸出 placeholder 而不帶原始工具結果。

- **Prompt-block governance path (target state)**
  1. 把 prompt block 分成 safety/identity、workflow contract、doc governance、enablement/tool routing、task-local context 幾類。
  2. 對高重複 block 建立條件式注入、摘要化或 retrieval-only 策略。
  3. 文件治理規範從常駐 prompt 改為 on-demand skill / subagent policy。

- **Context-inspector sidebar path (target state)**
  1. 以 telemetry 為資料底座，區分 active context、prompt blocks、compacted context、context diffs、dormant context、retrieval queue。
  2. 第一階段先回答「現在 prompt 裡有什麼」，以 token + 比例作為收折摘要。
  3. 第二階段再延伸至 dormant/retrieval 文檔記憶視角。

## Risks / Trade-offs

- **重複 prompt 組裝層次太多** -> 容易在不同檔案各自加字串，token overhead 累積卻不易觀測。
- **compaction summary 過度詳細** -> continuity 較好，但 compaction 本身變成昂貴請求，且 summary 可能長期佔用後續 context。
- **提早 compact vs 保留更多歷史** -> 提早 compact 可避免 hard overflow，但也可能犧牲原始 tool trace 與對話細節。
- **移除 prompt payload 必須避免改壞 policy/identity** -> system boundary 與 instructions 是行為保證，不能為省 token 直接刪除。
- **文件制度抽離若做不好會失去完成門檻** -> 必須保留最小 completion gate 在 workflow/core prompt，不能把所有要求都搬空。
- **類 compaction 的 prompt 節流若過度激進** -> 可能讓模型遺失行為約束或 repo-specific 規範。

## Critical Files

- `/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/processor.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/compaction.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/message-v2.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/provider/transform.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/config/config.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/test/session/compaction.test.ts`

## Supporting Docs (Optional)

- `/home/pkcs12/projects/opencode/specs/architecture.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260320_llm_context_control_spec.md`
