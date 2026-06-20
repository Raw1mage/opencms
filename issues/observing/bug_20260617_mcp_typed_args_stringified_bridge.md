# BR: MCP tool-call 的 object/number 參數被 stringify，導致下游 MCP server schema 驗證 reject

- **Date**: 2026-06-17
- **Severity**: high（讓任何「需要 typed args 的 MCP 工具」從 AI 端不可用，只能繞 raw JSON-RPC）
- **Status**: OBSERVING（2026-06-17）— 已 commit `3c4b26bcb`（universal CoerceArgs seam）、已部署。**待端到端即時驗證**（真實 session 驅動帶 typed args 的 deferred 工具）無復發後轉 closed。root cause 在 `provider-claude/src/antml-salvage.ts:57-65`（值被當字串搶救）；最終修復不只 MCP execute chokepoint，而是抽成共用 `tool/coerce-args.ts` 並在 `session/llm.ts` 兩個 seam（lazy-unlock + activeHit re-run）套用，涵蓋所有 off-wire deferred 工具。測試 25 cases 全綠（tool 10 + mcp 15）、typecheck 對 touched 檔乾淨。**已部署 2026-06-17**（`./webctl.sh restart --force`，health buildId `3c4b26bcb-dirty.1781708992` 三證綠）。**待端到端即時驗證**：需真實 opencode AI session 驅動一個帶 object/number/array 參數的 deferred 工具（如 bodesign `c02_generate_openscad`、`system-manager_restart_self` 的 `targets`）確認不再被 stringify reject；外部 Claude Code session 無法重現 provider-claude 的 ANTML-salvage 路徑，故由下次真實使用驗收。驗證無復發後轉 `observing/`。see `docs/events/fix_20260617_typed_args_coercion_universal_seam.md`。
- **Component**: provider-claude runtime — Claude 原生 ANTML 文字格式 tool-call 的 salvage 還原層（非 MCP relay 層）
- **Reporter**: pkcs12（live，session `ses_12cb50dd1ffeeWzWo2OIesXEsf`，aiguard C02 機構設計任務驅動 `bodesign_*` 生成工具時撞到）

## Symptom

從 AI 端呼叫帶有 **object / number** 參數的 MCP 工具，下游 MCP server 一律以 JSON-schema 驗證錯誤 reject，錯誤訊息顯示**收到的是字串**而非 typed value。string 參數的同類工具則完全正常。

實測（bodesign MCP，`bodesign_c02_*` 系列）：

| 呼叫                                                       | 參數型別 | 結果                                                                      |
| ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `bodesign_c02_generate_openscad({constraints: {...}})`     | object   | `Input validation error: '{"board_outline":...}' is not of type 'object'` |
| `bodesign_c02_generate_openscad({wall_thickness_mm: 2.5})` | number   | `Input validation error: '2.5' is not of type 'number'`                   |
| `bodesign_c02_export_stl({out_dir: "..."})`                | string   | ✅ 正常執行                                                               |
| `bodesign_c02_readiness({folder: "..."})`                  | string   | ✅ 正常執行                                                               |

錯誤裡的 `'{"board_outline":...}'` / `'2.5'` 帶引號 = 下游收到的是 **JSON 字串字面量**，不是 object / number。也就是 opencode 在把 AI 的 tool-call 參數轉送給 MCP server 之前，把非字串值序列化成了字串。

## 為什麼這是 bug 而非 server 端問題

1. **同一個 server、同一輪 session，string 參數工作正常、typed 參數失敗** → 不是 server 連線/schema 本身壞，是參數型別在傳遞途中被改。
2. **繞過 opencode 直連 server 即正常**：用 raw JSON-RPC 直打 bodesign 的 UDS / TCP endpoint（`/home/pkcs12/projects/bodesign/.run/bodesign.sock`、`:8077/mcp/`），自己構造 `arguments` 物件保留型別，**同一批工具全部成功**並真的產出檔案：
   - `bodesign_c02_export_stl` → `stl_exported`（real OpenSCAD CLI）
   - `bodesign_c02_export_step` → `step_exported`（real build123d/OCP）
   - `bodesign_c02_generate_openscad({constraints:{...object...}, wall_thickness_mm:2.5})` → `source_generated`，readiness 50%、`can_place_openings: true`
     這證明 server 的 schema 與 typed-arg 處理是對的；problem 在 opencode→server 的轉送層。
3. server 的 inputSchema 宣告該欄位為 `object`/`number`（bodesign self-describing，`/tools/{name}` 可查），opencode 卻送了 string → server 正確 reject。

## Root cause（已確認 2026-06-17）

**真正序列化點：`packages/provider-claude/src/antml-salvage.ts:57-65`** —— 與 BR 原推測的 MCP relay 層（`mcp/index.ts` / `resolve-tools.ts`）無關。

因果鏈：

1. `bodesign_*` 是 deferred/lazy 工具，完整 `inputSchema` 不在 wire `tools[]`（`resolve-tools.ts:469-475` 刻意把 lazy 工具移出 wire 以保 prompt-cache 穩定）。
2. 正因 deferred 工具不在 native tools，claude-opus 傾向退回用 **Claude 原生 ANTML 文字格式**發 tool call：`<invoke name="…"><parameter name="constraints">…</parameter></invoke>`。
3. `provider-claude/src/sse.ts:255-269`（content_block_stop）偵測到文字格式 tool call → 呼叫 `salvageAntmlInvokes()` 搶救。
4. `antml-salvage.ts:57` 把 params 宣告成 `Record<string, **string**>`，:63 把每個 `<parameter>` 內容**一律當字串**塞入，:65 `JSON.stringify(params)`。
5. 結果：每個非字串值被包成字串字面量（`{"constraints":"{...}"}`）；string 參數（`folder`/`out_dir`）剛好正確 → string-arg 工具正常、object/number 失敗。

**決定性證據（空白保留）**：live 呼叫 `bodesign_c02_readiness({constraints:{board_outline:{width_mm:130,height_mm:65}}})`，server 回 `'{"board_outline": {"width_mm": 130, "height_mm": 65}}' is not of type 'object'`，**逐字保留輸入空白**（`": "`、`, `）→ 該值被原樣文字擷取，不是 `JSON.stringify(obj)` 重序列化（後者會剝空白）。

**已排除**：

- `incoming/dispatcher.ts` `rewriteCandidates`（walk2 遞迴重建但保留型別）。
- `llm.ts` `experimental_repairToolCall`（input 可解析 JSON 時原樣 passthrough）。
- `provider/transform.ts` `sanitizeGemini`（僅 gemini 路徑；本 session 為 claude-cli，已排除）。
- `resolve-tools.ts` `stringifyForToolContent`（result-side helper，未接到 arg-side）。

## Fix（已實作）

選 schema-based coercion，落點在 **`mcp/index.ts` `convertMcpTool` execute 的單一 chokepoint**（所有 MCP 工具呼叫無論 active/deferred、任何 provider 都經此，且 closure 內已有 server 完整 `schema` + `argsObj`）。非 provider-claude 端，因為 deferred 工具 schema 在 provider 層根本看不到 —— provider 端修法會剛好在最需要它的地方失效。對齊 BR acceptance criteria「opencode 對 MCP 動態工具依其 inputSchema 做 JSON.parse / coercion」。

- 新增 `MCP.coerceArgsToSchema(args, schema)`（`mcp/index.ts`）：對 inputSchema 宣告為**具體非字串型別**（object/array/number/integer/boolean，且不含 string）的 top-level 欄位，若入站值是字串則 `JSON.parse`，**僅當 parse 結果的 runtime 型別符合宣告型別才採用**；否則保留原字串。schema 同時允許 string（ambiguous）→ 不動；parse 失敗 / 型別不符 → 不動。非 silent fallback：只還原 schema 明確要求的型別。
- execute 在 `argsObj` 建立後、`IncomingDispatcher.before` 前呼叫 coercion（`mcp/index.ts`）。
- 回歸測試 `packages/opencode/src/mcp/coerce-args.test.ts`（15 cases，全綠）：object/number/integer/boolean/array 還原、string 保留、型別不符不動、ambiguous（含 string）不動、未知欄位不動、no-schema no-op、空字串不動、identity 保留。

## Reproduction

1. session 內呼叫任一 deferred MCP 工具，傳一個 object 或 number 參數，例如
   `bodesign_c02_generate_openscad({out_dir:"x", wall_thickness_mm:2.5, constraints:{board_outline:{width_mm:130,height_mm:65}}})`。
2. 觀察回傳 `Input validation error: '...' is not of type 'object'|'number'`（引號內是被字串化的值）。
3. 對照：同工具只傳 string 參數（`out_dir`）正常。
4. 對照：raw JSON-RPC 直連同一 server、同一工具、同一 typed args → 成功。

## Impact

- **任何需要 object/array/number 參數的 MCP 工具，從 AI 端實質不可用** —— 只有純 string-arg 工具能用。
- 對 bodesign 影響最大：C02/C03/C04 的生成工具（`c02_generate_openscad`、`c02_export_step`、`compose_schematic`、`emit_layout`…）幾乎都吃 object/number constraints，等於整條 generation 半邊在 AI 端被封死。
- 使用者要求「用 bodesign 生 X」時，AI 會誤判工具不可用、退回手寫或繞 raw JSON-RPC（本案即如此），降低 MCP 工具信任度，且繞道不經 opencode 的 tool-call 觀測/審批路徑。

## Workaround（已驗證）

raw JSON-RPC 直連 MCP server，自控 `arguments` 型別：

- UDS：`curl --unix-socket /home/pkcs12/projects/bodesign/.run/bodesign.sock -X POST http://bodesign.local/mcp/`（`initialize` 取 `mcp-session-id` → `notifications/initialized` → `tools/call`，arguments 用真正的 JSON object/number）。
- 真工具名帶 `bodesign_` 前綴（`bodesign_c02_export_stl` 等），與 opencode 暴露名一致。
- 缺點：繞過 opencode tool-call 層，無觀測/審批，且要手寫 SSE 解析。

## Acceptance Criteria

- AI 對 MCP 工具發出帶 object/number/array 參數的 tool call 後，opencode 轉送給 MCP server 的 `arguments` **保留原始 JSON 型別**（object 仍是 object、number 仍是 number），server schema 驗證通過。
- 若上游 provider 以字串形式交付 tool-call arguments，opencode 對 MCP 動態工具依其 `inputSchema` 做 `JSON.parse` / coercion 還原後再轉送（與內建工具的 zod coercion 對齊）。
- 回歸測試：載入一個 deferred MCP 工具，呼叫帶 object + number 參數，assert 下游 `tools/call` 收到的 `arguments` 型別正確（不是字串字面量）。
- 不需透過 raw JSON-RPC 繞道即可驅動 typed-arg MCP 工具。

## 旁證：相關但不同的既有票

- `issues/closed/bug-docxmcp-dynamic-mcp-tool-schema-unavailable.md`（CLOSED）— 動態 MCP 工具「schema 不可見/不可呼叫」。本案不同：工具**可見可呼叫**，是**呼叫時的參數型別**在轉送途中被破壞。同屬 dynamic MCP tool exposure/invocation chain 的下游問題，但 failure mode 相異，非 reopen。

## Evidence refs

- `packages/opencode/src/mcp/index.ts:275-279`（callTool 轉送點）、`:229`（`jsonSchema(schema)` 動態 schema）
- `packages/opencode/src/session/resolve-tools.ts:57-64`（`stringifyForToolContent` 序列化 pattern）、`:498,537`（lazy-tool execute arguments 傳遞）
- live 實測：bodesign MCP 直連成功 vs opencode 轉送失敗（session `ses_12cb50dd1ffeeWzWo2OIesXEsf`，2026-06-17）

---

## Resolution extension (2026-06-17, evening)

The initial fix (`795f35178`) bolted `coerceArgsToSchema` to the MCP execute
chokepoint ONLY, so built-in deferred tools (`system-manager_restart_self`'s
`targets: array`, etc.) — which never pass through `convertMcpTool` — kept
failing. Under the Active Loader (DD-21) those off-wire tools are the _majority_
of calls, hence the high observed failure rate.

Cured by lifting coercion to a universal seam:

- shared `tool/coerce-args.ts` (`CoerceArgs`); `mcp/index.ts` re-exports it.
- `session/llm.ts experimental_repairToolCall` coerces against the unlocked
  tool's schema at the lazy-unlock seam (all deferred tools) and re-runs coerced
  calls at the `activeHit` seam instead of redirecting to `invalid`.

See `docs/events/fix_20260617_typed_args_coercion_universal_seam.md`.
