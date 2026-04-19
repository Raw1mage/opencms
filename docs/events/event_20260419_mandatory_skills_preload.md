# Event: mandatory-skills-preload (2026-04-19)

## Context

- Feature spec: `specs/mandatory-skills-preload/` (state=implementing as of 2026-04-19)
- Root issue: `agent-workflow` skill 在 `templates/AGENTS.md:10` 雖被規定為 Main Agent bootstrap step 1，但 SkillLayerRegistry 有 10min summarize / 30min unload 的 idle-decay 機制。relevance 復活靠 substring match、實務上幾乎命中不到。使用者觀察到 dashboard 長期看不到 agent-workflow。
- 同時 runloop 的 continuation 判準已收斂為「純 todolist 殘留」，把這條關鍵契約託付給會 decay 的 skill 是架構性錯誤。
- 根本解：runtime 硬注入 + pin 必要 skill，繞過 AI 自律呼叫 `skill()` 的環節；並同步退役已功能性空殼化的 `agent-workflow`。

## Locked Decisions (2026-04-19 兩輪 AskUserQuestion)

1. `agent-workflow` 完全退役；syslog debug contract 搬進 `code-thinker`；continuation/completion gate SOP 搬進 AGENTS.md 第三條。
2. Sentinel 語法：`<!-- opencode:mandatory-skills -->` HTML comment + markdown bullet list。
3. Global + Project AGENTS.md 合併去重，project 優先。
4. 初始 pin 清單：`plan-builder`（Main Agent）+ `code-thinker`（coding subagent）。
5. Coding subagent 以 sentinel 寫在 `coding.txt` 內（同一 parser 路徑）；skill 檔缺失必須 loud warn + skip（AGENTS.md 第一條）。
6. Runtime 模組新增為 `packages/opencode/src/session/mandatory-skills.ts` 獨立模組。
7. 編輯範圍：repo-root `AGENTS.md` + `templates/AGENTS.md` 同步；不動使用者本機 `~/.config/opencode/AGENTS.md`（第二條）。

## Phase 1 Summary — Preflight (2026-04-19)

- **Phase**: 1 — Preflight XDG Backup And Branch Prep
- **Done**: 1.1, 1.2, 1.3, 1.4
- **Key decisions**: 無新增 DD-N；沿用 design.md 既有決策。
- **Validation**:
  - XDG backup：`~/.config/opencode.bak-20260419-2355-mandatory-skills-preload/` (58MB, 含 accounts.json / opencode.json / managed-apps.json / gauth.json)
  - Admission gate：beta worktree = `/home/pkcs12/projects/opencode-beta`，branch = `beta/mandatory-skills-preload`，從 `main` tip 19d05dfc0 出發，0 commits ahead
- **Drift**: `plan-sync.ts` warn 了 `packages/opencode/src/session/processor.ts` 與 `tool/question.ts`，是之前 commit 的遺留（不相關於本 spec）
- **Remaining**: Phase 2 (Parser Module) 起跑

## Phase 2 Summary — Parser Module (2026-04-20)

- **Phase**: 2 — Parser Module (A1 + A2 foundations)
- **Done**: 2.1, 2.2, 2.3, 2.4
- **Files created**:
  - `packages/opencode/src/session/mandatory-skills.ts` (249 lines)
  - `packages/opencode/src/session/mandatory-skills.test.ts` (19 tests)
- **Files modified**:
  - `packages/opencode/src/session/skill-layer-registry.ts`: 新增 `peek(sessionID, name)` helper（沒有 pin/unpin 變動；unpin 本就存在於 line 123）
- **Key decisions**: 將 merge/dedup 邏輯抽成 pure function `mergeMandatorySources` 以支援單元測試（不依賴 Instance/Global FS），`resolveMandatoryList` 成為薄 async wrapper。這使 TV5/TV6/TV7 可在不 mock FS 的前提下覆蓋。
- **Validation**:
  - `bun test src/session/mandatory-skills.test.ts` → 19 pass / 0 fail / 25 expect() calls
  - `bun run typecheck` (beta worktree) → 新檔案無錯；既有 pre-existing errors 不相關於本 feature
- **Drift**: 無新增 drift。
- **Remaining**: Phase 3（Preload + Registry Integration）已由 Phase 2 實作合併完成大部分（3.3/3.4/3.5 代碼已在 mandatory-skills.ts）；Phase 3 真正剩下的是驗證 unpin 行為 + 補 applyIdleDecay 對 pinned 的測試 + preload/reconcile 的 integration tests。

## Phase 3 Summary — Preload + Registry Integration (2026-04-20)

- **Phase**: 3 — Preload + Registry Integration (A3 + A4)
- **Done**: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
- **Files modified**:
  - `packages/opencode/src/session/skill-layer-registry.ts`: added `peek()` helper
  - `packages/opencode/src/session/skill-layer-registry.test.ts`: +TV12 pinned-aged-decay test + peek test
  - `packages/opencode/src/session/mandatory-skills.test.ts`: +5 reconcileMandatoryList tests covering TV13 + non-mandatory preservation + empty registry + dual keepRules
- **Key decisions**: 沒有 DD-N 新增。確認現有 `unpin` 實作（`pinned=false`, `runtimeState="idle"`, `desiredState` 不動）符合 DD-7 預期——下一輪 `applyIdleDecay` 將依 `lastUsedAt` 重新分類。
- **Validation**:
  - `bun test src/session/skill-layer-registry.test.ts` → 5 pass / 0 fail
  - `bun test src/session/mandatory-skills.test.ts` → 24 pass / 0 fail / 34 expect() calls
- **Drift**: 無。
- **Remaining**: Phase 4 (Runtime Wiring into prompt.ts) — 真正把 preload + reconcile 掛到 session runLoop，讓新 session 第一輪 system prompt 就自動帶入 mandatory skills。Integration tests (TV9/TV10/TV11/TV14/TV15) 走 §4.5 一併驗證。

## Phase 4 Summary — Runtime Wiring (2026-04-20)

- **Phase**: 4 — Runtime Wiring into prompt.ts runLoop
- **Done**: 4.1, 4.2, 4.3, 4.4 (deferred w/ rationale), 4.5
- **Files modified** (beta worktree):
  - `packages/opencode/src/session/prompt.ts` — added imports + 新段落（在 `processor.process()` 前）呼叫 `resolveMandatoryList → reconcileMandatoryList → preloadMandatorySkills`。AGENTS.md 第一條 loud-warn 原則：任何失敗以 `log.warn` + 非阻塞方式繼續 prompt 組裝。
  - `packages/opencode/test/session/mandatory-skills-integration.test.ts` — 6 個整合測試，用 `tmpdir` + `Instance.provide` 建置真實 AGENTS.md + `.claude/skills/<name>/SKILL.md`，覆蓋 TV9 (missing file) / TV10 (preload + pin) / TV11 (idempotent) / Main agent ignores coding.txt / coding subagent uses coding.txt only
- **Key decisions**: 4.4 cache 整合延後——每輪 2 次小檔 I/O 成本可忽略，Bun 已有 OS page cache，不值得新增自訂 cache 層。若 profile 顯示問題再優化。
- **Validation**:
  - `bun test src/session/mandatory-skills.test.ts src/session/skill-layer-registry.test.ts test/session/mandatory-skills-integration.test.ts` → 35 pass / 0 fail / 77 expect() calls
  - `bun run typecheck` → mandatory-skills 相關模組 0 錯誤（codebase pre-existing errors 不相關）
- **Drift**: 無。

## Phase 5 Summary — AGENTS.md Content Edits (2026-04-20)

- **Phase**: 5 — AGENTS.md 第三條 + sentinel + agent-workflow purge
- **Done**: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
- **Files modified** (beta worktree):
  - `packages/opencode/AGENTS.md` (repo-root) — 新增第三條「自主 Continuation 契約」+ `## Mandatory Skills（runtime-preloaded）` 含 sentinel 區塊 + `## Autonomous Agent 核心紀律` 段落（併入 agent-workflow §0/§6/§7/§8/§10）。保留歷史引用僅作退役脈絡說明。
  - `templates/AGENTS.md` — 同步上述變更；移除 bootstrap directive `skill(name="agent-workflow")`；「開發任務預設工作流」改為指向 `plan-builder`；debug contract 指向 `code-thinker`。
- **Validation**:
  - `parseMandatorySkills(project AGENTS.md)` → `["plan-builder"]` ✓
  - `parseMandatorySkills(templates AGENTS.md)` → `["plan-builder"]` ✓
- **Drift**: 無。

## Phase 6 Summary — coding.txt Update (2026-04-20)

- **Phase**: 6 — coding.txt sentinel + agent-workflow removal
- **Files modified** (beta worktree):
  - `packages/opencode/src/agent/prompt/coding.txt` — 加入 `<!-- opencode:mandatory-skills -->` sentinel (`code-thinker`)，移除 `skill(name="agent-workflow")` 引用，debug contract 說明改指向 code-thinker。
  - `templates/prompts/agents/coding.txt` — 與 runtime 同步。
- **Validation**: `parseMandatorySkills(coding.txt)` → `["code-thinker"]` ✓

## Phase 7 Summary — Debug Contract Migration + Governance Re-homing (2026-04-20)

- **Phase**: 7 — code-thinker absorbs syslog debug contract; agent-workflow governance migrated to AGENTS.md
- **Discovery**: `/home/pkcs12/projects/skills/` submodule 兩份 WIP（來自先前 session 未 commit 的修改）：
  - `agent-workflow/SKILL.md` WIP — 原為 rule-7 改 Single-thread + rule-8 Narration/Silent-stop + plan-builder 路由等 feedback memory 對應更新
  - `code-thinker/SKILL.md` WIP — §1 4→6 步擴充、§3 輕量化；**將 debug contract 作為 SSOT 反向指向 agent-workflow §5**（與本 spec 方向相反）
- **Reconciliation decision**: 依原本 spec DD-8 完全退役 agent-workflow，將 WIP 中有價值的內容分流到對應新家（per user: 「照原計畫走，那些將會遺失的內容，應該找另外歸屬地」）。
- **Files modified** (skills submodule — /home/pkcs12/projects/skills/):
  - `code-thinker/SKILL.md` — 整份改寫：保留 WIP §1 6-step 擴充與 §3 輕量 output-gate 版本；**inline 完整 Syslog-style Debug Contract（從 agent-workflow §5 搬入，含五段 checkpoint 與 component-boundary 規則）**；標示 2026-04-20 併入紀錄。
  - `agent-workflow/SKILL.md` — **deleted**（`git rm`）。
- **Files modified** (beta worktree — content migration destinations):
  - `packages/opencode/AGENTS.md` — 新段落「Autonomous Agent 核心紀律」：§0 八項核心原則、§6 Narration 五類、§7 Interrupt-safe Replanning 四步、§8 WAITING_APPROVAL Paused 回報格式、§10 Ops 摘要。
  - `templates/AGENTS.md` — 同步上述。
- **Governance content mapping**:
  - `agent-workflow §0 核心原則 1-8` → AGENTS.md 「Autonomous Agent 核心紀律 > 八項核心原則」
  - `agent-workflow §5 統一 Debug Contract` → `code-thinker/SKILL.md §3`
  - `agent-workflow §6 NARRATION` → AGENTS.md 「Narration 紀律」
  - `agent-workflow §7 Interrupt-safe Replanning` → AGENTS.md 「Interrupt-safe Replanning」
  - `agent-workflow §8 WAITING_APPROVAL` → AGENTS.md 「Stop / Waiting 回報格式」
  - `agent-workflow §10 Ops digest` → AGENTS.md 「操作準則摘要」
  - `agent-workflow §1-§5 spec-driven execution` → 已被 `plan-builder/SKILL.md §16` 完整覆蓋，不重複搬運
- **Validation**: `code-thinker/SKILL.md` 長度合理、結構清楚；governance 段落在兩份 AGENTS.md 皆生效。
- **Drift**: 無。

## Phase 8 Summary — agent-workflow Retirement (2026-04-20)

- **Phase**: 8 — 結構性刪除 + enablement.json 清理 + submodule pointer bump
- **Done**: 8.1 (delete), 8.2 (commit + pointer bump)
- **Files modified** (beta worktree):
  - `packages/opencode/src/session/prompt/enablement.json` — 從 `skills.bundled_templates` 移除 `agent-workflow`
  - `templates/prompts/enablement.json` — 同步上述
  - `packages/opencode/src/session/llm.skill-layer-seam.test.ts` — 測試 fixture 中的 `"agent-workflow"` 字串改為 `"example-summarized-skill"`（避免對已退役 skill 名的延續引用）
  - `templates/system_prompt.md` — 退役引用改寫（bootstrap 段 + 工作流狀態機段）
  - `templates/global_constitution.md` — 同上
  - `templates/skills` submodule pointer → 9103663（skills repo 的 retirement commit）
- **Skills submodule commit** (9103663): `refactor(skills): retire agent-workflow; absorb debug contract into code-thinker` — 1 檔刪除（agent-workflow/SKILL.md, 496 lines）+ 1 檔改寫（code-thinker/SKILL.md, +67 -...)。尚未 push 至 remote (gitlab/raw1mage)；待使用者決定。
- **Residual references** (historical notes only, safe to keep):
  - `"(原 agent-workflow ... 併入)"` / `"從已退役的 agent-workflow"` / `"retired on 2026-04-20"` 等脈絡說明
  - `user-message-context.ts` 的 `subagent-workflow` import 是不同模組（名稱碰撞，無關）
  - `templates/backup/AGENTS.md` 是備份檔，不影響 runtime
- **Validation**: 
  - `grep -r "agent-workflow" beta/packages/opencode/src/` — 只剩歷史脈絡註記 + 無關的 `subagent-workflow` import
  - `bun test src/session/llm.skill-layer-seam.test.ts` → 4 pass / 0 fail
- **Drift**: 無。

## Phase 9 Summary — Architecture Sync (2026-04-20)

- **Phase**: 9 — architecture.md 新增 Mandatory Skills Preload Pipeline 章節
- **File modified** (main repo / docsWriteRepo):
  - `specs/architecture.md` — 新增「Mandatory Skills Preload Pipeline」章節（約 70 行），涵蓋 data flow、sentinel 語法、source authorities 表、observability events、current mandatory lists、agent-workflow 退役交叉引用。
- **Validation**: 架構文件完整說明 pipeline + sentinel 語法，可供下次 session 或新人查閱。

## Authority Fields (beta-workflow §1)

| Field | Value |
|---|---|
| `mainRepo` | `/home/pkcs12/projects/opencode` |
| `mainWorktree` | `/home/pkcs12/projects/opencode` |
| `baseBranch` | `main` |
| `implementationRepo` | `/home/pkcs12/projects/opencode-beta` |
| `implementationWorktree` | `/home/pkcs12/projects/opencode-beta` |
| `implementationBranch` | `beta/mandatory-skills-preload` |
| `docsWriteRepo` | `/home/pkcs12/projects/opencode` |

## Preserved Stale Branch

- `beta/autonomous-opt-in` 在啟動本 feature 前還佔據 opencode-beta worktree
- 2 個 commits 尚未合 main（使用者表示故意不合）：
  - `ed8e9be2e feat(autorun): Phase 2 — runtime gate replaces always-on loop`
  - `6db33208d feat(autorun): Phase 1 — Storage namespaces, atomic flag, Bus events`
- 處理方式：
  - 建 annotated tag `archive/autonomous-opt-in-20260419` 指向 `ed8e9be2e`
  - 分支改名 `beta/autonomous-opt-in` → `shelf/autonomous-opt-in`（移出 `beta/*` 一次性 namespace）
  - 未 push 到遠端；待使用者決定是否推上 gitlab / raw1mage
