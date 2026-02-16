# Event: Antigravity Quota Group Sync (Cockpit → CMS)

Date: 2026-02-12
Status: Done

## 背景

使用者回報 cockpit plugin 對 Claude 系列用量顯示異常。經比對 submodule 更新後確認：
- Antigravity 實際上將 `Claude-*` 與 `GPT-OSS-*` 視為同一組共享 quota/cooldown。
- CMS `/admin` 與 fallback 路徑仍以「只含 claude 字串」判斷，造成口徑偏差。

## 本次同步範圍（最小變更）

1. 新增共用分組邏輯：`quota-group.ts`
   - 將 `claude` 與 `gpt-oss`（含 `MODEL_OPENAI_GPT_OSS_*`）統一映射到 `claude` quota group。
2. 套用到所有既有用量判斷入口：
   - `plugin/quota.ts`
   - `cli dialog-admin.tsx`
   - `cli prompt/index.tsx`
   - `account/rotation3d.ts`
3. 移除未使用中間檔（先前嘗試）：`quota-cache.ts`。

## 驗證

- `bun run typecheck` ✅

## 結果

- CMS admin panel 的用量顯示口徑與 cockpit 對齊。
- 當共享額度耗盡時，Claude/GPT-OSS 將一致反映 cooldown 狀態。
