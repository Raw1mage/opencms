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
- 使用者指出多次 L5/grouping 嘗試導致畫面回歸、錯誤更多。已按使用者選擇恢復策略：`/home/pkcs12/projects/drawmiat/webapp/grafcet_renderer.py` 回到 HEAD，保留正式 `debug_gaps` CLI/service/MCP 入口，L5 routing/grouping/remap 問題暫不宣稱已修。
- 使用者指出恢復 baseline 後 step 9 output 又跨越 step 8 junction。追查確認 L3 route 不跨 junction；L5 的 `route_starts_at_branch_junction()` 以整段 horizontal span overlap 誤判為 branch-junction route，將 unrelated output lane remap 到 junction 高度。已改為只接受 source metadata match 或 horizontal endpoint 接觸 junction。
- 使用者要求保留目前 80% good 狀態、刪除所有 debug SVG，並將 11 個 `specs/<chapter>/grafcet.json` 以正式 drawmiat CLI 重繪為 `specs/<chapter>/<chapter>_grafcet.svg`。
- 使用者指出 `6G0` 是 L1 預留 join 空間，不是 L5 可見幾何；原始 `grafcet.json` 已以 `LinkInputType=["convergence_or"]` 表示 step 4/5/13 收斂到 step 6，真實 join 是 `gate:converge:6`。已移除 input_join reservation 對 L5 occupied/inventory/dense slots 的影響，並修復 `group.append()` 不可達，使 T6/T7 可按 X 不重疊合組/同高壓縮。

## Key Decisions

- 以現有 `specs/*/grafcet.json` 作為來源，不從程式碼重新推導流程。
- 頂層 `specs/<chapter>/<chapter>-grafcet.svg` 一律由 drawmiat `GrafcetRenderer.render()` 產生，不使用自製 SVG renderer。

## Validation

- `python3 scripts/generate-spec-grafcet-layers.py`：`{"total": 11, "ok": 11, "error": 0}`。
- Top-level XML validation：`top_level_svgs=11`、`invalid=0`，列出的檔案不含 `specs/archive/`。
- Harness debug SVG validation：正式 CLI `grafcet_cli.py ... --debug-gaps` 產生 `diagram.svg` 與 `diagram.debug.svg`，XML parse 通過；正式 service `generate_svg('grafcet', ..., debug_gaps=True)` 產生 `diagram.svg` 與 `diagram.debug.svg`，XML parse 通過；`PYTHONPYCACHEPREFIX=/tmp/drawmiat-pycache python3 -m py_compile service.py grafcet_cli.py mcp_tools.py` 通過。
- Renderer baseline restore validation：`git restore -- webapp/grafcet_renderer.py` 後，drawmiat 只保留 `grafcet_cli.py`、`service.py`、`mcp_tools.py` 的 debug-gaps 入口變更；`py_compile` 通過；正式 CLI 使用 restored renderer 重畫 `specs/harness/harness-grafcet.svg` 與 `specs/harness/harness-grafcet.debug.svg`，XML parse 通過，仍回報既有 `GRAF_LAYOUT_VIOLATION` warning。
- Junction grouping fix validation：`edge:T15:source-gate` L3 route `(20,77)->(20,80)->(34.45,80)->...`；L5 修正後 route `(20,59)->(20,63)->(34.45,63)->...`，不再與 `branch_junction:8` 的 y=61 同高；正式 CLI 重畫 `specs/harness/harness-grafcet.svg` 與 `specs/harness/harness-grafcet.debug.svg`，XML parse 通過且無 GRAF_LAYOUT_VIOLATION warning。
- Underscore SVG redraw validation：`debug_after=0`；11 個非 archive chapter targets 全存在；`specs/*/*_grafcet.svg` 對應 chapter SVG XML parse 通過。
- L5 phantom input_join validation：gap 4 inventory 不再包含 `input_join 6`；T6/T7 L5 route 均到 y=39；`harness_grafcet.debug.svg` 以正式 CLI 重畫，XML parse 通過。
- Architecture Sync: Verified (No doc changes) — 本次只補齊 specs 圖檔與可重跑產生器，不改 runtime module boundary、資料流、狀態機或 architecture chapter index。
