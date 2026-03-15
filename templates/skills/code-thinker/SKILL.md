---
name: code-thinker
description: 嚴格的複雜程式任務思考與執行技能，用於複雜邏輯修改、核心除錯、跨檔重構、架構敏感變更與任何容易讓模型衝動寫碼的任務。此技能要求先做靜默內部審查，再執行最小且可驗證的修改；嚴禁對使用者外顯 thinking tags、chain-of-thought 或逐條內部推理。
---

# ⚠️ 嚴格行為限制協議 (Strict Rigorous Mode) ⚠️

**【最高優先級警告】**：加載此技能代表目前的任務極度敏感或複雜。

- **絕對不允許** 憑藉直覺 (System 1) 直接產出最終程式碼。
- **絕對不允許** 在未完整閱讀過相關真實驗證程式碼前，猜測 API 或變數名稱。
- **絕對不允許** 只看片段、單一函式或局部輸出就對控制流 / exit code / 狀態語意下結論；凡涉及命令分派、返回值、trap、背景 worker、fallback 或多層呼叫鏈，必須完整讀完相關檔案或完整控制路徑後才能定性。
- **必須將任務拆解**，禁止在同一回合內完成「探勘」與「大規模寫入」。

若你違反下述任何流程約束，你的執行將被判定為失敗。

## 1. 靜默內部審查 (Silent Internal Review)

在你進行任何會改變系統狀態的動作之前，你**必須先在內部完成**以下四步檢查。

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
2. 若 repo 已有 `docs/ARCHITECTURE.md` 或相關 framework docs，讀文件建立系統模型。
3. 最後讀程式碼補證據。

> 教訓案例：`overflow-anchor: none` 設在 scroll container 上完全無效——CSS 規格定義此屬性作用在 scroller 的**子元素**上。16 輪除錯皆假設「設了就該生效」而未驗證規格，導致所有補丁徒勞。一查規格，兩行修完。

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

### Debug 任務強制加碼：Syslog-style Contract

若任務包含 bug / reload blank / 異常狀態 / 跨層資料錯誤，除了靜默審查外，還必須顯式建立以下五段 checkpoint：

1. **Baseline**：症狀、重現步驟、影響範圍、初始假設。
2. **Instrumentation Plan**：列出要在哪些 component boundary 埋點，觀察哪些輸入/輸出/狀態/環境訊號。
3. **Execution**：記錄實際埋設的 checkpoints、首次觀察到的證據、被排除或強化的假設。
4. **Root Cause**：用 causal chain 說明哪一層出錯，為何導致最終 symptom。若 chain 中涉及任何 API / 屬性 / 協議，必須先查官方規格確認合約語義，再判定是「用法錯誤」還是「邏輯錯誤」。
5. **Validation**：驗證修正、回歸風險、是否保留 instrumentation。

#### Component-boundary 規則

若問題跨多層，不得直接在 symptom 附近猜修。至少先在每一層邊界觀察：

- 進入資料
- 輸出資料
- 狀態轉移
- config / env / permission 傳遞
- fallback / retry / error 訊號

沒有 checkpoint evidence，就不算完成 root cause investigation。

### 階段二：精準施作 (Precise Execution)

只有在證據足夠，且行動條件成立後，才能進行寫入、指令執行與驗證。

- 只做與證據一致的最小修改。
- 每次修改後都要立刻驗證。
- 驗證失敗時，先回到 SSOT 與 Blast Radius 檢查，不要靠猜測連修。
- 若第 1 個修正無效，先回看 checkpoints 與 causal chain，而不是直接疊第 2 個猜測修正。

## 3. 防呆咒語

每次當你想發出超過十行的程式碼更新時，依序問自己：

1. **「我確定我理解這個 API / 屬性 / 參數的合約嗎？」** ——作用對象是誰、生效前提是什麼、預設行為是什麼？還是我只是在猜它應該怎麼運作？
2. **「我查過官方規格嗎？」** ——W3C spec、MDN、API reference、man page、SDK docs。程式碼裡的實作可能是錯的，規格才是 ground truth。
3. **「我確認過它真的生效了嗎？」** ——不是「我設了這個屬性」就算完成。要驗證它在目標元素上確實產生了預期效果。

> **反模式警示**：「某個措施沒有效果 → 再疊一層措施」是典型的症狀驅動循環。正確反應是：「某個措施沒有效果 → 先確認它是否真的生效了 → 沒生效就去查為什麼」。永遠先驗證前提，再追加手段。

如果有任何遲疑，回去查規格、閱讀實作、驗證生效，而不是硬寫。
