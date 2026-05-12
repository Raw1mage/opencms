---
name: code-thinker
description: 嚴格的複雜程式任務思考與執行技能，用於複雜邏輯修改、核心除錯、跨檔重構、架構敏感變更，以及任何容易讓模型衝動寫碼的任務。強制流程：靜默內部審查 → 最小可驗證修改。內含 Syslog-style Debug Contract（2026-04-20 從已退役的 agent-workflow §5 併入）。
---

# ⚠️ 嚴格行為限制協議 (Strict Rigorous Mode) ⚠️

**【最高優先級警告】**：加載此技能代表目前的任務極度敏感或複雜。

- **絕對不允許** 憑藉直覺 (System 1) 直接產出最終程式碼。
- **絕對不允許** 在未完整閱讀過相關真實驗證程式碼前，猜測 API 或變數名稱。
- **絕對不允許** 只看片段、單一函式或局部輸出就對控制流 / exit code / 狀態語意下結論；凡涉及命令分派、返回值、trap、背景 worker、fallback 或多層呼叫鏈，必須完整讀完相關檔案或完整控制路徑後才能定性。
- **必須將任務拆解**，禁止在同一回合內完成「探勘」與「大規模寫入」。

若你違反下述任何流程約束，你的執行將被判定為失敗。

## 1. 靜默內部審查 (Silent Internal Review)

在你進行任何會改變系統狀態的動作之前，你**必須先在內部完成**以下六步檢查。

### 內部檢查清單

1. **規格合約 (Spec Contract)**：我使用的每個 API、CSS 屬性、CLI flag、協議欄位——它的**官方規格**定義的作用對象、生效條件、預設值是什麼？程式碼是否符合這個合約？不得假設任何屬性「應該這樣運作」而不驗證。
2. **SSOT (單一真實來源) 檢查**：這個任務依賴哪些現有檔案？我是否已親眼讀過真實實作，而不是憑印象或宣告檔猜測？
   - 若問題牽涉 shell script、router、dispatcher、state machine、command wrapper、background worker 或 exit semantics，必須確認自己讀的是**完整控制路徑**，而不是只看 symptom 附近片段。
3. **打擊半徑 (Blast Radius)**：這次修改的影響範圍會波及到哪裡？是否有潛在 side effect、相依模組或回歸風險？
4. **反幻覺自我檢討 (Anti-Hallucination)**：我打算輸出的函式、參數、型別、路徑與流程，真的是系統裡存在且相容的嗎？
5. **驗證手段 (Validation Plan)**：改完後要用哪些測試、指令或觀察訊號，才能證明修改正確且未破壞既有功能？
6. **System / Boundary 檢查**：若這是跨模組、跨層、reload、sync、race、state mismatch 類問題，我是否已先拆出系統邊界、資料流與 checkpoint 計畫，而不是只盯著局部 symptom？

優先順序：

1. 先查**官方規格**（W3C spec、MDN、API reference、man page）確認合約語義。
2. 若 repo 已有 `specs/architecture.md` 或相關 framework docs，讀文件建立系統模型。
3. 最後讀程式碼補證據。

> 反模式示範：CSS `overflow-anchor: none` 設在 scroll container 上完全無效——規格定義此屬性作用在 scroller 的**子元素**上。沒先查規格就會陷入「設了屬性 → 沒生效 → 再疊一層措施」的症狀驅動循環。查規格是兩分鐘成本，猜測連修可能耗掉整個 session。

### 對外輸出契約

- **禁止**在任何對外訊息中輸出 `<thinking>`、`</thinking>`、`chain-of-thought`、`reasoning trace` 或任何原始內部推理逐步紀錄。
- **禁止**機械式貼出完整檢查清單或逐條播放內部審查過程。
- 對使用者只輸出**必要且精簡**的結果，例如：偵查結論、修改提案、風險、驗證計畫、待確認決策。
- 只有在檢查結果本身會影響使用者決策時，才摘要說明相關風險或驗證策略。

## 2. 雙階段操作鐵律 (Two-Phase Execution)

為了阻止你急著邀功的衝動，任務進展必須強制分為兩個斷點：

### 階段一：偵查與提案 (Reconnaissance & Proposal)

你這個階段只能使用只讀工具。目的只有一個：搜集證據，形成草案，確認修改範圍與驗證方式。

- 先搜尋，再精讀。
- 沒看到真實實作前，不得宣稱理解完成。
- 若問題核心是「為何回傳 1 / 為何走到這條 path / 為何選到這個實作」，不得只讀局部函式；至少要讀完整 dispatch + callee + relevant guard/return path。
- 若風險高、需求不明或打擊半徑大，先提交草案與風險，不要搶先動刀。

### 階段二：精準施作 (Precise Execution)

只有在證據足夠，且行動條件成立後，才能進行寫入、指令執行與驗證。

- 只做與證據一致的最小修改。
- 每次修改後都要立刻驗證。
- 驗證失敗時，先回到 SSOT 與 Blast Radius 檢查，不要靠猜測連修。
- 若第 1 個修正無效，先回看 checkpoints 與 causal chain，而不是直接疊第 2 個猜測修正。

## 3. Syslog-style Debug Contract（Mandatory for bug / cross-layer failure tasks）

**2026-04-20 注記**：本節內容原住在 `agent-workflow §5`，該 skill 退役後整段搬進 code-thinker 作為唯一真實來源（SSOT）。任何 debug 任務都以本節為準。

### 觸發條件

任務包含任一以下情境時，**強制**遵守本節 checkpoint schema：

- bug fix（功能失效、異常行為）
- reload blank / initial-render failure
- 跨層資料錯誤（page ↔ router ↔ session sync ↔ server ↔ persistence）
- state mismatch / race condition / lifecycle error
- unexpected behavior 需要根因追查

### 五段 Checkpoint（依序建立）

1. **Baseline**
   - 症狀（外顯現象，可重現的觀察）
   - 重現步驟
   - 影響範圍（哪些使用者 / session / path）
   - 初始假設（至少列 2-3 個可能根因）
   - 已知相關模組 / 邊界

2. **Instrumentation Plan**
   - 要在哪些 component boundary 埋 checkpoint
   - 每個 checkpoint 觀察哪些輸入 / 輸出 / 狀態 / env / correlation id
   - 使用哪些工具（log / trace / browser DevTools / test / script）
   - 預期要排除或確認哪個假設

3. **Execution**
   - 實際埋了哪些 checkpoints（附 commit / edit 範圍）
   - 第一次收集到什麼證據
   - 哪個假設被排除 / 強化
   - 若證據不足，要補哪些 checkpoint

4. **Root Cause**
   - 真正根因（一句話定位哪一層、哪一個動作）
   - causal chain（哪一層 → 哪一層 → 最終症狀）
   - 為何不是其他假設（明確排除）
   - **規格合約檢查**：若 causal chain 涉及任何 API / CSS 屬性 / 協議欄位 / CLI flag / SDK 合約，必須先確認官方合約語義，才能判斷是「用法錯誤」還是「邏輯錯誤」。不得以「程式碼看起來應該這樣跑」作為 root cause 結論。

5. **Validation**
   - 驗證指令（test / manual steps / observability queries）
   - 通過 / 失敗 詳細紀錄
   - regression 風險（修完是否可能產生新 bug）
   - 是否移除或保留 debug instrumentation（保留的原因）

### Component-boundary 埋點規則

若問題跨多層（例如 page → router → session sync → server → persistence），不得直接在 symptom 附近猜修。至少先在**每一層邊界**觀察：

- 進入資料（什麼進到這層）
- 輸出資料（這層往下送了什麼）
- 狀態轉移（這層 state 改了嗎，改成什麼）
- config / env / permission 傳遞（這層看到的 config 是什麼）
- 錯誤 / fallback / retry 訊號（這層有沒有吞錯或走備援）

禁止只在最終報錯點附近盲改。沒有 checkpoint evidence，就不算完成 root cause investigation。

### Checkpoint 落地位置

checkpoint 內容應寫進**當前 repo** 的事件目錄（預設 `docs/events/event_<YYYYMMDD>_<topic>.md`），每個 debug session 都要有對應事件檔案。路徑由 repo AGENTS.md 指定；若 repo 沒定，用預設。

## 4. 防呆咒語（§1 檢查清單的 output-time 輕量版）

每次當你想發出超過十行的程式碼更新時，依序問自己以下 3 題（§1 檢查清單已做過的內部審查，output 前快速再確認）：

1. **「我確定我理解這個 API / 屬性 / 參數的合約嗎？」** ——作用對象是誰、生效前提是什麼、預設行為是什麼？還是我只是在猜它應該怎麼運作？
2. **「我查過官方規格嗎？」** ——W3C spec、MDN、API reference、man page、SDK docs。程式碼裡的實作可能是錯的，規格才是 ground truth。
3. **「我確認過它真的生效了嗎？」** ——不是「我設了這個屬性」就算完成。要驗證它在目標元素上確實產生了預期效果。

> **反模式警示**：「某個措施沒有效果 → 再疊一層措施」是典型的症狀驅動循環。正確反應是：「某個措施沒有效果 → 先確認它是否真的生效了 → 沒生效就去查為什麼」。永遠先驗證前提，再追加手段。

如果有任何遲疑，回去查規格、閱讀實作、驗證生效，而不是硬寫。
