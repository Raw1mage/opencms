# Changelog

OpenCMS 採日期分段的變更紀錄（無 semver release；建置版本形如 `0.0.0-main-<timestamp>`）。
詳細的根因／決策留痕見 [`docs/events/`](docs/events/)，issue 生命週期見 [`issues/`](issues/)。

## 2026-06-17

### Fixed

- **typed-args**：MCP / built-in 工具的 object / number / array 參數被當字串轉送，導致下游 schema 驗證 reject。根因在 provider-claude 的 ANTML-salvage 把每個 `<parameter>` body 一律當字串並 `JSON.stringify`;在 Active Loader（DD-21）下 off-wire 的 deferred 工具是多數路徑,故失敗率高。修復把 schema-aware coercion 抽成共用 `tool/coerce-args.ts`（`CoerceArgs`),在 MCP execute chokepoint 與 `session/llm.ts` 兩個 seam（lazy-unlock + activeHit re-run）統一套用;保守設計,只 re-type schema 宣告為具體非字串型別且 parse 後型別相符的欄位。測試 25 cases 全綠。（`3c4b26bcb`,接續 `795f35178`;留痕 `docs/events/fix_20260617_typed_args_coercion_universal_seam.md`）
- **tool-loader**：`tool_loader` 在 Active Loader 架構下的成功訊息誤導（宣稱「available next action」）。改為誠實訊息並把該工具定位為相容性 shim。（`93cb098d3`）
- **task**：per-jobId auto-resume 冪等性,修掉 subagent double-turn。（`145965979`）

### Changed

- **compaction**：撤回當日的 size-only Rule 1,還原 claude cold-gated 200K+ 觸發（`c2dec8405`）。相關的 cold B-gate work-state issue（`bug_20260616`）因 size-trigger 方案已 revert、C-tail fix 未落地,依決策結案為 won't-fix/superseded;其衍生的 stream-swallow 與 dropped-user-turn 兩軸分別由獨立 issue 追蹤與 `d852214c0` 修復。

## 更早

更早的變更請見 git 歷史與 [`docs/events/`](docs/events/)。
