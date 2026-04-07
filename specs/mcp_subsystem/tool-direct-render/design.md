# Design: Tool Output Direct Render

## Context

MCP tool output 目前只有一條路：全部進 model context → model 消化後回覆。對於「讀信」這種純展示場景，50 頁內容全部被 model 吃掉，浪費 token 且小模型根本處理不了。

使用者的需求很單純：**我就是要看信，不需要 AI 幫我看。**

## Goals / Non-Goals

**Goals:**

- 直送模式：tool output → 對話中顯示檔案連結按鈕 → fileview tab 顯示完整 rich content
- AI 處理模式：tool output → model context（現有行為，適合 cron 自動化）
- 兩種模式可切換，預設直送

**Non-Goals (MVP):**

- 附件下載（Phase 2，擴充 fileview tab）
- HTML 原文 sandbox 渲染（Phase 2）
- 「交給 AI 分析」按鈕（Phase 3）

## 兩種模式

| 模式 | 觸發條件 | 資料流 | 適用場景 |
|------|---------|--------|---------|
| **直送**（預設） | 互動對話中、tool 不在 `modelProcess` 名單 | output → 寫入 fileview 暫存 → 對話顯示連結按鈕 → 點擊開 tab | 人在看 |
| **AI 處理** | cron 任務、或 tool 在 `modelProcess` 名單 | output → model context（現有行為） | 自動化 |

### 直送模式 UX

```
使用者：列出最新一封來自 zhenkang_lau 的信

AI：好的，我幫您查詢。
  [mcpapp-gmail_get-message]
  📎 20260407 股票排名  ← 檔案連結按鈕

  （fileview tab 自動開啟，顯示完整信件內容）
```

Model 只花 ~50 token：呼叫 tool + 產生一行回覆。完整內容在 fileview tab。

### AI 處理模式 UX（cron）

```
[cron] 每天早上 8 點檢查來自 zhenkang_lau 的新信，整理摘要

AI 讀取完整信件內容 → 產生摘要 → 存入報告
（無人互動，model 需要讀完整內容才能整理）
```

## Decisions

| DD | Decision | Rationale |
|----|----------|-----------|
| DD-1 | 預設直送，`modelProcess: string[]` 是例外名單 | 使用者需求：預設直送。只有 send/reply 等需要 model 確認的才走 AI 處理 |
| DD-2 | 直送不進 model context，而是寫成 fileview 可讀的暫存檔 | 完全跳過 model token 消耗。fileview tab 已有圖文顯示能力 |
| DD-3 | 對話中顯示檔案連結按鈕，不顯示 inline 內容 | 乾淨俐落。大量資料不應塞在對話流裡 |
| DD-4 | Model 收到的 summary：`[File displayed: "20260407 股票排名" (52KB). User can see it in file viewer.]` | 告訴 model 檔案已展示，不需重述 |
| DD-5 | Cron context 自動切換 AI 處理模式 | Cron 任務沒有人看 fileview，必須走 model 處理 |
| DD-6 | 暫存檔放 session 目錄下 `files/` 子目錄，markdown 格式 | fileview tab 已能讀取 session 內的檔案 |

## Data / State / Control Flow

### 直送模式

```
MCP tool execute() → result text
    ↓
resolve-tools.ts wrapper:
    1. 判斷：tool 不在 modelProcess[]？且不是 cron session？
       → 直送模式
    2. 將 result text 寫成暫存檔：
       {sessionDir}/files/{toolCallId}-{title}.md
    3. Session.updatePart() 寫入 part：
       state.directRender = {
         filePath: "files/{toolCallId}-{title}.md",
         title: "20260407 股票排名",
         size: 52076
       }
    4. Return summary to AI SDK:
       "[File displayed: \"20260407 股票排名\" (52KB)]"
    ↓
processor.ts:
    - output = summary（model 看到的）
    - directRender 已在 part state 裡（UI 讀）
    ↓
Bus → UI:
    - 檢測 part.state.directRender
    - 渲染為檔案連結按鈕（不是 inline 內容）
    - 使用者點擊 → fileview tab 開啟對應檔案
```

### AI 處理模式（cron 或 modelProcess 工具）

```
完全不變 — 現有行為，output 直接進 model context
```

### 模式判斷邏輯

```
if (tool in manifest.modelProcess[]) → AI 處理
else if (session.type === "cron") → AI 處理
else → 直送
```

## Risks / Trade-offs

- **Risk**: 暫存檔寫入和 AI SDK return 之間的時序
  - **Mitigation**: 先寫檔 + updatePart，都完成後才 return summary。同步操作，無 race
- **Risk**: fileview tab 能否處理 markdown 表格
  - **Mitigation**: fileview 已支援 markdown 渲染，需驗證表格顯示品質
- **Risk**: session 目錄下累積大量暫存檔
  - **Mitigation**: 跟隨 session 生命週期清理。或加 TTL（7天）
- **Risk**: cron session 判斷方式
  - **Mitigation**: session metadata 已有 lane/type 資訊，可從中判斷

## Critical Files

- `packages/opencode/src/mcp/manifest.ts` — add `modelProcess` to schema
- `packages/opencode/src/mcp/app-store.ts` — propagate to AppEntry
- `packages/opencode/src/session/resolve-tools.ts` — 核心：直送分叉 + 暫存檔寫入
- `packages/opencode/src/session/message-v2.ts` — ToolPart state 加 `directRender` 欄位
- `packages/opencode/src/session/processor.ts` — 保留已有的 directRender state
- `packages/app/src/pages/session/components/message-tool-invocation.tsx` — 渲染檔案連結按鈕
- `packages/app/src/pages/session/` — fileview tab 整合（可能不需改，已有檔案開啟能力）

## Future Phases

### Phase 2: Rich content in fileview
- Inline images（MCP ImageContent → fileview 內嵌圖片）
- 附件下載按鈕（擴充 fileview tab header）
- HTML 原文 sandbox 渲染（iframe + CSP）

### Phase 3: "交給 AI 分析" 按鈕
- 檔案連結按鈕旁加「AI 分析」按鈕
- 點擊後將 fullOutput 作為新的 user message 送入 model
- User-triggered — 不會自動消耗 token
