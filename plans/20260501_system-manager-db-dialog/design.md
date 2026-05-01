# Design

## Goal

讓 system-manager session 相關 tool 的 dialog 讀取行為與目前 DB-backed session persistence 對齊。

## Baseline checkpoints

- Baseline: 使用者指出 session 已全面改 DB，但 system-manager tool 仍需重構 dialog 讀取。
- Instrumentation plan: 先讀 DB session/message repository、server session route、system-manager session tool 實作與測試，確認目前資料邊界與輸出格式。
- Root cause target: 若 tool 仍讀舊 storage/filesystem/session transcript，改為呼叫 DB-backed session/message API。
- Validation: focused `packages/mcp/system-manager` tests，加上必要 typecheck/test。

## Decisions

- DD-1: DB-backed session/message repository 為 dialog read SSOT；禁止新增 filesystem fallback。
- DD-2: 保持 system-manager tool 對外 schema/參數相容，僅替換內部讀取來源。
