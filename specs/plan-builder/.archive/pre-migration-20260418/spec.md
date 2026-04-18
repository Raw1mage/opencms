# Spec: plan-builder

## Purpose

- 將「建立、演進、歸檔 spec」這個開發生命週期迴路收斂到單一 skill + 單一資料夾 + 單一 state machine，讓 spec 成為 AI-native 開發的唯一真相來源，同時對 legacy 資料結構提供和平 migration。

## Requirements

### Requirement: 統一資料夾
The system SHALL 將所有 per-feature spec artifact（active 或 archived）集中在 `specs/{slug}/` 底下，不再區分 `plans/` 與 `specs/` 兩個資料夾。

#### Scenario: 新建立的 spec 落點
- **GIVEN** 使用者觸發 `plan-builder` 新建 spec
- **WHEN** skill 初始化該 spec 資料夾
- **THEN** 資料夾必須建立在 `specs/{slug}/`，且包含 `.state.json` 與 `proposal.md` 骨架

### Requirement: 七大狀態機
The system SHALL 為每個 spec 維護 `.state.json`，其 state 欄位必須落在 { proposed, designed, planned, implementing, verified, living, archived } 七種之一。

#### Scenario: 初建的 spec 狀態
- **GIVEN** 新建的 spec 尚無任何內容
- **WHEN** `plan-init.ts` 執行完成
- **THEN** `.state.json.state` 必須等於 `proposed`，`history` 至少有一筆 `created` 紀錄

#### Scenario: 不合法的狀態轉換被拒絕
- **GIVEN** spec 當前狀態為 `proposed`
- **WHEN** 使用者呼叫 `plan-promote.ts --to implementing`
- **THEN** script 必須報錯並拒絕寫入（因為 proposed → implementing 跳過 designed / planned）

### Requirement: 七種 mode 驅動狀態轉換
The system SHALL 將任何非建立性的 spec 變更歸類為 { amend, revise, extend, refactor, sync, archive } 之一；新建則為 `new` mode。

#### Scenario: 實作中發現 bug 屬於既有 task 範圍
- **GIVEN** spec state = `implementing`，某 bug fix 不新增 task、不改 requirement
- **WHEN** 使用者以 amend mode 更新
- **THEN** state 不變，history 新增 `amend` 條目，僅 tasks.md / design.md Decisions 可能被動

#### Scenario: 架構級變更失效原 plan
- **GIVEN** 既有 spec 的 C4 component 需重做
- **WHEN** 使用者以 refactor mode 重啟
- **THEN** state 回到 `designed`，history 記錄 `refactor` 轉換原因，且需重跑該 state 的 artifact 要求

### Requirement: state-aware artifact 要求
The system SHALL 依當前 state 決定哪些 artifact 必須存在且通過 validation，尚未進入的 state 對應 artifact 不強制。

#### Scenario: proposed 狀態只驗 proposal.md
- **GIVEN** spec state = `proposed`
- **WHEN** 執行 `plan-validate.ts specs/{slug}/`
- **THEN** 只檢查 proposal.md 的必要 headings，其他 artifact 缺漏不報 blocker

#### Scenario: designed 狀態驗設計層 artifact
- **GIVEN** spec state = `designed`
- **WHEN** 執行 validation
- **THEN** 必須檢查 proposal / spec / design / IDEF0 / GRAFCET / C4 / Sequence / data-schema 的必要結構；tasks / handoff 不強制

### Requirement: on-touch 和平 migration
The system SHALL 在任何 plan-builder script 操作 legacy `plans/{slug}/` 資料夾時，自動執行 migration 到 `specs/{slug}/`，且不中斷 script 主流程。

#### Scenario: 首次觸碰 legacy 資料夾
- **GIVEN** `plans/user-auth-rewrite/` 是舊格式（無 `.state.json`）
- **WHEN** 使用者執行 `bun run plan-state.ts plans/user-auth-rewrite/`
- **THEN** script 必須先呼叫 `ensureNewFormat()`：
  1. 推斷當前 state（依 artifact 組合）
  2. 快照原資料夾內容到 `specs/user-auth-rewrite/.archive/pre-migration-YYYYMMDD/`
  3. `git mv plans/user-auth-rewrite/ specs/user-auth-rewrite/`
  4. 寫入 `.state.json` 含推斷 state + `migration` history 條目
  5. 印出所有動作的 log 行
- 然後才繼續 script 原工作

#### Scenario: 已為新格式則 no-op
- **GIVEN** `specs/user-auth-rewrite/.state.json` 已存在
- **WHEN** 任何 script 呼叫 `ensureNewFormat()`
- **THEN** helper 不做任何修改，直接返回（idempotent）

### Requirement: migration 不得靜默
The system SHALL 在 migration 過程中輸出每一步動作的 log；推斷失敗時必須明確報錯並中止，而不是退回某個 default state。

#### Scenario: 無法推斷 state
- **GIVEN** legacy 資料夾結構異常（例如只有 tasks.md 沒有 proposal.md）
- **WHEN** `ensureNewFormat()` 跑狀態推斷
- **THEN** 必須拋出 `StateInferenceError`，列出原因與人工處理建議，不得 default 為 `proposed`

### Requirement: git history 保留
The system SHALL 使用 `git mv` 搬移 legacy 資料夾，以保留每個檔案的 git 修改歷史。

#### Scenario: migration 後追溯歷史
- **GIVEN** 一份 legacy plan 完成 migration 到 `specs/{slug}/`
- **WHEN** 執行 `git log --follow specs/{slug}/proposal.md`
- **THEN** 必須能看到 migration 前 `plans/{slug}/proposal.md` 的歷史 commit

### Requirement: beta-workflow 契約相容
The system SHALL 確保 `tasks.md` 結構（heading / checkbox 格式）在新位置仍可被 `beta-workflow` skill 解析為 runtime todo。

#### Scenario: beta-workflow 讀取新位置
- **GIVEN** spec 已 migrate 到 `specs/{slug}/`，且 state = `planned`
- **WHEN** `beta-workflow` skill 被觸發並讀 tasks.md
- **THEN** 無論其當前寫死的讀取路徑為何，現有 tasks.md 內容格式不變（結構相容）；路徑差異由過渡期 symlink 或下游 skill 同步更新處理

### Requirement: 共存期雙 skill
The system SHALL 在過渡期內同時保留 `planner`（deprecated）與 `plan-builder`（active）skill，使舊 `/planner` 呼叫仍可運作。

#### Scenario: 舊 slash command 仍可用
- **GIVEN** 使用者輸入 `/planner`
- **WHEN** skill 載入
- **THEN** 舊 planner 可繼續載入；同時輸出 deprecation hint 建議改用 `/plan-builder`

### Requirement: Dog-fooding migration
The system SHALL 讓本 plan 自身（`plans/plan-builder/`）於 Phase 5 成為第一個 on-touch migration 測試案例。

#### Scenario: 本 plan 自動 migrate
- **GIVEN** 本 plan 位於 `plans/plan-builder/`，且實作進入 Phase 5
- **WHEN** 使用 `plan-builder` skill 操作本 plan
- **THEN** 必須自動搬到 `specs/plan-builder/`，狀態推斷為 `implementing`（因 tasks.md 有勾選項），快照保留於 `.archive/pre-migration-YYYYMMDD/`

### Requirement: Sync 為必經檢查點（warn 策略）
The system SHALL 在 `beta-workflow` 每個 task 勾選後自動執行 `plan-sync.ts`，偵測 code 變動對應 spec 的 drift；發現 drift 時印警告但不擋 commit，同時在 `.state.json.history` 記 `sync warned` 條目。

#### Scenario: task 勾選後自動 sync
- **GIVEN** beta-workflow 剛把 tasks.md 某項從 `[ ]` 改為 `[x]`
- **WHEN** 該 hook 自動呼叫 `plan-sync.ts specs/{slug}/`
- **THEN** script 對比 git diff 與 spec artifact 欄位；若發現 code 動了 schema 欄位但 data-schema.json 未更新，印 `[plan-sync] WARN: drift detected in user.session field`，並寫 `.state.json.history += {mode:"sync", result:"warned", drift:[...]}`

#### Scenario: drift 屬於 schema 欄位變動
- **GIVEN** code 新增 `user.lastActive` 欄位，`data-schema.json` 尚未同步
- **WHEN** sync 偵測
- **THEN** 輸出 WARN + 建議 mode（「建議以 amend mode 補 data-schema」），但不改 state、不擋後續 script

#### Scenario: 無 drift 時仍留痕
- **GIVEN** code 變動與 spec 一致
- **WHEN** sync 完成
- **THEN** `.state.json.history += {mode:"sync", result:"clean"}`，提供「持續有紀錄」的 audit evidence

### Requirement: Per-part history（extended document addition）
The system SHALL 為每個 artifact 的每個 part 支援版本疊加而非覆寫；採三層機制 inline delta markers / section-level supersede / full snapshot。

#### Scenario: amend 模式下的 inline delta
- **GIVEN** spec state=living，使用者以 amend mode 修 design.md Decision DD-3
- **WHEN** plan-builder 更新該 Decision
- **THEN** 舊 DD-3 不刪除，加上 `[SUPERSEDED by DD-7]` 標記；新 DD-7 新增並記錄 amended from DD-3

#### Scenario: extend 模式下的 delta marker
- **GIVEN** spec 新增 Requirement
- **WHEN** extend mode 寫入 spec.md
- **THEN** 新 Requirement 帶 `(vN, ADDED YYYY-MM-DD)` 前綴，既有 Requirement 不動

#### Scenario: refactor 自動 snapshot
- **GIVEN** 使用者執行 `plan-promote.ts --mode refactor specs/{slug}/`
- **WHEN** refactor 流程啟動
- **THEN** 除 proposal.md 以外所有 artifact 自動 `git mv` 到 `specs/{slug}/.history/refactor-YYYY-MM-DD/`，current artifact 重置為 proposed 階段骨架，state 回 `proposed`，history 記錄 snapshot 位置

#### Scenario: refactor rollback
- **GIVEN** refactor 已完成但使用者發現錯誤
- **WHEN** 執行 `plan-rollback-refactor.ts specs/{slug}/`
- **THEN** script 從 `.history/refactor-最近日期/` 還原所有 artifact，刪掉期間新產出的 reset 骨架，state 還原至 snapshot 前的值，history 新增 `{mode: "refactor-rollback", restored-from: ".history/..."}` 條目

## Acceptance Checks

- `plan-state.ts {path}` 對 proposed / designed / planned / implementing / verified / living / archived 七種狀態的樣本 plan，回傳對應 state 字串且與 `.state.json` 一致
- `plan-promote.ts {path} --to {state}` 對合法轉換成功寫入 history；對非法轉換回傳 exit code 非 0 並列出原因
- `plan-validate.ts {path}` 依 `.state.json.state` 動態調整驗證範圍，proposed 狀態僅驗 proposal.md；verified 狀態驗全套 artifact
- `plan-migrate.ts {legacy-path}` 在快照 + git mv 後，新位置 `.state.json` 的 state 欄位符合狀態推斷規則表
- `ensureNewFormat()` 在 legacy 路徑觸發時每步動作皆有 `[plan-builder-migrate]` 前綴 log 輸出
- `git log --follow` 可追溯本 `plans/plan-builder/proposal.md` 至 migrate 後的 `specs/plan-builder/proposal.md`
- `/plan-builder` slash command 載入時 SKILL.md 正確顯示；`/planner` 載入時顯示 deprecation hint 並指向 `/plan-builder`
- 人為建構「只有 tasks.md 沒有 proposal.md」的異常 legacy，`ensureNewFormat()` 報 `StateInferenceError`
- 本 plan 經過完整 Phase 1–6 後，`specs/plan-builder/.state.json.state = "verified"` 且 history 含完整七次轉換紀錄
- `plan-sync.ts` 對人工佈置的 drift fixture 正確輸出 `[plan-sync] WARN` + 寫入 `.state.json.history`
- 執行 `plan-promote.ts --mode refactor` 成功把 artifact snapshot 到 `.history/refactor-YYYY-MM-DD/` 並 reset current artifact
- `plan-rollback-refactor.ts` 能從 `.history/` 還原 snapshot 前狀態
- amend mode 對 design.md Decision 的修改產生 `[SUPERSEDED by DD-N]` inline marker 且舊 Decision 內容保留
