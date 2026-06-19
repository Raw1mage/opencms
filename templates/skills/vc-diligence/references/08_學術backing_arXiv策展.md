# 學術文獻策展：創投 AI、財報標準化、聯合學習（arXiv）

> 來源：arXiv API 檢索（2026-06-14）
> 性質：同儕審查／頂會論文（ICLR、EMNLP、CIKM、ICAIF、AAAI、Nature Communications、EJOR 等）
> 用途：為提案「創投痛點 → 技術解法 → 我們的三大支柱」提供學術 grounding，把宣稱升級為有文獻支撐的論證。

---

## A. 創投產業的核心痛點（學術實證）

這些論文不是談技術，而是**實證了創投／投資評估的結構性困難**——正好是本案題目二要解決的對象。

### A1. 早期新創「資料稀缺」是根本困難
- **kNN-ICL（Maarouf et al., 2026, arXiv:2601.16568）**：明言「許多創投只掌握數十家早期新創的成敗資料」，傳統監督式 ML 因缺乏大型標註資料集而失效。提出 in-context learning，僅需 ~50 個範例即達高平衡準確率。
- **Data Sparsity（Yin et al., 2021, arXiv:2112.07985）**：多數早期新創公開資料極少，用 Crunchbase 大資料集搭 LightGBM/XGBoost，F1 僅約 53%——凸顯「資料品質與完整度」是天花板。
- **PwC／本案痛點呼應**：早期新創「歷史財務有限、現金流為負、產品開發中」→ **缺漏與非標準化是常態**，標準化引擎必須具備缺漏標示與外部基準補強能力（本案支柱二）。

### A2. 公司間「關係」被忽略 → 評估失準
- **GraphRAG + 時間序列（Gao & Xiao, ICLR 2025 Financial AI, arXiv:2408.09420）**：傳統時間序列預測「未納入競爭與合作等公司間關係」而失準；以 GraphRAG 把關係整合進分析框架，顯著優於既有模型。→ 印證本案以**知識圖譜（knowledge/vectors GraphRAG）**串接多源資料的設計方向。

### A3. 純 LLM 直接判斷會「過度樂觀、幻覺」
- **SSFF（Wang et al., 2025, arXiv:2405.19456）**：基線 LLM 一致性地「高估新創成功率」，在真實類別不平衡下表現差，因過度依賴創辦人自述。需「多代理協作 + 判別式 ML」矯正。→ 直接支持本案**不靠單一模型硬判、改用可審計代理分工**的論述。
- **FinDVer（Zhao et al., EMNLP 2024, arXiv:2411.05764）**：即使最佳 GPT-4o 在長篇混合內容財報的可解釋查核仍落後人類專家——佐證金融文件需專門化管線而非通用大模型。

### A4. SME 財務文件「難以機器讀取」
- **Multi-Stage Field Extraction（Jin et al., 2025, arXiv:2510.23066）**：明言「SMB 文件難以解析——多為掃描影像、非機讀、低解析、歪斜、雜訊背景、多語混雜」。multistage（影像前處理→多語 OCR→頁面檢索→compact VLM 抽取）比直餵大型 VLM **欄位準確率高 8.8 倍、GPU 成本僅 0.7%、延遲降 92.6%**。→ 這正是題目二「多格式財務資料標準化」的核心技術痛點與解法佐證。
- **Multistage KYC（Han et al., 2026, arXiv:2604.26462）**：120 份生產級 KYC 文件、約 3000 頁多語掃描，頁面級檢索使欄位準確率提升最多 31.9 個百分點。

---

## B. 對應技術解法（對映本案三大支柱）

### 支柱一｜多代理技能化（skill）工作流 ← 學術 backing
- **多代理財報處理 Benchmark（Kulkarni & Kulkarni, 2026, arXiv:2603.22651）**：系統性比較四種編排架構（sequential / parallel fan-out / hierarchical supervisor-worker / reflexive self-correcting），跨 5 個 LLM、10,000 份 SEC filings（10-K/10-Q/8-K）。發現：
  - **hierarchical 架構在 cost-accuracy Pareto 前緣最佳**（F1 0.921 @ 1.4x 成本）。
  - reflexive 最高 F1 0.943，但成本 2.3x。
  - 混合配置可用 1.15x 成本回收 89% 的準確率增益。
  - → **為本案「代理分工 + A2A/MCP 編排」的架構選型提供量化依據**（我們對應 hierarchical/supervisor 模式）。
- **Agentic RL 表單解析（Amjad et al., 2025, arXiv:2505.13504）**：批評單體 LLM 抽取的侷限，提出模組化多代理 + 自我校正，跨格式/版面/LLM。→ 呼應本案「可組合、可替換代理技能」。
- **SSFF（arXiv:2405.19456）**：多代理協作模擬創投分析師推理（prediction / analysis / external knowledge 三模組 + RAG）。→ 與三步驟主軸（快篩→DD→投後）的代理組合同構。
- **Document Automation Survey（Achachlouei et al., 2023, arXiv:2308.09341）**：DA 目標即「自動整合多來源輸入、依模板組裝文件」——與本案標準化輸出契合。

### 支柱二｜開源資料交叉驗證 + 標準化 ← 學術 backing
- **HybridRAG（Sarmah et al., 2024, arXiv:2408.04948）**：結合知識圖譜（GraphRAG）+ 向量檢索（VectorRAG）做財報資訊抽取，檢索與生成階段皆優於單一方法。→ 支持本案「canonical schema + 知識圖譜 + 語意查詢」的混合設計。
- **FinSage（Wang et al., CIKM 2025, arXiv:2504.14493）**：多模態前處理管線統一異質格式（文字/表格/圖）、產生 chunk 級 metadata 摘要，合規導向；recall 92.51%，已服務逾 1,200 人。→ 印證「多格式 → 統一結構 + metadata」可production-grade 落地。
- **GraphRAG 時間序列（arXiv:2408.09420）**：見 A2，關係圖譜提升預測。
- **ViBERTgrid BiLSTM-CRF（Pala et al., MIDAS@ECML-PKDD, arXiv:2409.15004）**：非結構化財務文件的多模態關鍵資訊抽取。

### 支柱三｜聯合學習（隱私強化、跨機構不搬原始資料）← 學術 backing
- **Federated Learning for Open Banking（Long et al., 2021, arXiv:2108.10749）**：FL 與開放銀行資料市集天然契合，去中心化資料所有權下協作學習而不蒐集原始資料。→ 直接對映本案「跨投資機構聯合學習」場景。
- **ProxyFL（Kalra et al., Nature Communications 2023, arXiv:2111.11343）**：針對「金融與醫療等高度受規管、資料分享受限」機構，proxy 模型在更低通訊成本下達更強隱私（差分隱私保證）。→ 高權威期刊佐證 FL 在受規管金融的可行性。
- **Interpretable Federated Learning 綜述（Li et al., 2023, arXiv:2302.13473）**：強調金融/醫療關鍵應用需同時平衡效能、隱私、可解釋性；並可公平分配貢獻獎勵以激勵參與。→ 對應本案治理（可審計 + 貢獻度）。
- **FL→Split Learning（Thapa et al., 2020, arXiv:2011.14818）**：FL/SL/SplitFed 的隱私保護光譜，含差分隱私整合。

### 跨支柱｜既有落地產品佐證（最接近本案定位）
- **Intanify AI（Dorfler et al., AAAI 2025 Deployable AI, arXiv:2503.17374）**：**為 SME 萃取無形資產價值**而建的平台——五個知識庫（無形資產顧問、專利律師、盡職調查律師的知識）+ red flags / risk scoring / valuation（二階知識圖譜）+ 易用 GUI，已有 white-label 商用案例。→ **與本案「SME + 投資評估 + DD + 風險標示」定位幾乎同構**，是「此路可商轉」的最強外部佐證。
- **LLM in Finance Survey（Li et al., ICAIF 2023, arXiv:2311.10723）**：金融 LLM 採用決策框架（資料/算力/效能約束下選型），可作本案技術選型論述背書。

---

## C. 「痛點 → 我們的解法」對照表（提案可直接引用）

| 創投痛點（學術實證） | 文獻 | 本案解法 | 對應支柱 |
|---|---|---|---|
| 早期新創資料稀缺、缺漏多 | 2601.16568、2112.07985 | 開源資料交叉驗證補基準、缺漏標示 | 支柱二 |
| SME 財務檔掃描難讀、多格式多語 | 2510.23066、2604.26462 | 多階段 OCR + 抽取代理、canonical schema | 支柱一+二 |
| 公司間關係被忽略致評估失準 | 2408.09420 | 知識圖譜（GraphRAG）串接 | 支柱二 |
| 純 LLM 過度樂觀、幻覺 | 2405.19456、2411.05764 | 多代理分工 + 校驗 + 稽核，不靠單模型 | 支柱一 |
| 跨機構資料不能集中、隱私合規 | 2108.10749、2111.11343 | 聯合學習，原始資料不出域 | 支柱三 |
| 評估流程人工、難複用、無稽核軌跡 | 2308.09341、2503.17374 | 可組合/可審計代理技能、可替換規則包 | 支柱一 |
| 多代理架構如何選型才划算 | 2603.22651 | hierarchical/supervisor 編排（Pareto 最佳） | 支柱一 |

---

## D. 引用建議（提案用語）

- 創新性段可加一句：「本案技術路線與近期頂會研究一致——多代理編排在財報抽取的成本效益最佳區間（Kulkarni 2026, ICLR/AAAI 等），且聯合學習已在受規管金融場景獲 Nature Communications 等驗證（ProxyFL 2023）。」
- 應用可行性段可引 Intanify（AAAI 2025）作為「SME 無形資產 + DD 風險標示」已商轉的同類佐證。
- 痛點章可引 2510.23066 的「SMB 文件難解析」與 8.8 倍準確率數據，強化問題真實性與我方解法的量化效益。
