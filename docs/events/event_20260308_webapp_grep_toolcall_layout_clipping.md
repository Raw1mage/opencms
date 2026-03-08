# Event: webapp grep toolcall layout clipping

Date: 2026-03-08
Status: Completed

## 需求

- 修正 webapp session feed 中 grep toolcall 的 trigger 文字顯示異常。
- 避免長 pattern / include / path 文字被擠成兩行後超出框外並遭裁切。

## 範圍 (IN / OUT)

### IN

- `packages/ui/src/components/basic-tool.css`
- `packages/ui/src/components/message-part.tsx`
- 必要的 event / validation 記錄

### OUT

- grep tool 的後端輸出格式
- bash / glob / list 的語意變更
- 非 toolcall 區塊的 session feed 排版重構

## 任務清單

- [x] 檢查 grep toolcall trigger 與輸出區塊的實際樣式路徑
- [x] 建立最小 CSS 修正，避免文字裁切
- [x] 驗證 grep toolcall 在長文字下的顯示結果
- [x] 確認 `docs/ARCHITECTURE.md` 是否需要同步

## Debug Checkpoints

### Baseline

- 症狀：webapp 中 grep toolcall 的 trigger 文字會被擠壓，偶爾形成兩行但下半部超出框外被裁掉。
- 懷疑點：`BasicTool` trigger 使用單列 flex 佈局，`subtitle` 與 `arg` 對長文字的處理不一致；`info-main` 同時設有 `overflow: hidden`，可能造成多行內容在壓縮時被截斷。

### Execution

- 確認 webapp toolcall trigger 由 `packages/ui/src/components/message-part.tsx` 的 `grep` renderer 與 `packages/ui/src/components/basic-tool.css` 共同控制。
- 根因為 grep trigger 會塞入較長的 `path` / `pattern` / `include` 文字，但 `BasicTool` 預設為單列壓縮布局；在文字被擠成多行時，內容容易在 `overflow: hidden` 的 flex 容器中出現視覺裁切。
- 採最小修正：只對 grep trigger 加入 `wrap-friendly` / `wrap-layout` class，讓 grep 的 subtitle / args 可以斷行，且只有 grep 會切換成可換行的 trigger 佈局；其餘 toolcall 保持原樣。

### Validation

- 驗證指令：`bun turbo typecheck --filter @opencode-ai/ui --filter @opencode-ai/app`
- 結果：passed
- 補充檢查：已確認 `wrap-layout` 僅由 grep renderer 掛載，避免把一般 tool trigger 一起改成多行布局。
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅修正前端 tool trigger CSS 顯示，不涉及架構邊界、資料流、API contract 或 runtime 模組責任。
