# Handoff: bare_chat_session

## Execution Contract

在 opencode daemon 新增一種 bare/passthrough session：對 `buildStaticBlock` 只開 `userSystem` 層，讓同機外部 app（cecelearn）借用對話層（帳號池 + Claude 結構化輸出），但 system prompt 只含呼叫端自己的內容，不被 opencode 人格堆疊污染。本工作改動 opencode daemon 本體，**必須走 beta-workflow**（隔離 beta worktree 執行 → 驗證 → fetch-back → cleanup）。

## Beta-Workflow Authority SSOT (§1，使用者確認)

| 欄位 | 值 |
|---|---|
| `mainRepo` | `/home/pkcs12/projects/opencode` |
| `mainWorktree` | `/home/pkcs12/projects/opencode`（current branch=`main`） |
| `baseBranch` | `main` |
| `implementationRepo` | `/home/pkcs12/projects/opencode`（共用 .git） |
| `implementationWorktree` | `/home/pkcs12/projects/opencode-worktrees/bare-chat-session`（implementing 階段建立） |
| `implementationBranch` | `beta/bare-chat-session`（從乾淨 `main` 切，**非** stale beta） |
| `docsWriteRepo` | `/home/pkcs12/projects/opencode` |

**§2 stale 提醒**：現存無關 beta 分支 `beta/compaction-swallow-frontend`、`beta/freerun-plan-review`（+ worktree）不可當 authority 源，不可 fetch-back，本案從乾淨 `main` 切新分支。

**§3 Admission Gate**（implementing 開工前必驗）：(1) authority 欄位齊備；(2) 當前 surface = implementation surface；(3) 主線 surface 分離且明確；(4) implementation branch 源自乾淨 `main`，非 stale beta。任一不符即停。

## Required Reads

- `plans/bare_chat_session/proposal.md` — 需求與範圍
- `plans/bare_chat_session/design.md` — DD-1..DD-9 + Code Anchors
- `plans/bare_chat_session/spec.md` — GIVEN/WHEN/THEN + Acceptance Checks
- `plans/bare_chat_session/data-schema.json` — request/response 契約
- `plans/bare_chat_session/diagrams/` — IDEF0(A0) + GRAFCET 觸發狀態機
- opencode 現況關鍵檔（design.md Critical Files 全列，特別 `llm.ts:839-886`、`prompt.ts:3441-3478`、`provider-claude/provider.ts:311-326`、`agent.ts:67-`）

## Execution Order

beta-workflow §5 canonical 流程：
1. **Admission**：建 beta worktree + branch（從 main），restate authority，驗 surface。
2. **Execute in beta**：依 tasks.md phase 在 `implementationWorktree` 實作（reserved agent `bare` + llm.ts layer-zeroing + 工具/continuation 閘）。`/plans` `/specs` `docs/events` 錨定 `docsWriteRepo`。
3. **Validate**：beta path 跑 tsc/test + POC 端到端（固定 Claude 帳號，unix socket 真打一輪）。
4. **Fetch-back**：切 mainWorktree → `test/bare-chat-session` 從 main → merge beta branch → 驗證。
5. **Finalize**（approval-gated）：test → main `--no-ff`。
6. **Cleanup**：刪 beta/test branch + worktree；`/plans` 升格 `/specs`（plan_graduate，使用者指示）。

## Stop Gates In Force

- **Admission 失敗**（authority 不符 / surface 不對 / branch 源自 stale beta）→ 停。
- **改 daemon 本體前必須 restart_self 才生效**：禁止 AI 自行 spawn/kill daemon（天條 #12）；POC 驗證需 daemon 載入新 code 時走 `restart_self`。
- **結構化輸出 provider 限制（DD-5）**：POC 固定 Claude；若意外走到 codex 降級，停下回報（天條 #11）。
- **人格清零回歸（R1）**：若 bare 分支誤傷一般 session 的七層組裝，停。
- **fetch-back / finalize**：approval-gated，需使用者明確確認。
- **POC 燒真實 Claude 訂閱額度**：控制測試次數。

## Execution-Ready Checklist

- [x] proposal / design / spec 完成
- [x] IDEF0 + GRAFCET 驗證通過並存圖
- [x] data-schema / c4 / sequence 完成
- [x] beta authority SSOT 確認（baseBranch=main）
- [x] POC 帳號/socket/model 三元組就緒
- [ ] tasks.md 分階段（本階段補）
- [ ] 使用者批准進 implementing（plan_advance --to implementing + beta admission）

## Validation Plan

- beta path：`bun node_modules/typescript/lib/tsc.js` 型別檢查 + `bun test`（daemon 相關）。
- POC 端到端：daemon restart_self 載入新 code → curl unix socket 開 bare session → 送帶 system+format+model 的 message → 驗回 schema 受限 JSON + system prompt 無污染（log/trace）。
- 回歸：一般 top-level session 七層組裝零退化。

## Notes

- 不改 rotation3d / provider-claude / provider-codex 內部（DD Non-Goals）。
- POC 固定帳號 `claude-cli-subscription-claude-cli-d5002de6`（claude-opus-4-8）。
- cecelearn 端 client 為**另案** spec（cecelearn repo），不在本案範圍。
- 完成後 event_record 收尾 + 同步 `specs/architecture.md`（session/prompt-assembly 段落）。
