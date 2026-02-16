# Event: 2026-02-13 Fix Admin Panel Model Activities TUI Truncation

Date: 2026-02-13
Status: Done

## 1. 需求分析

- [x] 修復 admin panel 中 Model Activities 列表最右側文字被裁切的問題
- [x] 分析 TUI 寬度計算邏輯與 padding 設定

## 2. 執行計畫

- [x] 定位 `dialog-admin.tsx` 中的寬度計算邏輯 (Done)
- [x] 分析 `dialog-select.tsx` 中的實際渲染 padding (Done)
- [x] 修正寬度 buffer 值 (Done)

## 3. 關鍵決策與發現

- 發現 `dialog-admin.tsx` 計算 `desired` 寬度時僅預留 8 字元 buffer (`baseWidth + 8`)
- 檢查 `dialog-select.tsx` 發現實際 padding 累加超過 8：
  - Scrollbox padding-left: 1
  - Row padding-left: 3
  - Row padding-right: 4
  - Option text padding-left: 3
  - 合計約 11 字元
- 決定將 buffer 增加至 12 以確保足夠空間

## 4. 遺留問題 (Pending Issues)

- 無
