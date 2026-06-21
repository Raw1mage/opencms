# Design: pptx_fit_text_to_shape

## Context

`pptx_layout_lint`（`bin/_pptx_layout_lint.py`）是「偵測溢出」的 oracle。它的度量核心是純函式 `_estimate_text_height_in(paragraphs, box_w, box_h, font_pt, insets, line_factor) -> (needed_in, lines)`，配合 `_insets_in(node)`、`_visual_width_em(text)`、`Thresholds(overflow_tol=0.2, line_factor=1.2)`。

本 spec 補上它的**逆運算**：給定框 w/h + 文字，求「撐滿框高且不寬度超界的最大字級」。關鍵在於**共用同一個 `_estimate_text_height_in`**——求解器產出的字級，丟回 lint 定義上一定 ready。

## Goals / Non-Goals

### Goals
- 求解器與 lint 共用度量（單一真實來源），零來回。
- 支援 title/desc 雙角色，依比例分別求解。
- `limited_by` 邊界誠實（width / height / cap），不 silent fallback。
- 兩入口（`pptx_fit_text` 動作、`set_text fit="shape"`）共用同一求解器。
- byte 相容：`set_text` 不帶 `fit` 行為不變。

### Non-Goals
- 不複製一份平行度量邏輯。
- 不動 geometry（只調字級）。
- 不改 lint 的偵測門檻常數。

## Decisions

- **DD-1**: 求解器**呼叫 lint 的 `_estimate_text_height_in`**，不自寫高度估算。這是 FR 的核心訴求（消滅度量漂移）。實作上把該函式與 `_insets_in`/`_visual_width_em`/`Thresholds` 視為 `_pptx_layout_lint.py` 的公開介面（已是模組級函式，直接 import 即可，無需重構）。
- **DD-2**: 求解策略 = **整數 pt 線性下掃 / 二分搜尋**。字級候選域 `[floor, cap]`（整數 pt）。對每個候選 pt 呼叫 `_estimate_text_height_in`，找「最大的 pt 使 needed_in <= box_h*(1+overflow_tol) 且該 pt 下無段落寬度超界」。整數域小（通常 9..18），可直接線性下掃求穩；二分為可選優化。
- **DD-3**: **title/desc 雙角色**。輸入文字以 `role` 區分（沿用既有 multi-run set_text 的 role 概念："title" / "desc"）。先求 desc_pt（主文，受框限制最緊），title_pt = `min(round(desc_pt * ratio), title_cap)`，ratio 預設 1.30。求解時兩組段落各自貢獻高度（title 段以 title_pt、desc 段以 desc_pt 估高），總高一起比框高。
- **DD-4**: **`limited_by` 判定**（fail-fast，三值）：
  - `"height"`：採用字級 = 高度約束下的最大整數 pt（再大一級則 needed_in 超 box_h*(1+tol)）。
  - `"width"`：採用字級被「再大一級就有段落 wrap 超出 avail_w_em 觸發多行進而高度超界，或單行寬度估算超界」卡住——即瓶頸是窄框而非框高。判定法：在採用 pt+1 時，若導致溢出的主因是某段落 `w_em > avail_w_em`（換行數增加）而非純高度，標 width。
  - `"cap"`：採用字級 = `cap`（已達上限仍未溢出，框其實還能更大字但被 cap 擋住）。
  - 實作上以「採用 pt 是否等於 cap」「採用 pt+1 的溢出是否由寬度換行主導」決定標籤；預設先求出採用 pt，再做一次 pt+1 的反事實檢查歸因。
- **DD-5**: **求不出時不 silent fallback**。若 floor 字級仍溢出（框太小/文字太長），採用 floor 並回報 `limited_by` + `overflow=true`，明示「要 fit 需放寬框或減字」，而非假裝成功。（符合專案天條：fail fast、不 silent fallback。）
- **DD-6**: **寫回機制**沿用既有 set_text 的 run sz 寫入路徑（`bin/_pptx_surgery.py` / set_text CLI），把求出的 title_pt/desc_pt 寫進對應 role 段落的 `<a:rPr sz=...>`。不新建寫入路徑。
- **DD-7**: **byte 相容**。`set_text` 既有簽章不變；新增可選 `fit` 參數，預設 `None`。`fit=None` → 完全走現行路徑（byte-identical）。`fit="shape"` → 忽略傳入的明確 size，改呼叫求解器。
- **DD-8**: DD-4 歸因優先序澄清（Phase 1 實作發現）：limited_by 判定順序為 width > cap > height。當 desc_pt==desc_cap 但 pt+1 反事實的溢出主因是寬度 wrap（行數增加）時，須標 "width" 而非 "cap"——width-wrap 是誠實的綁定約束，優先於 cap 短路。未改 _pptx_layout_lint.py 任何偵測邏輯。

## Risks / Trade-offs

- **R-1**: title/desc 角色界定若與既有 set_text 的 role 語彙不一致 → 寫回對不上。緩解：implementing 前先讀 `pptx_revise_set_text.py` / `pptx_set_shape_text.py` 確認既有 role 欄位名與寫入路徑。
- **R-2**: `_estimate_text_height_in` 的 wrap 估算對 CJK/拉丁混排是粗略近似（`_visual_width_em` CJK=1.0/拉丁=0.5）。求解器共用它即「與 lint 同樣粗略」——這正是要的（一致即可），但回報字級不保證視覺最佳。緩解：文件說明「目標是過 lint 的最大安全字級，非像素完美」。
- **R-3**: geometry 解析鏈（placeholder 繼承 layout/master）對某些 shape 回 `no_resolvable_geometry`。求解器遇此須 fail-fast 回報「無法解析框幾何」，不亂猜。

## Critical Files

- `bin/_pptx_layout_lint.py` — 度量核心來源（`_estimate_text_height_in`/`_insets_in`/`_visual_width_em`/`Thresholds`/geometry 解析鏈 `_resolve_geometry`/`_ph_geometry_index`/`_layout_for_slide`/`_master_for_layout`）。**只 import，不改其偵測行為**（最多把私有函式視為可共用介面）。
- `bin/_pptx_fit_solver.py` — **新增**。求解器核心：`solve_fit(box_w, box_h, title_paras, desc_paras, *, title_cap, desc_cap, floor, ratio, overflow_tol, line_factor) -> FitResult`。
- `bin/pptx_fit_text.py` — **新增**。CLI wrapper：解析 doc_dir/index/shape_id → 取 geometry + 段落 → 呼叫 solver → 寫回 → emit envelope。
- `bin/_pptx_surgery.py` — set_text 寫回 sz 的路徑；`fit="shape"` 分支接 solver。
- `bin/pptx_revise_set_text.py` / `bin/pptx_set_shape_text.py` — set_text 入口，加 `fit` 參數。
- `bin/_mcp_registry.py` — 註冊 `pptx_fit_text` 動作 + `fit` 參數 schema（行 1601 附近已有 overflow_tol 等 pptx_layout_lint 參數可參考）。
- `tests/` — 新增 `test_pptx_fit_text.py`。

## Solver Taxonomy (執行契約 — implementing 不得偏離)

`solve_fit` — 求最大安全字級。
- **輸入**: `box_w_in, box_h_in`（框；inch）、`title_paras: list[str]`、`desc_paras: list[str]`、`title_cap=18, desc_cap=13, floor=9, ratio=1.30`（pt）、`overflow_tol=0.2, line_factor=1.2`、`insets`（(h,v) inch；預設 lint 的 0.2h/0.1v）。
- **輸出 `FitResult`**: `{title_pt:int, desc_pt:int, limited_by:"height"|"width"|"cap", overflow:bool, needed_in:float, box_h_in:float, est_lines:int}`。
- **運算**: desc_pt 從 desc_cap 向 floor 下掃，每級用 `_estimate_text_height_in(title_paras@title_pt(d) + desc_paras@d, ...)` 合計總高，取首個 `needed <= box_h*(1+tol)` 的 d 為採用值；title_pt = min(round(d*ratio), title_cap)。
- **不允許解讀成**: 不是「設個固定小字」；不是「無視 cap 無限放大」；不是「溢出時 silent 給 floor 假裝成功」（必須 overflow=true）。
- **完成判準**: 回傳的 (title_pt, desc_pt) 套回該 shape 後，`pptx_layout_lint` 對該 shape `OVERFLOW` 不觸發（除非 overflow=true 已誠實標明框真的太小）。
