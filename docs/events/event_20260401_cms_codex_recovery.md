# Event: cms codex recovery

## 需求

- 追查 codex websocket / `LLM 狀態` `WS/HTTP` 顯示為何在目前 `cms` 消失。
- 判定 `cms` 是否發生 branch 偏移，並找回走歪前最新進度。
- 在不碰主工作樹未提交變更的前提下，建立 recovery branch 並開始救回最近 24 小時內值得保留的後續發展。

## 範圍

IN:

- `/home/pkcs12/projects/opencode/.git`
- `/home/pkcs12/projects/opencode/specs/architecture.md`
- `/home/pkcs12/projects/opencode/docs/events/`
- `cms` / `recovery/*` / `backup/*` branches
- `/home/pkcs12/projects/opencode-recovery-20260401-183212`

OUT:

- 不直接重寫 `cms` branch ref
- 不對主工作樹做 `reset` / `stash`
- 不一次性把目前 `cms` 整條 merge 回 recovery

## 任務清單

- [x] 追查 `WS/HTTP transport label` 是否曾存在於 `cms`
- [x] 確認 `cms` 是否被 branch-pointer 操作拉離舊 codex 線
- [x] 找出走歪前最新合理 recovery 基準點
- [x] 建立 backup / recovery branches
- [x] 建立獨立 recovery worktree
- [x] 救回低風險最近 24 小時後續提交
- [ ] 決定如何處理主工作樹未提交的 `claude-cli anthropic audit` 修補

## Debug Checkpoints

### Baseline

- 使用者觀察到 codex websocket status 判斷欄位曾顯示 `WS` 狀態，但目前 `LLM 狀態` 只剩 `OK`。
- 初步懷疑是近期 codex websocket 相關功能在測試／merge 後又被回退。

### Instrumentation Plan

- 用 `git log -S/-G`、`git branch --contains`、`git reflog show cms` 重建時間線。
- 對照目前 Web/TUI 狀態欄位來源，區分是「明確 revert」還是「branch 偏移導致目前主線看不到」。
- 在不碰髒工作樹的前提下，先保全 branch refs，再用獨立 worktree 做 recovery。

### Execution

- 確認 `c08b509b3`（`fix(codex): prevent cascade account burn + rotation-aware auth + WS/HTTP transport label`）曾直接出現在 `cms` reflog：
  - `cms@{2026-03-30 11:43:04 +0800}`
- 確認 `cms` 在 `2026-04-01 15:18:31 +0800` 出現：
  - `reset: moving to beta/llm-packet-debug`
- 判定這不是單純 merge 後被 revert，而是 `cms` branch pointer 被拉到另一條歷史，讓舊 codex 線脫離目前主線視角。
- 以 `081595aa1` 作為走歪前較新的 recovery 基準點。
- 建立 branch refs：
  - `backup/cms-current-20260401-183212` -> `33700417d`
  - `recovery/cms-codex-20260401-183212` -> `081595aa1`
- 確認主工作樹不乾淨，因此不在主工作樹執行 recovery：
  - modified: `packages/app/src/context/models.tsx`
  - untracked: `docs/events/event_20260401_claude_cli_anthropic_audit.md`
  - untracked: `packages/app/src/context/model-preferences.test.ts`
  - untracked: `packages/app/src/context/model-preferences.ts`
- 建立獨立 recovery worktree：
  - `/home/pkcs12/projects/opencode-recovery-20260401-183212`
- 已救回最近 24 小時內的低風險後續提交：
  - `e875eacfa` from `4b7afb699` `fix(webapp): stop anthropic blacklist from disabling claude-cli`
  - `cdcd0f823` `recovery(debug): manually integrate llm packet checkpoints`
- `f3d1a00f2` 不能直接 cherry-pick，因為在 `packages/opencode/src/session/llm.ts` 與 recovery 線演進衝突；已改用手動整合，只保留低風險 observability checkpoints。
- 後續盤點確認：`recovery` 已天然包含走歪前的 auth/provider、codex-ws、efficiency/compaction 主體；走歪後真正有價值的新功能性變更僅上述兩項，剩餘差集主要是 templates/refs/submodule 類後勤提交。
- 使用者要求新增硬規則：`beta/*` 與 `test/*` 分支在測試完成且 merge/fetch-back 回主線後必須立即刪除，不得長留。

### Root Cause

- 根因不是 `c08b509b3` 後續被單一 revert commit 回退。
- 根因是 `cms` 在 `2026-04-01 15:18:31 +0800` 被 `reset` 到 `beta/llm-packet-debug`，導致舊 codex/cms 線上的 61 個 commits 不再位於目前 `cms` 祖先鏈上。
- 使用者體感上的「測完 merge 回 cms 卻又不見」是因為該功能一度真的進過 `cms`，但之後 `cms` 指標被拉走。
- 促成事故的流程缺口之一，是 stale `beta/test` 分支在 merge-back 後仍然存活，後續 branch-pointer 操作有機會把 `cms` 誤拉回舊 execution surface。

### Validation

- reflog 證據：
  - `cms@{2026-03-30 11:43:04 +0800}: commit: fix(codex): prevent cascade account burn + rotation-aware auth + WS/HTTP transport label`
  - `cms@{2026-04-01 15:18:31 +0800}: reset: moving to beta/llm-packet-debug`
- branch / ancestry 證據：
  - `backup/cms-current-20260401-183212` -> `33700417d`
  - `recovery/cms-codex-20260401-183212` -> `081595aa1`
- recovery worktree 證據：
  - `/home/pkcs12/projects/opencode-recovery-20260401-183212`
  - recovery HEAD: `cdcd0f823`
- 救回提交驗證：
  - `git diff --check` on recovery worktree ✅
  - `git log -2` on recovery worktree:
    - `cdcd0f823 recovery(debug): manually integrate llm packet checkpoints`
    - `e875eacfa fix(webapp): stop anthropic blacklist from disabling claude-cli`
- 流程修補：
  - 已同步更新 repo/template beta workflow 規範，新增 `beta/*` / `test/*` merge-back 後必刪的 branch lifecycle rule。

## 結論

- 判定：`cms` 確實發生 branch 偏移；不是整個 codex branch 遺失，而是 `cms` branch ref 被拉到另一條歷史。
- 走歪前最新合理基準已保全並開出 recovery branch。
- recovery 線已先救回兩項最近 24 小時內的低風險後續發展：
  - claude-cli webapp blacklist 修補
  - llm packet debug checkpoints（手動整合版）
- 其餘 codex runtime / efficiency / prompt / compaction 大功能群經盤點後已確認屬於 recovery 祖先主體，不是當前缺口。
- 新的流程硬規則已確立：`beta/*`、`test/*` 分支一律在測試完成且 merge/fetch-back 回主線後立即刪除。

## 2026-04-01 Recovery 主工作樹切換與 runtime/config 修補續記

### 需求

- 將主工作樹切回 `recovery/cms-codex-20260401-183212` 作為新的實際工作面。
- 確認 `node` 無法執行是否為 shell 載入問題。
- 在不再擴大測試導向修補的前提下，保留有產品/runtime 價值的修復，並同步文件。

### 範圍

IN:

- `/home/pkcs12/projects/opencode`
- `recovery/cms-codex-20260401-183212`
- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/project/instance.ts`
- `packages/opencode/src/bus/index.ts`
- `packages/opencode/src/server/killswitch/service.ts`
- `packages/opencode/src/mcp/apps/gauth.ts`
- `packages/opencode/src/server/routes/mcp.ts`
- `scripts/test-with-baseline.ts`

OUT:

- 不繼續擴大 `workflow-runner` / `planner-reactivation` / Smart Runner / route auth 等測試導向行為修補
- 不以 full-suite 全綠作為本輪收尾門檻

### 任務清單

- [x] 確認主工作樹切到 `recovery/cms-codex-20260401-183212`
- [x] 追查 `node` 執行失敗的環境根因
- [x] 在 login shell 下重跑並通過全 repo `typecheck`
- [x] 驗證 web runtime health
- [x] 修正 root test wrapper 的 repo root 計算
- [x] 修正 config migration / nested non-git config merge 邊界
- [x] 補強 `Instance.project` / Bus context fallback 韌性
- [x] 修正 managed app auth / error data contract 取值
- [x] 盤點目前變更並停止擴大測試導向修補
- [x] 同步 event / architecture 文件

### Debug Checkpoints

#### Environment

- non-login / non-interactive shell 下 `node` 不在 PATH。
- 根因是 `~/.bashrc` 以非互動 shell guard 提前 `return`，而 `nvm` 初始化在 guard 後方。
- `bash -lc` 可透過 `~/.profile` 載入 `nvm`，恢復 `node`：
  - `/home/pkcs12/.nvm/versions/node/v20.19.6/bin/node`

#### Execution

- 主工作樹已確認切到 `recovery/cms-codex-20260401-183212`。
- 全 repo `bun turbo typecheck` 已通過。
- `webctl.sh status` 顯示 gateway / daemon / health 正常。
- `scripts/test-with-baseline.ts` 的 repo root 從 `../..` 修正為 `..`，root test 入口不再因錯誤 cwd 失敗。
- `packages/opencode/src/config/config.ts` 已保留的產品向修補：
  - 恢復 `autoshare: true` → `share: "auto"` 相容遷移
  - 修正 non-git nested project 可向上合併父層 config 的搜尋邊界
- `packages/opencode/src/project/instance.ts` / `packages/opencode/src/bus/index.ts` 已補強缺值 fallback，避免 runtime context 缺值直接崩潰。
- `packages/opencode/src/server/killswitch/service.ts` 已把 seq 追蹤收斂到 `requestID + sessionID`。
- `packages/opencode/src/mcp/apps/gauth.ts` / `packages/opencode/src/server/routes/mcp.ts` 已對齊現行 managed app error contract。

#### Decision

- 使用者明確要求：延緩所有跟測試有關的程式修復。
- 因此本輪收尾只保留 branch/runtime/config/runtime-safety 類修補，不再延伸處理 workflow/planner/Smart Runner/route auth 等測試導向行為回歸。

### Validation

- Branch:
  - `git branch --show-current` -> `recovery/cms-codex-20260401-183212`
- Environment:
  - `bash -lc 'command -v node && node -v'` -> `v20.19.6`
- Typecheck:
  - `bash -lc 'cd /home/pkcs12/projects/opencode && bun turbo typecheck'` ✅
- Web runtime:
  - `bash -lc '"/home/pkcs12/projects/opencode/webctl.sh" status'` -> healthy ✅
- Config focused validation:
  - `bun test ./packages/opencode/test/config/config.test.ts` -> `60 pass, 0 fail`
- Architecture Sync:
  - Updated: `specs/architecture.md` 已補入 config resolution 與 runtime state initialization safety 的長期規則。

## Architecture Sync

- Updated: `specs/architecture.md` 已補入 beta/test disposable branch lifecycle 規則，明確禁止 merge-back 後長留 stale execution branches。

## 2026-04-01 Provider List「模型提供者」缺漏修補續記

### 需求

- 從 `cms` commit history 找回昨天針對 provider list / 「模型提供者」的專門修復。
- 將缺漏的最小修補回帶到目前 `recovery/cms-codex-20260401-183212`，避免 provider list 漏掉 `claude-cli`。

### 範圍

IN:

- `/home/pkcs12/projects/opencode/.git`
- `/home/pkcs12/projects/opencode/packages/opencode/src/provider/provider.ts`
- `/home/pkcs12/projects/opencode/docs/events/event_20260401_cms_codex_recovery.md`

OUT:

- 不擴大 cherry-pick 無關前端或其他 provider 變更
- 不新增 commit
- 不處理既有 generated/typecheck 雜訊

### 任務清單

- [x] 從 `cms` 歷史定位 provider list 修復 commit
- [x] 判定 recovery 缺漏是否僅為 `claude-cli` provider registration
- [x] 將最小修補套回 `packages/opencode/src/provider/provider.ts`
- [x] 執行 provider focused validation
- [x] 同步 event / architecture sync 記錄

### Debug Checkpoints

#### Baseline

- 使用者回報 recovery branch 的 provider list「模型提供者」缺少昨天已修復的內容。
- 畫面症狀對應 `claude-cli` 未正確出現在 provider list。

#### Instrumentation Plan

- 以 `git log` / `git show` 在 `cms` 歷史中找出昨天專門修 provider list 的 commit。
- 比對 recovery 目前內容，確認是單一缺漏還是整批 provider UI 修復未回來。
- 若只缺最小 runtime registration 修補，直接手動回補，不擴大 cherry-pick 範圍。

#### Execution

- 定位缺漏 commit：`addb248b2` `fix(claude-cli): call mergeProvider to register claude-cli in providers map`。
- 另外比對確認前端 related fixes `e875eacfa` / `30ba8cac1` 已存在於 recovery，不屬本次缺口。
- 實際缺漏位於 `packages/opencode/src/provider/provider.ts`：
  - 在 `database["claude-cli"]` 存在時補回 `mergeProvider("claude-cli", { source: "custom" })`
- 這次只回補最小必要 runtime provider registration，未引入其他 commit 內容。

#### Root Cause

- recovery branch 缺的不是整批 provider list 改動，而是昨天一個專門修復 `claude-cli` provider registration 的最小 commit 未被帶回。
- 因 `claude-cli` 只有 database entry、未呼叫 `mergeProvider(...)` 註冊進 providers map，導致 provider list / 模型提供者 UI 無法正確顯示該提供者。

#### Validation

- Focused test:
  - `bun test /home/pkcs12/projects/opencode/packages/opencode/src/provider/models.test.ts` ✅
- TypeScript:
  - `bun x tsc -p /home/pkcs12/projects/opencode/tsconfig.json --noEmit` ❌
  - 失敗點位於 `packages/opencode-codex-provider/build/CMakeFiles/*/compiler_depend.ts`，為 repo 既有/generated typecheck 問題，非本次 provider 修補引入。
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次僅為既有 provider registration 修補回帶，未改變長期模組邊界/資料流）

## 2026-04-01 Provider List「模型提供者」UI rename / polish 回補續記

### 需求

- 找回昨天把 provider dialog 從「連接提供者」改名為「模型提供者」並做選單界面優化的前端 commit。
- 只回補與 provider selector UI rename / polish 直接相關的前端變更到目前 `recovery/cms-codex-20260401-183212`。

### 範圍

IN:

- `/home/pkcs12/projects/opencode/.git`
- `/home/pkcs12/projects/opencode/packages/app/src/i18n/zht.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-provider.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/hooks/use-providers.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/components/dialog-custom-provider.tsx`

OUT:

- 不整批帶入 `4264f4133` 內較大的 backend CRUD / refreshProviders 依賴
- 不變更 server/runtime provider CRUD 契約
- 不新增 commit

### 任務清單

- [x] 重新定位昨天的 provider list UI commit
- [x] 判定 recovery 缺漏的前端檔案與最小相依
- [x] 回補「模型提供者」rename 與 dialog polish
- [x] 執行前端 focused typecheck
- [x] 同步 event / architecture sync 記錄

### Debug Checkpoints

#### Baseline

- 使用者指出前一輪鎖定錯誤：缺漏目標不是 `claude-cli` registration，而是 provider dialog「連接提供者」→「模型提供者」與界面優化 commit。

#### Instrumentation Plan

- 以 i18n 文案與 provider dialog 元件為主軸，從 `cms` 昨天歷史中定位 UI rename/polish commit。
- 比對 recovery 現況，只回補可獨立成立的前端變更，避免帶入缺少 backend 依賴的 CRUD 大改。

#### Execution

- 定位正確目標 commit：`4264f4133` `feat(provider): custom provider CRUD, model visibility, and UI fixes`。
- 只挑出與「模型提供者」UI rename / polish 直接相關的最小前端變更：
  - `packages/app/src/i18n/zht.ts`
    - `command.provider.connect` 改為「模型提供者」
  - `packages/app/src/components/dialog-select-provider.tsx`
    - 補回可調整大小 dialog + localStorage 尺寸記憶
    - 補回 provider row 版面優化與 custom provider edit mode 入口
  - `packages/app/src/hooks/use-providers.ts`
    - 補回 `providers().all`，讓 custom providers 出現在 provider list
  - `packages/app/src/components/dialog-custom-provider.tsx`
    - 補回最小 `editProviderId` 支援
- 保留 recovery 既有儲存流程，未把同 commit 內 backend CRUD / refreshProviders 相關部分帶回。

#### Root Cause

- `recovery` 缺漏的是 `4264f4133` 中 provider selector 前端體驗那一批變更，而不是單純 runtime provider registration。
- 因該 commit 內混有較大的 CRUD/runtime 依賴，若不做最小切片回補，容易誤帶入不完整後端契約。

#### Validation

- Frontend typecheck:
  - `bun x tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅
- Code evidence:
  - `packages/app/src/i18n/zht.ts:30` → `模型提供者`
  - `packages/app/src/components/dialog-select-provider.tsx:16` → `SIZE_KEY`
  - `packages/app/src/components/dialog-select-provider.tsx:108` → `editProviderId={x.id}`
  - `packages/app/src/hooks/use-providers.ts:30` → `providers().all`
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為既有 provider dialog 前端體驗回補，未新增長期架構邊界或資料流）

## 2026-04-01 cms branch overwrite / drift audit

### 需求

- 盤點 `cms` 歷史中主線 branch pointer 被拉偏、reset 到 stale beta/test/worktree surface、或造成既有 commit 脫離目前主線祖先鏈的事故次數。
- 評估每次掉失範圍的可恢復性，區分 confirmed / probable。

### 範圍

IN:

- `/home/pkcs12/projects/opencode/.git`
- `cms` reflog / local refs / remote refs
- `beta/*` / `test/*` / `recovery/*` / `backup/*`

OUT:

- 不修改任何 git refs
- 不直接做歷史救回或批次 cherry-pick
- 不將所有 unreachable object 都視為已確認事故

### 任務清單

- [x] 盤點 `cms` reflog 中 reset / pointer move 證據
- [x] 交叉比對 local/remote refs 與掉失 commit 範圍
- [x] 區分 confirmed overwrite、probable rollback/reset、pointer jump 無損事件
- [x] 評估 recoverability
- [x] 記錄 root-cause pattern 與後續守門建議

### Debug Checkpoints

#### Baseline

- 使用者觀察到已發現的功能回歸不只一次，懷疑還有更多未被發現的靜默掉失。

#### Instrumentation Plan

- 以 `git reflog show cms --date=iso` 為主證據，搭配 ancestry / branch containment / fsck 交叉比對。
- 僅把能連到 `cms` pointer drift/reset 的事件列為事故候選，不把所有 unreachable object 直接視為主線覆蓋。

#### Execution

- 審計結果：
  - **1 次 confirmed overwrite/drift**
  - **4 次 probable rollback/reset**
  - **1 次 probable pointer jump（無實際掉失）**
- 最大事故：
  - `2026-04-01 15:18:31` `reset: moving to beta/llm-packet-debug`
  - `old=3ab872842` → `new=f3d1a00f2`
  - 掉失 **138 commits**
  - 代表 commit 包含：
    - `c08b509b3` WS/HTTP transport label
    - `4264f4133` 「模型提供者」UI fixes
    - `addb248b2` claude-cli provider registration
    - `515a1ca7d` claude-provider merge
- 其他 probable reset/rollback：
  - `2026-03-31 02:34:08` `reset: moving to HEAD~1`（1 commit，後續已有新 SHA 重落）
  - `2026-03-30 15:50:47` `reset: moving to 7105706cb`（5 commits，後續已有等價 topic commits）
  - `2026-03-26 01:14:57` `reset: moving to HEAD~1`（1 commit，後續 fast-forward / 新 SHA 重落）
  - `2026-03-19 17:56:56` `reset: moving to HEAD~1`（21 commits，主體仍在 `remotes/beta/account-manager-refactor`）
- pointer jump 無損事件：
  - `2026-03-20 11:47:32` `reset: moving to 36baa9a606`（掉失 0 commits，但屬異常 pointer move）

#### Root Cause

- 事故模式高度一致：
  1. `beta/*` / `test/*` / worktree execution branches 長留
  2. 後續 `cms` 被 reset / fast-forward / pointer move 到這些 execution surfaces
  3. 有些事件是短暫回退後以新 SHA 重整合
  4. 但 `2026-04-01` 那次明確造成大規模主線視角掉失
- 結論：已知功能回歸並不是孤例；從 git 證據看，`cms` 歷史至少不只一次發生 reset/pointer 異常。

#### Validation

- Commands:
  - `git reflog show cms --date=iso`
  - `git reflog show cms --date=iso | rg 'reset: moving to|merge |Fast-forward|cherry-pick'`
  - `git rev-list --count <new>..<old>`
  - `git branch -a --contains <commit>`
  - `git fsck --full --no-reflogs --unreachable`
- Recoverability summary:
  - confirmed 大規模掉失：**partial → mostly recoverable**（因 `recovery/*` / feature/test refs 仍保有大量內容）
  - 4 次 probable reset/rollback：**recoverable 或 partial but strong**
  - **0 次明確完全不可救**，但部分證據只剩 reflog / remote beta refs，屬 reflog-dependent
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為事故審計與流程結論沉澱，未新增 runtime/module architecture）

## 2026-04-01 beta-workflow skill authority-first rewrite

### 需求

- 重寫 `beta-workflow` skill，明確定義 authoritative mainline 與 beta execution surface 的權限邊界。
- 把 authority mismatch、stale beta reuse、cleanup 缺失改寫成 fail-fast / completion-gate 契約。

### 範圍

IN:

- `/home/pkcs12/.local/share/opencode/skills/beta-workflow/SKILL.md`
- `/home/pkcs12/projects/opencode/templates/skills/beta-workflow/SKILL.md`

OUT:

- 不修改其他 runtime/prompt 檔案
- 不改 git/worktree 狀態

### 任務清單

- [x] 重寫 beta-workflow skill 為 authority-first 契約
- [x] 同步 repo template skill mirror
- [x] 驗證 authority / cleanup / fail-fast 段落存在
- [x] 在 event 記錄這次 skill contract 重寫

### Debug Checkpoints

#### Baseline

- 前述 git audit 顯示 branch overwrite/drift 的主要根因之一，是 AI 在 beta workflow 中容易混淆 mainline authority 與 disposable beta execution surface。

#### Execution

- 已重寫：
  - `/home/pkcs12/.local/share/opencode/skills/beta-workflow/SKILL.md`
  - `/home/pkcs12/projects/opencode/templates/skills/beta-workflow/SKILL.md`
- 新 skill 核心規則：
  - authority SSOT 必須明確列出並重述：
    - `mainRepo`
    - `mainWorktree`
    - `baseBranch`
    - `implementationRepo`
    - `implementationWorktree`
    - `implementationBranch`
    - `docsWriteRepo`
  - `beta/*` / `test/*` 與其 worktree 一律視為 disposable execution surface，不能當 mainline authority
  - build / validate / fetch-back / finalize 前都要先做 authority restatement + admission gate
  - mismatch 一律 fail fast，不可 fallback
  - merge/fetch-back/finalize 後必須刪除 `beta/*` / `test/*` refs 與 disposable worktree，否則不得宣告完成
  - 明確禁止把 implementation branch 當 base branch、猜 main branch 名稱、用 stale beta/test 當 authority source、把主線直接指向 beta/test surface

#### Validation

- Targeted grep/read evidence：
  - authority SSOT：`SKILL.md:18-43`
  - disposable beta/test rule：`SKILL.md:45-55`
  - admission gate：`SKILL.md:57-71`
  - forbidden actions：`SKILL.md:73-85`
  - cleanup as completion gate：`SKILL.md:142-152`
  - stop conditions / fail-fast：`SKILL.md:154-165`
- 本機 skill 與 repo template 內容一致，皆為 165 行版本。
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 workflow skill / template contract 重寫，architecture SSOT 無新增章節）

## 2026-04-01 recovery 現況盤點（相對 4/1 大規模掉失事件）

### 需求

- 盤點目前 `recovery/cms-codex-20260401-183212` 相對於 4/1 掉失前 tip `3ab872842`，還剩多少值得復原的功能切片。
- 明確把剛剛已補回的 provider list UI /「模型提供者」算進 recovered，而不是仍視為缺口。

### 範圍

IN:

- `recovery/cms-codex-20260401-183212`
- `3ab872842`
- provider/webapp、claude-provider/native、runtime/tooling、global onboarding 等主題差集

OUT:

- 不逐條列完全部 42 個 ancestry 差集 commit
- 不直接執行新的復原/merge/cherry-pick

### 任務清單

- [x] 以 4/1 掉失前 tip 比對目前 recovery 差集
- [x] 將差集整理成功能主題而非逐 commit 流水帳
- [x] 標記已恢復 / partial / 未恢復
- [x] 區分高價值功能群與低優先後勤差集
- [x] 更新 event 盤點結果

### Debug Checkpoints

#### Baseline

- 使用者判斷目前 recovery 應已恢復大部分 4/1 重大事件掉失內容，希望知道還剩多少真的需要救。

#### Execution

- 基準：
  - current recovery HEAD：`f6a176187`
  - pre-drift tip：`3ab872842`
  - `git rev-list --left-right --count HEAD...3ab872842` → `8 42`
- 盤點結論：
  - ancestry 上仍少 **42 commits**（非 merge 約 41 條）
  - 但大部分「4/1 重大事件核心功能」已恢復
  - 真正值得優先處理的，已收斂成 **3 個高價值功能群 + 1 個中價值產品群**

#### Recovered / Partial / Missing

- **已恢復**
  1. codex websocket / WS-HTTP / llm packet 主體
  2. provider list UI /「模型提供者」：**recovered（partial from original commit, functionally restored）**
  3. claude-cli provider registration：**recovered（partial）**
  4. 4/1 事故前的主線大方向（codex/auth/provider 基線）大致已回到 recovery 祖先主體

- **高價值仍缺（High）**
  1. Claude Native / claude-provider 原生鏈
     - 代表 commits：`197fc2bd7`、`9321ca7b1`、`809135c30`、`4a4c69488`、`515a1ca7d`
     - 現況：大多仍缺
  2. runtime/context optimization hardening
     - 代表 commits：`7bd35fb27`、`43d2ca35c`、`a34d8027a`、`4a6e10f99`、`eaced345d`
     - 現況：仍缺
  3. rebind / continuation / session hardening
     - 代表 commits：`3fd1ef9b8`、`efc3b0dd9`、`f041f0db8`、`85691d6e3`
     - 現況：仍缺

- **中價值仍缺（Medium）** 4. webapp provider management 後續完善
  - 代表 commits：`dda9738d8`、`cd8238313`、`81f2dc933`、`164930b23`、`9870e4f53`
  - `4264f4133` 其餘 backend CRUD / model visibility 部分仍未完整回來
  - 現況：**partial**
  5. multi-user onboarding / app market / repo-independent user-init
     - 代表 commits：`db1050f06`、`5c18f28fe`、`18793931b`
     - 現況：仍缺，但優先級低於核心 runtime/provider 回補

- **低優先差集（Low）**
  - docs/events、plans、spec promotion、datasheets、template 調整
  - refs/submodule/branding/website 類
  - github-copilot reasoning variants 等功能增量

#### Root Cause / Interpretation

- `42 commits` 不等於 `42 個重要功能未回來`。
- 目前剩餘差集多數已不是 4/1 事故救火核心，而是：
  - 少數高價值能力鏈（claude-provider/native、runtime hardening、session hardening）
  - 一部分 provider manager / onboarding 產品增量
  - 大量 docs/templates/refs 後勤差集

#### Validation

- Commands:
  - `git branch --show-current`
  - `git rev-parse --short HEAD`
  - `git rev-list --left-right --count HEAD...3ab872842`
  - `git log --oneline --decorate --no-merges HEAD..3ab872842`
  - `git diff --stat HEAD..3ab872842`
  - topic-scoped `git log` for provider/webapp, claude-provider/native, runtime/tooling, onboarding/branding
- Code evidence for recovered slices:
  - `packages/app/src/i18n/zht.ts` 有 `模型提供者`
  - `packages/app/src/components/dialog-select-provider.tsx` 有 `editProviderId={x.id}`
  - `packages/app/src/hooks/use-providers.ts` 有 `providers().all`
  - `packages/opencode/src/provider/provider.ts` 有 `mergeProvider("claude-cli", { source: "custom" })`
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 recovery gap inventory，未新增長期架構內容）

## 2026-04-01 AGENTS system-vs-project rule dedupe

### 需求

- 確認 subagent 委派限制若已由 system 層硬性規定，project/template `AGENTS.md` 不應重複宣告。
- 移除 repo/template `AGENTS.md` 中對 system-level subagent 規則的重複記載，避免規範漂移。

### 範圍

IN:

- `/home/pkcs12/projects/opencode/AGENTS.md`
- `/home/pkcs12/projects/opencode/templates/AGENTS.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260401_cms_codex_recovery.md`

OUT:

- 不修改 global `~/.config/opencode/AGENTS.md`
- 不調整 runtime code，只做規範去重

### 任務清單

- [x] 檢查 repo/template `AGENTS.md` 是否重複 system-level subagent 規則
- [x] 移除重複規範，只保留 project-specific 規則
- [x] 記錄 event

### Validation

- `AGENTS.md`
  - 已移除重複的 subagent count/type 限制，只保留 project-specific 規則
- `templates/AGENTS.md`
  - 已移除重複的 subagent count/type 限制，只保留 project-specific 規則
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 governance dedupe，非架構變更）

## 2026-04-01 apply_patch read-first prompt rule

### 需求

- 將 `apply_patch` 的 prompt 規範改為：更新既有檔案前必須先 `read` 該檔案。
- 降低 patch context 與實際檔案內容脫節時的高頻首輪失敗。

### 範圍

IN:

- `/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt/instructions.txt`
- `/home/pkcs12/projects/opencode/templates/prompts/session/instructions.txt`
- `/home/pkcs12/projects/opencode/docs/events/event_20260401_cms_codex_recovery.md`

OUT:

- 不修改 `enablement.json`（其僅登記 capability，不是詳細 prompt 指令面）
- 不修改 repo 外的上游 prompt 注入面

### 任務清單

- [x] 定位 apply_patch 實際 prompt 指令面
- [x] 更新 runtime `instructions.txt`
- [x] 更新 template mirror `instructions.txt`
- [x] 驗證兩者內容已同步
- [x] 記錄 event

### Validation

- Runtime SSOT:
  - `packages/opencode/src/session/prompt/instructions.txt:6`
  - 已新增：更新既有檔案時，`apply_patch` 前必須先在當前回合 `read` 該檔案；新建檔案不受此限制
- Template mirror:
  - `templates/prompts/session/instructions.txt:6`
  - 與 runtime 同步
- Non-target confirmation:
  - `packages/opencode/src/session/prompt/enablement.json` 與 `templates/prompts/enablement.json` 仍只作 capability 登記，未誤改
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 prompt/tooling instruction 更新）

## 2026-04-01 Claude Native first-slice replanning

### 需求

- 第一個 `Claude Native / claude-provider` slice 已觸發 stop gate，需要回到 plan mode 把可執行項目切細、文件化後再執行。

### 範圍

IN:

- `plans/20260401_provider-list-commit/implementation-spec.md`
- `plans/20260401_provider-list-commit/proposal.md`
- `plans/20260401_provider-list-commit/design.md`
- `plans/20260401_provider-list-commit/spec.md`
- `plans/20260401_provider-list-commit/tasks.md`
- `plans/20260401_provider-list-commit/handoff.md`
- `docs/events/event_20260401_cms_codex_recovery.md`

OUT:

- 不直接撰寫 Claude Native production code
- 不跳過 beta bootstrap 直接在 authoritative recovery worktree 開工

### 任務清單

- [x] 將 Claude Native oversized slice 標記為 blocked evidence
- [x] 把 build 入口改成 beta bootstrap 優先
- [x] 將 Claude Native 拆成 scaffold / auth bridge / loader wiring / activation 子階段
- [x] 同步 implementation-spec / proposal / design / spec / tasks / handoff
- [x] 記錄 event

### Validation

- `plans/20260401_provider-list-commit/tasks.md`
  - 已將原本過大的 Claude Native 首切片轉為較小子階段，並把 beta bootstrap 放在最前面
- `plans/20260401_provider-list-commit/implementation-spec.md`
  - 已加入 Claude Native oversized-slice replan 與新的 phase ordering
- `plans/20260401_provider-list-commit/handoff.md`
  - build entry 已改成先做 beta authority / worktree bootstrap
- Architecture Sync:
  - Verified: `specs/architecture.md`（No doc changes；本次為 execution-plan refinement）
