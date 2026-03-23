# Design

## Context
- OpenCode TUI 的消息加載當前為一次性同步拉取（limit=100），長 session 加載緩慢
- 後端 `MessageV2.stream()` 已實作反向迭代（最新優先），但 `Session.messages()` 等全部讀完才返回
- `filterCompacted()` 已能偵測 compaction 邊界，但僅用於 AI prompt 組裝，TUI 不使用
- TUI scrollbox 已有 `stickyStart="bottom"` 支援，理論上 prepend 不會跳動

## Goals / Non-Goals
**Goals:**
- 後端提供 cursor-based pagination，支援增量拉取
- TUI 實現兩階段加載（快速 + 背景補齊）
- TUI 利用 compaction 邊界減少初始加載量
- 整體改動最小化，不破壞現有 compact/prune/sync 流程

**Non-Goals:**
- 虛擬滾動（需 Ink 渲染引擎級改造）
- 修改 compact 觸發邏輯
- 重構 Storage 層

## Decisions

### DD-1: Cursor 設計選擇 — Message ID cursor
使用 message ID 作為 cursor（而非 offset 數字），因為：
- Storage key 已按 message ID 排序，天然支援 range query
- 避免 offset 在並發寫入時的 drift 問題
- `MessageV2.stream()` 反向迭代的現有邏輯只需加入 skip-until-cursor

### DD-2: 兩階段加載的批次大小 — 初始 20 條 + 每批 20 條
- 初始 20 條足以填滿典型終端可見區域（約 40-60 行高度）
- 每批 20 條平衡了 API 呼叫次數和單次 payload 大小
- 可通過 config 調整（但 Phase 1 不暴露配置）

### DD-3: Compaction 邊界作為加載上界
- TUI 初始加載止步於最近 compaction 邊界，而非固定 limit
- 理由：compaction 之前的消息對用戶的即時工作上下文價值低，tool output 已被清除
- 用戶仍可按需展開，保留完整歷史的可及性

### DD-4: sync store 的增量更新策略
- 使用 SolidJS `produce()` + `reconcile()` 進行增量 prepend
- `store.message[sessionID]` 前插新批次時，reconcile 的 `key: "id"` 確保不重複
- 需要一個 `loadingOlder` signal 控制背景加載的進度狀態

### DD-5: Compaction 邊界 UI 使用現有 compaction 元件擴展
- 現有 `<Show when={compaction()}>` 在 UserMessage 中已能渲染 compaction 標記
- 擴展此元件加入互動按鈕，而非建立全新元件
- 保持視覺一致性

## Data / State / Control Flow

### 加載流程
```
用戶進入 session
  → sync() 第一階段
    → GET /session/:id/message?limit=20
    → 渲染最新 20 條，用戶可立即操作
  → sync() 第二階段（背景）
    → GET /session/:id/message?limit=20&cursor=<oldest_loaded_id>
    → prepend 到 store，scrollbox 維持位置
    → 重複直到遇到 compaction 邊界或無更多消息
  → 用戶點擊「載入更早消息」
    → GET /session/:id/message?limit=20&cursor=<compaction_boundary_id>
    → prepend，繼續到下一個 compaction 邊界或起點
```

### API 回應結構擴展
```typescript
// 現有
type MessagesResponse = MessageV2.WithParts[]

// 擴展為
type MessagesResponse = {
  messages: MessageV2.WithParts[]
  cursor?: string          // 下一頁 cursor（如果還有更多）
  compactionAt?: string    // 最近 compaction 邊界的 messageID
}
```

注意：這是 breaking change。需要同時更新 SDK client types 或用 response header 傳遞 cursor metadata。

**替代方案**（更保守）：保持 response body 為 `MessageV2.WithParts[]`，用 response header 傳遞分頁元數據：
```
X-Cursor-Next: <messageID>
X-Compaction-At: <messageID>
```

→ 選擇 header 方案，避免 breaking change。

## Risks / Trade-offs

### R-1: scrollbox prepend 視口穩定性（中風險）
- Ink scrollbox 的 `stickyStart="bottom"` 是否在 prepend 子元素時穩定維持視口尚未驗證
- **Mitigation**: Phase 2 開始前先建立 PoC 驗證 scrollbox 行為；若不穩定，可在 prepend 前後手動計算並校正 scroll offset

### R-2: 並發加載與即時消息的 race condition（低風險）
- 背景加載舊消息期間，如果 AI 正在回應產生新消息，store 的 reconcile 可能出現順序問題
- **Mitigation**: 背景加載只 prepend（插入到 array 前端），即時消息只 append（插入後端），兩者不衝突

### R-3: API response 結構變更（低風險）
- 選用 header 方案傳遞 cursor metadata，避免 body breaking change
- **Mitigation**: cursor header 是 opt-in，不帶 cursor 參數時行為完全向下相容

### R-4: 短 session 性能退化（極低風險）
- 短 session（≤20 條）直接一次載完，不觸發第二階段
- **Mitigation**: 第一階段返回量 < limit 時，skip 第二階段

## Critical Files
- `packages/opencode/src/session/index.ts:711` — Session.messages() 需加 cursor 參數
- `packages/opencode/src/session/message-v2.ts:669` — MessageV2.stream() 需加 skip-until 邏輯
- `packages/opencode/src/session/message-v2.ts:702` — filterCompacted() 參考邏輯
- `packages/opencode/src/server/routes/session.ts:1335` — HTTP route 分頁 params
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx:707` — sync() 兩階段改造
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1014` — 消息列表渲染
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1256` — compaction UI 擴展
