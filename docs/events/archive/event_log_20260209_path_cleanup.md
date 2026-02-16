# Event: Legacy Path Deprecation and Environment Cleanup

Date: 2026-02-09
Status: Done

## 1. 需求分析

... (略)

## 2. 執行計畫

- [x] **移除判定邏輯**: 已修改 `src/installation/index.ts`。
- [x] **強化全域感知**: 已修改 `src/global/index.ts` 增加警告。
- [x] **驗證安裝腳本**: 執行 `bun run install` 成功遷移並刪除 `~/.opencode`。

## 3. 關鍵決策與發現

- 發現 `~/.opencode/bin/opencode` 會搶佔 PATH，已透過遷移邏輯將其封存。
- 為了安全性，`Global` 初始化保留了警告邏輯。

## 4. 遺留問題 (Pending Issues)

- 當前 shell session 的 PATH 變數需手動重整 (建議重啟終端機)。
