# Design: plan-builder

## Context

- 現行 `planner` skill 位於 `~/.claude/skills/planner/`，scripts 為 `plan-init.ts` 與 `plan-validate.ts`，產 10 類 artifact 於 `/plans/{slug}/`。全域 `specs/architecture.md` 為 SSOT，per-feature 的 `specs/{slug}/` 僅於 merge 後或明確要求時產生。
- `/plans/` 下現約 15+ 個 legacy plan 存活，其中多數已非 active，但使用者偏好自然消退而非批次清理。
- `beta-workflow` skill 在 Phase 5 handoff 後接手 build 執行，固定讀 `plans/{slug}/tasks.md` 做 todo materialization。
- AGENTS.md 第零條（plan before implement）與第一條（禁止靜默 fallback）為本 repo 硬約束。
- 前次對話共識：spec 是 source of truth，code 是 derivative；plan / spec 是同一份 artifact 的成熟度差異而非本質差異；OpenSpec 的 delta markers 可抄（機械），minimum-viable 哲學不抄（策略分歧）。

## Goals / Non-Goals

**Goals:**
- 一個對外低認知成本（「plan-builder」）、對內高覆蓋（lifecycle 全階段）的 skill
- 七大狀態 × 七種 mode 矩陣，判定邊界客觀化（不靠主觀大/中/小）
- 讓 spec 承擔 80% 開發資源投入，使 codegen 可機械化（補齊 5 類 code-independent artifact）
- SSDLC profile 以「evidence source」定位而非「合規產品」
- On-touch peaceful migration，不中斷使用者工作
- Dog-fooding：本 plan 自身為第一個 migration 測試向量

**Non-Goals:**
- 不做 MCP server、GUI editor、cross-repo 同步
- 不做合規認證本身（Vanta / Drata 的戰場）
- 不做 plan 自動產生器
- 不立即刪除舊 planner（保留共存期）

## Decisions

- **DD-1 Skill 名稱：plan-builder**
  - Rationale: 使用者選擇易懂的動作 + 角色命名，避免「lifecycle」「dlc」「ssdlc」等讓不熟的 AI 與人誤判 scope。內部實質是 lifecycle manager，但介面保持低認知成本。

- **DD-2 合併資料夾：僅 `specs/{slug}/`**
  - Rationale: plan / spec 是同一份 artifact 的成熟度狀態，不該因階段改住所。archived 是 state 而非資料夾，保留原位置 + `.archive/` 快照或搬到 `specs/archive/`。避免像舊流程「手動 formalize」造成 plan drift。

- **DD-3 `.state.json` 作為機器契約**
  - Rationale: 每份 spec 的 state + history 必須 machine-readable 才能支撐 SOC 2 CC8.1 Change Management evidence。欄位：`state`, `history[]` (each `{from, to, at, by, mode, reason}`), `profile` (optional array e.g. `["ssdlc"]`).
  - 位置：每個 `specs/{slug}/.state.json`；格式：JSON with schema at `~/.claude/skills/plan-builder/schemas/state.schema.json`.

- **DD-4 七大狀態**
  - proposed / designed / planned / implementing / verified / living / archived
  - 每個 state 綁定一組必須存在且通過 validation 的 artifact；尚未進入的 state 對應 artifact 不強制
  - Rationale: 覆蓋 SDLC + SSDLC 階段、對應 SSDLC gate、保留「living」狀態明確表達「merged 不等於凍結」

- **DD-5 七種 mode 作為狀態轉換動作**
  - new / amend / revise / extend / refactor / sync / archive
  - Mode 是「轉換」動作，state 是「位置」；mode 判定依據「影響哪一層 spec」客觀化（spec.md 變 → revise；data-schema breaking → extend/refactor；只改 code 不改 spec → 不進 plan-builder）
  - Rationale: 使用者原本按「改動大小」判斷，太主觀；按「影響 spec 層級」判斷可 deterministic

- **DD-6 prompt + script，不升級 MCP**
  - Rationale: 所有 state 都在 repo 檔案內，無 in-memory state；無跨 session 共享需求；LLM 本來就讀 artifact，script 只負責機械性操作。MCP 多出 daemon、schema registration、資源常駐代價，不划算。劃線：**只有當多 agent 需共享 in-memory state 或外部工具無 repo 存取時才升 MCP**。

- **DD-7 五類 core artifact 補 code-independence 缺口**
  - `data-schema.json`（JSON Schema / TypeSpec）
  - `test-vectors.json`（input/output pairs，可直接跑的測試向量）
  - `errors.md`（error code、message、recovery）
  - `observability.md`（events / metrics / logs 清單）
  - `invariants.md`（cross-cut 契約保證）
  - Rationale: 這 5 類補齊資料、測試、錯誤、監控、不變量五維度，才支撐「spec → code 機械生成」。

- **DD-8 SSDLC profile optional**
  - `threat-model.md`（STRIDE × C4）/ `data-classification.md`（PII 流向）/ `compliance-map.md`（Requirement ↔ control 映射）
  - 以 `.state.json.profile: ["ssdlc"]` 標記啟用
  - Rationale: 非預設強制，避免所有 plan 都得寫安全文件；regulated team 才啟用

- **DD-9 `git mv` 為 migration 搬移手段**
  - Rationale: 保留每檔 git history；且 `git mv` 在 git 層面視為 rename，diff 清晰。若遇特殊情境（如 cross-device）需 fallback，必須 stop gate 與使用者確認，禁止靜默改用 copy+delete。

- **DD-10 `ensureNewFormat()` 包在所有 script 入口**
  - Rationale: 使用者不需要記 migrate command。每個 script 第一步偵測格式、缺 `.state.json` + 路徑在 `plans/` 即觸發 migration。Idempotent。
  - 日誌前綴 `[plan-builder-migrate]`，方便 grep 稽核。

- **DD-11 狀態推斷規則 deterministic**
  - 規則表（見 Data Flow 段）：artifact 組合 → state 單射
  - 不符規則表 → 拋 `StateInferenceError`，絕不 default
  - Rationale: 遵守 AGENTS.md 禁止靜默 fallback 第一條

- **DD-12 雙資料夾衝突處理：plans/{slug}/ 勝**
  - Legacy plans/{slug}/ + specs/{slug}/ 同時存在時，specs 既有內容先搬到新 `specs/{slug}/.archive/pre-migration-formalized/`，再把 plans 版內容 git mv 上去
  - Rationale: `plans/` 版是 active working copy，最新；`specs/` 版通常是舊 formalize snapshot

- **DD-13 共存期舊 skill 保留**
  - `~/.claude/skills/planner/` 保留可用，但 SKILL.md 頭部加 deprecation banner
  - `/planner` slash command 仍觸發舊 skill
  - Rationale: 避免破壞正在使用 `/planner` 的使用者習慣；等 telemetry 顯示無人使用再移除

- **DD-14 Dog-fooding：本 plan 為第一個 migration 驗證**
  - Phase 5 故意讓本 plan（創建時仍用舊 planner 架構，位於 `plans/plan-builder/`）被新 skill 自然觸碰而 migrate
  - Rationale: 最真實的回歸測試；若本 plan 都無法乾淨 migrate，下游 legacy plans 必定出錯

- **DD-15 Sync mode 為必經檢查點，採 warn 策略**
  - 新 script `plan-sync.ts` 偵測 code 變動對應 spec 的 drift
  - 發現 drift 印 `[plan-sync] WARN` 但不擋 commit，寫入 `.state.json.history` 作為 audit trail
  - Rationale: block 太重（卡住開發）、log only 太輕（失去主動提醒）；warn 平衡「永不 drift 的 audit 精神」與「不打斷開發速度」
  - 與 AGENTS.md 第一條相容：warn 不是靜默 fallback，而是 explicit 警告 + 留痕；使用者有權忽略但責任在己

- **DD-16 Per-part history 三層機制**
  - Layer 1 `inline delta markers`：amend / revise / extend 使用 `+`/`-` 或 `~~strikethrough~~` 標記，舊內容保留
  - Layer 2 `section-level supersede`：Requirement / Decision 加 `(vN)` 與 `[SUPERSEDED by X]` 標記
  - Layer 3 `full snapshot`：refactor 自動把所有 artifact（proposal.md 除外）搬到 `specs/{slug}/.history/refactor-YYYY-MM-DD/`，current artifact 重置
  - Rationale: 使用者明確要求「extended document addition」，意即每個 part 的版本疊加。`.state.json.history` 只記狀態機層級，不夠細；per-part history 給 auditor 看到「某個 Requirement 經歷了哪些版本」

- **DD-17 Refactor 自動 snapshot + rollback 指令**
  - `plan-promote.ts --mode refactor` 直接執行 snapshot + reset，不需使用者二次確認
  - 但提供 `plan-rollback-refactor.ts` 逆向回復，從 `.history/refactor-最近日期/` 還原
  - Rationale: 使用者決策為「自動執行 + 可 rollback」。git history 也可作為 fallback；過度 prompt 會增加 cognitive load
  - Risk mitigation: rollback 指令必須 idempotent，且 `.history/refactor-*/` 資料夾永不自動清理（僅手動 archive）

- **DD-18 Sync 單一自動觸發點：beta-workflow 每 task 勾選後**
  - 不做 git pre-commit hook（避免擋 commit + 系統複雜度）
  - 不做 promote gate（避免和狀態機耦合）
  - 僅 beta-workflow 內 task 勾選後呼叫 `plan-sync.ts`
  - Rationale: 單一整合點最容易維護；task 勾選本就是 build agent 意圖變更 spec 的明確時機；其他時機保留手動 `plan-builder sync` 指令
  - 對 beta-workflow 的反向要求：Phase 3 批次同步時加 hook 呼叫 sync

## Data / State / Control Flow

### 七大狀態 × artifact 要求矩陣

| State | 必須存在 | 可選 | SSDLC profile 啟用時加 |
|---|---|---|---|
| proposed | proposal.md, `.state.json` | — | data-classification.md (初判) |
| designed | +spec.md, design.md, idef0.json, grafcet.json, c4.json, sequence.json, data-schema.json | invariants.md | threat-model.md |
| planned | +tasks.md, handoff.md, test-vectors.json, errors.md, observability.md | invariants.md | compliance-map.md |
| implementing | 同 planned + tasks 逐項勾選 | — | — |
| verified | 同 planned + 全 tasks 勾選 + validation evidence | — | audit-trail（`.state.json` 自動產生） |
| living | 同 verified，可因 amend/revise/extend 再次加 tasks | — | — |
| archived | 同 living，但 frozen（read-only） | — | — |

### 七種 mode × 狀態轉換合法性矩陣

| Mode | 允許的 from → to | 典型用途 |
|---|---|---|
| new | (none) → proposed | 新建 spec |
| (forward) | proposed → designed → planned → implementing → verified → living | 一般前進 |
| amend | living → living（不變位置） | bug fix 不改 requirement |
| revise | living → designed（回退至 designed 再前進） | scope 微調、新增 phase |
| extend | living → designed | 新增 requirement / capability |
| refactor | living → proposed 或 designed（視幅度） | 架構級變更 |
| sync | any → 同層或前進 | 從 code 反推 spec 狀態 |
| archive | living → archived | 功能退役或併入其他 spec |

> 其中 `new` 僅用於新建；proposed→designed→planned 的順序前進視為「自然 promote」，由 `plan-promote.ts` 在滿足 artifact 要求時觸發，history 記錄 `mode: new` 的延伸或 `mode: promote`。

### 狀態推斷規則（deterministic）

優先順序由上而下；第一個匹配為準：

1. 資料夾路徑含 `/archive/` → `archived`
2. 已在 `specs/{slug}/` 且有 `.state.json` → 讀 `.state.json.state`（no inference needed）
3. `tasks.md` 不存在但 `design.md` / `c4.json` 存在 → `designed`
4. `tasks.md` 存在且全 `- [ ]` 未勾選 → `planned`
5. `tasks.md` 存在且有 `- [x]` 勾選但未全勾 → `implementing`
6. `tasks.md` 存在且全勾選 + validation evidence（`validation/` 子資料夾或 `handoff.md` 的 Current State 段含 "all tests pass" 等關鍵字）→ `verified`
7. 已在 `specs/{slug}/`（舊 formalized，無 `.state.json`） → `living`
8. 只有 `proposal.md`，無其他 → `proposed`
9. 其他組合 → 拋 `StateInferenceError`（列出觀察到的 artifact、說明為何無法推斷、建議人工指定 state）

### Migration 流程（on-touch）

```
Script entry
  ↓
ensureNewFormat(path)
  ├─ path 在 specs/ 且有 .state.json → no-op, return
  ├─ path 在 plans/ 無 .state.json:
  │    ↓
  │    inferState(path)  ─ fail → throw StateInferenceError
  │    ↓
  │    snapshot: cp -r plans/{slug}/ → specs/{slug}/.archive/pre-migration-YYYYMMDD/ (via git if possible)
  │    ↓
  │    if specs/{slug}/ already exists:
  │       git mv specs/{slug}/ specs/{slug}/.archive/pre-migration-formalized-YYYYMMDD/
  │    ↓
  │    git mv plans/{slug}/ specs/{slug}/
  │    ↓
  │    write specs/{slug}/.state.json with inferred state + history entry {to: inferred, mode: "migration", reason: "peaceful on-touch from legacy plans/"}
  │    ↓
  │    log every step with [plan-builder-migrate] prefix
  └─ return to caller
```

### 各 script 職責

- `plan-init.ts {slug}`: 建 `specs/{slug}/proposal.md` + `.state.json` (state=proposed)；不預產其他 artifact
- `plan-state.ts {path}`: 讀 `.state.json.state` 印出；若舊格式先觸發 migration 再印
- `plan-promote.ts {path} --to {state}`: 驗 artifact 要求是否符合目標 state；合法則寫入 history；非法則報錯
- `plan-archive.ts {path}`: state → archived；選項 `--move-to-archive-folder` 將資料夾實體搬到 `specs/archive/{slug}-YYYY-MM-DD/`
- `plan-migrate.ts {legacy-path}`: 手動觸發 migration（也可由其他 script 自動觸發）
- `plan-gaps.ts {path}`: 分析 code-independence 漏洞（缺 schema、abstract GWT 缺 test-vectors、無 errors.md 等），輸出建議
- `plan-validate.ts {path}`: 依 `.state.json.state` 決定驗哪些 artifact（state-aware）

## Risks / Trade-offs

- **Risk: 狀態推斷規則遺漏邊緣情境** → **Mitigation**: 規則表任何 miss 直接拋 `StateInferenceError`（不 default）；實作 Phase 5 的 dog-fooding 會實測一種組合；規則表保留在 design.md 接受後續補充
- **Risk: `git mv` 在跨 filesystem 或 submodule 邊界失敗** → **Mitigation**: `plan-migrate.ts` 先偵測路徑是否同一 git 工作樹；失敗則中止並回報（不 fallback 到 copy+delete 除非使用者核准）
- **Risk: beta-workflow 仍讀舊路徑 `plans/{slug}/tasks.md`** → **Mitigation**: 過渡期在新位置建立 `plans/{slug}` → `specs/{slug}` symlink；或在 migration 時同步更新 beta-workflow 內硬編碼路徑（若 Phase 3 後批次處理則 symlink 為主手段）
- **Risk: 雙資料夾衝突時選擇 plans/ 為 source-of-truth 可能覆蓋 specs/ 新內容** → **Mitigation**: 衝突時具備 snapshot；並且在 log 強調「若 specs/ 版本較新請停止操作並人工仲裁」；邊緣情境接受
- **Risk: 使用者搞不清楚「state」「mode」「artifact」三者關係** → **Mitigation**: SKILL.md 首段用 1 張矩陣圖清楚標示：state = 位置、mode = 轉換動作、artifact = 每狀態要求的內容物
- **Risk: artifact 數量暴增（10 → 15+）讓使用者退怯** → **Mitigation**: 新 artifact 按 state 需要才生成；proposed 階段只要 proposal.md；SSDLC 預設 off
- **Risk: 共存期雙 skill 載入順序衝突** → **Mitigation**: `/planner` 與 `/plan-builder` 皆為獨立 skill name，Claude harness 不混淆；deprecation banner 指引使用者遷移
- **Trade-off: 不做批次 migration** → **Why chosen**: 使用者明確選擇和平轉移；主動批次會打斷正在進行中的 legacy plans，且若 migration 有 bug 會大範圍影響

## Critical Files

- `~/.claude/skills/plan-builder/SKILL.md`
- `~/.claude/skills/plan-builder/schemas/state.schema.json`
- `~/.claude/skills/plan-builder/scripts/plan-init.ts`
- `~/.claude/skills/plan-builder/scripts/plan-validate.ts`
- `~/.claude/skills/plan-builder/scripts/plan-state.ts`
- `~/.claude/skills/plan-builder/scripts/plan-promote.ts`
- `~/.claude/skills/plan-builder/scripts/plan-archive.ts`
- `~/.claude/skills/plan-builder/scripts/plan-migrate.ts`
- `~/.claude/skills/plan-builder/scripts/plan-gaps.ts`
- `~/.claude/skills/plan-builder/scripts/plan-sync.ts`
- `~/.claude/skills/plan-builder/scripts/plan-rollback-refactor.ts`
- `~/.claude/skills/plan-builder/scripts/lib/inline-delta.ts`（inline marker 工具）
- `~/.claude/skills/plan-builder/scripts/lib/snapshot.ts`（refactor snapshot 工具）
- `~/.claude/skills/plan-builder/scripts/lib/ensure-new-format.ts`
- `~/.claude/skills/plan-builder/scripts/lib/state-inference.ts`
- `~/.claude/skills/plan-builder/templates/`（8 新模板）
- `/home/pkcs12/projects/opencode/specs/architecture.md`
- `/home/pkcs12/projects/opencode/docs/events/`

## Supporting Docs (Optional)

- 待補：`notes/openspec-comparison.md`（OpenSpec methodology 對照筆記，如需）
