# Event: 20260209 Path Alias and URL Encoding RCA

Date: 2026-02-09
Status: Done
Author: Antigravity (Opencode Engineer)

## 1. 需求與症狀 (Symptoms)

- `edit` 工具在修改檔案後，LSP 頻繁回報無法解析 `@/` 路徑別名。
- 觀察到當檔案名稱包含特殊字元（如 `#`）時，此現象 100% 重現。

## 2. 根本原因分析 (RCA)

- **原因 1: tsconfig.json 配置不完整 (主要)**
  - 缺少 `baseUrl` 設定。雖然 Bun 能正確解析 `paths`，但 `typescript-language-server` 依賴 `baseUrl` 作為別名的基準目錄。
- **原因 2: LSP Root 定位不穩定**
  - 原本僅依賴鎖檔判定 Root。在 MonoRepo 或扁平化結構中，這可能導致 LSP 無法正確找到專案根目錄的 `tsconfig.json`。

## 3. 修復與驗證 (Resolution & Verification)

- [x] **修正 tsconfig.json**: 加入 `"baseUrl": "."`。
- [x] **優化 LSP Server 配置**:
  - 將 `tsconfig.json` 加入 `Typescript` 的 `NearestRoot` 目標。
  - 在初始化選項中顯式傳遞 `rootPath`。
- [x] **驗證結果**:
  - 建立了 `test_encoding#file.ts`。修復後，別名報錯消失，證明 `#` 字元不再干擾專案上下文判定。

## 4. 關鍵決策

- 優先使用 `tsconfig.json` 作為專案根目錄標記，這對 TypeScript 特化工具更具代表性。
