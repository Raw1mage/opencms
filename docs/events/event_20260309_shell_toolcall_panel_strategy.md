# Event: shell toolcall panel strategy

Date: 2026-03-09
Status: Completed

## 需求

- 評估 shell toolcall 是否應脫離目前 message flow 內嵌渲染模式。
- 在盡量保留現有資訊流架構下，規劃更穩定的 shell 子頁框/面板方案。
- 控制重構風險，避免為解決捲動鎖定問題而破壞整體 session UI。

## 範圍 (IN / OUT)

### IN

- shell toolcall 顯示模式選項分析
- session feed / shell panel scroll ownership 風險評估
- 低風險演進方案建議

### OUT

- 本輪不直接實作新 panel
- 不改動後端 shell tool 執行邏輯
- 不重設整個對話頁資訊架構

## 任務清單

- [x] 盤點現行 shell toolcall 的顯示/捲動 ownership
- [x] 比較內嵌、浮動、停靠 panel 等方案的相容性與風險
- [x] 提出最小風險的演進建議
- [x] 記錄 Architecture Sync 判定

## Debug Checkpoints

### Baseline

- 使用者觀察到：只要 shell toolcall 區塊在 streaming 更新，主對話頁 scroll 位置可能被重新拉回特定定點。
- 需求重點不是追求炫技 UI，而是找出一個不會輕易破壞既有資訊流、又能隔離 shell 動態輸出的穩定方案。

### Execution

- 現況盤點：
  - `bash` toolcall 本身使用的是 `BasicTool` 的一般 compact trigger；真正的多行內容在展開後的 `tool-output` 區塊。
  - 也就是說，shell 與 grep 問題不同；shell 的風險點不在 trigger，而在「持續 streaming、會增高的輸出區塊」仍掛在主 message flow 裡。
  - page-level session 仍有 `createAutoScroll(...)` 與 `overflow-anchor` 管理；即使已停用部分 auto-follow，streaming shell block 仍可能與瀏覽器 scroll anchoring / layout reflow 打架。
- 方案比較：
  - **A. 維持內嵌，只繼續補 scroll/anchor**
    - 優點：改動最小。
    - 缺點：治標不治本；shell block 仍在主資訊流內增高，後續很容易再出現 viewport ownership 問題。
  - **B. 完全改成 modal/floating window**
    - 優點：隔離最徹底。
    - 缺點：互動模型變太大，與現有 session feed 的可回顧性/上下文連續性衝突，重構風險高。
  - **C. 採 docked panel / drawer（推薦）**
    - session feed 仍保留 shell toolcall 的 task line 與狀態。
    - 真正 streaming output 改由獨立 panel 承接（底部 dock 或右側 drawer）。
    - 用 panel 接管 shell output 的 scroll ownership，讓主對話頁只負責閱讀與定位訊息。
- 推薦結論：
  - 經使用者偏好修正後，本輪最終不採 docked panel / drawer。
  - 目標改為：**保留 inline shell window，但將其升級為專用 shell-stream component**，不再用一般 `tool-output + markdown` 模型硬撐。
- 重新設計方向：
  1. **Inline Shell Stream Component**
     - feed 中仍保留 shell toolcall 位置與上下文連續性。
     - 但展開內容改為專用 `ShellStreamView`，而不是普通 markdown block。
  2. **雙層 scroll ownership**
     - 主 session scroller：只負責整個對話頁閱讀位置。
     - shell stream scroller：只在使用者明確聚焦 shell block 時才接管內部 follow-bottom。
     - 規則：shell stream 更新不得主動改變主 session viewport。
  3. **Follow state machine**
     - `attached`: 使用者停留在 shell block 底部，可跟隨新輸出。
     - `detached`: 使用者已往上閱讀或離開該 block，後續 streaming 只更新內容，不推動任何外層 scroll。
     - `resume`: 僅在使用者明確點擊「Jump to latest」或回到底部時，才恢復 attached。
  4. **Stable height model**
     - shell block 需要明確的 preview / expanded 高度策略。
     - Expanded 後也不應無限撐高主 feed；應改為受控 max-height + block-internal scrolling。
     - 關鍵不是回到舊的 nested scroll jail，而是只有 shell block 自己在 focus / hover / active 時才吃內層滾輪。
  5. **Renderer strategy**
     - streaming text 與 terminal-like viewport 分離：
       - data model 繼續 append output
       - UI renderer 改為 terminal-aware view（可保留 markdown/code 外觀，但不可再直接把整段 streaming text 當普通 block 反覆重排）
     - 優先考慮 append-only DOM / chunked render / virtual line buffer，降低每次更新造成的大面積 reflow。
- 建議演進路徑：
  1. **Phase 1: ownership hardening（最低風險）**
     - 抽出 `ShellStreamView` 元件，但先沿用現有資料來源。
     - 明確切斷 shell streaming 對主 session viewport 的任何 `scrollToBottom` / anchoring 影響。
     - 增加 `attached / detached` 狀態與「Jump to latest」控制。
  2. **Phase 2: stable expanded layout**
     - 讓 shell expanded view 使用受控高度，而不是持續增高整個訊息卡。
     - 內層 scroll 只在使用者真的與 shell block 互動時生效。
  3. **Phase 3: render optimization**
     - 視需要導入 append-only line list / terminal-aware renderer，減少 streaming 時的 layout thrash。
  4. **Phase 4: polish**
     - copy / select / pause follow / reopen latest output 等體驗強化。

### Validation

- Design / architecture review only; no code changes in this event.
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪僅完成 shell toolcall UI 模式與風險分析，未修改任何 runtime module 或 API。
