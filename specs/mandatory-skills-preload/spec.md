# Spec: mandatory-skills-preload

## Purpose

- 把「Main Agent / coding subagent 必載 skill」這條關鍵紀律，從「AI 讀到 AGENTS.md / coding.txt 後自律呼叫 `skill()`」的脆弱載體，升級為「runtime 每輪 system prompt 組裝時硬注入 + pin」，並同步退役已功能性空殼化的 `agent-workflow` skill、將其獨有規則遷移。

## Requirements

### Requirement: Mandatory-skills sentinel 解析

The system SHALL 從指定文字（AGENTS.md 或 coding.txt）中抽出 `<!-- opencode:mandatory-skills -->` 與 `<!-- /opencode:mandatory-skills -->` 包夾的 markdown bullet list，回傳去重後的 skill name 陣列。

#### Scenario: AGENTS.md 內含合法 sentinel 區塊
- **GIVEN** 專案根 `AGENTS.md` 內含
  ```
  <!-- opencode:mandatory-skills -->
  - plan-builder
  - code-thinker
  <!-- /opencode:mandatory-skills -->
  ```
- **WHEN** runtime 呼叫 `parseMandatorySkills(text)`
- **THEN** 必須回傳 `["plan-builder", "code-thinker"]`（bullet 順序保留、自動 trim）

#### Scenario: 沒有 sentinel 區塊
- **GIVEN** AGENTS.md 不含 sentinel 區塊
- **WHEN** 呼叫 `parseMandatorySkills(text)`
- **THEN** 必須回傳空陣列 `[]`，**不得**拋錯

#### Scenario: 區塊內 bullet 有註解或空白
- **GIVEN** sentinel 區塊內含
  ```
  - plan-builder    # 必要
  -  code-thinker 
  - 
  ```
- **WHEN** 呼叫 `parseMandatorySkills(text)`
- **THEN** 回傳 `["plan-builder", "code-thinker"]`（忽略 `#` 之後註解與純空白 bullet）

#### Scenario: 同一檔案內出現多組 sentinel 區塊
- **GIVEN** AGENTS.md 內有兩組 sentinel 區塊
- **WHEN** 呼叫 `parseMandatorySkills(text)`
- **THEN** 必須依序取出所有區塊的 skill name，合併後去重

### Requirement: Global + Project AGENTS.md 合併去重

The system SHALL 從 `~/.config/opencode/AGENTS.md` 與 `<project-root>/AGENTS.md` 同時擷取 mandatory list，合併後去重，以 project 出現順序優先。

#### Scenario: 兩份檔都存在且各有 skill
- **GIVEN** global AGENTS.md 列出 `[A, B]`；project AGENTS.md 列出 `[B, C]`
- **WHEN** runtime 取得 Main Agent 的 mandatory list
- **THEN** 合併結果為 `[B, C, A]`（project 優先序 + global 補充 + 去重）

#### Scenario: global 缺失、只有 project
- **GIVEN** global AGENTS.md 不存在
- **WHEN** 取得 Main Agent mandatory list
- **THEN** 回傳 project 內的結果，**不得**因 global 缺失而拋錯

### Requirement: Coding subagent 獨立 preload path

The system SHALL 在 `packages/opencode/src/agent/prompt/coding.txt` 內維護一組 `<!-- opencode:mandatory-skills -->` sentinel 區塊，runtime 在建 coding subagent system prompt 時以同一 parser 擷取。

#### Scenario: coding.txt 含 sentinel 區塊
- **GIVEN** coding.txt 內含 sentinel 區塊列出 `code-thinker`
- **WHEN** runtime 建構 `agent.name === "coding"` 的 subagent system prompt
- **THEN** 必須擷取清單、執行 preload + pin（與 Main Agent path 機制相同）

#### Scenario: 非 coding subagent 不吃 coding.txt 清單
- **GIVEN** `agent.name === "plan-builder"` 的 subagent
- **WHEN** 建構 system prompt
- **THEN** runtime **不得**讀 coding.txt 的 sentinel 區塊；該 subagent 只吃自己 agent prompt 檔（若有）的 sentinel 區塊

### Requirement: Skill 檔缺失 fallback

The system SHALL 在 mandatory list 中某 skill 的 SKILL.md 檔案不存在時，loud warn + 跳過該 skill，**不得**中斷 prompt 組裝或讓 session 崩潰。

#### Scenario: 一個 skill 檔缺失
- **GIVEN** mandatory list 為 `[plan-builder, nonexistent-skill]`，其中 `plan-builder` 的 SKILL.md 存在、`nonexistent-skill` 不存在
- **WHEN** runtime 嘗試 preload
- **THEN**
  - 必須呼叫 `log.warn` 記錄 `{ skillName: "nonexistent-skill", searchedPaths: [...], source: "agents_md" | "coding_txt", sessionID }`
  - 必須 `RuntimeEventService.append` 發 `eventType: "skill.mandatory_missing"` 事件（anomaly domain）
  - `plan-builder` 必須照常 preload + pin
  - prompt 組裝正常完成、session 不中斷

#### Scenario: 整張 mandatory list 的所有 skill 都缺失
- **GIVEN** mandatory list 內所有 skill 都找不到 SKILL.md
- **WHEN** runtime 嘗試 preload
- **THEN** 每個缺失 skill 都獨立 loud warn + 發事件；prompt 組裝繼續（只是沒有任何 skill 被 preload）

### Requirement: Skill content 以 pinned 狀態進入 system 陣列

The system SHALL 對 mandatory list 中存在的每個 skill：
1. 讀取其 SKILL.md 內容
2. 呼叫 `SkillLayerRegistry.recordLoaded(sessionID, skillName, { content, purpose, keepRules })`
3. 呼叫 `SkillLayerRegistry.pin(sessionID, skillName)`
4. 透過既有 skill-layer-seam 機制將 content 注入 system 陣列

#### Scenario: 第一輪 session 的 preload
- **GIVEN** 新 session 首次進入 prompt 組裝
- **WHEN** runtime 處理 Main Agent mandatory list `[plan-builder]`
- **THEN**
  - `SkillLayerRegistry` 內必須有 `plan-builder` 條目、`runtimeState === "sticky"`、`pinned === true`
  - 組裝完的 system 陣列必須含 `plan-builder` SKILL.md 的完整 content（以 skill-layer-seam 的 `<skill_layer name="plan-builder" state="full">` 標籤包裹）

#### Scenario: 後續輪次避免重複載入
- **GIVEN** 同一 session 的第 N 輪（N > 1），`plan-builder` 已 pinned
- **WHEN** runtime 處理 mandatory list
- **THEN**
  - **不得**重複讀 SKILL.md 檔案（若 content 未變）
  - **不得**重新 `recordLoaded`（會覆寫 `loadedAt`）
  - 只需確認 pin 狀態仍為 true；若被意外 unpin 則重 pin + warn

### Requirement: Pinned skill 不得被 idle-decay

The system SHALL 確保 `applyIdleDecay` 對 `pinned === true` 的條目維持 `runtimeState === "sticky"` 與 `desiredState === "full"`。

#### Scenario: session 閒置 35 分鐘後
- **GIVEN** Main Agent session 閒置 35 分鐘（超過 `IDLE_UNLOAD_MS`）、`plan-builder` 仍 pinned
- **WHEN** `applyIdleDecay` 在新一輪前執行
- **THEN** `plan-builder.runtimeState` 必須仍為 `"sticky"`（不可降為 `summarized` 或 `unloaded`）

#### Scenario: mandatory list 被移除後的 unpin
- **GIVEN** 使用者編輯 AGENTS.md 移除 `plan-builder`
- **WHEN** runtime 下一輪 parse 發現 mandatory list 不再含 `plan-builder`
- **THEN** 必須呼叫 `SkillLayerRegistry.unpin(sessionID, "plan-builder")`（使其回歸正常 idle-decay 規則），並 log 一次 `mandatory_unpinned` 事件

### Requirement: agent-workflow 退役與引用清理

The system SHALL 在本 spec 實作後：
1. 刪除 `templates/skills/agent-workflow/` 整個目錄
2. 從 `packages/opencode/src/session/prompt/enablement.json` 與 `templates/prompts/enablement.json` 的 `bundled_templates` 移除 `agent-workflow`
3. 從 `templates/AGENTS.md` 移除第 10 行的 `skill(name="agent-workflow")` bootstrap 指令
4. 從 `packages/opencode/src/agent/prompt/coding.txt` + `templates/prompts/agents/coding.txt` 移除 `agent-workflow` 引用

#### Scenario: 舊 session 殘留 agent-workflow 呼叫
- **GIVEN** 某 session 壓縮前歷史包含 `skill({name: "agent-workflow"})` 呼叫
- **WHEN** 同 session 後續 AI 再嘗試呼叫 `skill({name: "agent-workflow"})`
- **THEN** `skill` 工具必須回傳明確錯誤（skill 不存在），log 一次 warn；session 不崩潰

#### Scenario: Syslog debug contract 遷移
- **GIVEN** `agent-workflow` 原含 §5 Syslog-style Debug Contract
- **WHEN** 退役完成
- **THEN** 該 contract 必須完整搬入 `templates/skills/code-thinker/SKILL.md`（文字、結構、checkpoint schema、component-boundary 規則），且 `packages/opencode/src/agent/prompt/coding.txt` 的 §2 引用指向 `code-thinker` 而非 `agent-workflow`

### Requirement: AGENTS.md 第三條（Autonomous Continuation Contract）

The system SHALL 在 `AGENTS.md` 新增「第三條：自主 continuation 契約」，明文定義 AI 在何種條件下應 append pending todo 觸發 runloop continue、何時必須停下等待使用者決定。

#### Scenario: 第三條文字內容
- **GIVEN** 使用者開啟 `AGENTS.md`
- **WHEN** 檢視條款區塊
- **THEN** 第三條必須包含：
  - Continuation 觸發條件（例：spec 處於 `implementing` 狀態、tasks.md 尚有 `- [ ]` / `- [~]`、沒遇到 `- [!]` blocked / `- [?]` decision）
  - 禁止條件（例：待使用者決定、待外部批准、tasks.md 全 `- [x]`）
  - 實踐方式（例：結束 turn 前 `todowrite` append 下一項 pending todo）
  - 與 runloop `planAutonomousNextAction` 純 todolist 殘留判準的對應關係

### Requirement: Cache 相容性

The system SHALL 讓 mandatory-skills parse 結果與既有 `InstructionPrompt.systemCache`（10s TTL）一致：parse 結果與 AGENTS.md 文字內容同步 cache，避免每輪重新 parse。

#### Scenario: 10s 內連續兩輪
- **GIVEN** 同一 session 兩輪間距 < 10s
- **WHEN** runtime 建構 system prompt
- **THEN** 第二輪必須使用 cache 的 mandatory list（skill 仍 pinned），**不得**重新 I/O AGENTS.md

#### Scenario: AGENTS.md 修改後
- **GIVEN** 使用者在第 N 輪與第 N+1 輪之間編輯 AGENTS.md（mtime 變更）
- **WHEN** 第 N+1 輪建構 system prompt
- **THEN** cache 必須 invalidate、重新 parse、反映新的 mandatory list（可能 pin 新 skill 或 unpin 舊 skill）

## Acceptance Checks

本 spec 驗收條件（`planned → implementing` 前需滿足）：

1. `bun test packages/opencode/src/session/mandatory-skills.test.ts` 覆蓋以上所有 Scenario 並全數通過
2. 手動測試：啟動 main daemon，新開 session，dashboard 的「已載技能」必須出現 `plan-builder`（pinned 標記）
3. 手動測試：dispatch 一個 coding subagent，dashboard 必須顯示該 subagent 載入了 `code-thinker`（pinned）
4. 手動測試：閒置 session 35 分鐘後新對話，`plan-builder` 仍 pinned 不 decay
5. 手動測試：暫時搬走 `~/.claude/skills/code-thinker/SKILL.md`，新開 session；必須看到 warn log + `skill.mandatory_missing` 事件，session 仍可正常對話
6. `bun run scripts/plan-validate.ts specs/mandatory-skills-preload/` 在 `designed` state 全數通過
7. `templates/skills/agent-workflow/` 目錄確實不存在；`find templates/ -name "agent-workflow*"` 無輸出
8. `grep -r "agent-workflow" packages/opencode/src/` 僅剩註解 / 歷史事件文件引用
