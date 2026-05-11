# Event: session list delete auto-refresh

## 需求

- 修正 web session list 在 session 被刪除後仍停留舊資料、需要手動 reload 才會更新的缺口。

## 範圍(IN)

- 追查 session 刪除與 sidebar/session list 刷新之資料流。
- 補上對全域 session storage 變動的自動 refresh 機制。
- 驗證刪除後 web list 可自動更新。

## 範圍(OUT)

- 不修改 session storage schema。
- 不改 session delete 權限模型。
- 不處理與 session list 無關的其他 stale UI。

## 任務清單

- [x] 確認正常 `session.delete` 路徑與 web list 同步機制。
- [x] 確認 stale root cause 為直接刪除 storage 檔案、繞過 API 與 `session.deleted` SSE event。
- [x] 補上對全域 session storage 變動的自動 refresh 機制。
- [x] 驗證刪除後 web list 不必手動 reload。
- [ ] 記錄 architecture sync。

## Debug Checkpoints

- CP-1 `packages/app/src/context/global-sync.tsx`：確認 web session list 主要依賴 SSE reducer 與 `loadSessions()`，不是定時 polling。
- CP-2 `packages/app/src/context/global-sync/event-reducer.ts`：確認正常 `session.deleted` 事件會即時移除 store 中的 session。
- CP-3 `packages/opencode/src/server/routes/session.ts`：確認正常刪除路徑是 `DELETE /session/:sessionID`。
- CP-4 `packages/opencode/src/server/session-storage-watch.ts`：新增 storage watcher，將 out-of-band session storage 異動轉成 `global.disposed`，讓前端 queue.refresh 自動重抓。

## Key Decisions

- 不新增 polling/fallback；沿用既有 Bus + `global.disposed` + `GlobalSync.queue.refresh()` 路徑。
- watcher 掛在 per-user daemon app 啟動點，只監看 `Global.Path.data/storage/session` 的頂層 `ses_*` 變動。
- 以 debounce 150ms 合併 `.db` / `.db-wal` / 目錄刪除帶來的多次 fs event，避免多重 refresh。

## Validation

- `bun test packages/opencode/src/server/session-storage-watch.test.ts` passed.
- `bun test packages/opencode/test/server/global-session-list.test.ts` passed.
- `bun -e "import('./packages/opencode/src/server/app.ts').then(()=>console.log('app-import-ok'))"` passed.
- `bun x tsc -p tsconfig.json --noEmit` blocked by pre-existing syntax errors in `templates/skills/plan-builder/scripts/plan-rollback-refactor.ts`; unrelated to this change.

## Architecture Sync

- Synced：補記 webapp session list freshness 邊界，說明正常路徑依賴 session events；對 out-of-band storage mutation 由 daemon storage watcher 轉譯成 `global.disposed` 觸發 refresh。
