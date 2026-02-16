# Event: Antigravity Auth Update (v1.4.6 -> v1.5.1)

Date: 2026-02-12
Status: Done
Topic: origin_dev_antigravity_update

## 1. 需求分析 (Analysis)

檢查 `refs/opencode-antigravity-auth` 子模組狀態，發現已落後遠端 `origin/main` 數個版本。

- **Current Local**: v1.4.6 (`28f46c2`)
- **Remote Head**: v1.5.1 (`f7e0c50`)

### 關鍵變更 (Key Changes)

1.  **Dynamic Version Fetching (`src/plugin/version.ts`)**:
    - **Fix**: 不再依賴硬編碼的 `ANTIGRAVITY_VERSION`。
    - **Impact**: 解決因 Antigravity 後端更新導致的 "Version no longer supported" 錯誤。
    - **Note**: 新增 `setAntigravityVersion` 與 `getAntigravityVersion` 機制。

2.  **Account Verification Persistence**:
    - **Feature**: 記住帳戶是否需要驗證 (`verification-required`)。
    - **Impact**: 改善使用者體驗，減少重複驗證流程。

3.  **Linux Header Spoofing**:
    - **Change**: 移除 Linux 平台的 User-Agent 生成，改為偽裝成 MacOS/Windows。
    - **Risk Assessment**: 低風險。這是為了規避 Antigravity 對 Linux User-Agent 的潛在限制或指紋偵測。程式碼本身仍可在 Linux 運行 (Node.js)，僅是對外宣稱非 Linux。

4.  **Major Refactoring**:
    - `src/plugin.ts` 大幅重構 (+865 lines)，分離了大量邏輯。
    - `src/plugin/storage.ts` 改進了存儲邏輯。

## 2. 執行計畫 (Execution Plan)

目標：將 `refs/opencode-antigravity-auth` 的變更同步至 `packages/opencode/src/plugin/antigravity`。

- [x] **Step 1**: 更新子模組 (`git submodule update`)。
- [x] **Step 2**: 同步關鍵檔案 (Sync Files)。
  - `src/constants.ts` -> `packages/opencode/src/plugin/antigravity/constants.ts`
  - `src/plugin/version.ts` -> `packages/opencode/src/plugin/antigravity/plugin/version.ts` (New File)
  - `src/plugin/accounts.ts` -> `packages/opencode/src/plugin/antigravity/plugin/accounts.ts`
  - `src/plugin/storage.ts` -> `packages/opencode/src/plugin/antigravity/plugin/storage.ts`
  - `src/plugin/fingerprint.ts` -> `packages/opencode/src/plugin/antigravity/plugin/fingerprint.ts`
  - `src/plugin/ui/select.ts` -> `packages/opencode/src/plugin/antigravity/plugin/ui/select.ts`
  - **注意**: `src/plugin.ts` 需要小心合併，因為目標端是 `index.ts` 且結構可能不同。需手動檢查 `packages/opencode/src/plugin/antigravity/index.ts` 與 `refs/.../src/plugin.ts` 的差異。
- [x] **Step 3**: 修復引入路徑 (Fix Imports)。
  - 確保新檔案的 imports 對應到本地目錄結構。
- [x] **Step 4**: 驗證與測試 (Verification)。
  - 執行 `packages/opencode` 的相關測試。
  - 確認 Build 通過。

## 3. 實作細節 (Implementation Details)

- **Version Integration**: 在 `index.ts` 初始化時呼叫 `initAntigravityVersion()`。
- **Headers Logic**: 更新 `request.ts` 以移除 `X-Goog-Api-Client` 等 Headers，僅保留 `User-Agent` (Spoofing)。
- **Types Fix**: 補全 `types.ts` 缺失的導出成員，並修正 `PluginResult` 介面以支援擴展屬性。

## 4. 決策建議 (Recommendation)

**合併完成**。v1.5.1 的動態版本機制已整合。
