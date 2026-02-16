# RCA: 違反《AGENTS.md》核心憲法 - 語言規範與技能模板偏差

## 事件描述

在 2026-02-08 的對話中，Agent (Opencode) 在加載 `code-review-expert` 技能後，輸出了大篇幅的英文審查報告，違反了《AGENTS.md》第 1.1 條「始終使用繁體中文 (zh-TW) 進行溝通」的最高指令。

## 根本原因分析 (Root Cause Analysis)

1.  **技能模板優先級過高**：`code-review-expert` 技能內部定義了詳細的英文輸出格式。Agent 誤將「遵循技能格式」的權限置於「遵循核心憲法」之上。
2.  **缺乏自我審查機制**：Agent 在生成長篇內容時，未能在輸出前執行語言合規性檢查。
3.  **Prompt 強度不足**：原有的 `src/session/prompt/gemini.txt` 雖然提到了遵循指示，但未強調「繁體中文」是全域不變的強制要求，且未明確指出憲法高於技能。

## 修復措施 (Fixes Applied)

1.  **Prompt 硬核化**：修改 `src/session/prompt/gemini.txt`，新增 `Language and Constitution (CRITICAL)` 章節，明確要求全域使用繁體中文，並聲明《AGENTS.md》具有最高權威 (@event_20260208_gemini_prompt_fix)。
2.  **代碼健壯性提升**：修復了 `src/plugin/antigravity/index.ts` 中的 Prompt 轉換邏輯，增加了 `try...catch` 與更精確的正則表達式，確保系統穩定性。
3.  **型別優化**：移除了 `types.ts` 中的 `any` 型別，強化靜態檢查。

## 預防措施

1.  **全域語言監控**：Agent 在思考鏈 (Thought) 的起點必須重申語言規範。
2.  **模板轉換意識**：在加載任何帶有輸出模板的技能時，必須自覺將其內容翻譯為繁體中文。

---

_此文件由 Opencode 自我紀錄，作為後續改進與警示之用。_
