# Event: 2026-02-16 Enable debug.log only in dev

Date: 2026-02-16
Status: Done

## 1. 需求分析

- [x] `bun run dev` 期間啟用 `debug.log`
- [x] 打包成 binary `opencode` 時預設不產生 `debug.log`

## 2. 執行計畫

- [x] 在 debug logger 寫入前加上開關檢查
- [x] 於 `dev` script 設定環境變數啟用

## 3. 關鍵決策與發現

- 新增 `OPENCODE_DEBUG_LOG=1` 作為 debug.log 開關。
- `debugCheckpoint` / `debugSpan` / `debugInit` 全面受開關控制。
- `bun run dev` 透過 script 設定開關，binary 預設不設，故不記錄。

## 4. 遺留問題 (Pending Issues)

- 無
