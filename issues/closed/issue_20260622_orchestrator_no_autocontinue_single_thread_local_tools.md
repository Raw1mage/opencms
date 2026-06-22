# Orchestrator: 單線自執行（無 subagent）時，工具序列後仍有 pending todo 卻 text-only 結束 turn 停住

- **日期**：2026-06-22
- **Status**：CLOSED — WON'T-FIX by design（closed 2026-06-23）。處置確定為「純 AI 自律，不加 runtime 安全網」：唯一候選修法是 execution-mode turn-end 注入 continuation nudge，而那正是本批次（commit `6333a612a`，spec `harness/paralysis-steer-provider-split` DD-8）刻意撤除的 synthetic-injection 機制。autorun 已退役（`config/tweaks.ts` `triggerPhrases:[]`），continuation 在 execution mode 由 AI 自律 + SYSTEM.md §2.7（有 pending todo 不得 text-only 結束）承擔,不再回補 runtime 兜底。若日後出現「自律失效且自律規則本身無法覆蓋」的真實復現,再重開。原 RCA 內容保留於下供存查。
- **嚴重度**：high（破壞 execution mode 的 turn-boundary 契約；使用者必須手動催「繼續」，autonomous 多步驟執行中途停擺）
- **元件**：opencode orchestrator turn-boundary / continuation 機制（`packages/opencode/src/session/workflow-runner.ts` `planAutonomousNextAction`；execution-mode turn 結束判定）
- **回報者**：pkcs12（live；於 docxmcp `mineru-inspired-content-list` Phase A 單線實作中觀察到）

## 摘要

主代理在**明確 execution mode**（使用者已下「先做 Phase A」並選定範圍）、todolist 仍有 pending 項（A5 補工具描述 / A7 收尾驗證）的情況下，跑完一連串**純本地唯讀工具**（grep + read，無任何 `task()` subagent 委派）之後，產出一段 text-only 訊息就結束 turn，把控制權交回使用者。沒有撞到任何 stop gate（無 approval / decision / blocker / round budget），純粹是工具序列結束後沒有自發接著 dispatch 下一個 todo。

## 與既有 BR 的區別

`issue_20260622_orchestrator_no_autocontinue_after_subagent.md` 描述的是 **subagent 完成後**主代理不自發 resume，依賴 runtime 注入的 `Subagent … finished … continue` 訊息才推進。

本 BR 的場景**沒有 subagent**：主代理全程單線自己執行（read/grep/edit），不存在「subagent 完成事件」這個 resume 觸發點。即使前一份 BR 的修法（subagent-completion continuation）落地，也救不到這個場景——因為這裡根本沒有 completion notice 可以掛載。這是「**純本地工具序列結束 → turn 邊界**」這條路徑上的 continuation 缺口，與 subagent path 正交。

## 實際症狀（可複現）

1. 使用者進入 execution mode（「先做 Phase A」，已用 question 收斂範圍）。
2. 主代理建立 todolist（A1–A7），逐步推進到 A5/A7 仍 pending。
3. 主代理為了定位 A5 的編輯點，連續呼叫 `grep`（找 registry 中 extract_all）+ `read`（讀該段描述）。
4. 工具回傳後，主代理輸出一段純文字（描述找到的內容 / 下一步打算），**未接任何修改性工具呼叫，turn 結束**。
5. 使用者觀察：「你剛才已經停止 runloop 了」「沒有卡住不是事實」。
6. 需使用者手動「怎了？/繼續」才恢復推進。

## 期望行為

execution mode 下、todolist 仍有 pending/in_progress 且無 stop gate 時，**任何工具序列（含純本地唯讀工具）結束後**，主代理都應在同一 autonomous run 內自動 dispatch 下一個 actionable todo，直到 todolist 收斂或撞 stop gate——不該因為「這一輪只做了 read/grep」就把 turn 邊界當成 conversational stop 交回使用者。

text-only 結尾在 execution mode + 有 pending todo 時，應被視為**違規**（SYSTEM.md §2.7 已明文禁止），而非合法 turn 結束。

## 根因假設（待確認，未讀源碼前不定性）

- **H1（最可能）**：continuation 引擎只在特定 resume 觸發點（subagent 完成注入、autorun nudge、合成 continuation 訊息）才把主代理推回下一 turn。純本地工具序列（read/grep/edit）結束**不構成**任何 resume 觸發點，所以 turn 自然結束＝交回使用者。
- **H2**：autorun 停用（SYSTEM.md §9，opt-in，需 verbal trigger）後，execution mode 與 continuation 完全脫鉤——execution mode 只是「行為提示」，runtime 端沒有對應的 continuation 閘在工具序列後檢查 todolist 殘留並自動續跑。
- **H3（部分自責，非 runtime）**：主代理自身未遵守 §2.7「有 pending todo 不得 text-only 結束」的紀律。但即便如此，缺少 runtime 安全網意味著「AI 一旦自律失效就靜默停擺」，沒有任何機制兜底——這本身是可改善的 robustness 缺口。

→ 與停用 autorun 的後遺症高度相關：autorun 開啟時 continuation 由 autorun 引擎兜底；一旦停用，純本地單線執行就失去唯一的續跑驅動，完全押在 AI 自律上。

## 候選修法（方向，待確認）

1. **runtime 安全網**：execution mode（使用者明確 execute / 「先做 X」）下，每個 assistant turn 結束前檢查 todolist——若仍有 pending/in_progress 且無 stop gate，且本 turn 沒有以修改性動作收尾，注入一條 continuation nudge 推主代理續跑。涵蓋「無 subagent」的純本地路徑。
2. 釐清「execution mode」與「autorun continuation」的耦合：是否該讓 execution mode 隱含 arm 一個輕量 continuation（不限 subagent path），讓使用者對「開始做 X」的持續預期不落空。
3. 與 `issue_20260622_orchestrator_no_autocontinue_after_subagent.md` 合併考量：兩者同屬「continuation 觸發點覆蓋不全」，差別只在觸發點是 subagent-completion vs local-tool-sequence-end。修法應統一在「turn-end todolist 殘留檢查」這層，而非各自針對 resume 來源打補丁。

## 關聯

- 姊妹 BR：`issue_20260622_orchestrator_no_autocontinue_after_subagent.md`（subagent path 的同類問題）
- 觀察來源：docxmcp `specs/mineru-inspired-content-list/`（Phase A 單線實作）
- SYSTEM.md §2.7 Execution Modes（text-only 結束禁令）/ §2.3 Dispatch Rules（todolist load-bearing）/ §9 Autorun（opt-in，停用後續跑缺口）
