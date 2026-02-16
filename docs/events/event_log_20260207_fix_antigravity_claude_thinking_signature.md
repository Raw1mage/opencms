#### 功能：修復 Antigravity Claude Thinking `Invalid signature` (Tool Execution Failed)

**需求**

- subagent 使用 `antigravity / claude-*-thinking` 時，避免因為注入不合法的 thinking signature 而導致 400：`Invalid \`signature\` in \`thinking\` block`。
- 允許 Gemini 3 仍可使用 sentinel signature（官方機制）作為 cache-miss fallback。

**範圍**

- IN: `src/plugin/antigravity/plugin/request.ts`, `src/plugin/antigravity/plugin/request.test.ts`
- OUT: 調整模型選擇策略、rotation3d fallback 規則

**根因 (RCA)**

- `ensureThinkingBeforeToolUseInContents/messages` 在 signature cache miss 時，會注入 `skip_thought_signature_validator` 當作 thinking block 的 signature。
- 這個 sentinel 對 Gemini API 是官方支援的 bypass，但對 Antigravity/Vertex 的 **Claude thinking** payload 並不接受，導致請求被拒。

**修復**

- 讓 `ensureThoughtSignature()` / `ensureThinkingBeforeToolUseIn*()` 支援 `allowSentinel`：
  - `allowSentinel: false`（Claude thinking）：**不注入 sentinel**，cache miss 時直接移除/不注入 thinking blocks，避免送出不合法 signature。
  - `allowSentinel: true`（Gemini 3）：維持原 sentinel fallback 行為。
- 在 `prepareAntigravityRequest()` 對 Claude thinking 路徑明確傳入 `{ allowSentinel: false }`。
- 補測：確認 `allowSentinel=false` 時不會注入 thinking blocks / functionCall thoughtSignature。

**任務**

- [x] 修正 request payload 轉換邏輯（Claude 不注入 sentinel）
- [x] 新增/更新單元測試

**驗證**

- `bun test src/plugin/antigravity/plugin/request.test.ts`
