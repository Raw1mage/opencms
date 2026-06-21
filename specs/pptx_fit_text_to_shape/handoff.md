# Handoff: pptx_fit_text_to_shape

## Execution Contract

實作者在 **docxmcp repo**（`/home/pkcs12/projects/docxmcp`）動工。所有 OOXML / 字級求解邏輯一律在 `bin/` 內實作，禁止 caller-side 手算或手改 part（repo 紅線）。求解器**必須 import 並呼叫** `_pptx_layout_lint.py` 的度量函式，不得自寫平行高度估算（這正是本 FR 要消滅的漂移源）。

## Required Reads

動工前必讀：

1. `bin/_pptx_layout_lint.py` — 度量核心：`_estimate_text_height_in`（行 204）、`_insets_in`、`_visual_width_em`、`Thresholds`、geometry 解析鏈（`_resolve_geometry`/`_ph_geometry_index`/`_layout_for_slide`/`_master_for_layout`/`_master_txstyle_sizes`/`_slide_size_in`/`_effective_font_pt`）。
2. `bin/pptx_revise_set_text.py` + `bin/_pptx_surgery.py`（`set_shape_text`、`coerce_cli_text`、`min_font_pt` clamp）— 寫回 sz 的既有路徑（DD-6，R-1）。
3. `bin/_mcp_registry.py` 行 1601 附近 — pptx_layout_lint 的參數 schema 範式，pptx_fit_text 註冊比照。
4. 本 package：`design.md`（DD-1..DD-7 + Solver Taxonomy）、`spec.md`（GIVEN/WHEN/THEN）、`test-vectors.json`、`data-schema.json`。

## Stop Gates In Force

必停回報：

- **G1 寫回路徑分歧**：若 `set_shape_text` 的 role/sz 寫入機制與 design 假設（title/desc role 段落）不符，停下回報，不硬接。
- **G2 度量函式不可直接共用**：若 `_estimate_text_height_in` 無法在不改其偵測行為下被求解器 import（例如有副作用），停下回報，提重構方案再續。
- **G3 byte 相容破壞**：若 set_text 加 fit 參數導致不帶 fit 的既有測試 byte 變動，停下，不得犧牲 byte 相容。
- **G4 commit**：commit 前需確認 tasks.md checkbox 同步 + 測試綠 + architecture sync。commit 本身需使用者批准（預設不自動 commit）。

## Execution-Ready Checklist

- [x] proposal/spec/design 對齊 FR 全文
- [x] 求解器 taxonomy 明確（輸入/輸出/運算/完成判準）— design.md
- [x] data-schema + test-vectors 涵蓋 FR §5 五項 + 框太小 + 無幾何 fail-fast
- [x] idef0/grafcet/sequence baseline（drawmiat 驗證通過）
- [x] tasks.md 分 5 階段，切片可執行
- [ ] 動工（implementing phase 1：求解器核心）

## Phase 順序

1. 求解器核心（純函式，可獨立單測）— 風險最低，先做
2. pptx_fit_text CLI + 接線 + 真檔 e2e
3. set_text fit 參數（雙入口共用 + byte 相容）
4. MCP 註冊
5. 驗證與收尾（含 architecture sync + issue 歸檔）

## Validation Plan

- 單元：`tests/test_pptx_fit_solver.py`（TV1/TV2/TV5/TV6）。
- e2e：真檔跑 pptx_fit_text → `pptx_layout_lint` ready=true（TV1 then_lint、TV3 雙入口一致、TV4 byte 相容、TV7 fail-fast）。
- 回歸：全 pptx 測試套件無回歸。
- 度量一致性 grep：solver 確實 import 自 `_pptx_layout_lint`。
