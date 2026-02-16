# Event: XDG Path Cleanup and Legacy Path Prevention

Date: 2026-02-09
Status: Done

## 1. 需求分析

- [ ] 修正 Antigravity 插件中的硬編碼絕對路徑 `"/home/pkcs12/opencode/logs/debug.log"`。
- [ ] 修正 `getProjectConfigPath` 以防止在 `$HOME` 下誤用 `.opencode`。
- [ ] 增強 `Config.installDependencies` 的防禦邏輯。
- [ ] 掃描並清理其餘 `join(..., ".opencode", ...)` 的硬編碼邏輯。

## 2. 執行計畫

- [x] 修正 `src/plugin/antigravity/plugin/debug.ts` (Done: Yes)
- [x] 修正 `src/plugin/antigravity/plugin/config/loader.ts` (Done: Yes)
- [x] 修正 `src/config/config.ts` (Done: Yes)
- [x] 執行全域掃描 (Done: Yes)

## 3. 關鍵決策與發現

- 發現 `src/plugin/antigravity/plugin/debug.ts` 含有特定開發環境的絕對路徑。
- `Config.installDependencies` 對 legacy 路徑的判定邏輯仍有優化空間。

## 4. 遺留問題 (Pending Issues)

- 無
