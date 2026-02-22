# Event: Enablement Registry Unified Routing

Date: 2026-02-23
Status: Done

## 1. 需求與目標

- 建立 tools / skills / MCP 的單一真相來源。
- 降低 driver/SYSTEM/AGENTS 分散式描述造成的可發現性問題。
- 支援 on-demand MCP（需要才開、閒置可關）。
- 將能力擴充流程（skill-finder / mcp-finder）納入同一治理面。

## 2. 本次變更

1. 新增 runtime 能力總表：
   - `packages/opencode/src/session/prompt/enablement.json`
2. 新增 template 對應檔：
   - `templates/prompts/enablement.json`
3. 更新 `SystemPrompt` 種子流程：
   - `packages/opencode/src/session/system.ts` 增加 `enablement.json` seed。
4. 更新 LLM 注入流程：
   - `packages/opencode/src/session/llm.ts` 新增 enablement snapshot 注入（依使用者訊息匹配 intent）。
5. 更新 SYSTEM 規範：
   - `templates/prompts/SYSTEM.md` 新增 Capability Registry 條款。
6. 更新 AGENTS 規範（project + template）：
   - 新增 `mcp-finder`、`skill-finder` 為核心擴充技能。
   - 明確要求擴充能力後同步更新 `enablement.json`。
7. 更新架構文件：
   - `docs/ARCHITECTURE.md` 新增 Capability Enablement Layer 說明。
8. 更新工具解析流程：
   - `packages/opencode/src/session/resolve-tools.ts` 新增 on-demand MCP auto-connect + idle auto-disconnect。
9. 更新 driver prompt 層：
   - `templates/prompts/drivers/*` 與 `packages/opencode/src/session/prompt/*` 補充「enablement.json 為能力導引主來源」聲明。

## 3. 關鍵決策

- Prompt 三層（drivers / SYSTEM / AGENTS）保留，但改為：
  - SYSTEM 負責紅線與邊界；
  - AGENTS 負責協作策略；
  - Driver 負責模型風格調校；
  - 能力路由與盤點統一收斂到 `enablement.json`。
- `enablement.json` 作為可發現性主索引；擴充後必須回寫，形成可持續成長機制。

## 4. 風險與後續

- 風險：driver 文本仍保留歷史工具片段，可能與 registry 敘述有重疊。
- 後續：在 session prompt/llm prompt 包裝中加入精簡 enablement snapshot 注入，並導入 runtime on-demand auto-toggle + idle reaper。

## 5. 驗證流程調整（暫行）

- 針對目前基線已知噪音，日常驗證允許排除 `antigravity auth plugin` 相關 typecheck 失敗。
- 指定排除目標：`packages/opencode/src/plugin/antigravity/plugin/storage.legacy.ts`（`vitest` module / `implicit any`）。
- 原則：僅在「本次變更未修改該路徑」時視為 non-blocking；若有修改，恢復完整嚴格驗證。
- 已落地：新增 `scripts/typecheck-with-baseline.ts`，並將 root `check` 改為 `lint + verify:typecheck`；`typecheck` 指令仍保留為嚴格模式。
