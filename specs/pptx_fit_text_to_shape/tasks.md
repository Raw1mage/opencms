# Tasks: pptx_fit_text_to_shape

> Canonical execution checklist. Checkbox notation：`[ ]` pending · `[~]` in_progress · `[x]` done · `[!]` blocked · `[?]` decision · `[-]` cancelled。

## 1. 求解器核心（主修 A 基礎）

- [x] 1.1 讀 `_pptx_layout_lint.py` 確認可共用的純函式介面：`_estimate_text_height_in` / `_insets_in` / `_visual_width_em` / `Thresholds` / geometry 解析鏈（`_resolve_geometry`/`_ph_geometry_index`/`_layout_for_slide`/`_master_for_layout`/`_master_txstyle_sizes`/`_slide_size_in`）
- [x] 1.2 新增 `bin/_pptx_fit_solver.py`：`solve_fit(box_w_in, box_h_in, title_paras, desc_paras, *, title_cap=18, desc_cap=13, floor=9, ratio=1.30, overflow_tol=0.2, line_factor=1.2, insets=None) -> FitResult`，import lint 度量函式，**不自寫高度估算**（DD-1）
- [x] 1.3 實作下掃求解（DD-2）：desc_pt 從 desc_cap→floor，每級用 `_estimate_text_height_in` 合計 title@title_pt+desc@desc_pt 總高，取首個 ≤ box_h*(1+tol) 的值；title_pt=min(round(d*ratio),title_cap)
- [x] 1.4 實作 `limited_by` 歸因（DD-4）+ overflow 誠實標記（DD-5）：採用 pt==cap→"cap"；pt+1 反事實溢出主因為寬度 wrap→"width"，否則→"height"；floor 仍溢出→overflow=true
- [x] 1.5 單元測試 `tests/test_pptx_fit_solver.py`：TV1/TV2/TV5/TV6（solver-unit 向量）

## 2. pptx_fit_text CLI + 接線（主修 A 完成）

- [x] 2.1 讀 `_pptx_surgery.py` 的 `set_shape_text` 寫回路徑 + `coerce_cli_text`，確認 role/sz 寫入機制（R-1）
- [x] 2.2 新增 `bin/pptx_fit_text.py` CLI：解析 doc_dir/index/shape_id/caps → 用 lint geometry 解析鏈取 box + 段落（依 role 分 title/desc）→ 呼叫 solve_fit → 寫回 sz → emit envelope（含 limited_by/overflow）
- [x] 2.3 geometry 無法解析時 fail-fast 報錯（R-3，不亂猜）
- [x] 2.4 真檔 e2e 冒煙：對一個已知大框小字 shape 跑 pptx_fit_text → `pptx_layout_lint` ready=true（TV1 的 then_lint）

## 3. set_text fit 參數（主修 B）

- [x] 3.1 `pptx_revise_set_text.py` / 對應 set_text CLI 加 `--fit`（值 shape）；`_pptx_surgery.set_shape_text` 或 wrapper 支援 fit 分支
- [x] 3.2 fit="shape" → 忽略傳入 size、呼叫同一 solve_fit（DD-3 雙入口共用）
- [x] 3.3 fit=None → 完全走現行明確-size 路徑（DD-7 byte 相容）
- [x] 3.4 batch set_text（`pptx_revise_batch.py` / `pptx_edit_batch.py`）op 支援 fit 欄位
- [x] 3.5 測試 TV3（雙入口一致）+ TV4（不帶 fit byte 相容，不回歸）

## 4. MCP 註冊

- [x] 4.1 `_mcp_registry.py` 註冊 `pptx_fit_text` 動作 + JSON schema（doc_dir/index/shape_id/title_cap/desc_cap/floor/ratio）
- [x] 4.2 `_mcp_registry.py` 為 `pptx_revise`/`set_text` 系 schema 加 `fit` 參數（enum: shape | null，預設 null）
- [x] 4.3 確認 `mcp_server.py` envelope 正確帶出 fit 結果（limited_by/overflow）

## 5. 驗證與收尾

- [x] 5.1 跑全 pptx 測試套件確認無回歸（既有 set_text/layout_lint 測試）
- [x] 5.2 grep 確認 solver import 自 `_pptx_layout_lint`（無平行度量實作，Acceptance §4）
- [x] 5.3 同步 `specs/architecture.md` pptx authoring 段落（求解器↔lint 度量共用關係）
- [x] 5.4 event log 收尾紀錄（Key Decisions / Verification / Remaining）
- [x] 5.5 issue `fr_20260621_pptx_fit_text_to_shape_size.md` 移到 `issues/closed/`
