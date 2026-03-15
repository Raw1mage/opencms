# Proposal: autorunner planner retarget

## Why

- 目前 autorunner 雖已具備 planner / mission / todo / queue 等基礎，但實際使用效果接近 0，仍停留在一步一停的回合制 assistant。
- 造成停滯的核心不是 planning 缺失，而是 bootstrap 常駐技能與 runner contract 沒有真正服務 delegation-driven execution loop。
- 預設常駐 `model-selector`、`mcp-finder`、`skill-finder`、`software-architect` 在目前政策與實際使用中幾乎沒有正向作用，反而增加 prompt 噪音、過時知識與顧問化傾向。

## Original Requirement Wording (Baseline)

- "Autorunner使用檢討。目前autorunner的實際使用效果為0。仍然處於回合制對話機制裏。即使有了完整的planning也一樣是一步一步的停下來回報，沒有形成真正的agent execution loop。"
- "檢討1：mcp finder和skill finder的效果基本為零。AI並不會在工作中主動去擴充自己的能力。預設改成不加載。"
- "檢討2：我們已經實作了planner，其實基本能力software-architect是重疊的。最好是不要再加載software-architect，並且把software-architect中的優點移植到planner的硬編碼中。"
- "檢討3：agent-workflow的寫法應該配合autorunner的架構，讓委派工作成為預設的行為。"
- "skill model-selector在目前的運作政策裏也無法發揮作用。model的能力和版本也不斷擴充。我難以維護一個最新版本。而且因政策因素，我們要避免大量切換model和account。所以這個skill暫時派不上用場。取消加載。"
- "我要的不是一份報告，而是一個優化後的autorunner執行環境。請用planner更新autorunner計畫。"

## Requirement Revision History

- 2026-03-15 / 初始討論：從「autorunner 效果為 0」收斂到 root cause 不是 plan 缺失，而是 runtime contract 仍停留在 turn-based assistant。
- 2026-03-15 / bootstrap 檢討：使用者明確決定移除預設 `mcp-finder`、`skill-finder`、`software-architect`、`model-selector`。
- 2026-03-15 / planner 檢討：使用者要求把 `software-architect` 的有效部分併入 planner 硬編碼，而不是保留常駐 skill。
- 2026-03-15 / workflow 檢討：使用者要求 `agent-workflow` 改寫為配合 autorunner，讓 delegation 成為預設行為。

## Effective Requirement Description

1. autorunner 的優化重點是 execution environment，而不是再多寫一份分析報告。
2. bootstrap 必須精簡為最小必要集合，移除低實效常駐 skills，避免常駐顧問化與過時模型策略。
3. planner 必須吸收 architecture / constraints / trade-off / boundary thinking，讓 `software-architect` 不再是常駐依賴。
4. `agent-workflow`、plan-mode prompt、runner contract、handoff templates 必須共同重寫成 delegation-first、gate-driven auto-continue 的 execution contract。

## Scope

### IN

- bootstrap policy rewrite
- planner artifact template rewrite
- runner / plan prompt rewrite
- enablement routing policy update
- targeted tests and docs sync

### OUT

- daemon substrate 重寫
- worker supervisor 大改
- 新 mission source
- 未經批准的模型/帳號自動切換策略

## Non-Goals

- 不追求在本輪完成完整 daemon-based autorunner 架構
- 不在本輪移除 skill 實體檔案或 capability registry 中的可選能力
- 不重新設計 provider/account/runtime switching 產品面

## Constraints

- 不得新增 fallback mechanism。
- 必須維持 planner artifact contract 與 `plan_enter` / `plan_exit` 的完整性。
- 必須同步 `templates/**`、runtime prompt、event docs，避免 template/runtime 漂移。
- 必須保持 `agent-workflow` 與 `code-thinker` 的既有 debug/syslog 契約不被弱化。

## What Changes

- bootstrap 將改成只保留直接服務 autorunner loop 的最小 workflow 基底，不再預設加載 `model-selector`、`mcp-finder`、`skill-finder`、`software-architect`。
- planner templates 將吸收 architecture-thinking 欄位與 delegation-first execution phase 寫法。
- runner / plan prompt 與 `agent-workflow` skill 將明確區分 narration 與 pause，並把 delegation / integration / validation 當成 planner-to-runner 的主路徑。
- enablement 與模板提示將從「預設載入多 skill」改成「按需載入 skill」。

## Capabilities

### New Capabilities

- planner-centered bootstrap policy: planner artifact 與 runner contract 共同定義 autorunner 的最小 execution environment。
- delegation-first planning contract: 任務切片預設可委派、可整合、可驗證，而不是單純 phase bullet list。

### Modified Capabilities

- `agent-workflow`: 從一般 autonomous-ready SOP 改為更明確的 autorunner-centered / delegation-first contract。
- planner artifact generation: 從通用模板提升為內建 architecture / constraints / delegation 思維的 execution contract。
- capability routing: 將 `model-selector`、`software-architect`、`mcp-finder`、`skill-finder` 從預設常駐路徑降級為 on-demand。

## Impact

- 影響所有非瑣碎開發任務的 bootstrap 與 planner-first 入口。
- 影響 autorunner 在 build-mode continuation 時的語氣、任務切片方式與 pause/continue 邏輯描述。
- 影響模板發佈面：`templates/AGENTS.md`、`templates/prompts/enablement.json`、`templates/system_prompt.md`、`templates/global_constitution.md`。
- 影響測試保護網：需新增對 bootstrap default policy 與 planner template 內容的回歸保護。
