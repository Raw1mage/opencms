---
name: vc-diligence
description: Taiwan/international venture-capital domain knowledge for investment evaluation, due diligence, and startup valuation. Provides the structured "domain brain" — VC five-stage process, five evaluation dimensions, six valuation methods, financial-rule checks, funding stages and investor types, plus arXiv academic backing on VC AI / financial-document standardization / federated learning. Use this skill when a task involves venture capital, due diligence (DD), startup/company valuation, investment evaluation, investment-readiness assessment, screening startups, post-investment monitoring, or when another workflow needs an investment-domain knowledge base to ground its analysis or document generation. Triggers on "創投/盡職調查/投資評估/新創估值/募資/投後管理", "venture capital", "due diligence", "startup valuation", "investment screening", or requests to build/evaluate investment-evaluation data, reports, or scorecards.
---

# Skill: vc-diligence

## Purpose

This skill is a **domain knowledge集 (the "domain brain")** for venture-capital investment evaluation. It does **not** own document tooling, data pipelines, or codegen — it supplies the *investment-domain knowledge* that those workflows call upon to be grounded, professional, and correct.

Distilled from 8 authoritative Taiwan + international sources (CBIA practitioner notes, PwC, startup101, CYUT academic, Addin Ventures, 中企署/SME government, RayCheese/TAcc+, and ~20 arXiv papers). Full source texts live in `references/`; this file is the queryable summary.

## When to use

Load this skill when a task mentions:

- Venture capital / 創投 / 風險投資, angel/VC/CVC investors
- Due diligence (DD) / 盡職調查 / 投資評估
- Startup or company valuation / 新創估值 / 公司估值
- Investment screening, scoring, or readiness assessment
- Post-investment monitoring / 投後管理, risk early-warning
- Funding rounds / 募資階段 (seed / angel / Pre-A / A+)
- Building or evaluating **investment-evaluation data, reports, scorecards, or DD checklists**
- Any other workflow (document generation, data standardization, RAG) that needs an **investment-domain knowledge base** to ground its output

Do **not** use this skill for: generic financial accounting unrelated to investment, public-market equity research, or document/file mechanics (that is `doc-workflow` / `docxmcp`).

## How to use

1. Read the relevant `references/NN_*.md` for the dimension you need (map below).
2. Apply the structured frameworks in §1–§6 as the judgment layer.
3. When grounding a claim academically, cite from `references/08_學術backing_arXiv策展.md` (§7 here).
4. Treat this as a *swappable domain layer* — the same downstream workflow can serve another industry by swapping the knowledge集.

---

## 1. VC process — 創業投資五部曲 (the spine)

The end-to-end venture-investment lifecycle (CBIA practitioner framework, cross-confirmed by RayCheese's three-act model):

| # | Stage | 中文 | What happens | Data-heaviest? |
|---|---|---|---|---|
| 1 | Deal sourcing | 案源建立 | Pipeline building, initial screening | — |
| 2 | **Investment evaluation (DD)** | **投資評估** | Most professional, most data-intensive stage; 1–2 months to 6–12 months per case | ✅ **the core** |
| 3 | Investment agreement | 投資協議 | Term sheet, valuation, deal structure | — |
| 4 | Post-investment management | 投後管理 | Monitoring, board seats, value-add, risk early-warning | ✅ ongoing |
| 5 | Exit / disposal | 投資處分退出 | IPO or M&A — the profit realization goal | — |

The three "prompt-axis" steps a modern investment workflow covers:
**1-1 多家新創多維度快篩 (pre-screen) → 1-2 單家深度研究/體檢/盡職調查 (DD) → 1-3 投後追蹤管理 (post-investment)** map onto stages 2 and 4.

## 2. Five evaluation dimensions — 五大評估構面 (the DD rubric)

Taiwan VC practice evaluates a target across five dimensions (CBIA):

1. **經營(募資)計畫書** — business/fundraising plan: feasibility & completeness
2. **主要經營團隊** — management team: experience & integrity (often *unquantifiable*, relies on judgment — the human factor)
3. **市場規模與行銷模式** — market size & go-to-market
4. **主要產品與核心技術** — core product & technology (incl. patents/IP)
5. **財務配置與投資報酬** — financial structure & expected return

> Key insight (Addin Ventures): early-stage evaluation leans heavily on **qualitative judgment** because hard data is scarce. The value of standardization is to free human analysts for high-value judgment, not to replace it.

## 3. Investment-evaluation report architecture — 11 大架構 (CYUT/張福榮)

A thorough investment-evaluation report spans 11 cross-domain sections — proving investment evaluation is fundamentally a **multi-source data integration** problem:

1. 計畫緣由及要點 (motivation, team, summary)
2. 市場行銷 (industry analysis / market & competition / marketing strategy)
3. 設計技術 (design & process)
4. 建廠工程 (facility/engineering)
5. 生產製造 (production)
6. 環境影響及污染防治 (environmental)
7. 財務 (financial forecast & analysis)
8. 經濟效益分析 (economic benefit)
9. 敏感性分析 (sensitivity analysis)
10. 社會效益 (social benefit)
11. 結論及建議 (conclusion)

### Risk-assessment four layers (海外/overseas investment)
1. 總體環境風險 (macro: political/economic/legal/cultural)
2. 產業結構風險 (industry structure)
3. 公司營運風險 (company operations)
4. 財務風險 (financial)

→ Layers 1–2 need **external/open data** (industry, macro); layers 3–4 need **internal financials**. This is the basis for cross-validation against open sources.

## 4. Valuation methods — 六大估值法 (PwC, by stage)

| Stage | Applicable methods |
|---|---|
| Seed / idea | 固定區間法 (fixed-range), 成本法 (cost), 評分卡法 (Scorecard) |
| Early growth / expansion | 創投法 (VC Method), 折現現金流法 (DCF) |
| Stable growth | DCF + 市場倍數法 (EV/R, EV/EBITDA, EV/EBIT, EV/FCF) |

- **VC Method**: Exit Value = exit-time earnings × industry P/E multiple; discount back to present at a stage-dependent rate.
- **Scorecard Method**: qualitative questionnaire across (a) team & product/service, (b) market & business strategy; discount rate = min + (max − min) × (100% − questionnaire score%).
- **IRR benchmark** (startup101): VCs typically require **20%–30%** internal rate of return on early-stage deals.
- Why valuation is hard for startups (PwC): negative cash flow, no historical financials, product still in development → **data gaps & non-standardization are the norm**, so an evaluation system must do missing-data flagging + external-benchmark補強.

## 5. Funding stages & investor types — 募資4階段 / 三類投資人 (中企署, policy-aligned)

### Three investor types (by timing & strategic relatedness)
- **Angel (天使)**: earliest, capital-for-equity, non-interventionist, often advisor/connector
- **VC (創投)**: explicit *financial* investment, low-price equity, higher return demand, may intervene in operations
- **CVC (企業創投)**: *strategic* investment driven by corporate parent's core business

### Four funding stages
1. **種子輪 (Seed)**: idea stage, founder/F&F money, highest risk
2. **天使輪 (Angel)**: product developed / company registered; attracts angels
3. **Pre-A 輪**: bridge between angel-late and A
4. **A 輪之後 (A+)**: maturing — A/B/C/D/E/IPO rounds

### 5 keys to winning VC backing
1. Present ROI  2. Confirm clear target-market opportunity  3. Reasonable risk assessment + bold future projection  4. Build good networks  5. Don't rush to accept all VC money

## 6. Financial-rule pack — the "懂財務" layer

The lightweight domain rules that turn generic ETL into investment-aware evaluation (cross-table sanity checks for anomaly/missing flagging):

- **Accounting identity**: 資產 = 負債 + 權益 (Assets = Liabilities + Equity)
- **Financial-ratio sane ranges**: gross margin, current ratio, AR turnover, debt ratio — by industry benchmark
- **Cross-statement勾稽**: BS ↔ IS ↔ CF consistency (e.g. net income → retained earnings → CF reconciliation)
- **Period continuity**: no gaps/jumps across reporting periods
- **External cross-validation**: registered capital (商工登記), industry averages (data.gov.tw), SEC EDGAR / OECD as ground-truth to flag implausible self-reported figures and backfill missing fields (industry code, founding year)

## 7. Academic backing — arXiv 策展 (grounding claims)

Use `references/08_學術backing_arXiv策展.md` for full citations. Key anchors:

**VC pain points (empirical):**
- Data sparsity: most VCs hold only dozens of labeled early-startup outcomes → traditional supervised ML fails (kNN-ICL 2601.16568; Yin 2112.07985)
- Inter-company relations ignored → mispricing; GraphRAG helps (ICLR 2025, 2408.09420)
- Pure-LLM judgment is over-optimistic / hallucinates → needs multi-agent + discriminative ML (SSFF 2405.19456; FinDVer EMNLP 2024)
- SME financial docs hard to machine-read: scanned, low-res, multilingual; multistage OCR+VLM beats direct large-VLM by 8.8× field accuracy at 0.7% GPU cost (2510.23066)

**Technical solutions (mapped to three pillars):**
- *Multi-agent orchestration*: hierarchical supervisor-worker best on cost-accuracy Pareto (F1 0.921 @ 1.4×) across 10K SEC filings (2603.22651)
- *Open-data cross-validation + standardization*: HybridRAG (KG+vector, 2408.04948), FinSage (CIKM 2025, recall 92.51%, 2504.14493)
- *Federated learning* (privacy-preserving, cross-institution, no raw-data movement): Open Banking FL (2108.10749), ProxyFL (Nature Comms), Intanify (AAAI 2025 — SME intangible-asset IP audit + DD + red flags + risk scoring, a shipped product)

## 8. Reference map

| Ref | Source | Best for |
|---|---|---|
| `01_台灣創投實務_CBIA.md` | CBIA 賴荃賢 | 五部曲, 五大構面, Taiwan VC history |
| `02_新創估值方法_PwC.md` | PwC | 六大估值法, VC Method, Scorecard |
| `03_創投評估交易面_startup101.md` | startup101 | IRR 20-30%, deal terms |
| `04_投資評估架構_張福榮CYUT.md` | CYUT academic | 11 大架構, 風險四層 |
| `05_早期投資案評估_AddinVC.md` | Addin Ventures | early Team/Product/Market, qualitative judgment |
| `06_募資4階段與投資人類型_中企署.md` | 中企署 (govt) | 募資4階段, Angel/VC/CVC, policy-aligned |
| `07_創投培訓課綱_RayCheese.md` | RayCheese/TAcc+ | accelerator curriculum, 三部曲 |
| `08_學術backing_arXiv策展.md` | arXiv (~20 papers) | academic grounding, pain-point evidence |

## 9. Provenance

Distilled 2026-06 from the SME「以數據驅動優化中小企業融資環境」competition preparation (project shelved; knowledge preserved). The investment-domain knowledge is reusable; the original proposal's tooling narrative (MCP×workflow×src) belongs to `doc-workflow`/`docxmcp` and is intentionally excluded here.
