# Implementation Spec

## Goal

- 建造 `plan-builder` skill 取代 `planner`，以七大狀態機 + 七種 mode 驅動統一 `specs/{slug}/` 資料夾下的 spec 生命週期，並支援 on-touch 和平 migration。

## Scope

### IN

- 新 `plan-builder` skill 的 SKILL.md（使用者面契約）
- `.state.json` schema（機器面契約）+ state × artifact 要求矩陣 + mode × 狀態轉換矩陣
- 5 類 core artifact schema：`data-schema.json` / `test-vectors.json` / `errors.md` / `observability.md` / `invariants.md`
- 3 類 SSDLC profile artifact schema（optional）：`threat-model.md` / `data-classification.md` / `compliance-map.md`
- 新增 5 支 script：`plan-state.ts` / `plan-promote.ts` / `plan-archive.ts` / `plan-migrate.ts` / `plan-gaps.ts`
- 升級 2 支既有 script 為 state-aware：`plan-init.ts` / `plan-validate.ts`
- `ensureNewFormat()` migration helper + deterministic 狀態推斷
- Legacy `plans/{slug}/` → `specs/{slug}/` on-touch 和平轉移流程
- Dog-fooding：用舊 planner 建本 plan，Phase 2+ 由新 skill 接手

### OUT

- 下游 skill（beta-workflow / agent-workflow / miatdiagram / code-thinker）的同步更新
- SYSTEM.md / AGENTS.md / templates/ 相關段落更新
- 合規驗證產品本身（SOC 2 / ISO 27001 certification tooling）
- 批次 migration（主動掃描所有 legacy plans）
- MCP server 化
- 舊 `planner` skill 立即刪除

## Assumptions

- Bun runtime 在開發與 CI 環境穩定可用，所有 scripts 以 `bun run` 執行
- Git 為唯一版控後端，`git mv` 可保留 history
- 本 repo `/plans/` 與 `/specs/` 資料夾為可變更目標，且現行約 15+ 個 legacy plan 會在日後觸碰時才逐個 migrate
- `beta-workflow` skill 現行只讀 `plans/{slug}/tasks.md`，在 Phase 3 批次同步前仍可用（過渡期由 migration logic 保證 tasks.md 存在於新位置）
- AGENTS.md 第零條（plan before implement）與第一條（禁止靜默 fallback）為硬約束，本實作需滿足
- 使用者接受「共存期」：舊 `planner` skill 與新 `plan-builder` skill 至少共存一個大版本
- `/home/pkcs12/.claude/skills/` 可寫入；或 repo-local `.claude/skills/plan-builder/` 亦可作為部署位置（最終位置由使用者決定，Stop Gate 之一）

## Stop Gates

- **使用者未確認 SKILL.md draft**：SKILL.md + `.state.json` schema 合併 draft 產出後必須取得使用者 review，才可進入 script 實作
- **使用者未確認 skill 部署位置**：`~/.claude/skills/plan-builder/`（全域）vs `.claude/skills/plan-builder/`（repo-local）需使用者拍板
- **migration 邏輯若改變 git history**：如實作發現 `git mv` 在特殊情境需改走 copy+delete，必須停下與使用者確認
- **狀態推斷規則無法 deterministic 收斂**：若某組 legacy artifact 組合無法推斷單一 state，必須設計 explicit fallback 並取得批准（禁止靜默推斷到 default）
- **下游 skill 契約變動超出相容範圍**：若 beta-workflow handoff 契約因 `specs/{slug}/` 路徑改變而必須連動改 runtime behavior，停下討論
- **Phase 5 驗收**：dog-fooding migration 實測失敗（本 plan 搬進 `specs/plan-builder/` 過程出錯），停下並回歸 Phase 2 修補

## Critical Files

- `~/.claude/skills/plan-builder/SKILL.md`（或 repo-local 等效位置）
- `~/.claude/skills/plan-builder/schemas/state.schema.json`
- `~/.claude/skills/plan-builder/scripts/plan-init.ts`（升級）
- `~/.claude/skills/plan-builder/scripts/plan-validate.ts`（升級）
- `~/.claude/skills/plan-builder/scripts/plan-state.ts`（新）
- `~/.claude/skills/plan-builder/scripts/plan-promote.ts`（新）
- `~/.claude/skills/plan-builder/scripts/plan-archive.ts`（新）
- `~/.claude/skills/plan-builder/scripts/plan-migrate.ts`（新）
- `~/.claude/skills/plan-builder/scripts/plan-gaps.ts`（新）
- `~/.claude/skills/plan-builder/scripts/lib/ensure-new-format.ts`（新 helper）
- `~/.claude/skills/plan-builder/scripts/lib/state-inference.ts`（新 helper）
- `~/.claude/skills/plan-builder/templates/` 下 8 個新 artifact 模板
- `/home/pkcs12/projects/opencode/plans/plan-builder/`（本 dog-fooding 計畫自身位置，最終會 migrate 到 `specs/plan-builder/`）
- `/home/pkcs12/projects/opencode/specs/architecture.md`（plan-builder 架構段落新增點）
- `/home/pkcs12/projects/opencode/docs/events/`（新增架構決議 event record）

## Structured Execution Phases

- **Phase 1 — Contract 定案（draft SKILL.md + state schema）**：產出新 SKILL.md 與 `.state.json` schema draft，包含七大狀態 × artifact 要求矩陣、七種 mode × 狀態轉換矩陣、狀態推斷規則。Stop gate: 使用者 review 通過。
- **Phase 2 — Core scripts 實作**：實作 `plan-state.ts` / `plan-promote.ts` / `plan-archive.ts` / `plan-migrate.ts` / `plan-gaps.ts` + `ensureNewFormat` helper + state-inference helper，並升級 `plan-init.ts` / `plan-validate.ts` 為 state-aware。
- **Phase 3 — Artifact 模板建立**：產出 5 類 core artifact + 3 類 SSDLC profile artifact 的模板檔，並在 `plan-init.ts` 中依 state 觸發對應模板生成。
- **Phase 4 — Skill 部署 + 舊 skill deprecation marker**：將 `plan-builder` 部署到選定位置（全域或 repo-local），舊 `planner` skill 加上 deprecated 標記與指向新 skill 的 hint。
- **Phase 5 — Dog-fooding migration 驗證**：以本 plan（`plans/plan-builder/`）當第一個 migration 測試案例，執行 `ensureNewFormat()` 讓它搬到 `specs/plan-builder/` + 快照到 `.archive/pre-migration/`，驗證狀態推斷結果、history 寫入、git history 保留。
- **Phase 6 — 文件與事件紀錄**：更新 `specs/architecture.md` plan-builder 段落；新增 `docs/events/YYYY-MM-DD-plan-builder-launch.md` 事件紀錄；本 plan 自身狀態推進到 verified。

## Validation

- **Phase 1 驗收**：SKILL.md 通過使用者 review；`.state.json` schema 可被 JSON Schema validator 解析；七大狀態與七種 mode 的矩陣互相一致（無孤兒 state、無孤兒 mode）
- **Phase 2 驗收**：
  - `bun run scripts/plan-state.ts specs/plan-builder/` 正確印出當前 state
  - `bun run scripts/plan-validate.ts specs/plan-builder/` 只驗當前 state 要求的 artifact 且通過
  - `plan-promote.ts` 能從 proposed → designed → planned 逐步前進，拒絕違法轉換
  - `plan-migrate.ts` 對人工佈置的 legacy plan 樣本能正確推斷 state 並搬家
- **Phase 3 驗收**：每類 artifact 模板可被 `plan-init.ts` 依 state 觸發產生；validator 能辨識其必要 heading
- **Phase 4 驗收**：`/plan-builder` slash command 可觸發新 skill；`/planner` alias 仍可用；舊 skill 載入時顯示 deprecation hint
- **Phase 5 驗收**：
  - 本 `plans/plan-builder/` 自動 migrate 到 `specs/plan-builder/`
  - `specs/plan-builder/.state.json` 存在且 state 推斷為 `implementing`（因為 tasks.md 含已勾選項）
  - `specs/plan-builder/.archive/pre-migration/` 快照存在
  - `git log --follow specs/plan-builder/proposal.md` 可追溯到 `plans/plan-builder/proposal.md` 的 history
  - 所有 migration 動作有對應 log 行輸出
- **Phase 6 驗收**：`specs/architecture.md` 通過人工閱讀檢查；event record 存在且格式一致
- **整體端到端驗收**：本 plan 自身走完 proposed → designed → planned → implementing → verified 五次 promote 無誤

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts (proposal.md / spec.md / design.md / tasks.md / handoff.md / idef0.json / grafcet.json / c4.json / sequence.json) before coding.
- Build agent must materialize runtime todo from tasks.md before coding.
- Conversation memory is supporting context only, not the execution source of truth.
- If scope changes mid-execution, update this plan via revise/extend/refactor mode before coding further.
- At completion time, review implementation against proposal.md's Effective Requirement Description section.
