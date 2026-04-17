# Tasks

## 1. Phase 1 — Server-side 防線 (DONE 2026-04-17)

- [x] 1.1 audit webapp `/global/config` 錯誤渲染路徑（找到 bootstrap.ts:88 + client.gen.ts:211 + server-errors.ts:25-29 三個點）
- [x] 1.2 rewrite `JsonError` in [config.ts](../../packages/opencode/src/config/config.ts)：結構化 `{ path, message(短摘要), line, column, code, problemLine, hint }`；`buildJsoncParsePayload` helper 產出 payload + daemon-only debugSnippet
- [x] 1.3 integrate LKG snapshot：`$XDG_STATE_HOME/opencode/config-lkg.json` atomic write；`createState` 包 `createStateInner`，parse 失敗時讀 lkg + `log.warn` + `configStale: true`
- [x] 1.4 rewrite `onError` handler in [server/app.ts](../../packages/opencode/src/server/app.ts)：`Config.JsonError` / `InvalidError` / `ConfigDirectoryTypoError` → 503
- [x] 1.5 implement webapp ErrorBoundary：新增 `ConfigJsonError` type + `formatReadableConfigJsonError`；`formatServerError` 先判 JsonError；`truncate()` 500-char guard 防舊 daemon 回傳原文
- [x] 1.6+1.7 validate：`bun test packages/opencode/test/config/config.test.ts` 62 pass；`bun test packages/app/src/utils/server-errors.test.ts` 9 pass；新增 2 個 LKG tests + 1 個 webapp guard test
- [x] 1.8 docs/events/：[event_2026-04-17_config_crash.md](../../docs/events/event_2026-04-17_config_crash.md) 已寫入主 repo

## 2. Phase 2 — disabled_providers 衍生

- [ ] 2.1 delegate new module [provider/availability.ts](../../packages/opencode/src/provider/availability.ts)：`providerAvailability(id)` 回傳 `"enabled" | "disabled" | "no-account"`
- [ ] 2.2 integrate availability 進 provider catalog filter，替換原 `disabled_providers` 直讀邏輯
- [ ] 2.3 preserve 舊 `opencode.json.disabled_providers` 讀取作為 override 合併；boot 時 `log.info` 提示遷移
- [ ] 2.4 write `scripts/migrate-disabled-providers.ts` 支援 `--dry-run`；輸出「可刪 X 筆冗餘、保留 Y 筆真 override」
- [ ] 2.5 validate：`bun run scripts/migrate-disabled-providers.ts --dry-run` 列表檢查
- [ ] 2.6 validate：刪除 `disabled_providers` 後 `/provider` snapshot 與之前語意一致
- [ ] 2.7 validate：新增 / 移除 account → availability 自動更新

## 3. Phase 3 — 拆檔 providers.json / mcp.json

- [ ] 3.1 design `loadSplit(paths)` in [config.ts](../../packages/opencode/src/config/config.ts)：section-level try/catch、per-sub-file `JsonError`
- [ ] 3.2 integrate `providers.json` 載入：失敗走 lkg 或空集、`log.warn`
- [ ] 3.3 integrate `mcp.json` 載入（lazy，連線時才讀）：失敗停用 MCP subsystem、`log.warn`
- [ ] 3.4 preserve 舊單檔 `opencode.json` 格式讀取（向後相容一個 release cycle）
- [ ] 3.5 delegate `templates/opencode.json` / `templates/providers.json` / `templates/mcp.json` 新範本同步
- [ ] 3.6 delegate `scripts/migrate-config-split.ts`：讀舊單檔、拆 3 檔、寫 `.pre-split.bak`、支援 `--dry-run`
- [ ] 3.7 validate unit test：三檔存在時 merge 結果 = 舊單檔語意
- [ ] 3.8 validate：`mcp.json` 壞掉 → daemon boot 成功、主 UI 活、MCP 全 disable
- [ ] 3.9 validate：`providers.json` 壞掉 → daemon boot 成功、其他功能正常
- [ ] 3.10 sync [specs/architecture.md](../../specs/architecture.md) config subsystem 段落
- [ ] 3.11 sync [templates/AGENTS.md](../../templates/AGENTS.md) 與 [templates/prompts/SYSTEM.md](../../templates/prompts/SYSTEM.md)（若涉及）

## 4. Documentation / Retrospective

- [ ] 4.1 append `docs/events/` 每 Phase 完成節點條目
- [ ] 4.2 compare 實作結果 vs `proposal.md` 的 Effective Requirement Description
- [ ] 4.3 produce validation checklist：requirement 覆蓋、gap、deferred、evidence
