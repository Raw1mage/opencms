# Event: Session Header IA Refactor Plan (Status / Accounts / Files / Terminal)

Date: 2026-03-07
Status: In Progress

## 需求

- 重新盤點目前 web session header 中的 `Status` 與 `Launcher` 入口，避免功能分散與邏輯重疊。
- 原始規劃曾將目前 9 個功能整理為 4 個一級主按鈕：`狀態`、`帳號`、`檔案`、`終端機`；後續依使用者決策，webapp banner 取消顯示 `帳號` 主按鈕。
- web PC 與 web mobile 需共用同一套資訊架構，但允許因版面限制使用不同呈現方式。
- web PC：banner 直接常駐主要工作按鈕；目前定案保留 `狀態`、`檔案`、`終端機`，取消顯示 `帳號`。
- web PC：`終端機` 保持既有底部 panel / 獨立視窗切換模式，不改成 sidebar。
- web mobile：4 個主功能都走獨立子頁模式，避免在有限版面內塞入多層浮窗與 overlay。
- `StatusPopover` 現有內容不能原封不動搬移；需重新整理成「狀態」與「帳號」兩個不同責任領域。
- TUI sidebar 本輪先不直接改，但規劃時必須避免做出之後無法對齊 TUI 的資訊架構。

## 範圍

### IN

- 盤點 web 端目前 `StatusPopover`、`SessionHeader`、launcher route / panel / popover 的責任分工。
- 產出新的 header IA（Information Architecture）與 interaction model。
- 明確定義 web PC / web mobile 的呈現方式、元件責任與遷移順序。
- 提出 phased migration plan，讓既有功能可逐步轉換而不是一次推倒重做。

### OUT

- 本輪不直接實作 TUI sidebar 重構。
- 本輪不設計完整 SVG 圖稿，只先定義 icon slot / 命名 / 視覺責任。
- 本輪不修改後端 server / mcp / lsp / plugin / account API contract。
- 本輪不處理所有 banner 視覺精修，只聚焦在 IA 與 interaction 結構。

## 任務清單

- [x] 盤點目前 `StatusPopover` 與 `Launcher` 的功能重疊、呈現差異與狀態來源
- [x] 定義新的主按鈕 IA 與各自責任邊界（後續 desktop banner 移除 `帳號`）
- [x] 定義 web PC 的 sidebar / terminal / banner 常駐按鈕模型
- [x] 定義 web mobile 的子頁模型與 route 結構
- [x] 規劃舊 `Status` / `Launcher` 的 phased migration plan
- [x] 待使用者確認方案後，再進入實作
- [x] Phase 2：實作 web PC 的 4 主按鈕與 right-panel mode 重構
- [ ] Phase 3：實作 web mobile 4 主功能 child-page 導航重構

## 現況盤點

### 現有 9 個功能來源

1. `StatusPopover`
   - server
   - mcp
   - lsp
   - plugins
   - accounts
2. `Launcher`
   - files
   - todo
   - monitor
   - terminal

### 現況問題

- 同樣屬於「工作上下文狀態」的資訊被拆散在 `StatusPopover` 與 `Launcher` 兩邊。
- `accounts` 被放在 `StatusPopover`，但其性質更接近管理功能，而非 session runtime status。
- web PC 與 web mobile 雖然近期透過 launcher 有所對齊，但 `StatusPopover` 仍維持另一套完全不同的 interaction model。
- web PC 的 header 缺少穩定的一級資訊架構：現在更像是歷史功能堆疊，而不是清楚的主導航。
- web mobile 若繼續沿用 popover + drawer + child page 混搭，認知成本會持續升高。

## 新的一級資訊架構（Draft）

### 原始 4 個主按鈕草案

1. **狀態**
   - 收納：`server / mcp / lsp / plugins / todo / monitor`
   - 核心語意：目前 session / runtime / environment 的即時工作狀態

2. **帳號**
   - 收納：account management
   - 核心語意：provider/account family 的管理與檢視

3. **檔案**
   - 收納：file tree
   - 核心語意：專案檔案工作區入口

4. **終端機**
   - 收納：terminal
   - 核心語意：命令列工作區入口

### IA 決策原則

- `狀態` 與 `帳號` 分離：避免把管理功能錯放到 runtime status 裡。
- `todo` 與 `monitor` 歸入 `狀態`：它們更接近 session work status，而不是檔案工具。
- `檔案` 與 `終端機` 保持獨立：它們是 primary workspace，不應被包進 `狀態`。
- 三端（TUI / web PC / web mobile）未來應盡量共用這 4 個概念分組，即使 UI 呈現不同。
- 後續使用者決策：由於 webapp 上仍有其他入口可達帳號設定，且目前 webapp 帳號設定功能未完整實作，desktop banner 不再暴露 `帳號` 主按鈕。

## Web PC 設計草案

### Header

- banner 右側直接常駐 3 個主按鈕：
  - 狀態
  - 檔案
  - 終端機
- `帳號` 不在 webapp banner 顯示；保留其他既有入口。
- 每個按鈕都應有獨立 icon + label；不可退回單一 launcher menu。
- review toggle 可保留獨立存在，不與 4 主按鈕混淆。

### 互動模式

- **狀態**：開啟右側 sidebar
  - 內容一次呈現：server / mcp / lsp / plugins / todo / monitor
  - 建議為單一 sidebar 容器內的多 section，而不是再嵌套第二層 tab popup
- **檔案**：開啟右側 sidebar
  - 沿用既有 file tree panel
- **終端機**：保持既有 bottom panel / popout 行為
  - header 按鈕只負責開關 terminal panel
  - 不移入 sidebar 模型

### PC sidebar 建議整合方向

- 目前 `layout.fileTree.mode = files | todo | monitor` 的概念，應升級成更通用的右側 panel mode。
- 建議未來擴充為類似：
  - `files`
  - `status`
  - `accounts`（暫保留底層 mode，但不在 banner 暴露）
- `status` panel 內部再以 section 組合 server / mcp / lsp / plugins / todo / monitor。
- 避免把 `todo` / `monitor` 繼續視為與 `files` 同層的 panel mode，否則 IA 會繼續歪斜。

## Web Mobile 設計草案

### Header

- 因為空間有限，不要求 4 個主按鈕直接常駐。
- mobile 可以保留單一入口按鈕，但其語意不再是舊式 launcher，而是「主功能導航」。
- 點開後列出主功能：
  - 狀態
  - 檔案
  - 終端機
- `帳號` 不在 mobile session banner 直接暴露；保留其他入口。

### 互動模式

- **狀態**：進入獨立子頁
  - 單一頁面內顯示 server / mcp / lsp / plugins / todo / monitor 六個 section
- **檔案**：進入獨立子頁
- **終端機**：進入獨立子頁

### Mobile 原則

- 避免多層 overlay / popover / drawer 疊加。
- 以 route-based child page 作為主要互動模型。
- 共享 banner 只負責：
  - 顯示目前子頁 title
  - 提供返回 session 主頁能力
  - 提供 session 主功能導航入口

## 建議的 route / component 分工

### 既有可重用

- `packages/app/src/components/status-popover.tsx`
  - 可拆出資料 section 元件，但不應繼續直接綁定 popover presentation
- `packages/app/src/pages/session/tool-page.tsx`
  - 可演進為 generic session child-page shell，而不只承接 files/todo/monitor
- `packages/app/src/pages/session/terminal-popout.tsx`
  - 可保留作 terminal child page / popout route
- `packages/app/src/pages/session/session-side-panel.tsx`
  - 可重構為更通用的 session right-panel renderer

### 建議新增抽象

- `SessionPrimaryNav` / `SessionHeaderPrimaryActions`
  - 專責 4 主按鈕與 active state
- `SessionStatusPanel`
  - PC 右側狀態 sidebar
- `SessionAccountsPanel`
  - PC 右側帳號 sidebar
- `SessionStatusPage`
  - mobile 狀態子頁
- `SessionFilesPage`
  - mobile 檔案子頁（可沿用/抽象自既有 tool-page）

### 建議 route 草案（mobile / shared page model）

- `/session/:id?/status`
- `/session/:id?/files`
- `/session/:id?/terminal-popout`

> 備註：是否保留舊 `/tool/:tool` 路由，可作為 migration bridge；最終目標應轉向語意更清楚的 route。

## 分階段實作計畫

### Phase 1 — IA Groundwork

- 新增 planning doc（本文件）
- 定義 4 主按鈕模型與 active-state 規則
- 凍結舊 launcher 的功能擴張，避免再往錯誤方向堆功能

### Phase 2 — Web PC Header Restructure

- 將 PC header 的單一 launcher 改為 4 個常駐主按鈕
- 建立新的 right-panel mode：至少區分 `status / accounts / files`
- `terminal` 保持既有 bottom panel / popout 機制
- `StatusPopover` 降級或移除，將 server/mcp/lsp/plugins/todo/monitor 轉入 `SessionStatusPanel`

### Phase 3 — Web Mobile Navigation Restructure

- mobile 導航入口改為 session 主功能
- 導入/收斂語意更清楚的 child-page grouping：status / files / terminal
- 將 todo / monitor 自 child page 中移出，併入狀態頁

### Phase 4 — Cleanup / Compatibility

- 視需要保留舊 route 做向後相容，再逐步移除
- 清理 `StatusPopover` 與舊 launcher i18n / icon / helper
- 更新 architecture doc（若 runtime / component responsibility 已實質改變）

### Phase 5 — TUI Follow-up (Deferred)

- 本輪只記錄，不實作
- 後續另開 event，將 TUI sidebar 對齊同一套 4 主功能資訊架構

## Session Browser Redesign Addendum (TUI-aligned)

### 背景補充

- 使用者明確指出：先前曾要求 webapp 復現 TUI 的 session list 呈現方式，但目前只做到 sidebar list 的局部微調，尚未達成 TUI 的整體閱讀節奏。
- 問題核心不只在 row 樣式，而在於 **容器型態**：
  - webapp 目前是 left sidebar + drawer
  - TUI 更像獨立的 session browser / selector surface

### TUI 參考基準

- 真實參考實作：`packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx`
- 目前觀察到的核心特徵：
  - 以日期 category 分組（Today / 具體日期）
  - title 單行、time 單行，右側 footer 對齊
  - root row 帶 project label，例如 `[opencode] ...`
  - child row 僅保留極簡 tree prefix（`├─` / `└─`）
  - 幾乎沒有 card chrome，整體更像 terminal browser 而非卡片清單

### 新的容器策略

#### Web PC

- 保留 sidebar / panel 架構，不強制改成 modal 浮窗。
- 但 session list panel 的寬度、內距、header、分組與 row 密度要改成更接近 TUI session browser 的感受。
- 目標：**browser in panel**，不是一般的 app sidebar list。

#### Web Mobile

- mobile 仍可延用 sidebar drawer 型式，不強制改成獨立 full-page route/surface。
- 重點改為：在 drawer 內把 session list 做得更像 session browser，而不是傳統 app sidebar list。
- 若需要更多寬度，可優先調整 drawer 寬度與內部排版，不必先推翻 drawer 互動模型。

### 實作方向

#### Phase A — Shared TUI-style Session Browser Body

- 抽出共用的 session browser list body，負責：
  - date grouping
  - single-line title/time layout
  - minimal child indentation
  - active row treatment
  - selected-row repeat-tap behavior

#### Phase B — PC Container Reshape

- 重新調整 session list panel 寬度與容器節奏，使其更像 TUI browser。
- 弱化 card/drawer 感，強化 grouped list browser 感。

#### Phase C — Mobile Drawer-style Session Browser

- mobile session browser 維持 sidebar drawer 型式。
- 調整 mobile sidebar shell 內部配置，讓 session browser 在 drawer 中仍保有足夠寬度與更清楚的 project/session hierarchy。

### 本輪執行目標

- 先做第一版 web port：
  - 共用 TUI-style session browser body
  - PC panel 寬度與 row 排版初步對齊
  - mobile shell 先收斂成更 session-browser 化的 drawer 內容

## 風險與注意事項

- 目前 `layout.fileTree` 同時承擔 files/todo/monitor，若直接硬塞 `status/accounts`，需小心避免把 state 命名與責任搞亂。
- `StatusPopover` 目前包含資料抓取、UI 呈現、toggle action 三種責任；重構時應先做 presentation / data 邊界拆分。
- mobile 新 route 若一次替換過快，容易破壞既有 shared banner / return behavior。
- icon 設計需先保留統一 slot / name，避免在 IA 尚未穩定前過早微調視覺細節。

## Debug Checkpoints

### Baseline

- 已確認 `packages/app/src/components/status-popover.tsx` 目前以單一 popover tabs 承載 `servers / mcp / lsp / plugins / accounts`。
- 已確認 `packages/app/src/components/session/session-header.tsx` 目前以 launcher 呈載 `files / todo / monitor / terminal`，且 PC / mobile 已有不同 interaction。
- 已確認目前 web session header 的一級資訊架構仍是歷史功能疊加，而非你想要的 4 主按鈕模型。

### Execution

- planning phase：
  - 以「狀態 / 帳號 / 檔案 / 終端機」作為新的單一真實資訊架構，重新規劃 web PC / web mobile 呈現方式。
  - 明確將 `todo / monitor` 重新歸類到 `狀態`，將 `accounts` 從 status cluster 中抽離為獨立管理領域。
- Phase 2 implementation：
  - `packages/app/src/context/layout.tsx`
    - `layout.v7` 升級為 `layout.v8`
    - desktop right-panel mode 先從 `files | monitor | todo` 轉為 `files | status | accounts`
    - 之後依產品決策收斂為 session-level `files | status`
    - migration 規則將舊 `todo/monitor/accounts` mode 自動收斂為 `status`
    - `fileTree.toggle()` 回歸真正的檔案面板 toggle：未開時開啟 files、若目前是其他 mode 先切回 files、若已是 files 則關閉
  - `packages/app/src/components/session/session-header.tsx`
    - desktop header 移除單一 launcher 與 `StatusPopover` 入口
    - desktop 改為 4 個常駐主按鈕：狀態 / 帳號 / 檔案 / 終端機
    - 4 個按鈕使用 inline SVG icon，並保留 active state
    - `終端機` 保持既有 bottom panel toggle 行為；不進入 sidebar mode
    - mobile 仍保留當前 launcher / child-page 模型，等 Phase 3 再重構
  - `packages/app/src/pages/session/session-status-sections.tsx`（new）
    - 抽出 desktop `狀態` sidebar 需要的 section content
    - `狀態` section 包含：servers / mcp / lsp / plugins
  - `packages/app/src/pages/session/session-side-panel.tsx`
    - secondary panel 最終改為依 `files | status` 顯示內容
    - `status` panel 內整合：servers / mcp / lsp / plugins / todo / monitor
- Phase 2 follow-up fixes：
  - `packages/app/src/components/session/session-header.tsx`
    - 新增 desktop 4 主按鈕的 `type="button"`，避免隱式 submit / navigation 導致帳號按鈕點擊時出現全畫面閃爍
  - `packages/app/src/pages/session/session-status-sections.tsx`
    - 移除帳號 sidebar 對 `account.listAll()` 的 mount-time fetch / polling，改為直接使用 `useGlobalSync().data.account_families`
    - 簡化帳號 sidebar 結構，移除重複的「帳號」標題與額外 container 包裝
  - `packages/app/src/components/settings-models.tsx`
    - 移除已不再需要的 `settings.models.recommendations`（路由建議）區塊
    - 保留其餘模型可見性設定列表；不再暴露 rotation recommendation apply UI
  - latest product decision：
    - 依使用者指示，desktop webapp banner 取消顯示 `帳號` 主按鈕
    - 理由：其他位置已有入口，且 webapp 帳號設定功能目前未完整實作，不適合作為一級主導航暴露
  - desktop cleanup：
    - 移除 session-level `accounts` panel mode、`SessionAccountsSection` 與對應 header active-state 殘留
    - desktop session 導航最終收斂為 `狀態 / 檔案 / 終端機`
- Phase 3 implementation：
  - `packages/app/src/components/session/session-header.tsx`
    - mobile launcher 由 `files / todo / monitor / terminal` 收斂為 `status / files / terminal`
    - `subpage()` / `subpageTitle()` 將舊 `todo` / `monitor` route 視為 `status`，維持向後相容
    - `openToolPage()` / `toggleMobileTool()` 收斂為 `status / files / terminal`
  - `packages/app/src/pages/session/tool-page.tsx`
    - child page 模型由舊 `files/todo/monitor` 改為 `files/status`
    - `status` page 內整合：servers / mcp / lsp / plugins / todo / monitor
    - 舊 `/tool/todo` 與 `/tool/monitor` 自動映射到新的 `status` 聚合頁
- mobile banner icon refactor：
  - `packages/app/src/pages/session/index.tsx`
    - 移除 mobile `SessionMobileTabs` 與 `mobileTab` state，不再顯示「工作階段 / 檔案變更」切換列
    - mobile 主畫面改為預設只顯示 session 對話；「檔案變更」改用 `view().reviewPanel.opened()` 控制
  - `packages/app/src/components/session/session-header.tsx`
    - mobile banner 由 launcher menu 改為 4 個 icon actions：檔案變更 / 狀態 / 檔案 / 終端機
    - `檔案變更` icon 直接切換 mobile review view；若目前在子頁，會先返回主 session 再開啟 review
    - 點擊狀態 / 檔案 / 終端機 icon 時，會關閉 mobile review view，避免返回主頁時仍停留在 changes 畫面
  - route alignment follow-up：
    - 實際生效的 mobile session route 為 `packages/app/src/pages/session.tsx`，因此同步移除該檔中的 `SessionMobileTabs` / `mobileTab` 舊邏輯
    - mobile changes view 的顯示與 diff 請求條件統一改為 `view().reviewPanel.opened()`
- mobile file viewer prototype：
  - `packages/app/src/pages/session/tool-page.tsx`
    - mobile `files` 子頁新增第一版文字檔 viewer flow
    - 點檔案後不再返回主 session，而是在同一路徑下切入 viewer 子狀態
    - viewer 關閉後回到原 file tree，並恢復先前 scrollTop，保持瀏覽連貫性
    - 目前僅支援文字內容；二進位檔顯示既有 `session.files.binaryContent` 提示
- session list follow-up polish：
  - `packages/app/src/pages/layout/sidebar-items.tsx`
    - 工作階段時間欄改為 `whitespace-nowrap` 單行顯示，避免上午/下午與時分拆成兩行
    - dense row 的前綴縮窄，減少 `-` 之後的冗餘空白
    - mobile 目前選中的工作階段改用更直接的顯性標記（active background + border + interactive text），避免依賴某些 mobile browser 對狀態選擇器/弱對比 token 的不穩定呈現
    - mobile 再點一次目前已選中的工作階段時，直接關閉 `mobileSidebar`，回到工作階段主畫面開始操作
    - 將原本不顯著的 `-` 字元改為明顯的 action button（dot-grid icon button）
    - action button 以 `pointerdown/click stopPropagation + preventDefault` 隔離事件，避免誤觸發 active session 的 repeat-click close 行為
    - mobile dense row action menu 恢復，讓既有 rename/delete 回到可用狀態，並保留未來擴充 export/share actions 的 menu 結構空間
    - action button 與 active highlight 規則同步套用到 desktop session list，不再只限 mobile
    - active highlight 由「弱背景 + 降階文字色」改為「interactive text + interactive weak surface」，讓 PC/mobile 的目前工作階段都更清楚
    - 根因補充：先前 active text 是把 `text-text-interactive-base` 疊加在既有 `text-text-strong / text-text-weak` 上，可能被 utility 順序覆蓋，造成 highlight 幾乎不可見；現改為 active/inactive 互斥 class
    - 根因補充：session action button 若位於 row link 互動區附近，即使 stopPropagation 仍可能在 touch 流程觸發 row close；現額外以 `data-session-action` + row-level target guard 阻擋 repeat-click close
    - active session click-close 規則擴大為 desktop + mobile 共用：點擊 active session row 主體（不含 function button）即收合 session list
    - 為避免 function button 第二次點擊仍誤觸 close，新增 `recentAction` guard，短時間內忽略 active row close
    - 進一步將 `recentAction` guard 前移到 row link 最上層，直接攔截 mobile 上 function button 觸發的 ghost click/navigation/close
  - `packages/app/src/pages/layout.tsx`
    - desktop resize handle 提高 z-index，並補上 `onDblClick => layout.sidebar.close()`，恢復 double-click close 行為
    - desktop session list 恢復為 overlay drawer：左側只保留 64px rail，session browser panel 以 `absolute left-16` 疊加在主工作區之上，不再作為實體 column 擠壓 session 視窗
    - desktop resize handle 改掛在 overlay panel 上，保留拖曳寬度與 double-click close
    - desktop overlay drawer 的 resize max 放寬為 `window.innerWidth - 96` 級別，不再被先前 30% 視窗寬度上限過度壓制
    - 進一步移除 desktop hover drawer 依賴：desktop overlay panel 僅在 `layout.sidebar.opened()` 時顯示，不再因 mouse leave / hover project 切換而躲藏
    - `SidebarPanel` 自身的 420px 寬度上限已移除，避免 overlay drawer state 與實際可見寬度不同步，造成「拖曳像隔一層」的手感
  - `packages/app/src/pages/layout/sidebar-project.tsx`
    - desktop project tile 點擊未選中專案時，先穩定指定 `openProject` 並打開 opened drawer；不再把 session list 顯示與 route navigate 時序綁死
  - `packages/ui/src/components/resize-handle.tsx`
    - 直接以 `mousedown.detail === 2` 處理 double-click collapse，避免僅依賴外部 `dblclick` 事件在某些情況下不觸發
  - `packages/app/src/pages/layout/sidebar-workspace.tsx`
    - local workspace 也改用 grouped session list renderer，讓跨日時可顯示日期 separator
- TUI-style session browser container follow-up：
  - `packages/app/src/pages/layout/sidebar-shell.tsx`
    - mobile session browser 維持 drawer 型式，但不再沿用「左 project rail + 右 panel」的擁擠比例
    - 改為 drawer 內的上方 project strip + 下方完整 session browser panel，保留 mobile sidebar 開關便利性
    - `新增專案 / 設定 / 說明 / 登出` 工具改併入 mobile project strip 末端，避免佔用左側固定欄寬
  - `packages/app/src/pages/layout.tsx`
    - 依使用者最新決策，mobile 仍保留 drawer 互動模型，但打開時寬度可直接佔滿螢幕（`100vw`）
    - 因已採滿版 drawer，移除 mobile overlay resize handle，避免保留多餘的寬度調整心智模型
    - desktop session list sidebar 仍維持原本可自訂寬度模型；只有 mobile drawer 使用滿版寬度
    - desktop/mobile shell 判斷不再使用 `xl` breakpoint；改為 runtime media query：僅當視窗寬度 `< 450px` 且為 touch/coarse pointer 瀏覽器時，才進入 mobile drawer mode

### Validation

- planning doc 已獲使用者確認後進入 Phase 2。
- Phase 2 後 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- Phase 2 follow-up fixes 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 帳號 sidebar data-path simplification 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 移除 desktop banner `帳號` 主按鈕後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 移除 session-level `accounts` panel 殘留後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- Phase 3 mobile navigation restructure 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- mobile banner icon refactor 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 修正實際 session route (`pages/session.tsx`) 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- mobile file viewer prototype 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- session list UX follow-up 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- TUI-style session browser container follow-up 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 依使用者將 mobile 方向收斂回 drawer-style 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 依使用者確認 mobile drawer 可滿版後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 修正 mobile active session highlight / repeat-tap close 行為後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 修正 mobile active highlight 顯示可靠性並恢復 mobile `-` action menu 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 修正 desktop/mobile shell 誤判（避免窄 desktop 視窗被切進 mobile mode）後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 將 session action menu trigger 改為顯著按鈕並隔離 repeat-click close 事件後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 將 session action button / active highlight 規則同步到 desktop session list 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 修正 active highlight CSS 根因、session action target guard，並恢復 desktop resize handle double-click close 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 恢復 desktop overlay drawer（不再擠壓 main session 視窗），並將 resize / double-click close 掛回 overlay panel 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 放寬 desktop overlay drawer resize 上限、將 active click-close 套用到 desktop/mobile、並以底層 `mousedown.detail===2` 補強 double-click close 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 移除 desktop hover drawer、讓 desktop project click 穩定進入 opened overlay drawer，並把 mobile function-button ghost click guard 前移到 row link 後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 清理 desktop drawer 舊寬度公式（移除 `SidebarPanel` 420px cap 與 overlay/in-flow 寬度錯位）、修正 desktop project icon 開啟鏈，並完成 mobile menu/backdrop close 隔離後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- 將 desktop drawer resize 的可見邊界、實際寬度與 handle 命中區重新對齊後再次 `bun run typecheck` 通過（`Tasks: 16 successful, 16 total`）
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪最終收斂集中於 `packages/app` 的 web session drawer 互動層（desktop overlay drawer、mobile full-width drawer、session row action/active 行為與 resize hit area），未變更 `docs/ARCHITECTURE.md` 已描述的 runtime 邊界、API 責任、provider/account/session 核心拓樸，因此維持 No doc changes。
