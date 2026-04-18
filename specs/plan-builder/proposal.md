# Proposal: plan-builder skill — 取代現行 planner 的 spec-centric lifecycle manager

## Why

- 現行 `planner` skill 過度偏向「new plan from scratch」：實作過程中發現 bug、產生新想法、需要重構時沒有明確回到 plan 的同步流程。
- `plans/` 與 `specs/` 兩個資料夾是手工時代遺留的二元論——在 AI-native 持續迭代下 spec 從 day 0 到 day N 是同一份活文件，不應因「進入執行」就改住所。
- 現行 artifact 集重於結構建模（IDEF0/C4/Sequence），但缺少**讓 code 能機械生成**的資料層：沒有 data schema、沒有 test vector、沒有 error catalogue、沒有 observability spec、沒有 invariants。code-independent spec 的 80/20 目標無法達成。
- 合規（SSDLC）證據收集成本高：現行 artifact 無法產出 auditor 需要的 change management evidence、threat model、data classification 等結構化資料。
- 「發現 bug→修改」分小/中/大改的判斷沒有客觀依據，使用者每次得主觀決定，導致 plan drift。

## Original Requirement Wording (Baseline)

- "planner skill也可以擴充成prompt帶script的方式，去輔助進行plan文件的規劃工作"
- "pm和dlc漸漸的融合了。變成一個all in one的管理loop"
- "我是覺得先把skill和附帶腳本都先create好，然後要做向下相容，用和平轉移的方式處理現在所有的轉案"
- "skill的名稱，我選擇plan-builder，主要目的是讓AI或所有人都易懂"
- "這是舊planner退役前的最後一個任務，就是幫自己寫一個新版出來"

## Requirement Revision History

- 2026-04-18：初始版本，基於當日對話收斂出 plan-builder 架構（7-state machine + 7-mode matrix + 合併 plans/specs + 新增 5 類 core artifact + SSDLC profile + 和平 migration）
- 2026-04-18：命名定為 `plan-builder`（捨棄 `lifecycle` / `dlc` / `ssdlc` 等對外高調方案，保持低認知成本）
- 2026-04-18：migration 策略確定為 on-touch 和平轉移 + `git mv` + 快照保留，不做批次轉換

## Effective Requirement Description

綜合原始需求與修訂紀錄，有效需求如下：

1. 建立名為 `plan-builder` 的新 skill 取代 `planner`，對外定位「易懂的 plan 建造工具」，內部實質為 spec-centric lifecycle management system。
2. 合併 `plans/{slug}/` 與 `specs/{slug}/` 為單一 `specs/{slug}/` 資料夾，以 `.state.json` 記錄當前狀態與轉換歷史。
3. 定義七大狀態（proposed / designed / planned / implementing / verified / living / archived）驅動 artifact 成熟度，每個 state 只要求該階段必要的 artifact。
4. 定義七種 mode（new / amend / revise / extend / refactor / sync / archive）作為狀態轉換動作，mode 判定依據「影響哪一層 spec」客觀化。
5. 新增五類 core artifact 補足 code-independent spec 缺口：`data-schema.json` / `test-vectors.json` / `errors.md` / `observability.md` / `invariants.md`。
6. 提供 SSDLC profile（optional）：`threat-model.md` / `data-classification.md` / `compliance-map.md`，讓開發流程產生合規級 evidence（不做合規驗證產品本身）。
7. 採用 prompt + script 架構（不升級為 MCP），新增 5 支新 script 與升級 2 支既有 script。
8. 向下相容 + on-touch 和平 migration：任何新 script 入口先跑 `ensureNewFormat()`，自動 `git mv` legacy 資料夾並快照，僅 log 不 modal prompt。
9. 保留與 `beta-workflow` 的 handoff 契約：tasks.md 仍為 build agent 的 todo materialization 來源，僅路徑調整。
10. Dog-fooding：本計畫本身用舊 planner 跑最後一次，作為新 skill 第一個 migration 測試向量。
11. **Sync mode 升格為必經檢查點**：每次 code 變動都須過「spec 是否要動」check。drift 偵測採 `warn`（印警告但放行）策略，`.state.json.history` 記錄 `sync warned` 作為 audit trail。自動觸發點為 `beta-workflow` 每個 task 勾選後（不走 git pre-commit hook、不擋 promote）。
12. **Per-part history（extended document addition）**：每個 artifact 的各個 part 必須支援版本疊加而非覆寫。採三層機制：inline delta markers（amend/revise/extend 的 `+`/`-` 差異標記）、section-level supersede（Requirement / Decision 加 v1/v2 + `[SUPERSEDED]` 標記）、full snapshot（refactor 時整份 artifact 自動搬到 `.history/refactor-YYYY-MM-DD/` 後重寫，可 rollback 透過 `plan-rollback-refactor` 指令）。

## Scope

### IN

- 新 `plan-builder` skill 的 SKILL.md 撰寫（使用者面契約）
- `.state.json` schema 定義（機器面契約）
- 七大狀態 × artifact 要求矩陣
- 七種 mode × 狀態轉換合法性矩陣
- 新增五類 core artifact 的 schema / required headings：`data-schema.json` / `test-vectors.json` / `errors.md` / `observability.md` / `invariants.md`
- SSDLC profile 三類 artifact 的 schema（optional profile）
- 新 scripts：`plan-state.ts` / `plan-promote.ts` / `plan-archive.ts` / `plan-migrate.ts` / `plan-gaps.ts`
- 既有 scripts 升級為 state-aware：`plan-init.ts` / `plan-validate.ts`
- `ensureNewFormat()` migration helper（被所有 scripts 呼叫）
- 狀態推斷規則（deterministic inference from legacy artifact set）
- Legacy `plans/{slug}/` → `specs/{slug}/` 的和平轉移流程（on-touch）
- 本計畫的 dog-fooding 執行（用舊 planner 建 `plans/plan-builder/`，Phase 2+ 由新 skill migrate 接手）
- 新增 script `plan-sync.ts`：偵測 code 改動對應 spec 的 drift，採 warn 策略回報
- 新增 script `plan-rollback-refactor.ts`：從 `.history/refactor-*/` 回復 snapshot 前狀態
- Per-part history 機制的三層實作：inline delta markers、section-level supersede、full snapshot
- 與 `beta-workflow` 的整合點：每 task 勾選後自動呼叫 sync（僅此單一觸發點，不做 git hook / promote gate）

### OUT

- 下游 skill（`beta-workflow` / `agent-workflow` / `miatdiagram` / `code-thinker`）同步更新：留到 plan-builder Phase 3 後批次處理
- SYSTEM.md / AGENTS.md / templates/ 相關段落更新：同上批次
- 合規驗證產品本身（SOC 2 / ISO 27001 certification 工具）：由 Vanta / Drata / auditor 處理
- 批次 migration（主動掃描所有 legacy plans）：僅做 on-touch 被動轉移
- MCP server 化：刻意保持在 prompt + script 層
- 舊 `planner` skill 立即刪除：保留共存期至少一次大版本

## Non-Goals

- 不做 plan 自動產生器（「輸入一句話生出完整 plan」）——planner 仍是 judgment-heavy 工作
- 不做 cross-repo plan 同步 / indexing
- 不做 GUI / web UI；CLI + skill prompt + markdown 足夠
- 不做 rich-text plan editor；artifact 維持純文字 markdown + JSON

## Constraints

- **禁止靜默 fallback**（AGENTS.md 第一條）：migration 必須 log 所有動作；狀態推斷失敗必須明確報錯不可 default
- **禁止跳過 plan**（AGENTS.md 第零條）：本計畫本身遵守——使用舊 planner 創建本 plan
- **不得破壞 beta-workflow handoff 契約**：tasks.md 結構與路徑解析相容
- **script 在 Bun runtime 下執行**：沿用 `bun run scripts/xxx.ts` 約定
- **git mv 必須保留 history**：migration 不可 copy + delete
- **Skill 必須可被 `/plan-builder` 或 `/planner`（alias）觸發**：過渡期雙命名並存

## What Changes

- 新增 skill `plan-builder`（`~/.claude/skills/plan-builder/`）
- 新增 `.state.json` schema 定義檔
- 新增 5 支新 script：`plan-state.ts` / `plan-promote.ts` / `plan-archive.ts` / `plan-migrate.ts` / `plan-gaps.ts`
- 升級 2 支既有 script：`plan-init.ts` / `plan-validate.ts`（state-aware）
- 新增 5 類 core artifact 模板
- 新增 3 類 SSDLC profile artifact 模板
- 舊 `planner` skill 保留但標記 deprecated

## Capabilities

### New Capabilities

- **Lifecycle state machine**: 追蹤 spec 從 proposed 到 archived 的成熟度演進，每次轉換留 history
- **Mode-driven change management**: amend / revise / extend / refactor / sync / archive 六種 in-flight mode 讓實作中的 bug 與新想法有明確回 spec 入口
- **Code-independent spec baseline**: 新增 artifact 補足資料、錯誤、可觀測性、不變量、測試向量五個維度，使 codegen 可機械化
- **SSDLC profile**: optional 啟用的安全性 artifact 層，產生可供 auditor 採信的 evidence
- **On-touch peaceful migration**: 舊 plans/{slug}/ 被觸碰時自動升級，使用者無感
- **Deterministic state inference**: 從既有 artifact 組合穩定推斷當前 state
- **Archive as state**: archived 是 state 轉換結果而非獨立位置
- **Mandatory sync checkpoint**: 每 task 勾選後自動 sync 檢查 code↔spec drift；drift 以 warn 策略回報並記入 history，不擋 commit
- **Per-part artifact history**: 三層（inline delta / supersede marker / full snapshot）；refactor 自動 snapshot 並提供 `plan-rollback-refactor` 逆向回復

### Modified Capabilities

- **Planner skill → plan-builder skill**: 名稱從「規劃」動詞改為「建造者」角色；scope 從單次建 plan 擴大到全生命週期
- **plans/ 資料夾 → specs/{slug}/ 唯一資料夾**: 合併後 spec 位置不因階段改變
- **plan-validate.ts**: 從「一次驗全部 10 個 artifact」改為「依當前 state 驗該 state 要求的 artifact」
- **plan-init.ts**: 從「產 10 個模板」改為「產 proposal.md + .state.json 骨架」
- **Validation Checklist**: 從扁平 12 項改為 state-gated——每個 state 有自己的進入條件

## Impact

- **新增檔案**:
  - `.claude/skills/plan-builder/SKILL.md`
  - `.claude/skills/plan-builder/scripts/` 下 5 新 + 2 升級
  - `.claude/skills/plan-builder/schemas/state.schema.json`
  - `.claude/skills/plan-builder/templates/` 下 8 新模板（5 core + 3 SSDLC profile）
- **影響資料夾**:
  - `plans/` 逐步清空（on-touch migration）
  - `specs/` 逐步累積 per-feature 資料夾 + `.state.json`
- **影響工作流程**:
  - 所有「開 plan」入口改走 plan-builder；`/planner` 保留 alias
  - beta-workflow tasks.md 讀取路徑在 Phase 3 後批次同步
- **影響文件**:
  - `docs/events/` 新增架構決議 event record
  - `specs/architecture.md` 新增 plan-builder 架構段落
  - `templates/AGENTS.md` / `templates/prompts/SYSTEM.md` 後續批次同步
  - `templates/prompts/enablement.json` 後續批次同步
- **影響使用者**: 任何現在用 `/planner` 的使用者；過渡期 `/planner` 仍可用
- **影響 APIs**: 無（本計畫不改 runtime API，只改 dev-time artifact 組織）
