# Tasks: codex-c-library-removal

## 1. Pre-check

- [ ] 1.1 `git ls-files packages/opencode-codex-provider/` 列出所有 tracked 檔案，確認 `.c` / `.h` / `CMakeLists.txt` 哪些是 tracked
- [ ] 1.2 `grep -r "codex_provider\.so\|libcodex_provider\|codex-native" --include="*.ts" --include="*.js" --include="*.json" --include="*.yml" --include="*.yaml"` 全 repo 掃，確認無任何消費者
- [ ] 1.3 檢查 CI config (`.github/workflows/*`、`package.json` scripts) 是否呼叫 `cmake` / `make` / `codex_provider.so`

## 2. Delete

- [ ] 2.1 `git rm packages/opencode-codex-provider/src/{auth,jwt,main,originator,provider,quota,storage,stream,transform,transport}.c`
- [ ] 2.2 `git rm packages/opencode-codex-provider/include/codex_provider.h`（若 tracked）或 `rm -rf include/`
- [ ] 2.3 `git rm packages/opencode-codex-provider/CMakeLists.txt`
- [ ] 2.4 `rm -rf packages/opencode-codex-provider/build/`（untracked artifact）
- [ ] 2.5 `.gitignore` 調整：移除僅為 C build 存在的 entries

## 3. Verify

- [ ] 3.1 `bun install`（or workspace equivalent）成功
- [ ] 3.2 `bun run typecheck`（或 `tsc --noEmit`）成功
- [ ] 3.3 `bun test packages/opencode-codex-provider/` 測試全綠
- [ ] 3.4 `./webctl.sh dev-refresh` 後 smoke test 一個 codex 請求（非 429 路徑亦可，確認無載入錯誤）

## 4. Doc sync

- [ ] 4.1 `specs/codex/provider_runtime/design.md`：若有提到 C library 或 native FFI，補「codex provider 純 TS、C library 已於 2026-04-18 移除（revision/2026-04-18_codex-c-library-removal）」
- [ ] 4.2 `plans/codex-refactor/plan.md` 若有 C library 相關 task，標記為已完成或已取消
- [ ] 4.3 `docs/events/event_2026-04-18_codex_c_library_removal.md` 記錄刪檔清單與前後行為差異

## 5. Close

- [ ] 5.1 Beta worktree commit + push；主線 fetch-back
- [ ] 5.2 刪除 beta branch
