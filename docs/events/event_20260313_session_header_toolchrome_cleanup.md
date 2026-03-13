## Requirements

- 收斂 web session header / layout sidebar 的工具列與浮層互動細節，移除一個在 header 中顯得多餘的 file search 入口，並簡化 review/context 控制的呈現。
- 保持 non-breaking：不改動後端 contract 或 session navigation route shape。

## Scope

### In

- `packages/app/src/components/session/session-header.tsx`
- `packages/app/src/pages/layout.tsx`
- `packages/app/src/pages/layout/sidebar-items.tsx`
- event ledger / validation

### Out

- file search backend behavior
- prompt footer autonomous contract
- session/server API contract

## Task List

- [x] 移除 header 左側 fallback file-search button
- [x] 簡化 review / file-pane 圖示呈現
- [x] 調整 context button styling 對齊 desktop active state
- [x] 調整 sidebar overlay z-index 與 session row action placeholder render
- [x] 補 event / validation

## Baseline

- session header 左側在沒有 subpage title 時會顯示一個額外的 file-search 按鈕，與既有 file search 入口重疊。
- review/file-pane toggle icon 依賴多層 icon hover/active 疊圖，視覺與維護成本都偏高。
- sidebar overlay z-index 與 session row action placeholder render 也存在局部工具列/浮層干擾問題。

## Changes

- `packages/app/src/components/session/session-header.tsx`
  - 移除左側 fallback file-search button 與相關未使用依賴
  - 將 mobile review / desktop file-pane icon 改為簡化 SVG 呈現
  - `SessionContextUsage` 補上 active button class 對齊 desktop tool chrome
- `packages/app/src/pages/layout.tsx`
  - 調整 desktop sidebar nav / overlay z-index，避免浮層與 nav 交疊異常
- `packages/app/src/pages/layout/sidebar-items.tsx`
  - `showActions()` 為 false 時不再渲染 placeholder dash，避免 row chrome 雜訊

## Decisions

1. file search 不需要在 session header 再保留一個額外 fallback button；既有對話/檔案相關入口已足夠。
2. 這組變更屬 UI chrome cleanup，不應與 autonomous contract 或 backend routing 綁在一起。

## Validation

- `bun x tsc --noEmit --project /home/pkcs12/projects/opencode/packages/app/tsconfig.json` ✅
- Architecture Sync: Verified (No doc changes)

## Next

- 若後續要重新引入 header 級全域搜尋入口，應另開明確 IA/UX 切片，而不是回到隱性 fallback button。
