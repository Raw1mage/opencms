# Event: set webapp default locale/theme

Date: 2026-03-02
Status: Done

## 需求

- WebApp 預設語言改為「繁體中文」。
- WebApp 預設配色改為「深色」。

## 範圍 (IN/OUT)

### IN

- 調整 app 語言初始化 fallback default。
- 調整 UI theme context 首次啟動的 color scheme default。

### OUT

- 不覆寫已存在的使用者 localStorage 設定。
- 不變更主題 token 或主題清單內容。

## 任務清單

- [x] `packages/app/src/context/language.tsx` 預設 locale 改為 `zht`
- [x] `packages/ui/src/theme/context.tsx` 預設 scheme 改為 `dark`
- [x] 驗證編譯流程可通過

## Debug Checkpoints

### Baseline

- 語言 fallback 預設為 `en`。
- theme scheme 預設為 `system`（跟隨 OS）。

### Execution

- 將 `detectLocale()` 的無匹配 fallback 與 SSR fallback 改為 `zht`。
- 將 theme store 初始值改為 `colorScheme: "dark"`、`mode: "dark"`。

### Validation

- 既有 localStorage 偏好仍優先於預設值。
- 首次使用（無偏好）時，語言為繁中、配色為深色。
