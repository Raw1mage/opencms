# Event: drawmiat debug-gaps enablement hint

## 需求

- 將 drawmiat Grafcet debug overlay 能力記錄到 tool/capability 描述，讓 AI 下次遇到 layout/routing debug 任務時能主動想到 `debug_gaps` / `--debug-gaps`。

## 範圍(IN)

- `packages/opencode/src/session/prompt/enablement.json`
- `docs/events/event_20260511_drawmiat_debug_gaps_enablement.md`

## 範圍(OUT)

- 不修改 drawmiat renderer 實作。
- 不修改 MCP tool schema 參數面。
- 不新增新的 debug tool 或 wrapper。

## 任務清單

- [x] 確認 repo 中實際存在的是 `debug_gaps` / `--debug-gaps`，不是 `--debug-mode`。
- [x] 更新 runtime enablement 描述，補上 Grafcet debug overlay 提示。
- [x] 確認此能力屬開發者功能，不保留於 `templates/` 對外發布面。
- [x] 記錄本次 capability hint 變更。

## Debug / Evidence Checkpoints

- `drawmiat/scripts/render_grafcet_l5_samples.py:185` 定義 `--debug-gaps`。
- `drawmiat/webapp/grafcet_renderer.py:7282` `render(..., debug_gaps=False)`。
- `drawmiat/webapp/grafcet_renderer.py:7304` 啟用後回傳 `debug_svg_text`。

## Key Decisions

- 將這項能力僅記在 runtime `enablement.json` 的 drawmiat tool description 與 diagram-generation routing notes，而不是修改既有 MCP schema 參數面。
- 用語明確指向「Grafcet routing/layout debug 時優先考慮 debug_gaps / --debug-gaps」，避免 AI 只知道一般 render，不知道 debug overlay。
- `templates/prompts/enablement.json` 不保留這項 hint，避免把開發者專用能力當成對外發布契約。

## Validation

- Runtime `enablement.json` 已補記 hint；`templates/prompts/enablement.json` 已依使用者指示排除這項開發者專用提示。
- Architecture Sync: Verified (No doc changes) — 本次只更新 capability routing/描述，不改 runtime module boundary、資料流或 state authority。
