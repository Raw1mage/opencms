# Event: specs major-layer GRAFCET SVG generation

## 需求

- 接續前一個 session，補齊 `/specs/` 中每一層主要 GRAFCET SVG。

## 範圍(IN)

- 檢查 `specs/architecture.md` 的 chapter index 與現有 `specs/*/grafcet.json`。
- 以現有 GRAFCET JSON 為來源產生主要層級 SVG。
- 保留現有 IDEF0/GRAFCET traceability，不改 runtime code。

## 範圍(OUT)

- 不重寫 GRAFCET 流程語意。
- 不修改 drawmiat renderer。
- 不啟動或重啟 opencode daemon/gateway。

## 任務清單

- [x] 盤點 `specs/architecture.md` 與章節清單。
- [x] 產生/補齊主要層級 GRAFCET SVG。
- [x] 驗證輸出檔案存在且來源可追溯。
- [x] 記錄 Architecture Sync 結果。

## Debug / Evidence Checkpoints

- `specs/architecture.md` chapter index 指向 11 個 chapter：account、app-market、attachments、compaction、daemon、harness、mcp、meta、provider、session、webapp。
- `docs/events/event_20260221_miatdiagram_hierarchy_rules_update.md` 要求 GRAFCET 透過 `ModuleRef` 對應 IDEF0 hierarchy。
- `templates/skills/miatdiagram/references/drawmiat_format_profile.md` 記錄 GRAFCET root 為 Step array，`ModuleRef` 為 traceability extension。
- 使用者追加要求排除 `archive`；產生器明確跳過 `specs/archive/`。
- 使用者指出必須使用 drawmiat 的 `grafcet_renderer.py`；已將產生器改為匯入 `/home/pkcs12/projects/drawmiat/webapp/grafcet_renderer.py` 的 `GrafcetRenderer.render()`，並重畫 11 個 `specs/<chapter>/<chapter>-grafcet.svg` 頂層圖。
- 使用者要求繪製 `harness` debug 版；先透過 drawmiat MCP 產生後，使用者修正為必須直接使用正式 SSOT 執行鏈。已在 `/home/pkcs12/projects/drawmiat/webapp/service.py`、`grafcet_cli.py`、`mcp_tools.py` 接上 `debug_gaps`，讓正式 CLI 與 MCP 都能輸出 `diagram.debug.svg`。
- 使用者指出 step 9 output detour 穿透 `converge:11` 並產生錯誤 dogleg。追查後確認 L3 原始 route 安全，但 L5 compaction 將 `edge:T15:source-gate` 壓縮後造成新 `edge_crosses_box`；已在 `/home/pkcs12/projects/drawmiat/webapp/grafcet_renderer.py` 補上 L5 post-projection detour repair，並修正 downward detour entry lane 不得越過 blocker。

## Key Decisions

- 以現有 `specs/*/grafcet.json` 作為來源，不從程式碼重新推導流程。
- 頂層 `specs/<chapter>/<chapter>-grafcet.svg` 一律由 drawmiat `GrafcetRenderer.render()` 產生，不使用自製 SVG renderer。

## Validation

- `python3 scripts/generate-spec-grafcet-layers.py`：`{"total": 11, "ok": 11, "error": 0}`。
- Top-level XML validation：`top_level_svgs=11`、`invalid=0`，列出的檔案不含 `specs/archive/`。
- Harness debug SVG validation：正式 CLI `grafcet_cli.py ... --debug-gaps` 產生 `diagram.svg` 與 `diagram.debug.svg`，XML parse 通過；正式 service `generate_svg('grafcet', ..., debug_gaps=True)` 產生 `diagram.svg` 與 `diagram.debug.svg`，XML parse 通過；`PYTHONPYCACHEPREFIX=/tmp/drawmiat-pycache python3 -m py_compile service.py grafcet_cli.py mcp_tools.py` 通過。
- L5 detour fix validation：`edge:T15:source-gate` 最終 route 變為 `(20,57)->(20,58)->(34.45,58)->(34.45,67.62)->(20,67.62)->(20,74)`；repair diagnostics 為空；正式 CLI 重畫 `specs/harness/harness-grafcet.svg` 與 `specs/harness/harness-grafcet.debug.svg`，XML parse 通過。
- Architecture Sync: Verified (No doc changes) — 本次只補齊 specs 圖檔與可重跑產生器，不改 runtime module boundary、資料流、狀態機或 architecture chapter index。
