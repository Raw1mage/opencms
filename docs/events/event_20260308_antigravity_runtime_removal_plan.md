# Event: Antigravity Runtime Removal Plan

Date: 2026-03-08
Status: In Progress

## 1. 需求

- 將 `antigravity` 從 repo 中永久移除，不再作為 provider / runtime / UI 能力出現。
- 在移除過程中保護既有 canonical family，尤其是 `openai`，且不破壞 `accounts.json` 語義。

## 2. 範圍

### IN

- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/server/routes/account.ts`
- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
- antigravity plugin runtime references

### OUT

- 本階段先完成 runtime 拔除順序規劃與風險界定；避免直接在同一輪混入大規模刪除。

## 3. 任務清單

- [x] 盤點 antigravity backend/runtime/TUI 特例注入點
- [x] 定義最小可落地的 removal phases
- [x] Phase 1: 移除 backend provider builder 注入
- [x] Phase 2: 移除 account route antigravity special routes/status payload
- [x] Phase 3: 移除 TUI prompt/admin antigravity quota/account manager path
- [ ] Phase 4: 清理 plugin/storage/quota 死碼與文件

## 4. Debug Checkpoints

### Baseline

- antigravity 已從 canonical family provider list/UI 顯示層排除，但 runtime 仍大量存在。

### Execution

- `provider/provider.ts` 仍包含 antigravity whitelist、dynamic loader、legacy account merge 與 provider state 注入。
- `server/routes/account.ts` 仍包含：
  - `/account` 回傳 `antigravity` rich status payload
  - `POST /account/:family/active` 對 antigravity 使用自訂 manager/index path
  - `POST /account/antigravity/toggle` 專屬 route
- `tui/component/dialog-admin.tsx` 仍依賴 antigravity plugin：
  - `AccountManager`
  - quota storage / quota-group
  - account list / active index / toggle / quota footer
- `tui/component/prompt/index.tsx` 仍把 antigravity 視為 footer quota 特例 provider。

### Execution (2026-03-08 follow-up)

- 已移除 `packages/opencode/src/plugin/index.ts` 的 antigravity / antigravity-legacy internal plugin registration。
- 已移除 `packages/opencode/src/cli/cmd/auth.ts` 的 antigravity provider login flow、排序與提示文案，現在只保留 `gemini-cli` 的 Google subscription OAuth 入口。
- 已將 `packages/opencode/src/cli/cmd/models.ts` 從 antigravity plugin account/model registry 解耦，改用 generic `packages/opencode/src/provider/model-registry.ts`。
- 已移除 `packages/opencode/src/provider/capabilities.ts`、`packages/opencode/src/provider/health.ts`、`packages/opencode/src/tool/registry.ts`、`packages/opencode/src/project/bootstrap.ts` 中的 antigravity runtime references。
- `docs/ARCHITECTURE.md` 已同步更新：antigravity 不再被記錄為 canonical runtime family，且 Antigravity Plugin 章節已自 architecture baseline 移除。

### Execution (2026-03-08 quota/runtime follow-up)

- 已移除 `packages/opencode/src/account/rotation3d.ts` 的 antigravity quota probing、plugin storage/client 依賴與 antigravity fallback quota 判斷。
- 已將 `packages/opencode/src/account/rate-limit-judge.ts` 的 cockpit strategy 收斂為 `openai` 專用；不再 import antigravity plugin quota/token/auth helpers。
- OpenAI quota/backoff 改為直接讀取 `packages/opencode/src/account/quota/openai.ts` 的 live quota state，保留 openai 專屬 backoff 行為，同時切斷 antigravity runtime 依賴。

### Validation

- 靜態搜尋確認 antigravity 已不再作為 canonical UI provider family 顯示，但 runtime special-case 仍完整存在。✅
- 靜態搜尋確認本輪修改檔案中的 antigravity 直接引用已清除。✅
- `bunx tsc --noEmit -p packages/opencode/tsconfig.json` ✅
- `bunx eslint packages/opencode/src/plugin/index.ts packages/opencode/src/cli/cmd/auth.ts packages/opencode/src/cli/cmd/models.ts packages/opencode/src/provider/capabilities.ts packages/opencode/src/provider/health.ts packages/opencode/src/provider/model-registry.ts packages/opencode/src/tool/registry.ts packages/opencode/src/project/bootstrap.ts` ✅
- `./webctl.sh dev-refresh` ✅
- Architecture Sync: Verified (Doc updated to remove antigravity from current runtime baseline and canonical family description). ✅
- 靜態搜尋確認 `packages/opencode/src/account/rotation3d.ts`、`packages/opencode/src/account/rate-limit-judge.ts` 中的 antigravity 直接引用已清除。✅
- `bunx eslint packages/opencode/src/account/rotation3d.ts packages/opencode/src/account/rate-limit-judge.ts` ✅
- `bunx tsc --noEmit -p packages/opencode/tsconfig.json`（quota/runtime follow-up 後複驗）✅
- `./webctl.sh dev-refresh`（quota/runtime follow-up 後複驗）✅
- Architecture Sync: Verified (No doc changes) — 本輪 quota/runtime follow-up 未改變 architecture baseline，只移除 runtime 依賴與 specialized backoff implementation。✅

## 5. 初步風險評估

1. **高風險**：直接刪掉 antigravity plugin import 可能造成 TUI prompt/admin typecheck 與 quota footer 大面積失敗。
2. **中風險**：直接刪 `/account` 的 `antigravity` payload 可能影響仍未清乾淨的 web/TUI consumer。
3. **低風險**：先移除 canonical list/UI visibility 已完成，不影響 `accounts.json`。

## 6. 建議移除順序

1. **先斷新入口**（已基本完成）
   - canonical provider list / web UI / TUI provider list 不再顯示 antigravity。
2. **再移除 backend route contract**
   - 讓 `/account` 不再回傳 `antigravity` rich payload。
   - 移除 `/account/antigravity/toggle`。
   - `POST /account/:family/active` 只走 `Account.setActive()` 通路。
3. **再移除 TUI prompt/admin plugin quota path**
   - 把 antigravity-specific quota footer 與 AccountManager 邏輯抽掉。
4. **最後移除 provider builder / plugin dead code**
   - 包含 provider registration、quota helper、storage helper、相關 docs/tests。
