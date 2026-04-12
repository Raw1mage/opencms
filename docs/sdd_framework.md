# SDD Framework — Spec-Driven Development 方法論

本文件說明 OpenSpec 的架構設計、我們如何將其移植為 planner skill 作為規劃執行工具，以及這套方法論的獨特之處與實際效益。

---

## 1. OpenSpec 架構概覽

[OpenSpec](https://github.com/Fission-AI/OpenSpec) 是一套 **spec-driven development framework**，核心理念為：

> fluid not rigid · iterative not waterfall · easy not complex · built for brownfield not just greenfield

### 1.1 雙層結構：specs/ 與 changes/

```
openspec/
├── specs/           ← 系統行為的 Source of Truth（按 capability domain 分類）
│   ├── auth/
│   ├── payments/
│   └── ...
└── changes/         ← 提案中的變更（delta-based，只描述差異）
    ├── add-2fa/
    └── archive/     ← 已完成的變更（日期前綴歸檔）
```

- **specs/** 描述系統「現在是什麼」—— 每個 capability domain 包含 Purpose、Requirements（RFC 2119 關鍵字）、Scenarios（GIVEN/WHEN/THEN）。
- **changes/** 描述「要改什麼」—— 使用 ADDED / MODIFIED / REMOVED / RENAMED 四種 delta 操作，不是重寫整份 spec，而是描述差異。

### 1.2 四層 Artifact 依賴圖

每個 change 是一個資料夾，包含四份逐層建構的文件：

```
            proposal.md
           (Why + What)
              │
    ┌─────────┴─────────┐
    ▼                   ▼
  specs/            design.md
(Delta specs)    (How + Decisions)
    │                   │
    └────────┬──────────┘
             ▼
          tasks.md
      (Execution checklist)
```

| Artifact     | 回答什麼           | 內容                                           |
| ------------ | ------------------ | ---------------------------------------------- |
| proposal.md  | Why / What Changes | 動機、影響範圍、新增/修改的 capabilities        |
| specs/       | What (behavioral)  | GIVEN/WHEN/THEN 場景，delta 格式                |
| design.md    | How                | 技術決策、風險、Critical Files、Migration Plan  |
| tasks.md     | Do what, in order  | 分層編號的 checkbox 清單，依賴排序              |

### 1.3 生命週期：propose → apply → archive

```
/opsx:propose  →  /opsx:apply  →  /opsx:archive
  建立 change       實作 tasks      merge delta → specs/
  + 全部 artifacts                   歸檔到 archive/
```

Archive 過程會將 delta specs 合併回主 specs（RENAMED → REMOVED → MODIFIED → ADDED），變更資料夾完整保留到 `changes/archive/YYYY-MM-DD-name/`，提供完整的變更追溯。

### 1.4 Schema 驅動的工作流

OpenSpec 的工作流由 YAML schema 定義（`schemas/spec-driven/schema.yaml`），描述 artifact 的類型、模板、生成指令和依賴關係。支援自訂 schema 來適應不同的工作流需求。

---

## 2. 移植到 Planner Skill

我們將 OpenSpec 的核心概念移植到 `planner` skill，並進行了大幅度的擴充，使其成為 AI agent 可執行的規劃工具。

### 2.1 從 4 層擴充到 10 層 Artifact

OpenSpec 原始的 4 份 artifact（proposal / specs / design / tasks）在我們的 planner 中被擴充為 **10 份**：

#### Markdown Artifact（6 份）

| # | Artifact               | 角色                                         |
|---|------------------------|----------------------------------------------|
| 1 | implementation-spec.md | **主執行契約** — build agent 最先讀的文件       |
| 2 | proposal.md            | 需求來源、修訂歷程、影響分析                    |
| 3 | spec.md                | 行為需求 + GIVEN/WHEN/THEN 場景                |
| 4 | design.md              | 架構決策（DD-1, DD-2…）、風險、Critical Files  |
| 5 | tasks.md               | 分層執行清單，對齊 implementation-spec 的 Phase |
| 6 | handoff.md             | 交接清單：必讀文件、Stop Gates、就緒檢查        |

#### JSON Diagram Artifact（4 份）

| # | Artifact       | 標準來源     | 角色                                      |
|---|----------------|-------------|-------------------------------------------|
| 7 | idef0.json     | IEEE 1320.1 | 功能分解 — 系統「做什麼」的層級拆解          |
| 8 | grafcet.json   | IEC 60848   | 狀態機 — 系統「怎麼轉換狀態」的序列模型      |
| 9 | c4.json        | C4 Model    | 組件圖 — 系統「由什麼組成」                  |
| 10| sequence.json  | UML         | 時序圖 — 關鍵場景的 runtime 互動流           |

### 2.2 四向追溯鏈

四份 JSON artifact 之間建立了嚴格的 cross-reference：

```
IDEF0 (A<N>)  ──moduleRef──→  C4 (C<N>)  ──componentRef──→  Sequence (P<N>/MSG<N>)
  功能分解                      組件結構                       運行時流程
     ↑
  GRAFCET (ModuleRef)
  狀態轉移
```

- 每個 C4 component 的 `moduleRef` 必須指向有效的 IDEF0 activity ID
- 每個 Sequence participant 的 `componentRef` 必須指向有效的 C4 component/system ID
- 每個 GRAFCET step 的 `ModuleRef` 必須指向有效的 IDEF0 activity ID
- `plan-validate.ts` 自動驗證這些 cross-reference 的完整性

### 2.3 Plan 生命週期

```
Phase 1: Understand     探索 codebase、釐清需求
Phase 2: Plan           初始化 plan 目錄、撰寫 proposal → impl-spec → spec → design
Phase 3: Detail         撰寫 tasks + handoff、生成 IDEF0/GRAFCET/C4/Sequence
Phase 4: Validate       bun run plan-validate.ts → 修正 → 直到通過
Phase 5: Handoff        使用者審核 → beta-workflow 接手執行
```

**工具鏈：**
- `plan-init.ts` — 從模板初始化 10 份 artifact（已存在的不覆寫）
- `plan-validate.ts` — 結構完整性 + placeholder 偵測 + JSON schema 驗證 + 跨 artifact 追溯驗證
- `miatdiagram` skill — 專責產出 IDEF0 + GRAFCET JSON
- `beta-workflow` skill — 接手 build execution（建立 worktree / branch / todo 物化）

### 2.4 Plan 目錄結構

```
plans/
└── YYYYMMDD_feature-slug/
    ├── implementation-spec.md
    ├── proposal.md
    ├── spec.md
    ├── design.md
    ├── tasks.md
    ├── handoff.md
    ├── idef0.json
    ├── grafcet.json
    ├── c4.json
    ├── sequence.json
    └── diagrams/              ← 深層分解（A1, A2 子層級）
        ├── repo_a1_idef0.json
        ├── repo_a1_grafcet.json
        └── ...
```

完成實作並 merge 後，plan artifact 整合到 `specs/<semantic_family>/` 作為長期 SSOT。

---

## 3. 方法論特色

### 3.1 Delta-Based 變更管理（繼承自 OpenSpec）

不同於傳統 SDD 要求重寫完整的需求文件，我們採用 delta 格式（ADDED / MODIFIED / REMOVED），這讓 brownfield 專案的規格維護成本大幅降低。變更只描述「差異」，archive 時自動合併回主 specs。

### 3.2 工業標準建模 + AI 原生執行

我們將 IEEE 1320.1（IDEF0）和 IEC 60848（GRAFCET）這兩個工業自動化標準引入軟體規劃：

- **IDEF0** 提供功能分解的嚴格層級（A0 → A1-A9 → A11-A19 → ...），每個 activity 有明確的 ICOM（Input / Control / Output / Mechanism）語義
- **GRAFCET** 提供狀態轉移的形式化描述，嚴格交替 step 與 transition，適合描述非同步系統行為

這不是紙上的圖表——JSON 格式讓 AI agent 能直接解析、驗證、執行。

### 3.3 Implementation-Spec 作為執行契約

OpenSpec 沒有 `implementation-spec.md`，這是我們新增的核心 artifact。它是 build agent 的 **第一份必讀文件**，包含：

- **Goal**：一句話執行目標
- **Scope（IN/OUT）**：明確的邊界，防止 scope creep
- **Stop Gates**：需要人工決策的阻斷條件
- **Structured Execution Phases**：分階段的執行計劃
- **Validation**：驗收標準

這讓 AI agent 能在沒有對話歷史的情況下，僅從 artifact 就能理解並執行任務。

### 3.4 四向追溯 + 自動驗證

傳統 SDD 的追溯矩陣是手動維護的表格，容易腐敗。我們的追溯是：

- **結構化的**：JSON 中的 `moduleRef` / `componentRef` 是機器可驗證的 foreign key
- **自動驗證的**：`plan-validate.ts` 在每次 plan exit 時檢查所有 cross-reference
- **四向的**：功能（IDEF0）↔ 狀態（GRAFCET）↔ 組件（C4）↔ 時序（Sequence）

### 3.5 Discussion-First + Fail-Fast

- **Planning 階段禁止大規模實作**，只允許探索性的小改動
- **每個 artifact 必須非空**，placeholder 會被偵測並擋住
- **Silent fallback 被明確禁止**——查不到 loader、fetch 失敗，都必須明確報錯
- **Stop Gates 機制**要求在關鍵決策點暫停，取得人工確認

### 3.6 Delegation-Aware 的任務拆解

tasks.md 的設計不是給人讀的待辦清單，而是 **build agent 能直接拾取的 action slice**：

- 任務名稱是動作導向：`rewrite X`、`integrate Y`、`validate Z`
- 任務對齊 implementation-spec 的 Phase 編號
- `[x]` 已完成、`[ ]` 待執行、`[~]` 延後——agent 能解析並追蹤進度

### 3.7 Formalization Lifecycle（Plan → Spec 晉升）

```
plans/20260408_webapp/  →  (build + merge)  →  specs/webapp/voice-input/spec.md
plans/codex-refactor/   →  (build + merge)  →  specs/codex/provider_runtime/
```

Plan 是暫態的工作空間；Spec 是長期的行為契約。完成後的 plan 整合到語義化的 `specs/` 家族，成為系統行為的 SSOT。

---

## 4. 效益總結

### 對規劃品質的效益

| 效益 | 說明 |
|------|------|
| **需求不遺失** | Proposal 忠實記錄原始需求措辭，revision history 追蹤每次修訂 |
| **設計可驗證** | GIVEN/WHEN/THEN 場景可直接轉化為測試案例 |
| **架構可視化** | IDEF0 提供功能全景、GRAFCET 提供行為全景、C4 提供結構全景 |
| **追溯可機驗** | 四份 JSON 的 cross-reference 由腳本自動驗證，不依賴人工維護 |

### 對 AI Agent 執行的效益

| 效益 | 說明 |
|------|------|
| **Context-Free 執行** | Build agent 僅從 artifact 即可理解任務，不需對話歷史 |
| **Scope 約束** | Implementation-spec 的 IN/OUT + Stop Gates 防止 agent scope creep |
| **進度可追蹤** | tasks.md 的 checkbox 狀態讓 agent 和人都能追蹤進度 |
| **失敗可恢復** | Handoff.md 包含就緒檢查清單，新 agent 能從斷點續做 |
| **驗證可自動化** | plan-validate.ts 強制結構完整性，消除「空殼 plan」的風險 |

### 對團隊協作的效益

| 效益 | 說明 |
|------|------|
| **知識保存** | 每個 plan 的完整 context（proposal + design + diagrams）歸檔保留 |
| **Brownfield 友好** | Delta-based 變更管理讓規格維護成本隨變更量而非系統總量增長 |
| **漸進式深化** | IDEF0 的層級分解支援先粗後細：A0 快速對齊 → A1-A9 逐步展開 |
| **可審計** | 日期前綴的 plan 目錄 + archive 提供完整的決策時間線 |
| **工具無關** | 所有 artifact 都是 Markdown + JSON，不綁定特定 IDE 或平台 |

### 對系統演進的效益

| 效益 | 說明 |
|------|------|
| **Spec 有機增長** | Archive 將 delta 合併回主 specs，系統行為契約自然演進 |
| **Architecture SSOT** | `specs/architecture.md` 作為全域結構真相來源，plan 不重複定義 |
| **語義化歸檔** | 完成的 plan 整合到 `specs/<family>/`，按 domain 而非時間組織 |
| **標準兼容** | IDEF0 (IEEE 1320.1) / GRAFCET (IEC 60848) / C4 / UML 都是業界標準 |
