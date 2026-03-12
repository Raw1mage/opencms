# Event: webapp scroll ownership refactor

Date: 2026-03-10
Status: In Progress

## 需求

- 將 webapp session scroll 行為重構成明確的雙模式：自由閱讀 / 自動追底。
- 取消目前分散在 page / sticky / tool / steps 之間的隱性 auto-focus / auto-follow 搶權。
- 以使用者閱讀權威為最高優先，只有顯式 resume follow 才能重新接管最外層捲動。

## 範圍 (IN / OUT)

### IN

- `packages/ui/src/hooks/create-auto-scroll.tsx`
- `packages/app/src/pages/session.tsx`
- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/ui/src/components/session-turn.tsx`
- 必要的 debug / verification instrumentation
- 事件與 architecture sync 記錄

### OUT

- 不重寫後端 session/event protocol
- 不更動 tool execution semantics
- 不做新的 UI redesign（僅修正 scroll ownership 與控制模式）

## 任務清單

- [x] 定義 scroll ownership 雙模式 contract
- [x] 盤點並關閉既有隱性 auto-focus / auto-follow source（Phase 1 首輪）
- [x] 建立單一 page-level follow controller gate（Phase 1 首輪）
- [ ] 驗證自由閱讀模式不再被打斷
- [ ] 驗證 resume follow 可正確回到底部
- [ ] Architecture Sync 檢查

## 雙模式規格（初版）

### Mode A: Free Reading

- 觸發：使用者任何手動閱讀/捲動行為，或顯式離底。
- 契約：
  - page-level viewport 不得因 content growth 自動位移
  - sticky/status/tool/steps 只能更新內容，不能搶 outer scroll
  - 新資料到達僅更新內容，不改變閱讀位置

### Mode B: Follow Bottom

- 觸發：使用者明確點擊「回到底部」或等價 resume 動作。
- 契約：
  - 只有單一 page-level controller 可更新 outer scrollTop
  - 其他局部元件（sticky/tool/steps）不得各自做 auto-focus
  - follow 位置必須以最外層 session scroller 為唯一真相來源

## 目前 root cause 摘要

- 既有實作同時存在：
  - page-level resize follow
  - sticky thinking row height reflow
  - tool/task/steps 區的局部更新副作用
- 這些路徑在 streaming 過程中會對同一個 viewport 提出不同定位意圖，形成 oscillation。

## 分期策略

### Phase 1: Stop Hidden Auto-Focus

- 停用 session page 的 resize-follow。
- 拔除 tool/task wrapper 的局部 auto-follow。
- 保留 instrumentation，確認 page-level 強制貼底已消失。

### Phase 2: Reading Authority Hard Lock

- 將 user reading state 升格為明確 mode，而不是脆弱旗標。
- 任何 sticky/steps update 都不能覆寫該 mode。

### Phase 3: Explicit Resume Follow

- 只允許顯式 resume 動作切回 follow-bottom。
- follow-bottom 由單一 controller 執行，統一計算 outer page bottom。

### Phase 4: Cleanup / Doc Sync

- 回收臨時 debug/instrumentation 或收斂為正式 observability contract。
- 同步 `docs/ARCHITECTURE.md`（若 scroll ownership contract 成為穩定架構事實）。

## Debug Checkpoints

### Baseline

- 已確認純 agent 文字輸出在無 toolcall 干擾時可順暢貼底。
- 真正問題出現在 thinking/sticky/steps/tool updates 共同存在時的 focus/anchor 搶權。
- 已確認 `session-page resize-follow` 是主要強制力來源之一。
- 新增使用者重現條件（phase3 後續觀察）：
  - 在 `follow-bottom` 模式下，若較上方已有展開中的卡片，且下方持續 streaming 新內容，畫面仍可能出現快速 scroll oscillation。
  - 使用者肉眼觀察不到具體是哪一塊在振動，但症狀符合「外層 page follow 與內層展開卡 anchoring/scroll state」互相競爭。
- 補充後續觀察：即使未立即復現 oscillation，只要上方有展開卡，追底也可能「追不夠底」，使最新內容局部落到可視範圍外。
- 最新使用者觀察：在追底模式下，瀏覽器似乎會把錨點吸附到最後一個「文字類型」段落，而不是整個 growing bottom；當下方 toolcall/card 持續增生時，就形成最後文字段落固定、真正底部繼續往下長的錯位，進而導致 oscillation 或 under-follow。
- 最新補充觀察：在所有 toolcall 結束、進入純文字回覆 streaming 的階段，只要使用者自己的 prompt window 處於展開態，且思考鏈也展開，viewport 震盪位置會鎖在中下方、靠近該 prompt window；症狀像是想追最新文字、卻瞬間被拉回 prompt window。
- 使用者補充截圖：震盪區間可視上並不是「整頁底部附近亂跳」，而是明顯在同一個 session turn 內的兩段內容之間切換：上方偏 toolcall / read 區塊，與下方偏純文字 response 區塊；底部 prompt dock 只是參考邊界，不一定是唯一主因。

### Execution

- Phase 1 已先落地三個關鍵 gate：
  1. `session.tsx`
     - session page 的 `createAutoScroll(...)` 改為 `followOnResize: false`
     - 代表 page-level `ResizeObserver -> resize-follow` 不再因新增內容自動貼底
  2. `create-auto-scroll.tsx`
     - 新增 `followOnResize` / `resumeOnly` 選項
     - session page 目前採 `resumeOnly: true`，只有顯式 resume 才能清除 detached 狀態
  3. `message-part.tsx`
     - task tool wrapper 內層 auto-scroll 綁定已移除
     - child tool list 僅保留普通 scrollable output，不再主動搶 viewport
- 目前等同完成第一輪「先關掉所有隱性 auto-follow，再逐步重建雙模式」的 Phase 1 目標。
- Phase 2 首輪補強（reading authority hard lock）：
  1. `session-turn.tsx`
     - 新增 `stickyDisabled = working() || props.stepsExpanded`
     - working / steps-expanded 期間，sticky height 直接歸零，不再參與外層 sticky 量測
  2. `session-turn.css`
     - `session-turn-sticky[data-sticky-disabled="true"]` 改為普通 flow block，取消 sticky 定位與 gradient tail
  3. 目標
     - 當「思考中」動畫列與展開步驟持續更新時，不再用 sticky header 形式競爭 outer viewport
- Phase 2 第二輪收斂（explicit reading mode）：
  1. `create-auto-scroll.tsx`
     - 將原本隱含的 `userScrolled: boolean` 提升為明確 `mode: "follow-bottom" | "free-reading"`
     - `pause()/user-stop` 一律切到 `free-reading`
     - `resume()` 一律切回 `follow-bottom`
     - 在 `resumeOnly: true` 的 session page 上，到達底部本身不再隱式奪回 follow ownership；只有顯式 resume 才能切回 follow-bottom
  2. `session.tsx`
     - 補充 page-level mode debug，讓 Phase 2 驗證時可直接觀察目前處於 `free-reading` 或 `follow-bottom`
  3. 目標
     - user reading authority 不再只是脆弱的距底判斷，而是明確模式狀態
     - sticky/steps/resize 等更新只能在既有 mode 下運作，不能偷偷覆寫閱讀模式
- Phase 3 首輪收尾（explicit resume flow becomes real）
  1. 根因
     - 對話中間的向下箭頭按鈕雖然已接到 `resumeScroll() -> autoScroll.resume()`，但 session page 先前把 `followOnResize` 全域關掉，導致該按鈕只能「跳到底一次」，之後 streaming 新內容不會持續追底。
  2. `session.tsx`
     - session page 改回 `followOnResize: true`
  3. `create-auto-scroll.tsx`
     - resize-follow 不再單靠距底閾值決定是否追底
     - 在 `resumeOnly: true` 的 explicit mode flow 下，只要目前不在 `free-reading`，content resize 便可持續維持 bottom lock
     - `free-reading` 仍由 `userScrolled()/mode` 硬鎖保護，因此不會重現先前「一旦被判成未脫底就整頁搶權」的問題
  4. 目標
     - 向下箭頭按鈕成為真正有效的 resume 入口：按下後不只回到底一次，而是重新進入可持續 follow-bottom 的 streaming 狀態
- Phase 3 第二輪偵查（expanded card oscillation hypothesis）
  1. 新假設
     - 問題不一定只剩 sticky；更可能是上方展開卡內部的 nested scrollable region（`data-scrollable`）仍保有自己的 anchoring/scroll state，與 page-level follow-bottom 競爭。
  2. 最小收斂方向
     - 先關閉 `tool-output[data-scrollable]` 這類內層展開卡的 `overflow-anchor`
     - 讓 outer session scroller 在 follow-bottom 模式下成為唯一 anchor owner
  3. 後續補強（under-follow after late layout）
     - 即使同一拍已執行 `resize-follow`，上方展開卡的晚到 layout 仍可能讓 page-level target 變大，造成「已追底但其實還差一截」
     - `create-auto-scroll.tsx` 現改為在 `resize-follow` 後再排一個下一幀 `deferred-follow` 檢查；若新的 `distanceFromBottom` 仍大於 1，就再補一次 bottom lock
  4. 最新假設（last text segment anchoring）
     - 除 `tool-output[data-scrollable]` 外，`text-part` / `reasoning-part` 本身也可能被瀏覽器選成 scroll anchor。
     - 當最後一個文字段落停止生長、但底下 toolcall/card 繼續生長時，anchor 會停在該文字段落，造成「追底 target 被算成最後文字段落附近，而不是整個容器底部」。
     - 最小修正：對 `text-part` / `reasoning-part` 也明確加上 `overflow-anchor: none`。
  5. 最新重現收斂（shell toolcall vs previous shell window）
     - 使用者觀察到 oscillation 更集中在「最新 shell toolcall（底部）」與「前一個 shell toolcall window」之間。
     - 只要 toolcall 處於執行中且畫面持續更新，就容易進入震盪。
     - 這強化了另一個假設：不只是文字段落，連整張 `Collapsible` tool 卡本身也可能被瀏覽器選為 scroll anchor。
     - 最小修正：對共用 `collapsible` 與其 `collapsible-content` 也明確加上 `overflow-anchor: none`，讓 shell/tool cards 不再參與 anchor ownership。
  6. Shell-specific instrumentation
     - 在 `BashToolOutput` 內新增 `shell-toolcall` scroll debug checkpoints：
       - `bash-output-text-update`
       - `bash-output-resize`
       - `bash-output-expand`
       - `bash-output-collapse`
     - 每筆事件都會記錄：
       - shell card 高度 / clientHeight / viewport rect
       - expanded / canExpand
       - outer `.session-scroller` 的 `scrollTop / scrollHeight / clientHeight / distanceFromBottom`
       - shell command/description 摘要（`debugLabel`）
     - 目的：下次一旦復現，可直接判定是最新 shell 卡還是前一張 shell 卡觸發 reflow 與 anchor 競爭。
  7. User prompt window anchoring hypothesis
     - 由於震盪在「純文字回覆 streaming」階段仍可發生，且視窗主要鎖在展開中的 user prompt window 附近，代表不是只有 shell/tool cards 會成為錯誤 anchor。
     - 最小修正：將 `user-message` 整塊也標記為 `overflow-anchor: none`，避免展開中的 prompt window 被瀏覽器當作 anchor candidate。
  8. Bottom-trace instrumentation
     - `create-auto-scroll.tsx`
       - 額外記錄 `bottom-formula` 事件，直接輸出 `scrollTop / scrollHeight / clientHeight / distanceFromBottom / maxScrollTop / threshold`
       - `scroll-apply` 現區分 `before / after-scrollTo / after-assignment`，可看出每次寫 `scrollTop` 前後的真實值變化
     - `session.tsx`
       - 額外記錄 page-level `update-scroll-state`
       - 額外記錄 `prompt-dock-resize`，觀察 prompt dock 高度變化是否在追底判定中扮演角色
     - `message-part.tsx`
       - `user-message` 額外記錄 `user-message-resize / expand / collapse`
       - `bash-output` 已額外記錄 `bash-output-text-update / resize / expand / collapse`
     - `session-turn.tsx`
       - `sticky-height` 現額外帶上 `working / stepsExpanded / stickyDisabled / distanceFromBottom`
     - 目的：把「底怎麼算、誰改了它、誰在同一時間改高度」串成單一可追 trace，而不是只靠肉眼觀察症狀猜測。
  9. Auto-capture instrumentation
     - `scroll-debug.ts` 現在會對 `session-page` recent events 做輕量模式偵測：
       - `oscillation`：短窗口內 `distanceFromBottom` 在 near-bottom / far-from-bottom 之間反覆切換，且伴隨多次 `scroll-apply`
       - `under-follow`：在 `follow-bottom` 模式下，連續多筆事件仍維持顯著 `distanceFromBottom > 24`
       - `conclusion-stream-instability`：在 follow-bottom 下進入純文字結論 streaming 階段時，即使未達強 oscillation，也只要連續出現 `resize-follow / scroll-apply / bottom-formula` 並伴隨明顯 `distanceFromBottom` 波動，就先抓樣本
     - 一旦命中，會自動插入 `scope="scroll-auto-capture" / event="auto-capture"` 事件，附上最近一段 page-level metrics 摘要，並立即嘗試 flush
     - 目標：盡量不需要使用者手動開 console dump，也能在復現瞬間保住最關鍵的 evidence slice
     - 額外快速檢索契約：
       - `auto-capture` 現帶固定 marker：`OPENCODE_SCROLL_AUTO_CAPTURE`
       - 同時會把最後一次 capture 摘要寫入 `localStorage["opencode:scroll-auto-capture:last"]`
       - 之後使用者只要回報「發生了」，即可優先從固定 marker / localStorage 摘要定位，不必再對整個 session storage 做慢速全域掃描
  10. Server-side retained capture path
      - 為了避免 auto-capture 只存在於前端 buffer 或一般 `/api/v2/log` 大海撈針，新增專用 retained path：
        - `POST /api/v2/experimental/scroll-capture`
        - `GET /api/v2/experimental/scroll-capture/latest`
      - 後端固定落點：`${Global.Path.log}/scroll-capture-latest.json`
      - 保留策略：`latest` + `recent[0..9]`
      - 目的：當使用者只說「發生了」時，可直接讀固定檔或 hit 固定 endpoint，不必再掃整份 debug.log
  11. Turn-internal block tracing
      - 根據 retained capture + 使用者截圖，假設從「prompt dock / shell 卡」再收斂到「同一個 session turn 內的 toolcall block 與 response block 之間的 anchor 競爭」。
      - 新增 page-level `viewport-blocks` debug 事件：每次更新 scroll state 時，記錄目前 viewport 內最靠近上緣的幾個 block 候選：
        - `session-turn-sticky`
        - `session-turn-collapsible-content-inner`
        - `session-turn-summary-section`
        - `user-message`
      - 新增 turn-level `section-metrics` debug 事件：對 `sticky / steps / summary` 三塊在 resize / render 後記錄：
        - rect top / bottom / height
        - 相對 scroller 的 top / bottom
        - 當下 scroller `scrollTop / scrollHeight / clientHeight / distanceFromBottom`
      - 目的：下次 retained capture 命中時，不只知道 root scroller 被回拉，也能知道「回拉瞬間 viewport 正在貼哪一塊、哪一塊剛改高度」。
  12. Retained payload enrichment
      - 為避免 `viewport-blocks / section-metrics` 又掉回 generic `/api/v2/log` 難以檢索，`scroll-debug.ts` 現在會把以下資訊直接併入 retained capture payload：
        - `latestViewportBlocks`
        - `recentTurnLayout`
        - `recentStickyMetrics`
      - 目的：之後使用者只說「發生了」，即可直接從 `scroll-capture-latest.json` 查看 block-level 證據，不必再依賴 batch log 搜索。
  13. Evidence-based anchor suppression on steps block
      - 後續 retained captures（含使用者回報的零星回跳）持續顯示：
        - `recentTurnLayout` 幾乎全部是 `section: steps`
        - `stepsExpanded: true`
        - `working: true`
        - `relativeBottom` 長時間固定在 ~`1053px`
      - 判讀：展開中的 steps block 很像被當成 scroll restore / anchor owner。
      - 最小修正：對 `session-turn-collapsible-content-inner` 新增 `overflow-anchor: none`，先阻止外層 root scroller 在 follow-bottom 模式下被這個 steps container 搶走 anchor 所有權。
  14. Structural simplification experiment (remove collapsible ownership)
      - 使用者提出新的根治方向：放棄思考鏈/steps 的收折功能，不再讓 streaming 中的 thought/tool/reasoning 內容待在可收折容器與其 sticky trigger 契約內。
      - 本輪實作先採最小結構版本：
        - assistant steps/tool/reasoning 永遠直接渲染
        - 不再顯示 steps expand/collapse trigger
        - `hideReasoning` 改為固定顯示
        - `stickyDisabled` 改為固定停用，避免 sticky header 參與 outer scroll ownership
      - 使用者新增版位要求：平鋪出的 steps 內容必須位於「思考中 / 狀態動畫行」上方；因此狀態列改成單獨的 `session-turn-status-inline`，放在 steps 區塊之後，作為 working/retry 階段的底部狀態行。
  15. Tool-card focused mitigation
      - 使用者提供新症狀：畫面原本可正常追底，但一進入「修補 / patch」這類工具卡片階段，就開始跳回最後輸入點附近。
      - 直接回找畫面對應 source 後，鎖定：
        - `packages/ui/src/components/message-part.tsx` 的 `apply_patch` tool card
        - `packages/ui/src/components/basic-tool.tsx` / `collapsible.tsx`
        - `packages/ui/src/components/basic-tool.css` 中 `[data-component="tool-trigger"] { content-visibility: auto; }`
      - 本輪最小修正：
        - 移除 `tool-trigger` 的 `content-visibility: auto`
        - 新增 `BasicTool.flat` 路徑，working 中的 tool card 直接 inline 顯示，不再走 `Collapsible.Trigger/Content`
        - `ToolPartDisplay` 對 `part.state.status !== "completed"` 的 tool 一律傳入 `flat`
      - 目的：避免 mobile / 長串流 / tool card 掛載時，由 collapsible + deferred layout（content-visibility）共同觸發 scroll jump。
  16. Mobile-specific prompt dock repair
      - 使用者確認：桌機版已大致穩定，只剩少量 under-follow；手機版在同一 session 仍非常容易 oscillation。
      - 新判讀：手機版較容易受 browser chrome / visual viewport / safe-area 變化影響，而 `promptDock` 又是 absolute bottom 疊加層，且 resize 後會直接影響：
        - `--prompt-height`
        - session feed bottom padding
        - resume button bottom offset
        - `stick` 成立時的 `autoScroll.scrollToBottom()`
      - 本輪最小 mobile repair：
        - 新增 `mobileScrollRepair = !isDesktop()` 分支
        - `status !== idle` 期間凍結 `mobilePromptHeightLock`
        - mobile + working 時，`promptDock` resize 只記錄 `measured`，但 layout 使用鎖定高度
        - mobile + working 時，停用 `promptDock` resize 觸發的 `autoScroll.scrollToBottom()`
        - `prompt-dock-resize` debug 事件補記：
          - `promptHeightMeasured`
          - `mobileLocked`
          - `innerHeight`
          - `visualViewportHeight`
          - `visualViewportOffsetTop`
          - `visualViewportPageTop`
      - 目的：讓手機版 working 期間不再因瀏覽器 viewport / prompt dock 細碎高度抖動而反覆改寫 outer scroller 與 bottom padding。

### Validation

- 驗證指令：`bun turbo typecheck --filter @opencode-ai/ui --filter @opencode-ai/app`
- 結果：passed（Phase 1 + Phase 2 第二輪）
- 驗證指令：
  - `cd /home/pkcs12/projects/opencode/packages/opencode && bun run typecheck`
  - `cd /home/pkcs12/projects/opencode/packages/ui && bun run typecheck`
  - `cd /home/pkcs12/projects/opencode/packages/app && bun run typecheck`
- 結果：passed（server-side retained capture path round）
- 補充：`bun turbo typecheck --filter opencode --filter @opencode-ai/ui --filter @opencode-ai/app` 曾因 workspace 依賴建置超時而中斷，故改用各 package 直接 typecheck 驗證此次最小變更。
- 驗證指令：
  - `cd /home/pkcs12/projects/opencode/packages/ui && bun run typecheck`
  - `cd /home/pkcs12/projects/opencode/packages/app && bun run typecheck`
- 結果：passed（turn-internal block tracing round）
- 驗證指令：
  - `cd /home/pkcs12/projects/opencode/packages/ui && bun run typecheck`
  - `cd /home/pkcs12/projects/opencode/packages/app && bun run typecheck`
- 結果：passed（retained payload enrichment round）
- 補充：本輪 `overflow-anchor` CSS 調整為樣式層單點修正，未涉及 TypeScript 變更；待使用者下一次復現後，以 retained capture 行為變化作為主要驗證依據。
- 驗證指令：
  - `cd /home/pkcs12/projects/opencode/packages/ui && bun run typecheck`
  - `cd /home/pkcs12/projects/opencode/packages/app && bun run typecheck`
- 結果：passed（inline steps / bottom status row round）
- 驗證指令：
  - `cd /home/pkcs12/projects/opencode/packages/ui && bun run typecheck`
  - `cd /home/pkcs12/projects/opencode/packages/app && bun run typecheck`
- 結果：passed（flat working tool-card round）
- 驗證指令：
  - `cd /home/pkcs12/projects/opencode/packages/app && bun run typecheck`
- 結果：passed（mobile prompt dock repair round）
- 待實機驗證：
  - steps/tool/reasoning 平鋪後，follow-bottom 不應再與可收折容器/sticky trigger 競爭
  - working 狀態列應固定出現在所有 steps 輸出下方，而不是卡在其上方
  - working 中的 patch/read/tool card 掛載不應再因 collapsible/content-visibility 路徑而觸發上跳
  - mobile working 期間，browser chrome / visual viewport 抖動不應再反覆帶動 prompt-height 與 scroll jump
- 使用者觀察回饋（pre-phase2）
  - 已確認 agent 純文字輸出不再強制貼底，表示 page-level follow source 已顯著下降
  - 剩餘問題更集中在 thinking/steps 相關 focus 錨點，而非全文字流本身
- 目前程式層驗證
  - `create-auto-scroll.tsx` 已具備明確 `mode` 狀態與 debug 訊號
  - `session.tsx` 已在 page 層輸出 mode 變化，方便後續實機觀察 `free-reading -> follow-bottom` 是否只發生於顯式 resume
- 待實機驗證（phase3 round 1）
  - working/steps 更新時，視角不應再被 sticky thinking row 拉回使用者最後輸入處
  - 一旦進入 `free-reading`，除非按下 resume button，mode 不應被底部接近、resize 或 streaming 過程隱式改回 follow-bottom
  - 按下對話中間的向下箭頭後，應重新持續追底，而不是只瞬間跳到底一次
- 本輪程式層補強
  - `tool-output[data-scrollable]` 現在強制 `overflow-anchor: none`
  - 目的是避免內層展開卡與外層 session scroller 同時充當 scroll anchor owner
  - `create-auto-scroll.tsx` 在 `resize-follow` 後新增 `deferred-follow`
  - 目的是補上上方展開卡或晚到 reflow 造成的 page-level under-follow
  - `text-part` / `reasoning-part` 現也強制 `overflow-anchor: none`
  - 目的是避免瀏覽器將最後一個文字段落選為 anchor，與真正的 growing bottom 分離
  - 共用 `collapsible` / `collapsible-content` 現也強制 `overflow-anchor: none`
  - 目的是避免上一張 shell/tool card 整張被瀏覽器選為 anchor，與最新 growing shell output 互相競爭
  - `user-message` 現也強制 `overflow-anchor: none`
  - 目的是避免展開中的 prompt window 在純文字 streaming 階段被選成 anchor，將 viewport 拉回使用者輸入位置
- Architecture Sync: Updated
  - 已同步 `docs/ARCHITECTURE.md`，新增 web scroll incident observability contract，並補充 session turn 的 inline steps / bottom status row UI contract。
  - 依據：本輪除 retained capture 外，也正式改變了 session turn 的顯示結構：steps 不再依賴可收折 trigger，working 狀態列改為底部行。這已屬穩定 UI/scroll ownership contract 變更。
