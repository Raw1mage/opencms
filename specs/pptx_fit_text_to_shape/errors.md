# Errors: pptx_fit_text_to_shape

每個錯誤碼含使用者可見訊息、復原策略、負責層。fail-fast，不 silent fallback。

## Error Catalogue

| Code | Message | Recovery | Layer |
|---|---|---|---|
| `PPTX_FIT_NO_GEOMETRY` | "shape {shape_id} on slide {index}: 無法解析框幾何（slide/layout/master 鏈皆無 xfrm）" | caller 改用有明確 geometry 的 shape，或先 set placeholder geometry；不亂猜框大小（R-3） | `_pptx_fit_solver` / `pptx_fit_text` CLI（A1） |
| `PPTX_FIT_BOX_TOO_SMALL` | "shape {shape_id}: 文字在 floor {floor}pt 仍溢出框（needed {needed_in}in > box {box_h_in}in）" | **非致命錯誤**：採用 floor + `overflow=true` 回報；caller 得知需放寬框或減字（DD-5）。不 raise，回 envelope。 | `_pptx_fit_solver`（A2/A4） |
| `PPTX_FIT_NO_TEXT` | "shape {shape_id}: 無文字段落可求解" | caller 先 set_text 再 fit，或本就無需 fit | `pptx_fit_text` CLI（A1） |
| `PPTX_FIT_SHAPE_NOT_FOUND` | "slide {index}: 找不到 shape_id {shape_id}" | caller 用 pptx_read action=shapes 確認 shape_id | `pptx_fit_text` CLI（A1） |
| `PPTX_FIT_BAD_PARAMS` | "fit params 非法：floor {floor} > desc_cap {desc_cap}（或 ratio<=0）" | caller 修正 caps（floor <= desc_cap <= title_cap、ratio>0） | `_pptx_fit_solver`（A2） |
| `PPTX_FIT_WRITEBACK_FAILED` | "字級寫回失敗：{detail}" | 檢查 set_shape_text 路徑；可能 role 段落結構不符（G1 stop gate） | `_pptx_surgery.set_shape_text`（A3） |

## 設計原則

- `PPTX_FIT_BOX_TOO_SMALL` 是**誠實回報**而非 raise：求解器仍回採用值（floor）+ `overflow=true` + `limited_by`，讓 caller 知道「框真的太小」而非求解器壞掉。這是與專案 fail-fast 一致的「顯式回報，不 silent fallback」。
- 其餘錯誤碼皆 fail-fast raise（不亂猜、不續跑）。
- 錯誤碼沿用 docxmcp 既有 `SurgeryError(code, message, exit_status)` 慣例。
