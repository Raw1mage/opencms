# Design: mandatory-skills-preload

## Context

- 現況：`templates/AGENTS.md` 第 10 行要求 Main Agent bootstrap 載入 `agent-workflow` skill，但：
  - AGENTS.md 對 Main Agent 由 `InstructionPrompt.system()`（[instruction.ts:80-117](../../packages/opencode/src/session/instruction.ts#L80-L117)）每輪強制注入，契約**文字**保證在場。
  - 但呼叫 `skill()` 工具仍是 AI 行為。AI 在首輪 boostrap 後若未再主動 reference，SkillLayerRegistry（[skill-layer-registry.ts:32-33](../../packages/opencode/src/session/skill-layer-registry.ts#L32-L33)）的 `IDLE_SUMMARY_MS=10min` / `IDLE_UNLOAD_MS=30min` 會讓 skill 逐步 decay 成 summary 甚至完全 unload。
  - relevance 復活（[skill-layer-registry.ts:175-188](../../packages/opencode/src/session/skill-layer-registry.ts#L175-L188)）只對 `latestUserText` 做 substring match，實務上極少命中。
  - 使用者觀察：「已載技能」dashboard 常看不到 `agent-workflow`。
- 另一方面，runloop 的 autonomous continuation 判準已在 `workflow-runner.ts:559-596` 演化成「純 todolist 殘留」—— 要 AI 在條件符合時主動 append pending todo 來驅動 runloop 繼續跑。這條紀律若住在會 decay 的 skill 裡，就會出現「關鍵契約不在場」的失效模式。
- 根本解：
  1. 把「每輪都必須在場」的契約升級為 runtime 硬注入 + pin，繞過 AI 自律呼叫 `skill()` 的環節。
  2. 退役功能性空殼化的 `agent-workflow`，獨有規則（syslog debug contract、continuation SOP）分別搬到 `code-thinker` skill 與 AGENTS.md 第三條。

## Goals / Non-Goals

- **G1**：Main Agent 每輪 system prompt 穩定帶入 `plan-builder` SKILL.md 完整內容（pinned，不 decay）。
- **G2**：coding subagent 每輪 system prompt 穩定帶入 `code-thinker` SKILL.md（pinned，不 decay）。
- **G3**：Mandatory list 的聲明位置留在文件內（AGENTS.md / coding.txt），可人類可讀、可版本控制；runtime 只負責解析與執行。
- **G4**：Skill 檔缺失時 loud warn + skip，不拋錯、不靜默（符合 AGENTS.md 第一條）。
- **G5**：Parser 與 skill loader 為純 function，可單元測試；runtime 整合點集中在 `instruction.ts` / `prompt.ts` 兩處。
- **G6**：`agent-workflow` skill 完全退役，獨有規則找到新歸屬；templates 與 runtime 同步。

## Non-Goals

- **NG1**：不改 runloop 的 continuation 觸發邏輯（仍是純 todolist 殘留）。
- **NG2**：不讓 subagent 讀 AGENTS.md（推翻 2026-02-16 `instruction_simplify` 決議，本 spec 不做）。
- **NG3**：不重寫 SkillLayerRegistry 的 relevance 演算法（另案；本 spec 只處理 mandatory pin 場景）。
- **NG4**：不引入新的配置檔格式（mandatory 清單寄生在 AGENTS.md / coding.txt）。
- **NG5**：不提供 UI / command 操作 mandatory list（只能編輯檔案）。

## Decisions

- **DD-1**（2026-04-19）Sentinel 語法 = `<!-- opencode:mandatory-skills -->` HTML comment。  
  *Alternatives considered*：YAML frontmatter（需引入 YAML parser + 破壞現有 AGENTS.md 首部結構）；fenced code block（AI 視覺會看到大塊 code fence）；opencode.json 欄位（config 跟文件分離，維運不直覺）。  
  *Why*：HTML comment 對 AI 視覺完全隱形、對人類 reviewer 明顯、正則解析穩定、不影響 markdown 渲染。

- **DD-2**（2026-04-19）Parser 以純 function 形式放在 `packages/opencode/src/session/mandatory-skills.ts` 獨立模組。  
  *Alternatives*：擴進 `instruction.ts`（職責混雜：從「讀 instruction 檔」變成「讀 instruction + 解析 skill + 載入 skill」）；擴進 `skill-layer-registry.ts`（registry 應專注於 runtime state，不該知道 AGENTS.md 長什麼樣）。  
  *Why*：新增獨立檔案讓 parser + preload 形成內聚單元，其他模組只需 import pure function，責任邊界清晰、單元測試好寫。

- **DD-3**（2026-04-19）Global + Project AGENTS.md 皆參與解析；合併順序 project 優先、global 補充、同名去重。  
  *Alternatives*：只讀 project（失去跨 repo 共用機制）；只讀 global（專案無法覆寫）；二選一配置開關（複雜度不成比例）。  
  *Why*：與現有 `InstructionPrompt.systemPaths()` 的雙來源模型保持一致；使用者本機 global 是個人偏好、project 是團隊共識，都應該被尊重。

- **DD-4**（2026-04-19）Coding subagent 專用 sentinel 放在 `coding.txt` 本身，而非另外新開 `coding` 區塊在 AGENTS.md。  
  *Alternatives*：AGENTS.md 新增 `<!-- opencode:mandatory-skills-coding -->`（subagent 根本拿不到 AGENTS.md，會讓人誤會此區塊會被 subagent 消費）；runtime 常數 hardcode（違反「可文件聲明」原則）。  
  *Why*：coding subagent system prompt 確實會帶入 coding.txt，把聲明放這裡 scope 精準；同一 parser 同時處理 AGENTS.md 與 coding.txt，沒有額外 parser 分支。

- **DD-5**（2026-04-19）Skill 檔缺失採 loud warn + skip + anomaly event，不拋錯、不靜默。  
  *Alternatives*：拋錯讓 session 初始化失敗（災難級 UX）；完全靜默跳過（違反 AGENTS.md 第一條）。  
  *Why*：使用者環境可能缺檔（初始化不完整、版本不一致、手動刪除），session 必須能繼續跑；但缺失必須 observable，dashboard 與 log 都要能看見。

- **DD-6**（2026-04-19）Mandatory-skills 解析結果納入 `InstructionPrompt.systemCache`（10s TTL）。  
  *Alternatives*：獨立 cache 層（多一份 cache 同步風險）；每輪重新 parse（增加小量 I/O 與 regex 成本，但可避免不一致）。  
  *Why*：mandatory 清單來源是 AGENTS.md 與 coding.txt，命中 cache 時就跟 instruction text 一樣穩定；既有 cache 已經處理 mtime invalidation，相容性最高。

- **DD-7**（2026-04-19）`SkillLayerRegistry.pin()` 對 mandatory 場景不需新增 API，但要補 `unpin()` 方法處理「使用者從 AGENTS.md 移除 skill 後回歸正常 idle decay」情境。  
  *Alternatives*：不提供 unpin（移除後 skill 永遠 sticky 浪費 token）；直接 force unload（會丟失該 skill 的 recent usage state）。  
  *Why*：unpin 後該 entry 的 `pinned` 欄位變 false，後續 `applyIdleDecay` 會依正常規則處理；既不浪費 context 也不突兀丟失狀態。

- **DD-8**（2026-04-19）agent-workflow `§5 Syslog-style Debug Contract` 搬入 `code-thinker` SKILL.md，不獨立新 skill。  
  *Alternatives*：新獨立 `syslog-debug` skill（多一層維護、大多情境 code-thinker 已被載入時才需要 debug contract）；搬進 AGENTS.md（文字體積大，每輪都在浪費 token）。  
  *Why*：code-thinker 本就管 rigor discipline，debug contract 是延伸；coding subagent 透過 DD-4 機制會自動 pin code-thinker，等於同時帶入 debug contract，不需另外設計載入路徑。

- **DD-9**（2026-04-19）AGENTS.md 第三條「自主 continuation 契約」用條款形式（跟第零/一/二條同色），不新建章節。  
  *Alternatives*：新獨立 `## Autonomous Continuation Contract` 章節；合併進「開發任務預設工作流」段。  
  *Why*：既有第 X 條已形成閱讀節奏，AI 讀 AGENTS.md 時會連續掃過這些 rule 條款；把最重要的 continuation 紀律放在第三條位置，對稱且容易被 reference。

- **DD-10**（2026-04-19）初始 mandatory list 只放 `plan-builder`（Main Agent）+ `code-thinker`（coding subagent）；其他 skill 不納入。  
  *Alternatives*：把 `beta-workflow` / `miatdiagram` 也 pin（token 成本倍增、未必每 session 相關）；什麼都不 pin 只做機制（無法驗證）。  
  *Why*：`plan-builder` 是 continuation 契約的實質載體（spec lifecycle、tasks.md ↔ todolist 對應），最值得 pin；`code-thinker` 覆蓋 coding subagent 最常見場景且容納 syslog debug contract。其他 skill 保持 on-demand。

## Risks / Trade-offs

- **R1**：Mandatory skill 內容大，每輪都注入會顯著增加 Main Agent token 成本。  
  *Mitigation*：只 pin 真正每輪都需要的 skill（DD-10 嚴選）；定期 review pin 清單、token 預算監控。

- **R2**：使用者手動編輯 AGENTS.md 弄壞 sentinel 區塊（漏閉合、拼錯 skill name）。  
  *Mitigation*：parser 對漏閉合採「遇 EOF 視為結束」+ warn；拼錯 skill name → 走 DD-5 的 loud warn path。新增 `plan-validate` 時可擴充一條「mandatory-skills 區塊格式檢查」。

- **R3**：SkillLayerRegistry 的 `applyIdleDecay` 未來若被修改可能意外讓 pinned 條目降級。  
  *Mitigation*：新增 unit test 明確覆蓋「pinned 條目在 idle 30min 後仍為 sticky」。

- **R4**：agent-workflow 退役後，舊 session 壓縮歷史裡可能仍含 `skill({name: "agent-workflow"})` 呼叫，新工具解析會拿到 not-found。  
  *Mitigation*：skill 工具本來就要處理 not-found；本 spec 確保 log warn 明確，不讓 session 崩潰。事件文件留痕供追溯。

- **R5**：Cache miss 時雙讀 AGENTS.md + coding.txt，加上讀 SKILL.md 檔案，可能累積小量 I/O。  
  *Mitigation*：DD-6 命中率高；首輪 I/O 成本在可接受範圍（< 10ms）；SKILL.md 讀取結果可另建小 cache（留待 implementing phase 視需要加）。

- **R6**：Mandatory list 變動（新增 / 移除 skill）時，run-time state 需要同步更新，錯過可能導致 pinned 與 list 不一致。  
  *Mitigation*：每輪 parse 後執行 `diff(currentPinned, newList)`：新增項走 pin path、移除項走 unpin path（DD-7）。

- **R7**：併入 code-thinker 的 syslog debug contract 若與原 code-thinker 內容衝突，可能產生互相矛盾的指令。  
  *Mitigation*：migration 前先 diff `agent-workflow/SKILL.md §5` 與 `code-thinker/SKILL.md`，找出重疊 / 衝突處；衝突以 code-thinker 既有規則為基，agent-workflow 獨有補上。

## Critical Files

### 新增
- `packages/opencode/src/session/mandatory-skills.ts` — parser + preload loader。
- `packages/opencode/src/session/mandatory-skills.test.ts` — 覆蓋 spec.md 所有 Scenario。
- `specs/mandatory-skills-preload/**` — 本 spec package（正在建）。
- `docs/events/event_<YYYYMMDD>_agent-workflow_retirement.md` — 退役留痕。
- `docs/events/event_<YYYYMMDD>_mandatory_skills_preload.md` — 本 feature 留痕。

### 修改
- `packages/opencode/src/session/instruction.ts` — `InstructionPrompt.system()` 結果對外暴露 mandatory list，或新增 sibling 函式 `InstructionPrompt.mandatorySkills()`。
- `packages/opencode/src/session/prompt.ts` — Main Agent 與 coding subagent 的 system 陣列組裝前呼叫 `preloadMandatorySkills()`。
- `packages/opencode/src/session/skill-layer-registry.ts` — 新增 `unpin()` method；`applyIdleDecay` 對 pinned 條目的保守跳過行為補 test。
- `packages/opencode/src/agent/prompt/coding.txt` + `templates/prompts/agents/coding.txt` — 加入 sentinel 區塊；移除 agent-workflow 引用；§2 改指 code-thinker。
- `packages/opencode/AGENTS.md` — 新增第三條；新增 sentinel 區塊；刪除 agent-workflow 引用。
- `templates/AGENTS.md` — 同 repo-root AGENTS.md。
- `templates/skills/code-thinker/SKILL.md` — 併入 §5 syslog-style debug contract。
- `packages/opencode/src/session/prompt/enablement.json` + `templates/prompts/enablement.json` — `bundled_templates` 移除 agent-workflow。
- `specs/architecture.md` — 新增 mandatory-skills-preload 流程章節（資料流、掛勾點、pinned 分類）。

### 刪除
- `templates/skills/agent-workflow/`（整個目錄）

## Data flow

```
session prompt construction (prompt.ts:1650+)
  │
  ├── instructionPrompts = await InstructionPrompt.system()   // 既有
  │       └── AGENTS.md files → string[]
  │
  ├── [新] mandatoryList = await MandatorySkills.resolve({ agent, sessionID })
  │       ├── Main agent: parse AGENTS.md 路徑（global + project, 去重）
  │       └── coding subagent: parse coding.txt sentinel 區塊
  │       → ["plan-builder", ...] or ["code-thinker", ...]
  │
  ├── [新] await MandatorySkills.preload(sessionID, mandatoryList)
  │       ├── 對每個 skill：嘗試讀 SKILL.md
  │       ├── 存在 → SkillLayerRegistry.recordLoaded + .pin
  │       └── 缺失 → log.warn + RuntimeEventService anomaly event
  │
  ├── skillLayerEntries = SkillLayerRegistry.list(sessionID)
  │       └── 已含 pinned 的 mandatory skills
  │
  ├── system: [
  │     await getPreloadedContext(sessionID),
  │     ...environmentPrompts,
  │     ...(session.parentID ? [] : instructionPrompts),
  │     ...skillLayerSeamContent(skillLayerEntries),     // 既有機制注入 content
  │     ...(lazyCatalogPrompt ? [lazyCatalogPrompt] : []),
  │     ...(format.type === "json_schema" ? [STRUCTURED_OUTPUT_SYSTEM_PROMPT] : []),
  │   ]
  │
  └── [新] 每輪結尾：若 mandatory list 變化（diff），unpin 已移除的 skill
```

## Invariants

- **I1**：Mandatory list 在 Main Agent session 每輪必然存在於 `SkillLayerRegistry` 且 `pinned === true`（除非 skill 檔缺失，則該項不會在 registry 內）。
- **I2**：pinned skill 的 `runtimeState` 必然是 `"sticky"`，不會被 idle-decay 降級。
- **I3**：`parseMandatorySkills(text)` 是 pure function — 同輸入必同輸出，無副作用。
- **I4**：skill 檔缺失的 warn log 與 anomaly event 必須一對一對應（每次缺失都發事件，不抑制）。
- **I5**：Cache invalidation 與 instruction text mtime 連動；mandatory list 變更的第一輪 prompt 必定反映。

## Observability

- **Log channels**：
  - `log.info("[mandatory-skills] preloaded", { sessionID, skillName, source })`
  - `log.warn("[mandatory-skills] skill file missing", { sessionID, skillName, searchedPaths, source })`
  - `log.info("[mandatory-skills] unpinned on removal", { sessionID, skillName })`
- **Runtime events**：
  - `eventType: "skill.mandatory_preloaded"`（info / workflow domain）
  - `eventType: "skill.mandatory_missing"`（warn / anomaly domain，`anomalyFlags: ["mandatory_skill_missing"]`）
  - `eventType: "skill.mandatory_unpinned"`（info / workflow domain）
- **Dashboard**：
  - 「已載技能」面板應顯示 pinned 標記 + 來源（`mandatory:agents_md` / `mandatory:coding_txt`）。
- **Metrics（可選）**：
  - `mandatory_skills_preload_count`、`mandatory_skills_missing_count` per session / per skill。

## Migration path

階段 1（本 spec）：
1. 實作 `mandatory-skills.ts` + tests
2. 整合 `instruction.ts` / `prompt.ts`
3. 擴 `skill-layer-registry.ts` 補 `unpin`
4. 編輯 AGENTS.md（加第三條 + sentinel 區塊 + 刪 agent-workflow）
5. 編輯 coding.txt（加 sentinel + 移除 agent-workflow）
6. 併 debug contract 進 code-thinker
7. 刪 `templates/skills/agent-workflow/`
8. 同步 templates/
9. 刷 `specs/architecture.md` + `docs/events/`

階段 2（後續 spec，不在本 spec 範圍）：
- 評估把 `beta-workflow`、`miatdiagram` 等納入 mandatory list。
- 重構 `SkillLayerRegistry.applyIdleDecay` 的 relevance 機制。
- UI / TUI 提供 mandatory list 管理介面。
