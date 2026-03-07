# Event: tui message meta footer simplification

Date: 2026-03-07
Status: In Progress

## 需求

- 移除 TUI 對話框頂部 assistant meta 中冗餘的 `Build · modelID` 顯示
- 將 elapsed time 從對話框上方移到 prompt/footer 提示列，與 command hint 同行顯示
- 移除 prompt 輸入框上方殘留的 `□ Build` 列
- 壓縮 prompt hint 與底部 footer 之間的垂直空白
- 保持 TUI-first 驗證，不擴大到 web UI

## 範圍

### IN

- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`

### OUT

- 不修改 web session UI
- 不修改 transcript export 格式
- 不改動 agent / model footer 本身既有顯示內容

## 任務清單

- [x] 建立 TUI meta/footer event
- [ ] 盤點頂部 meta 與 footer hint 的來源
- [ ] 落地顯示調整
- [ ] 驗證並 commit

## Debug Checkpoints

### Baseline

- assistant message block 頂部目前顯示 `mode · modelID · elapsed`。
- prompt/footer 區已經顯示 agent 與 model，因此 `Build` / `gpt-5.4` 在對話框頂部屬重複資訊。
- 需求是保留 elapsed，但把它移到 prompt/footer hint 同一行，降低訊息頭部噪音。

### Execution

- Removed redundant assistant header metadata (`modelID` + elapsed) from the session message block, keeping only the mode label and interruption marker.
- Added footer-level elapsed rendering in the prompt hint row, next to the existing command hint, derived from the latest assistant message timing and refreshed via the existing footer tick cadence.
- Removed the extra prompt metadata strip that rendered `□ Build` / `□ Shell` above the input box.
- Removed the decorative one-line spacer between the prompt hint row and the global footer so the bottom area uses terminal space more tightly.

### Validation

- `bun run typecheck` passed in `/home/pkcs12/projects/opencode` (`Tasks: 16 successful, 16 total`).
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪僅調整 TUI message meta 與 prompt/footer 呈現位置，不改動 runtime architecture 邊界。
- Follow-up validation after removing the extra `□ Build` strip and spacer line also passed via `bun run typecheck` (`Tasks: 16 successful, 16 total`).
