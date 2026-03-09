---
name: code-thinker
description: 嚴格的複雜程式任務思考與執行技能，用於複雜邏輯修改、核心除錯、跨檔重構、架構敏感變更與任何容易讓模型衝動寫碼的任務。此技能要求先做靜默內部審查，再執行最小且可驗證的修改；嚴禁對使用者外顯 thinking tags、chain-of-thought 或逐條內部推理。
---

# ⚠️ 嚴格行為限制協議 (Strict Rigorous Mode) ⚠️

**【最高優先級警告】**：加載此技能代表目前的任務極度敏感或複雜。

- **絕對不允許** 憑藉直覺 (System 1) 直接產出最終程式碼。
- **絕對不允許** 在未完整閱讀過相關真實驗證程式碼前，猜測 API 或變數名稱。
- **必須將任務拆解**，禁止在同一回合內完成「探勘」與「大規模寫入」。

若你違反下述任何流程約束，你的執行將被判定為失敗。

## 1. 靜默內部審查 (Silent Internal Review)

在你進行任何會改變系統狀態的動作之前，你**必須先在內部完成**以下四步檢查。

### 內部檢查清單

1. **SSOT (單一真實來源) 檢查**：這個任務依賴哪些現有檔案？我是否已親眼讀過真實實作，而不是憑印象或宣告檔猜測？
2. **打擊半徑 (Blast Radius)**：這次修改的影響範圍會波及到哪裡？是否有潛在 side effect、相依模組或回歸風險？
3. **反幻覺自我檢討 (Anti-Hallucination)**：我打算輸出的函式、參數、型別、路徑與流程，真的是系統裡存在且相容的嗎？
4. **驗證手段 (Validation Plan)**：改完後要用哪些測試、指令或觀察訊號，才能證明修改正確且未破壞既有功能？
5. **System / Boundary 檢查**：若這是跨模組、跨層、reload、sync、race、state mismatch 類問題，我是否已先拆出系統邊界、資料流與 checkpoint 計畫，而不是只盯著局部 symptom？

優先順序：若 repo 已有 `docs/ARCHITECTURE.md` 或相關 framework docs，先讀文件建立系統模型，再讀程式碼補證據。

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
- 若風險高、需求不明或打擊半徑大，先提交草案與風險，不要搶先動刀。

### Debug 任務強制加碼：Syslog-style Contract

若任務包含 bug / reload blank / 異常狀態 / 跨層資料錯誤，除了靜默審查外，還必須顯式建立以下五段 checkpoint：

1. **Baseline**：症狀、重現步驟、影響範圍、初始假設。
2. **Instrumentation Plan**：列出要在哪些 component boundary 埋點，觀察哪些輸入/輸出/狀態/環境訊號。
3. **Execution**：記錄實際埋設的 checkpoints、首次觀察到的證據、被排除或強化的假設。
4. **Root Cause**：用 causal chain 說明哪一層出錯，為何導致最終 symptom。
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

每次當你想發出超過十行的程式碼更新時，先問自己：

**「我真的查過這個 API 是怎麼實作的嗎？還是這是我幻覺生出來的？」**

如果有任何遲疑，回去搜尋、閱讀、驗證，而不是硬寫。
