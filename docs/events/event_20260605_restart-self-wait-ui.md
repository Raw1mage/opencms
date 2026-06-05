# Restart Self Wait UI

## 需求

- 使用者指出 `system-manager_restart_self` 後前端/對話不應立刻繼續輸出大量文字，應進入等待重啟完成的狀態，避免 daemon self-terminate 時中斷訊息。

## 範圍

### IN

- 盤點現有 settings restart 等待 UI 與 direct tool restart 路徑。
- 讓 `restart_self` 工具結果可觸發前端 restart waiting 狀態。
- 同步 enablement / 架構文件與驗證紀錄。

### OUT

- 不改變 sanctioned restart endpoint 行為。
- 不新增 fallback restart 路徑。
- 不自行重啟 daemon 作為驗證。

## 任務清單

- [x] 讀取架構與定位 restart UI / tool 路徑。
- [x] 建立 XDG 白名單備份。
- [x] 實作 restart_self 等待 UI 訊號。
- [x] 驗證並同步架構文件。

## Debug Checkpoints

- CP-1 Architecture baseline: `specs/architecture.md` 記錄 controlled self-restart 透過 durable handover checkpoint，socket close 不可當成功訊號。
- CP-2 UI baseline: `packages/app/src/components/settings-general.tsx` 已有 settings restart waiting/recovery UI，`packages/app/src/context/restart-status.ts` 提供全域 restart status override。
- CP-3 Tool baseline: `packages/mcp/system-manager/src/index.ts` 的 `restart_self` 回傳純文字 scheduled 訊息，目前沒有可讓前端暫停/等待的 structured signal。
- CP-4 UI hook: `packages/app/src/pages/session.tsx` 偵測完成的 `system-manager_restart_self` tool part 且 output 包含 `restart_self scheduled` 後，啟動 restart wait footer 與 health polling。

## Key Decisions

- 不改 sanctioned restart endpoint；前端只在已經觀測到 tool result scheduled 訊號後進入 waiting/recovery。
- `packages/app/src/context/restart-status.ts` 集中提供 `beginRestartWait`，讓 settings restart 與 tool-triggered restart 可共享同一個全域 footer 狀態模型。
- 用 `sessionStorage` 記錄已處理的 tool part id，避免 reload 後重新掃到同一個 completed restart tool part 造成無限 reload。

## Verification

- XDG Backup: `/home/pkcs12/.config/opencode.bak-20260605-1949-restart-self-wait-ui/`。
- Diff hygiene: `git diff --check` passed。
- App TypeScript: `bun node_modules/typescript/bin/tsc -p packages/app/tsconfig.json --noEmit` passed。
- Typecheck script caveat: `bun run --cwd packages/app typecheck` still resolves to opencode CLI and exits 1 before TypeScript runs。
- Architecture Sync: Updated `specs/architecture.md` controlled self-restart section with frontend waiting / health polling / duplicate reload guard.
