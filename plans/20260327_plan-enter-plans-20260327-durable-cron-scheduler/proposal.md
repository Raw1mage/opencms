# Proposal

## Why

- 目前系統已經有 tool surface 注入鏈，但缺少顯式的 `dialog_trigger_framework` 來統一決定何時進 plan/replan、何時要求 approval、何時露出 tool menu、何時切 beta workflow。
- 最近 remote-terminal 事件暴露出一個核心問題：流程不是沒有 plan 入口，而是缺少中途重規劃與 trigger/gate 的正式框架，導致硬性 contract 被跳過。
- `plan_enter` 目前還會自己亂命名 active plan root，會讓 planner artifact root 與實際任務主題脫節，增加後續 execution 與 docs 的混亂。

## Original Requirement Wording (Baseline)

- "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
- 後續使用者補充：`plan_enter` 會自己亂命名的問題到時候也要順便處理。先做1

## Requirement Revision History

- 2026-03-28: 對話從 remote-terminal implementation 轉向規劃更高層的 `dialog_trigger_framework`。
- 2026-03-28: 使用者選擇先沿用目前錯誤 slug 的 active plan root，直接覆寫成正確規劃內容。
- 2026-03-28: 使用者明確要求把 `plan_enter` 亂命名 active root 的問題納入同一份 plan。

## Effective Requirement Description

1. 規劃一個 `dialog_trigger_framework`，統一管理對話中的 trigger/gate/mode switch。
2. 第一版採 rule-first、程式化 detector、next-round rebuild，不採背景 AI governor 與 in-flight hot reload。
3. 將 `plan_enter` active root naming 修正視為同一框架下的第一個明確 implementation slice，且第一版只修 slug derivation。

## Scope

### IN

- `dialog_trigger_framework` 的 planning artifact 完整化。
- trigger taxonomy：第一版先收斂 `plan enter`、`replan`、`approval` 三個 must-have trigger；tool menu、beta workflow、docs sync 留待後續擴充。
- `plan_enter` 命名修正的需求、風險、驗證與執行切片。
- 既有 runtime surfaces 的 reuse 策略與 integration 邊界。

### OUT

- 完整產品化 UI/UX 文案與最終 interaction polish。
- 背景語意分類 agent。
- remote-terminal 具體執行改碼。

## Non-Goals

- 不做全新 tool hot-swap runtime。
- 不把所有 decision 都交給模型在每輪自由判讀。
- 不用 fallback 掩蓋 planner root naming mismatch。

## Constraints

- 必須遵守 fail-fast、no silent fallback、docs-first、beta workflow contract 等既有專案規範。
- 必須重用既有 runtime infrastructure，而不是另外造一套平行 orchestration system。
- `plan_enter` 命名修正不能破壞既有 `/plans` artifact lifecycle 與 authoritative root contract。
- 第一版 detector 寫法採集中式 registry/policy surface，避免繼續在多點散落規則。

## What Changes

- active plan package 會從模板轉為 `dialog_trigger_framework` 的正式規劃文件。
- 後續 build work 將被切成明確 slices：planner slug-derivation fix、集中式 trigger detector layer、policy/action integration、validation/doc sync。
- 對既有 tool surface 的理解會正式化成 framework 設計，而不再只是口頭結論。

## Capabilities

### New Capabilities

- `dialog_trigger_framework`: 以明確 detector/policy/action 合約判定下一輪是否進 plan、replan、approval gate、beta gate、tool menu。
- `surface dirty + next-round rebuild`: 對 tool surface / runtime capabilities 變化採可觀測的 deterministic rebuild 契約。

### Modified Capabilities

- `plan_enter`: 第一版至少不再因錯誤 slug derivation 產生與任務主題脫節的 active plan root。
- Planner/build handoff: 之後可依 trigger framework 更明確地把 mode switch/gates 視為系統 contract，而不是 prompt prose。

## Impact

- 影響 planner lifecycle、session prompt/runtime、tool resolve、MCP tool visibility、以及 docs/event/architecture 內的 workflow 描述。
- 會成為後續 remote-terminal、builder workflow、tool-menu policy 等議題的上層統一框架。
