# drawmiat Inline SVG Card — 對話串內嵌圖表卡片

## Goal

在 session 對話串中，當 `generate_diagram` MCP tool 回傳 SVG 時，直接以內嵌卡片形式渲染圖表預覽，而非只顯示 generic tool 摺疊列。

## 現狀分析

### MCP Tool 命名規則
- MCP tool 在前端的 key = `{sanitizedServerName}_{sanitizedToolName}`
- drawmiat 的工具：`drawmiat_generate_diagram`、`drawmiat_validate_diagram`

### MCP Tool Output 格式（generate_diagram）
`_format_result()` 回傳多個 `TextContent` blocks：
1. **Summary block**：`## IDEF0 — OK` + logs/warnings/errors/saved paths
2. **SVG blocks**（每個 artifact 一個）：`--- SVG: {name} ---\n{svg_string}`

### 現有渲染架構
- `ToolRegistry.register({ name, render })` — 註冊 custom renderer
- `BasicTool` — 可收合卡片殼（icon + trigger + content）
- MCP tool 未註冊 → fallback 到 `GenericTool`（只顯示 tool name）
- `props.output` 是 string（所有 TextContent blocks 串接）

## Design

### 核心元件：`DiagramToolCard`

註冊為 `drawmiat_generate_diagram` 的 custom renderer。

**渲染邏輯**：
1. Parse `props.output` → 分離 summary block 和 SVG blocks
2. 從 SVG blocks 中提取 `--- SVG: {name} ---` 標記後的 SVG 字串
3. 卡片佈局：
   - **Trigger**（摺疊態）：icon 📐 + "generate_diagram" + diagram type + status
   - **Content**（展開態，defaultOpen）：
     - Summary 區（logs/warnings/saved paths）— 用 Markdown 渲染
     - SVG 預覽區 — 每張圖一個 inline `<div innerHTML={svg}>` with max-height
     - 底部工具列：Download / Open in Tab（跳到 file-tabs）

**SVG 安全**：
- drawmiat 產的 SVG 是自有引擎輸出，不含外部腳本
- 仍用 `<img src="data:image/svg+xml;base64,...">` 而非 innerHTML 注入，以 sandbox SVG 執行

### validate_diagram

也註冊 custom renderer，但只渲染 summary（Markdown），不含 SVG 預覽。

## 實作位置

**單一檔案**：`packages/ui/src/components/diagram-tool.tsx`（新增）

在 `message-part.tsx` 尾部 import 並觸發 register（跟其他 ToolRegistry.register 一致）。

## Tasks

- [ ] T1: 建立 `packages/ui/src/components/diagram-tool.tsx`
  - 實作 `parseDiagramOutput(output: string)` — 分離 summary + SVG artifacts
  - 實作 `DiagramCard` component — BasicTool 殼 + SVG preview + toolbar
  - 註冊 `drawmiat_generate_diagram`
  - 註冊 `drawmiat_validate_diagram`（summary only）
- [ ] T2: 在 `message-part.tsx` 尾部 import `diagram-tool.tsx`（side-effect import 觸發 register）
- [ ] T3: TypeScript 編譯驗證
- [ ] T4: 更新 event log `docs/events/event_20260326_drawmiat_mcp_integration.md`

## 不做

- 不改 drawmiat MCP server 的 output 格式
- 不改 file-tabs 的 SvgViewer（已完成的功能不受影響）
- 不做 SVG inline editing（在卡片裡）— 編輯走 file-tabs
