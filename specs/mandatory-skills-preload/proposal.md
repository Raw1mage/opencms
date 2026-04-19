# Proposal: mandatory-skills-preload

## Why

- `agent-workflow` skill 雖然在 `templates/AGENTS.md` 第 10 行被規定為 Main Agent bootstrap step 1，實務上卻「可有可無」——使用者觀察多數 session 的「已載技能」dashboard 完全看不到它。
- 根因在 `packages/opencode/src/session/skill-layer-registry.ts` 的 idle-decay 機制：`IDLE_SUMMARY_MS=10min`、`IDLE_UNLOAD_MS=30min`，且 relevance 復活條件只是 `latestUserText` 純字串 substring 比對 skill name / purpose / keepRules。一般對話（「繼續」「修 bug」）完全不會 match 到 `agent-workflow`，於是它被默默降級 / 卸載。
- 同時，runloop 的 autonomous continuation 判準已演化為「純 todolist 殘留」（見 `packages/opencode/src/session/workflow-runner.ts`）。這個設計要 AI 在條件符合時主動 append pending todo 來觸發 continue，但承載這條紀律的 `agent-workflow` skill 又是最容易 decay 掉的載體——形成「關鍵契約住在最脆弱的地方」的矛盾。
- 根本解：把需要「每輪都在場」的契約從 skill layer 搬到 runtime 硬保證路徑（AGENTS.md / runtime preload + pin），並退役已經功能性空殼化的 `agent-workflow`。

## Original Requirement Wording (Baseline)

- 「agent-workflow在這陣子的使用以來，變得可有可無的。大部份時候在『載入技能』dashboard也未曾看到它存在。」
- 「runtime能強制讀AGENTS.md，那有沒有辦法parse AGENTS.md用skill()幫我把必要skills註冊起來甚至pin起來」
- 「第一個問題是，agent-workflow到底還有沒有需要留。」

## Requirement Revision History

- 2026-04-19: initial draft created via plan-init.ts
- 2026-04-19: 7 項鎖定決策經 AskUserQuestion 兩輪收斂完成（見 §Effective Requirement Description）

## Effective Requirement Description

在 `main` branch runtime 引入「AGENTS.md mandatory-skills 區塊解析 + 自動 register + 自動 pin」機制，並同步退役 `agent-workflow` skill，將其獨有規則遷移到適當位置。具體契約：

1. **`agent-workflow` 完全退役**：刪除 `templates/skills/agent-workflow/`，移除 `templates/AGENTS.md:10` 的 bootstrap 指令與其他引用。獨有規則搬家如下：
   - **Syslog-style Debug Contract (§5)** → 併入 `templates/skills/code-thinker/SKILL.md`
   - **continuation / completion gate / delegation SOP** → `AGENTS.md` 新增「第三條」
2. **AGENTS.md 新增第三條**：在既有「第零條（必須先 plan）」「第一條（禁止靜默 fallback）」「第二條（XDG 備份）」之後，新增「第三條：自主 continuation 契約」，文字定義何時 AI 應 append pending todo、何時必須停下。
3. **Mandatory-skills 區塊語法**：AGENTS.md 內使用 `<!-- opencode:mandatory-skills -->` HTML comment sentinel 夾一段 markdown bullet list，列出要 runtime preload + pin 的 skill name。
4. **初始 pin 清單**：第一批只納入 `plan-builder`。其他 skill 後續驗證機制穩定再擴充。
5. **Coding subagent preload 策略**：`packages/opencode/src/agent/prompt/coding.txt` 內加入同款 `<!-- opencode:mandatory-skills -->` sentinel 區塊（初始值 `code-thinker`），由 runtime 同一 parser 處理。coding.txt 其餘人類可讀說明維持，但移除 `agent-workflow` 引用。
6. **Parse 範圍**：Main Agent path 同時讀取 `~/.config/opencode/AGENTS.md`（global）與 `<project-root>/AGENTS.md`（project），skill name 合併後去重；coding subagent path 讀取 `coding.txt` 的 sentinel 區塊。
7. **Skill 檔缺失 fallback**：parser 找到 skill name 後，runtime 解析該 skill 的 SKILL.md 時若檔案不存在（使用者環境未必都有完整 skills 目錄），必須：
   - `log.warn` 明確記錄：skill 名稱、嘗試的路徑、來源（AGENTS.md / coding.txt）
   - 對該 skill 跳過 preload + pin（其他 skill 照常處理）
   - 不中斷 session、不阻斷 prompt 組裝
   - 發一次 `RuntimeEventService.append` anomaly 事件（`eventType: "skill.mandatory_missing"`）供 dashboard 可見
   - 符合 AGENTS.md 第一條「禁止靜默 fallback」—— 有 log、有事件、呼叫方不會誤以為 pin 成功。
8. **Runtime 整合**：AGENTS.md 讀取路徑（`packages/opencode/src/session/instruction.ts`）與 coding.txt 讀取路徑都掛接同一 parser；每輪建 system prompt 前檢查 mandatory list → 對每個存在的 skill 呼叫 `SkillLayerRegistry.recordLoaded()` + `SkillLayerRegistry.pin()`，並把 skill content 注入 system 陣列（繞過 AI 呼叫 `skill()` 工具的自律環節）。

## Scope

### IN

- 新增 `packages/opencode/src/session/mandatory-skills.ts`（或等價模組）：parser + skill loader。
- 修改 `packages/opencode/src/session/instruction.ts`：掃描 AGENTS.md 後額外解析 sentinel 區塊並暴露 skill name list。
- 修改 `packages/opencode/src/session/prompt.ts`：Main Agent 每輪進 LLM 前，依 mandatory list 把 skills 確保載入 + pin；coding subagent 每輪進 LLM 前依硬編清單同步完成。
- 擴充 `packages/opencode/src/session/skill-layer-registry.ts`（若需要支援「mandatory pin」這個新 keepRules 分類）。
- 修改 `packages/opencode/AGENTS.md`（專案根 AGENTS.md）：新增第三條 + mandatory-skills sentinel 區塊（初始值 `plan-builder`）、刪除 `agent-workflow` 引用。
- 修改 `templates/AGENTS.md`：同專案根 AGENTS.md（release 後使用者 init 會取得）。
- 修改 `templates/skills/code-thinker/SKILL.md`：併入 syslog-style debug contract 與 component-boundary 觀測規則。
- 刪除 `templates/skills/agent-workflow/` 整個目錄。
- 修改 `packages/opencode/src/agent/prompt/coding.txt` + `templates/prompts/agents/coding.txt`：加入 `<!-- opencode:mandatory-skills -->` sentinel 區塊（初始值 `code-thinker`）；移除 `skill({name: "agent-workflow"})` 引用；補上「runtime 會自動 preload 上述 skills；若 skill 檔在本機缺失，AI 仍可嘗試 `skill()` 工具自行載入」說明。
- 修改 `packages/opencode/src/session/prompt/enablement.json` + `templates/prompts/enablement.json`：從 `bundled_templates` 移除 `agent-workflow`。
- 新增 `docs/events/event_<YYYYMMDD>_agent-workflow_retirement.md` 與 `docs/events/event_<YYYYMMDD>_mandatory_skills_preload.md` 留痕。
- 更新 `specs/architecture.md`：記錄 mandatory-skills-preload 的資料流、掛勾點與 skill-layer-registry 的 mandatory 分類。

### OUT

- Runtime 對「AI 實際遵守契約與否」的保證——那是 LLM 行為問題，本次不處理。
- Subagent 也讀 AGENTS.md——subagent system 陣列明確排除 AGENTS.md 是 2026-02-16 `instruction_simplify` 事件決定，本次不推翻。
- 其他 skill（`code-thinker`、`beta-workflow`、`miatdiagram` 等）納入 pin 清單——初始只 pin `plan-builder`，其他等 runtime 穩定後獨立評估。
- SkillLayerRegistry 的 relevance 機制重寫——雖然「substring match」確實很弱，但本次只解 mandatory 這類「不論相關性都在場」的情境；relevance 演算法另案。
- 任何對 `workflow-runner.ts` continuation 判準（純 todolist 殘留）的改動——runtime 閘維持現狀，改動全在 prompt 層。

## Non-Goals

- 不改變 runloop 的 continuation 觸發邏輯——繼續由 todolist 殘留驅動。
- 不把 continuation contract 變成 runtime 硬閘——AI 行為仍由 prompt 紀律約束。
- 不引入新的 configuration format——所有 mandatory 宣告都寄生在現有 AGENTS.md 內。
- 不提供 UI 操作介面——mandatory list 只能靠編輯 AGENTS.md 管理（至少 phase 1 如此）。

## Constraints

- **AGENTS.md 第一條**：parser 遇到 sentinel 區塊列了不存在的 skill 時，必須 `log.warn` 明確報錯並跳過該 skill，不可靜默 fallback。
- **AGENTS.md 第零條**：本 spec 就是這次實作的 plan，tasks.md 寫完並經使用者確認後才能動手。
- **AGENTS.md 第二條**：plan approved 後、動工前，必須備份 `~/.config/opencode/` 至 `~/.config/opencode.bak-<timestamp>-mandatory-skills-preload/`。
- **Token 成本**：每個 mandatory skill 的完整 content 都會進入每輪 system prompt，需嚴選。初始 `plan-builder` 一個是可接受折衷。
- **Cache 相容性**：`InstructionPrompt.system()` 的 10s TTL cache 必須一併 cover mandatory-skills 解析結果，否則每輪重 parse 會有 I/O 開銷。
- **skill-layer-seam 注入順序**：已 pin 的 skill 必須出現在 system 陣列中，且不能被 idle-decay tick 覆寫 `pinned=true` 狀態。
- **退役相容性**：若使用者的 global `~/.config/opencode/AGENTS.md` 仍殘留 `skill(name="agent-workflow")` 指令，runtime 應記錄 warn 但不中斷（skill 已不存在）。
- **Skill 檔缺失容忍**：mandatory list 內的 skill 若在磁碟上找不到 SKILL.md（可能因使用者初始化不完整、skill 被手動刪除、opencode 版本不一致），必須 loud warn + skip + event，不可讓 runtime crash 或讓 prompt 組裝失敗。
- **Templates 同步**：`templates/` 與 runtime code 必須同步更新，違反 `AGENTS.md:「Release 前檢查清單」`。

## What Changes

- `agent-workflow` skill 從 codebase 與 template 中消失。
- `AGENTS.md` 多一條「第三條」+ 一組 `<!-- opencode:mandatory-skills -->` sentinel 區塊。
- runtime 每輪 Main Agent 的 system prompt 自動帶入 `plan-builder` skill 完整內容並 pin。
- runtime 每輪 coding subagent 的 system prompt 自動帶入 `code-thinker` skill 完整內容並 pin。
- `code-thinker` skill 內容擴充（吸收 syslog debug contract）。
- `coding.txt` 不再要求 AI 主動 `skill({name: "agent-workflow"})`。
- dashboard 的「已載技能」面板會穩定看到 `plan-builder`（Main Agent）與 `code-thinker`（coding subagent）。

## Capabilities

### New Capabilities

- **AGENTS.md mandatory-skills 區塊解析器**：從 AGENTS.md 內抽出 sentinel 區塊，輸出 skill name 陣列。
- **Runtime 自動 preload + pin**：不需 AI 呼叫 `skill()` 工具，直接在建 system prompt 時把指定 skill content 注入 + 標 `pinned=true`。
- **Coding subagent 硬編 preload**：runtime 辨識 `agent.name === "coding"`，自動帶入 `code-thinker`。
- **第三條 continuation 契約文字**：AGENTS.md 明文定義 AI 自主 continuation 的觸發與停止條件，供 Main Agent 每輪參考。

### Modified Capabilities

- `InstructionPrompt.system()`：回傳值新增 mandatory-skills list（或以 sibling 函式另外提供）。
- `SkillLayerRegistry`：`keepRules` 新增 `"mandatory:agents_md"` 或 `"mandatory:coding_agent"` 分類；`applyIdleDecay` 對 `pinned=true` 項目明確跳過（現況已經這麼做，只是要複核並補測試）。
- `code-thinker` skill 內容：新增「syslog-style debug contract」章節。
- `coding.txt` agent prompt：移除 `agent-workflow` 引用，改為敘述「runtime 會自動為此 subagent preload code-thinker」。
- `enablement.json` bundled_templates：移除 `agent-workflow`。

## Impact

### 受影響程式碼

- `packages/opencode/src/session/instruction.ts`（解析入口）
- `packages/opencode/src/session/prompt.ts`（Main / Subagent system 陣列組裝點）
- `packages/opencode/src/session/skill-layer-registry.ts`（pin keepRules 擴充、tests）
- `packages/opencode/src/session/mandatory-skills.ts`（新增模組）
- `packages/opencode/src/agent/prompt/coding.txt`（移除 agent-workflow 引用）
- `packages/opencode/src/session/prompt/enablement.json`（bundled_templates 去除）

### 受影響文件 / 配置

- `packages/opencode/AGENTS.md`（加第三條 + sentinel 區塊 + 刪 agent-workflow 引用）
- `~/.config/opencode/AGENTS.md`（使用者本機，不由 repo 管；遷移靠 `templates/AGENTS.md`）
- `templates/AGENTS.md`（release 版）
- `templates/prompts/enablement.json`（release 版）
- `templates/prompts/agents/coding.txt`（release 版）
- `templates/skills/code-thinker/SKILL.md`（併入 debug contract）
- `templates/skills/agent-workflow/`（整個目錄刪除）

### 受影響的執行中 session

- 舊 session 轉 main 後，第一次 prompt 輪會看到：
  1. AGENTS.md 多了第三條
  2. `plan-builder` skill 突然出現在 skill-layer dashboard（pinned）
  3. coding subagent 的 system prompt 突然多了 `code-thinker` skill（pinned）
- 任何 AI 試圖 `skill({name: "agent-workflow"})` 的呼叫會拿到 not-found 錯誤——需要明確 warn。

### 受影響的 operator / 使用者

- 使用者若曾手動編輯 `~/.config/opencode/AGENTS.md` 加入自訂指令，需要留意與新第三條的合併衝突。
- 使用者的 `~/.config/opencode/prompts/` 覆寫檔不受影響（不涉及 skill content）。
- docs/events 留痕使使用者可追溯本次變更。

### Runtime 效能

- 每輪 Main Agent system prompt 新增 `plan-builder` 完整 SKILL.md（~500 行 markdown），token 成本可估 ~3-5K。可接受。
- 每輪 coding subagent system prompt 新增 `code-thinker` SKILL.md，token 成本類似。Subagent 本來就短命，影響有限。
- Parser I/O 在 `systemCache` 10s 命中內無額外成本；cache miss 時多一次小檔解析與 glob，可忽略。
