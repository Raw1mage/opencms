# Event: session scroll force RCA

Date: 2026-03-09
Status: Completed

## 需求

- 追查為何 webapp 對話頁在使用者已上捲後，仍存在不受控的強制貼底/拉回行為。
- 釐清 page-level、reasoning stream、toolcall stream 之間是哪一條 scroll path 重新奪回控制權。

## 範圍 (IN / OUT)

### IN

- `packages/app/src/pages/session.tsx`
- `packages/app/src/pages/session/use-session-hash-scroll.ts`
- `packages/ui/src/hooks/create-auto-scroll.tsx`
- `packages/ui/src/components/message-part.tsx`
- 必要的 RCA event 記錄

### OUT

- 本輪先不直接修改行為
- 不重構 shell / reasoning renderer

## 任務清單

- [x] 盤點使用者上捲後理應解除 auto-follow 的現行機制
- [x] 找出何處仍會在特定事件下 force scroll
- [x] 輸出最可疑 root cause 與後續修正方向
- [x] 記錄 Architecture Sync 判定

## Debug Checkpoints

### Baseline

- 使用者已觀察到：思考鏈中穿插文字輸出時，畫面像同時受到「保留原位置」與「貼底追最新」兩股力量拉扯。
- 現有理解：系統理論上已有「使用者上捲就解除強制貼底」的保護，但實際上仍出現不受控回拉，表示解除條件未完全覆蓋真實互動路徑。

### Execution

- 先確認「使用者上捲就解除強制貼底」機制確實存在：
  - `packages/ui/src/hooks/create-auto-scroll.tsx` 中，`stop()` 會把 `userScrolled=true`。
  - `MessageTimeline` 在根 scroller 收到向上 wheel 時會呼叫 `autoScroll.pause`。
  - `handleScroll()` 也會在離底部超過 threshold 時將狀態切到 `userScrolled=true`。
- 但追查後發現：這個解除機制**不是絕對的**，因為同一個 hook 裡的 `forceScrollToBottom()` 會在 `scrollToBottom(true)` 路徑中直接把 `userScrolled` 清回 `false`：
  - `packages/ui/src/hooks/create-auto-scroll.tsx`
  - 關鍵行為：`if (force && store.userScrolled) setStore("userScrolled", false)`
- 換句話說，系統目前存在「使用者可暫停 auto-follow」與「其他路徑可無條件把暫停狀態重新打開」兩套邏輯；這正符合使用者觀察到的兩股力量互相拉扯。
- 已定位到的 page-level 強制貼底呼叫源：
  1. `packages/app/src/pages/session.tsx`
     - `resumeScroll()` → `autoScroll.forceScrollToBottom()`
     - prompt dock resize 時若判定 `stick` → `autoScroll.forceScrollToBottom()`
  2. `packages/app/src/pages/session/use-session-hash-scroll.ts`
     - 無 hash 時 `applyHash()` 直接 `forceScrollToBottom()`
     - session 初次 ready 時也直接 `forceScrollToBottom()`
     - 找不到 hash target 時 fallback 再次 `forceScrollToBottom()`
- Tool/task 內層也仍有獨立 auto-scroll：
  - `packages/ui/src/components/message-part.tsx` 的 task/child tool wrapper 仍建立 `createAutoScroll({ working: () => true })`
  - 這不一定是主因，但表示內外兩層 scroll policy 都仍存在。
- 目前最可疑的 root cause 不是「單純 auto-follow 沒有 pause 機制」，而是：
  - pause 機制存在，
  - 但 **多個 `forceScrollToBottom()` caller 仍可在某些 state transition / layout event 中把 `userScrolled` 重設回 false**，
  - 使得後續 reasoning/tool streaming 一更新，`ResizeObserver -> scrollToBottom(false)` 又重新接管畫面。
- 本輪最小修正：
  - 保留只有 `resumeScroll()`（使用者按下回到底部）才會呼叫 `autoScroll.resume()`，明確覆寫 user pause。
  - 其餘原本的 page-level force source 全部降級為尊重 `userScrolled` 的 `scrollToBottom()`：
    - `use-session-hash-scroll.ts`：無 hash fallback、hash miss fallback、session 初次 ready
    - `session.tsx`：prompt dock resize stick 情境
  - 等於把「強制貼底權限」收斂到真正的使用者明確操作，而不是一般 lifecycle / layout 事件。
- 使用者後續觀察補充：真正更明顯的錨點似乎是帶有 spinner 的「思考中」那一列。
- 追查 `packages/ui/src/components/session-turn.tsx` 後確認：
  - 「思考中」文字不是一般內文，而是放在 `data-slot="session-turn-sticky"` 的 sticky trigger 區塊內。
  - 此區塊在 working 狀態時會持續更新 `store.status`（例如 thinking / gathering thoughts / running commands），並同步顯示 spinner。
  - `session-turn-sticky` 本身使用 `position: sticky; top: var(--session-title-height, 0px); z-index: 20;`，是整個 turn 的黏性頭部。
  - 元件還會透過 `ResizeObserver` 持續量測 sticky 區高度，並寫回 `--session-turn-sticky-height` CSS variable，進一步影響 turn 佈局。
- 因此，這行「思考中」確實不是單純文字，而是**具 sticky 定位 + 動態高度量測 + 狀態持續更新**的 header。它非常可能成為瀏覽器與自家 scroll logic 共同選中的 anchor 熱點。
- 目前最可疑的下一層 root cause：
  - reasoning/text streaming 不只在更新內容，還會改變這個 sticky trigger 的 status 文案與高度量測；
  - 當 sticky header 反覆重算時，session viewport 比一般內文更容易被拉回該 turn 附近。
- 後續優先修正方向應先鎖定這個 sticky thinking row，而不是 shell output：
  1. 優先嘗試對 `session-turn-sticky` / `session-turn-response-trigger` 強制 `overflow-anchor: none`
  2. 評估在 working 狀態下凍結 sticky 高度，避免 status 文案更新時連帶改寫 `--session-turn-sticky-height`
  3. 若仍有跳動，再考慮把 thinking status 從 sticky header 拆成非 sticky 顯示
- 本輪先做第一層止血：對 `session-turn-sticky` 與 `session-turn-response-trigger` 加上 `overflow-anchor: none`，優先嘗試切斷瀏覽器把這條「思考中」sticky row 當成 viewport anchor 的機會。
- 依使用者最新回報，進一步改成 **mobile-first 全盤掃描**，重點檢查「PC 不明顯、mobile 明顯」的差異路徑。
- 掃描後的主要嫌疑點如下：
  1. **page-level auto-scroll 仍會在 working 變化時主動貼底**
     - 檔案：`packages/ui/src/hooks/create-auto-scroll.tsx`
     - 關鍵：`createEffect(on(options.working, ...))` 在 `working=true` 時仍會 `scrollToBottom(true)`。
     - 雖然前面已把多個外部 force source 收斂，但 hook 本體在工作開始時仍保留一次強制貼底權限。
  2. **ResizeObserver + content streaming 是 assistant text/reasoning 的直接貼底來源**
     - 檔案：`packages/ui/src/hooks/create-auto-scroll.tsx`
     - 關鍵：`createResizeObserver(() => store.contentRef, ...)` 只要 `active()` 且 `!userScrolled` 就會 `scrollToBottom(false)`。
     - 這條路徑不分 tool/text；assistant 純文字 streaming 一樣會觸發，因此很符合使用者觀察到的「不是 toolcall，而是 agent 輸出文字」第二來源。
  3. **mobile 的 user-intent 偵測比 desktop 脆弱**
     - 檔案：`packages/app/src/pages/session/message-timeline.tsx`
     - desktop：`onWheel(delta < 0)` 很直接就會 `props.onAutoScrollUserIntent()`。
     - mobile：只在 `onTouchMove` 且 `delta < 0`（手指向下拖）時才 pause；若使用者是輕微拖曳、慣性滾動、或先被程式拉動後再 scroll，這條件很可能沒有穩定命中。
     - 再加上 `onScroll` 內只有 `hasGesture` 為真時才會 `props.onAutoScrollHandleScroll()`，使 mobile 比 desktop 更容易漏掉「使用者已奪回控制權」的判定。
  4. **mobile 不跑 scrollSpy，但這反而凸顯 auto-scroll hook 本身就是主嫌**
     - 檔案：`packages/app/src/pages/session/message-timeline.tsx`
     - `if (props.isDesktop) props.onScrollSpyScroll()`，表示 mobile 沒有 scrollSpy 主動干預；若 mobile 仍嚴重跳動，更指向 page-level auto-scroll / touch 判定，而不是 scrollSpy。
  5. **多個 sticky 結構在 mobile viewport 內更容易成為 anchor 熱點**
     - `data-session-title`（頁首 sticky）
     - `session-turn-sticky`（thinking / response trigger sticky）
     - `sticky-accordion-header`（steps 區塊 sticky）
     - 小螢幕 viewport 較短，sticky 區塊佔比更高，因此同樣的 layout 變動在 mobile 更容易造成「兩個錨點打架」的體感。
  6. **session-level diff preload 與 prompt dock resize 不是本輪主嫌，但仍會製造額外 resize 噪音**
     - `session.tsx` 中 `sync.session.diff(id)` preload
     - prompt dock `ResizeObserver`
     - 目前它們較像次級放大器，不像 assistant text streaming 那麼直接。
- 目前 mobile 專屬/優先可疑排序：
  1. `create-auto-scroll.tsx` 的 `working=true -> scrollToBottom(true)`
  2. `create-auto-scroll.tsx` 的 `ResizeObserver -> scrollToBottom(false)` for streaming text
  3. `message-timeline.tsx` 的 mobile touch pause 條件過窄
  4. sticky thinking row / sticky headers 作為 anchor 放大器
- 本輪依 mobile 掃描結果先做兩個低風險修正：
  1. `create-auto-scroll.tsx`
     - 將 `working=true` 時的初始貼底從 `scrollToBottom(true)` 降級為 `scrollToBottom(false)`，避免工作開始瞬間覆寫 user authority。
  2. `message-timeline.tsx`
     - mobile `onTouchStart` 先標記 scroll gesture。
     - mobile `onTouchMove` 只要有實際位移就直接視為 user intent，不再限定 `delta < 0`。
     - mobile `onScroll` 不再依賴 `hasGesture` 才呼叫 `onAutoScrollHandleScroll()`，改為一律讓 auto-scroll hook 重新判定，以涵蓋觸控慣性與先前漏判情境。
- 使用者再補充症狀後，已可更精確區分成兩組錨點：
  1. 「思考中」sticky row（第一錨點）
  2. 每個有新 output 的 toolcall / task tool 區（第二錨點）
- 針對第二錨點追查 `packages/ui/src/components/message-part.tsx` 後確認：
  - task tool wrapper 內原本另外建立了一套 `createAutoScroll({ working: () => true, overflowAnchor: "auto" })`
  - 並將 `tool-output` 容器接上 `scrollRef / contentRef / handleScroll`
  - 代表 child tool 列表在 streaming 更新時，**自己也有一層獨立的 auto-follow**。
  - 這與 page-level session auto-scroll 疊加後，非常符合「跳到 toolcall，再跳回 thinking row」的症狀。
- 本輪額外修正：
  - 直接移除 task tool wrapper 的內層 `createAutoScroll` 綁定。
  - child tool list 改為普通 `tool-output` 容器，只保留 `overflow-anchor: none`，不再主動搶 viewport。
  - 目標是先把 tool-level scroll ownership 全部拔掉，讓 session page 成為唯一的上層 scroll 決策者。
- 依使用者要求加入前端 scroll debug instrumentation，方便直接觀察 page scroll 行為：
  - `create-auto-scroll.tsx` 現在會輸出 `[scroll-debug]` 事件，包含：
    - `scroll-request`
    - `scroll-apply`
    - `scroll-blocked-user`
    - `resize-follow`
    - `resize-blocked-user`
    - `working-start`
    - `working-stop`
    - `handle-scroll-user/auto/bottom-zone`
    - `resume`
  - `session.tsx` 將 page-level auto-scroll scope 命名為 `session-page`
  - `session-turn.tsx` 會額外記錄 sticky thinking row 的 `sticky-height` 更新
  - 啟用策略：`dev-refresh` build 也會開啟；若要關閉可在 browser console 執行 `localStorage.setItem("opencode:scroll-debug", "0")`
  - 額外提供自動 ring buffer：最近 300 筆事件會存進 `window.__scrollDebugBuffer`
  - 可在 console 執行 `window.__dumpScrollDebug()` 或 `window.__dumpScrollDebug({ last: 120, scope: "session-page" })` 直接匯出關鍵事件
- 依使用者要求，再往前一步加上主動寫入後端 `debug.log` 的 bridge：
  - 前端會將 scroll-debug 事件先進 ring buffer，再以小批次 POST 到 server `/log`
  - server side service 名稱：`webapp.scroll-debug`
  - 可在既有 debug log 中搜尋 `frontend scroll debug batch`
  - 目的：即使 console 很難手動抓，也能在 `debug.log` 裡回放當時事件序列
- 首次橋接實測發現 `POST /log` 回傳 403，根因是 web auth mutation 需要 CSRF header 且 webapp 實際應走 `/api/v2/log`。
- 本輪修正：
  - bridge endpoint 改為 `/api/v2/log`
  - request 加上 `credentials: "include"`
  - 由 `web-auth` context 將當前 CSRF token 暴露給 `window.__opencodeCsrfToken`，供 scroll debug bridge 帶入 `x-opencode-csrf`
- 為避免 transport failure 被靜默吞掉，bridge 再補一層可觀測性：
  - `window.__lastScrollDebugFlush` 會記錄最近一次 flush 成功/失敗狀態
  - console 會明確輸出 `[scroll-debug] flush ok` / `[scroll-debug] flush failed`
  - 失敗批次會回塞 queue，避免事件直接遺失
- 透過 ring buffer 抓到 oscillation 期間的關鍵序列後，已可確認主手是 `session-page resize-follow -> scroll-request -> scroll-apply`，且當時 `userScrolled` 持續為 `false`。
- 本輪進一步加入 **near-bottom hard guard**：
  - `create-auto-scroll.tsx` 的 `ResizeObserver` 路徑除了 `userScrolled` 之外，還必須滿足 `distanceFromBottom <= followThreshold` 才允許 `resize-follow`
  - 若已明顯離底（即使 `userScrolled` 漏判仍是 false），事件會改記錄為 `resize-blocked-distance`
  - 目標是阻止長頁面中段閱讀時因 content growth 被 page-level auto-follow 重新拖走
- 經使用者再次確認後，策略改為更直接：session page 不應因內容新增而自動貼底。
- 本輪將 `session.tsx` 的 page-level `createAutoScroll` 額外設定 `followOnResize: false`，直接停用 session page 的 `ResizeObserver -> resize-follow` 自動貼底路徑。
- 這代表新增的 toolcall output / reasoning text / assistant text 不再透過 page-level resize 事件主動把 viewport 拉到底；若仍有跳動，剩餘嫌疑就能更純粹聚焦到 sticky 錨點或其他顯式 scroll source。

### Validation

- 檢查依據：
  - `packages/ui/src/hooks/create-auto-scroll.tsx`
  - `packages/app/src/pages/session.tsx`
  - `packages/app/src/pages/session/use-session-hash-scroll.ts`
  - `packages/ui/src/components/message-part.tsx`
- 驗證指令：`bun turbo typecheck --filter @opencode-ai/ui --filter @opencode-ai/app`
- 結果：passed
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪僅收斂 session auto-scroll 呼叫時機與測試命名，未改變架構邊界、API contract 或模組責任。
