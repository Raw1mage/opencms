---
date: 2026-05-11
summary: "Chapter 05 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions / D5-1 datasheet"
---

# Chapter 05 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions / D5-1 datasheet

## Audit result: PASS

- **Submodule SHA pinned**: `76845d716b720ca701b2c91fec75431532e66c74` (unchanged).
- **Claims**: 12 (C1–C12).
- **Anchors**: 12.
- **TEST/TYPE diversity**: **5 TYPE** (C1 enum, C2 struct, C3 struct, C4 enum, C6 struct field, C9 module re-exports, C12 struct layout — actually 7 TYPE anchors) + **1 TEST** (C11). Sufficient.
- **Open questions**: 0.

## Datasheet delivered

- **D5-1**: `tools` field of ResponsesApiRequest. Outer Vec<Value> shape + per-variant JSON forms (Function / Namespace / ToolSearch / LocalShell / ImageGeneration / WebSearch / Freeform) + sibling fields (tool_choice = "auto" hard-coded, parallel_tool_calls per-turn) + sanitized example payload. Cross-links to D6-1 (full request body, owned by Chapter 06).

## Cross-diagram traceability (per miatdiagram §4.7)

Walked:
- tools/src/tool_spec.rs::ToolSpec → A5.1, A5.5, A5.6 → D5-1 ✓
- tools/src/responses_api.rs::ResponsesApiTool → A5.1, A5.3, A5.4 → D5-1 Function row ✓
- tools/src/mcp_tool.rs::parse_mcp_tool → A5.3 ✓
- rmcp-client/src/lib.rs::RmcpClient → A5.2 ✓
- codex-api/src/common.rs::ResponsesApiRequest.tools → wire-level D5-1 ✓
- TEST C11 pins D5-1 Function-row JSON byte-exact ✓

## Audit table

| Cn | Anchor | Kind | Verified |
|---|---|---|---|
| C1 | tools/src/tool_spec.rs:17 | enum | ✓ 7 variants confirmed |
| C2 | tools/src/responses_api.rs:26 | struct | ✓ 6 fields incl serde-skip output_schema |
| C3 | tools/src/responses_api.rs:73 | struct | ✓ tools: Vec<ResponsesApiNamespaceTool> |
| C4 | tools/src/responses_api.rs:64 | enum | ✓ only Function variant |
| C5 | tools/src/tool_spec.rs:100 | fn | ✓ fn signature + body confirmed |
| C6 | codex-api/src/common.rs:175 | struct field | ✓ Vec<serde_json::Value> + sibling fields |
| C7 | core/src/client.rs:719 | fn body | ✓ tool_choice="auto", parallel_tool_calls from prompt |
| C8 | tools/src/mcp_tool.rs:6 | fn | ✓ parse_mcp_tool signature |
| C9 | rmcp-client/src/lib.rs:33 | re-exports | ✓ RmcpClient + transport launchers confirmed |
| C10 | tools/src/responses_api.rs:69 | fn pair | ✓ dynamic_tool_* sibling fns confirmed |
| C11 | tools/src/tool_spec_tests.rs:146 | TEST | ✓ JSON shape assertion byte-exact |
| C12 | codex-api/src/common.rs:170 | struct layout | ✓ tools/input siblings at same nesting depth |

## OpenCode delta — key findings

1. **`tools` field wire shape aligned**, content differs by design (different built-in tool set, OpenCode-specific names).
2. **Tools dimension cache** is independent from input[] cache — confirmed structurally (C12). Reasonable assumption that mid-session MCP changes won't tank input[] prefix cache (subject to backend behaviour we cannot directly inspect).
3. **OpenCode's `skill` tool** is a clever alternative to upstream's `AvailableSkillsInstructions` developer bundle fragment (Ch04 C10). Both work; cache profiles differ but net byte cost is comparable.
4. **AI SDK v2 convertTools adapter** is OpenCode's equivalent of `create_tools_json_for_responses_api` (C5). Final wire output matches C11's TEST byte-exact for tool entries.

## Cumulative spec progress (5/12 chapters audited)

- 60 claims / 60 anchors total
- 5 TEST + 22 TYPE
- 5 datasheets (D2-1, D2-2, D4-1, D4-2, D5-1)
- 0 open questions
- All on SHA 76845d716b

## Next

Chapter 06 — Responses API Request Build. This is where Chapters 04 + 05 converge: full `ResponsesApiRequest` body shape (D6-1), per-turn headers (D6-2), `prompt_cache_key` derivation, `client_metadata` composition, `service_tier` / `store` / `stream` / `include` / `reasoning` / `text` fields. Will be the longest chapter so far because it spans the largest set of wire-level fields.
