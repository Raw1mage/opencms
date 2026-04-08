# Codex Refactor V2 — Handoff

## 接手前必讀

1. **plan.md** — 施工清單（§五）和驗證方法（§六，13 項）
2. **datasheet.md** — 完整規格（request body, input items, event mapping, providerOptions）
3. **golden-request.json** — 舊 provider 的實際 WS request dump（唯一真相來源）

## Authority SSOT

| Field | Value |
|---|---|
| mainRepo | `/home/pkcs12/projects/opencode` |
| mainWorktree | `/home/pkcs12/projects/opencode` |
| baseBranch | `main` (at `aa9490815`) |
| implementationWorktree | `/home/pkcs12/projects/opencode-beta/codex-refactor-v2` |
| implementationBranch | `beta/codex-refactor-v2` |

**main 已 reset 到 aa9490815，舊 codex provider 正常運作。新 codex 全部在 beta 裡。**

## V1 失敗教訓

convert.ts 從 type definition 猜格式，沒對照舊 provider 實際 output。結果：
- system prompt 放錯欄位 → AI 沒 context
- tool result stringify → AI 看到空內容
- tool-call StreamPart 缺失 → tool 不執行
- finishReason 永遠 "stop" → tool loop 不繼續
- content parts 格式全錯（string vs array, input_text vs output_text）

**V2 規則：任何格式轉換必須對照 golden-request.json 驗證，不准猜。**

## 當前進度

### 已完成

- Package 建立（11 .ts files）
- 整合 wiring（custom-loaders-def.ts + plugin/codex-auth.ts）
- WS transport + delta + continuation
- Plan + datasheet + golden dump
- IDEF0 3 層 21 子圖 + Grafcet 2 圖（全繁體中文 + SVG）
- **sse.ts 修復**：finishReason=tool-calls、text-end flush、text-start auto-emit、response.incomplete、max_output_tokens
- **清理完成**：刪除 codex.ts(977) + codex-websocket.ts(653) + codex-native.ts(318) = 1948 行
- **plugin/index.ts**：移除 old CodexAuthPlugin，僅保留 CodexNativeAuthPlugin
- **ContinuationInvalidatedEvent** 搬到 codex-auth.ts
- **provider.ts**：env OPENAI_API_KEY → []
- **Unit tests**：sse.test.ts 7/7 pass
- **bodyStr bug**：HTTP fallback path 的 undefined 變數修復

### 下一步（按順序）

1. **providerOptions dump 對照 golden**：
   - 需啟動 beta daemon，發送 codex 請求，dump actual request body
   - diff with golden-request.json 逐欄位比對

2. **Failure path 測試**（plan §六 #8~#13）：
   - WS 失敗 → HTTP fallback
   - Rate limit → error propagation
   - Token refresh mid-session
   - Account switch → WS reset
   - Daemon restart → continuation restore

3. **Fetch-back to main**：通過全部 13 項驗證才能 merge

## drawmiat 工具路徑

```bash
# IDEF0
python3 /home/pkcs12/projects/drawmiat/webapp/idef0/idef0_renderer.py input.json output.svg

# Grafcet
python3 /home/pkcs12/projects/drawmiat/webapp/grafcet_cli.py input.json --output_dir output_dir/
```

## 關鍵文件位置（beta worktree）

```
plans/codex-refactor/plan.md              — 施工清單
plans/codex-refactor/datasheet.md         — 規格書
plans/codex-refactor/golden-request.json  — 標準答案
plans/codex-refactor/diagrams/            — IDEF0 + Grafcet JSON + SVG
packages/opencode-codex-provider/src/     — provider package（11 .ts files）
packages/opencode/src/plugin/codex-auth.ts — thin auth plugin
packages/opencode/src/provider/custom-loaders-def.ts — codex loader
```
