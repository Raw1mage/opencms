# Tasks: bare_chat_session

對應 spec.md Requirements 與 design.md DD-1..DD-9。**改 opencode daemon 本體，全程走 beta-workflow**。每完成一項即時勾選。

## 1. Beta Admission（beta-workflow §3，開工前）

- [x] 1.1 Restate authority SSOT（handoff.md §1）：baseBranch=main、implementationBranch=beta/bare-chat-session、implementationWorktree=/home/pkcs12/projects/opencode-worktrees/bare-chat-session
- [x] 1.2 從乾淨 main 建 beta branch + worktree（非 stale beta；§4 禁用 beta/compaction-swallow-frontend 等）
- [x] 1.3 驗 admission gate：current surface == implementation surface；mainline 欄位分離明確
- [x] 1.4 切換到 implementationWorktree 開工

## 2. Reserved agent `bare`（DD-1）

- [x] 2.1 `agent.ts` getNativeAgents 新增 reserved agent `bare`：空 prompt、最小權限、mode 適當、native:true
- [x] 2.2 標記機制：讓下游（llm.ts/prompt.ts）能辨識當前 session/turn 為 bare（經 agent.name === "bare" 或衍生 flag）
- [x] 2.3 驗證：tsc 編譯通過；agent 列表含 bare

## 3. Layer-zeroing system 組裝（DD-2）

- [x] 3.1 `llm.ts` buildStaticBlock 呼叫點（:839-854）加 bare 分支：layers 只留 userSystem，清零 driver/agent/agentsMd/systemMd/identity（鏡像 :871-886 driverOnlyBlock）— commit eda272bda
- [x] 3.2 fail-fast（DD-8）：bare 模式 agent/agentsMd 層非空 → 擲 BARE_LAYER_INJECTION_VIOLATION（driver/systemMd/identity 為 opencode 內建、清零即功能，不報錯）— commit e7d8bdc16
- [x] 3.3 TV1 ✓（POC：reply+reasoning 純 tutor voice、零 opencode persona）。TV2 ✓（清零嚴格 gated 於 agent==bare，else 分支 byte-identical；main build 上一般 opencode 正常運作、tsc 綠）

> **DD-10「不落地」= cecelearn 端處理，opencode 無 task**（2026-06-18 拍板，見 design.md DD-10）：reset-to-zero 由 cecelearn 每頁開新 session 達成；opencode 不改 storage。

## 4. 工具閘 + continuation 閘（DD-3/DD-4）

- [x] 4.1 `prompt.ts` 工具解析：bare session 不掛內建工具，只保留 format:json_schema 的 StructuredOutput tool（:3441-3448）
- [x] 4.2 `prompt.ts` continuation 判斷：bare session 識別為 passthrough，回應後 break，不觸發 autorun
- [x] 4.3 TV7 ✓（POC response 無任何 tool part；bare gate 刪全部內建工具）。TV8 ✓（一問一答 step-finish reason=stop，無 autorun/continuation）

## 5. 帳號 pin + fail-fast（DD-6/DD-8）

- [x] 5.1 確認 model.{providerId,modelID,accountId} pin 路徑（prompt.ts pinnedAccountId / incomingModel）對 bare session 生效、不走 rotation
- [~] 5.2 **不寫程式**（2026-06-18 拍板）：查 `llm.ts:640-680` 帳號解析——pin 不存在的 accountId 不會靜默成功，會在 provider 載入憑證時失敗（系統已保證）。唯一的靜默換帳號（pin 帳號 429 → `llm.ts:652-674` 轉同 provider 帳號）為**同 family**（claude→claude），結構化輸出不壞；危險的跨 family 降級在 `rotation3d`，DD-6 固定 pin 已規避。故毋須 BARE_ACCOUNT_NOT_FOUND。
- [x] 5.3 TV5 ✓（POC：response accountId = pinned d5002de6，無 rotation、無跨 family）。壞帳號明確失敗為 reasoned（見 5.2，系統憑證載入已擋 + DD-6 規避），未專門觸發

## 6. POC 端到端驗證（beta path）

- [x] 6.1 載入新 code：restart_self 不在 Claude Code session 工具集，改走 sanctioned `webctl.sh dev-refresh`（同 restart_self 底層路徑，非 raw kill；天條 #12 精神保留）
- [x] 6.2 curl unix socket 開 bare session + 送帶 system+format+model 的 message ✓
- [~] 6.3 TV3 ✓（intent=start_dictation 結構化 JSON 正確、persona 零污染、帳號 pin）。**TV4 N/A**：claude-cli（OAuth 訂閱）後端 **不強制** toolChoice:required，結構化輸出為**軟性**（模型回 prose ```json fence），非 forced tool-call → StructuredOutputError 路徑未觸發。屬 provider 行為（Non-Goal 不改 provider），cecelearn 端以「解析 JSON + Gemini 靜默備援」吸收（見 event）。
- [~] 6.4 核心 acceptance 經 POC 驗證；完整逐項手測屬 cecelearn client 另案

## 7. Fetch-back + Finalize（beta-workflow §7，approval-gated）

- [x] 7.1 restate authority 後建 test/bare-chat-session 從 main（無 drift，merge-base=main HEAD）
- [x] 7.2 merge beta 進 test，tsc 綠（僅既有 freerun-bridge 無關錯誤）
- [x] 7.3 [approved] finalize：test → main `--no-ff`（main HEAD b69e7e6e9）；daemon --force rebuild 於 main（buildId b69e7e6e9）

## 8. Cleanup + 文件 + 收尾（beta-workflow §8）

- [x] 8.1 刪 beta/bare-chat-session + test/bare-chat-session branch + beta worktree（已無殘留 surface）
- [x] 8.2 同步 `specs/architecture.md`（session / prompt-assembly 段落新增 bare session）
- [x] 8.3 event_record 收尾：bare_chat_session/event_2026-06-18_poc-validated-finalized-bare-session-to-main-struc
- [x] 8.4 [使用者指示] plan_graduate：/plans → /specs（verified→living）
