# Event: 2026-02-12 TS Ignore Cleanup

Date: 2026-02-12
Status: Done

## 1. 需求分析
- 目標：清理 `packages/` 目錄下的 `@ts-ignore` 標註。
- 原因：`@ts-ignore` 隱藏了所有型別錯誤，可能掩蓋潛在 bug。
- 策略：替換為 `@ts-expect-error` 並加上具體原因，或修復型別問題。

## 2. 執行計畫
- [x] 掃描所有 `@ts-ignore` 出現位置。
- [x] **Core/Backend Fixes**:
  - `packages/console/function/src/auth.ts`: 標註 KVNamespace 與 OpenAuth interface 差異。
  - `packages/console/resource/resource.node.ts`: 標註 SST 資源的動態屬性存取。
  - `packages/console/core/src/user.ts`: 標註 JSX Email render 型別問題。
- [x] **Frontend/UI Fixes**:
  - `packages/app/**/*.tsx`: 標註 SolidJS `use:sortable` directive 型別問題。
  - `packages/ui/src/components/select.tsx`: 標註 Kobalte Select 泛型推斷問題。
- [x] **SDK/Script Fixes**:
  - `packages/sdk/js/src/**/client.ts`: 標註 Bun/Node fetch 的 timeout 擴充。
  - `packages/app/**/use-session-backfill.test.ts`: 標註測試環境缺少的 `requestIdleCallback`。
  - `packages/plugin/script/publish.ts`: 標註對唯讀 JSON import 的修改。
- [x] 驗證：執行 `bun run typecheck` 確保無 regression。

## 3. 關鍵決策
- 對於涉及第三方函式庫定義不全 (SolidJS directives, Kobalte generics, OpenAuth) 的情況，優先使用 `@ts-expect-error` 並附上註解，而非強制轉型 `as any`，以保留未來的修復機會（當 library 升級修復型別後，TS 會提示 unused directive）。
- 保持 `packages/console/resource/resource.node.ts` 的 Proxy 結構，僅對動態屬性存取做 expect-error。

## 4. 遺留問題
- 無。所有目標 `@ts-ignore` 皆已處理。
