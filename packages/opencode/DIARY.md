# DIARY：主要開發知識庫

> 單一真實來源（SSOT）。整合 CHANGELOG / PLANNING / DEBUGLOG，依日期排序，繁體中文維護。

## 目錄

- 2026-02-04：google_search 認證修復與文件政策調整
- 2026-02-03：近期變更與規劃
- 2026-02-02：Monitor 與測試快取規劃
- 2026-02-01：Provider 正規化與 Model Health Dashboard
- 2026-01-31：/admin 流程與 Rate limit 體驗修復
- 2026-01-30：Antigravity 通信修復
- 未標日期：CMS 模組化與大型重構規劃（彙總）

---

## 模板（新增條目）

```
## YYYY-MM-DD

### CHANGELOG

- ...

### PLANNING

#### 功能：...

**需求**
- ...

**範圍**
- IN: ...
- OUT: ...

**作法**
1. ...

**任務**
1. [ ] ...

**問題**
- ...

### DEBUGLOG

#### 問題名稱

**問題摘要**
- ...

**根本原因**
- ...

**修復重點**
- ...

**驗證**
- [x] ...
```

---

## 2026-02-04

### CHANGELOG

- 全域 AGENTS 指引更新：以 DIARY.md 分章節維護規劃與架構，停止維護 PLANNING.md/ARCHITECTURE.md。
- debug log 註解對齊實際路徑（使用 `<codebase>/logs/debug.log`）。
- debug log 統一路徑為 `/home/pkcs12/opencode/logs/debug.log` 並於啟動即清空（debug.ts + debug-log.ts）。
- 清理 debugLog 殘留，auto-update-checker 與 antigravity 改用 debugCheckpoint。
- google_search 的 Gemini CLI 錯誤訊息移除 `opencode auth login` 指引。
- google_search 改用 randomized headers，支援 Origin/Referer 環境變數。
- google_search 成功/錯誤回應 body 追加 debug log（截斷）。
- google_search 執行時記錄工具來源（internal / refs）。
- google_search 工具優先選用 `/refs/opencode-antigravity-auth-1.4.3` 來源。
- 停用 google_search 工具註冊，改採 websearch。
- 統一 debug log 系統為純文字輸出，gemini-cli/antigravity/Log/legacy trace 改走同一 writer。
- debugCheckpoint 改用同步 append，避免短命令（--version）結束前漏寫。
- debug log 行加上 [opencode] 統一前綴，方便與系統工具 JSON 行區分。
- PromptInput 修正 typecheck：SlashCommand source 收斂、model optional 分離、Tooltip/Icon props 對齊。

### PLANNING

#### 功能：Model Health Dashboard 隱藏 Untracked

**需求**

- admin panel 的 Model Health Dashboard 不顯示 Untracked 模型。
- 只保留 Ready / Rate limit 的列表與統計。

**範圍**

- IN: `src/cli/cmd/tui/component/dialog-model-health.tsx`
- OUT: 其他 admin panel UI、後端狀態來源、資料結構調整

**作法**

1. 在列表組裝時直接略過 untracked 狀態，不加入 items。
2. 統計與標題不再包含 untracked。

**任務**

1. [ ] 更新 Model Health Dashboard 過濾 untracked
2. [ ] 確認標題統計不再顯示 untracked

**問題**

- 目前無。

#### 功能：修復貼上圖片 invalid image data（支援 PNG/JPEG/WebP）

**需求**

- 修復 WSL+Windows 剪貼簿貼圖在 TUI/CLI 流程出現 invalid image data。
- 影像格式支援 PNG + JPEG + WebP。
- 遇到無效影像資料要提示使用者，不送出影像。

**範圍**

- IN: `src/cli/cmd/tui/util/clipboard.ts`, `src/cli/cmd/tui/component/prompt/index.tsx`
- IN: `src/cli/cmd/cli.ts`（若有共用 paste 流程）
- OUT: 影像縮圖/壓縮、UI 版面重設計、非貼上相關流程

**作法**

1. 擴充 clipboard 影像讀取，允許 PNG/JPEG/WebP，並驗證 data URL 與 base64。
2. 發現無效影像時直接中止並顯示提示，不送出 image part。
3. TUI/CLI 共享驗證邏輯，避免分支行為不一致。
4. 補上 debug checkpoint（必要時），協助追蹤剪貼簿輸入與格式。

**任務**

1. [ ] 檢查 clipboard.ts 目前 PNG-only 與 data URL 生成流程
2. [ ] 新增 JPEG/WebP 支援與 base64 驗證
3. [ ] 在 TUI/CLI paste 流程加入「無效影像提示」
4. [ ] 驗證 WSL+Windows 貼圖流程（TUI/CLI）

**問題**

- 目前無。

#### 功能：google_search 回應 body 紀錄與 headers 強化

**需求**

- 僅針對 google_search 記錄成功與錯誤的回應 body（含截斷）。
- google_search headers 改用 randomized 組合，加強 client 模擬。
- Origin/Referer 由環境變數控制，未設定則不帶。

**範圍**

- IN: `src/plugin/antigravity/plugin/search.ts`
- OUT: 其他 antigravity request、其他工具或 provider

**作法**

1. google_search request headers 改用 `getRandomizedHeaders`。
2. 讀取 `OPENCODE_ANTIGRAVITY_SEARCH_ORIGIN` / `OPENCODE_ANTIGRAVITY_SEARCH_REFERER`，有值才加入。
3. 成功/錯誤回應都記錄 response body（截斷），維持 debug log 可讀性。

**任務**

1. [ ] 更新 google_search headers 組裝邏輯
2. [ ] 補上成功/錯誤回應 body 的 debug log
3. [ ] 更新 DIARY CHANGELOG

**問題**

- 是否需要對回應 body 做進一步遮罩（除了截斷）？

#### 功能：google_search 工具來源記錄與 internal vs /refs 協議比較

**需求**

- 比較 internal 與 `/refs/opencode-antigravity-auth-1.4.3` 的協議差異（僅診斷，不改邏輯）。
- 在 google_search 執行時記錄工具來源（internal / refs）。
- 不切換來源、不對齊行為、不新增測試。

**範圍**

- IN: `src/tool/registry.ts` 或 google_search 入口（新增來源日誌）
- OUT: 工具來源切換、協議/模型/端點調整、測試

**作法**

1. 在工具解析/執行處加入 debugCheckpoint，輸出實際來源路徑或註冊標識。
2. 彙整 internal vs /refs 的協議差異並回報（不改碼）。

**任務**

1. [ ] 找到可取得工具來源資訊的執行位置
2. [ ] 加入 google_search 工具來源 debugCheckpoint
3. [ ] 整理協議差異清單與結論

**問題**

- 來源標識是否能直接取得註冊路徑？若無需額外標記？

#### 功能：停用 google_search 改用 websearch

**需求**

- 停用/移除 google_search 工具註冊。
- 改採 opencode 原生 websearch（不改其行為）。
- 更新文件紀錄。

**範圍**

- IN: `src/tool/registry.ts`, DIARY
- OUT: websearch 行為調整、測試

**作法**

1. 在工具過濾階段移除 `google_search`。
2. 更新 DIARY CHANGELOG。

**任務**

1. [ ] 停用 google_search 工具註冊/解析
2. [ ] 更新 DIARY 記錄

**問題**

- 是否需提示使用者改用 websearch 指令？

#### 功能：貼上觸發 tool call 的 3D rotation 反覆重試問題

**需求**

- 釐清貼上文字/圖片後的 tool call 流程，找出 3D rotation 反覆重試的根因。
- 產出精簡版 RCA，說明症狀/根因/影響/建議。
- 提出修復計畫（含實作建議），採用「短期記憶當前可用 vector list」避免反覆從頭重跑。

**範圍**

- IN: 貼上事件處理流程、tool call 入口、3D rotation/模型輪替/health 檢查
- OUT: 非貼上觸發的其他輸入流程、非相關 UI 重構

**作法**

1. 盤點貼上事件 → tool call 的主流程與相關模組。
2. 定位 rotation3d/rotation3D 或模型輪替核心邏輯與重試條件。
3. 比對「已抓 model status」與「仍重跑」的差異點。
4. 形成 RCA 與修復計畫（含短期記憶 vector list 的設計方向）。

**任務**

1. [ ] 搜尋貼上事件與 tool call 的串接路徑
2. [ ] 搜尋 rotation3d / model rotation / fallback / retry 相關程式碼
3. [ ] 產出精簡版 RCA 與修復計畫

**問題**

- rotation3d 的具體觸發點是否只在 tool call，或也在一般 prompt 流程？
- vector list 的「短期記憶」需存在於 session、process、或全域快取？

#### 功能：google_search 空結果修復

**需求**

- 修正 google_search 回傳空內容時的輸出，避免 UI 一律判定無結果。
- 補上必要的 fallback 或解析，確保最少有可讀內容。

**範圍**

- IN: google_search 工具輸出格式、搜尋回應解析、空結果判定
- OUT: 非搜尋相關功能、UI 互動流程重構

**作法**

1. 盤點搜尋回應結構（content/groundingMetadata/searchEntryPoint）。
2. 為空內容加入 fallback（例如 searchEntryPoint 文字化）。
3. 空結果明確回報為錯誤或提示訊息，便於上層判斷。

**任務**

1. [ ] 讀取 google_search 回應解析流程
2. [ ] 加入空內容 fallback 與判定
3. [ ] 更新 debug checkpoint 以識別空結果來源
4. [ ] 驗證 UI 搜尋可回傳非空結果

**問題**

- 實際 API 回應欄位可能變動，需保留保守處理。

#### 功能：google_search hardcode 路徑（antigravity 固定帳號/模型）

**需求**

- google_search 僅走 hardcode 路徑，固定帳號 `yeatsluo@gmail.com` 與模型 `gemini-3-pro`。
- hardcode 路徑失敗就回傳錯誤，不做 fallback。
- 僅限 google_search tool call，不影響其他工具。

**範圍**

- IN: `src/plugin/antigravity/index.ts` google_search 分支
- OUT: 其他工具、一般搜尋 fallback 流程

**作法**

1. 在 google_search 入口強制選取指定帳號。
2. 固定使用 `gemini-3-pro` 執行搜尋。
3. hardcode 失敗直接返回錯誤並停止。

**任務**

1. [ ] 修正 hardcode 路徑的型別錯誤
2. [ ] 確保 hardcode 路徑 early return，略過原本 loop/fallback

**問題**

- 是否需要補 debugCheckpoint 以識別 hardcode 路徑命中？

#### 功能：PromptInput typecheck 修復（SlashCommand/Model/Tooltip/Icon）

**需求**

- 修正 `prompt-input.tsx` 的型別錯誤（SlashCommand source、model 可選、Tooltip/Icon props）。
- 允許 UI 微調，但不改動核心流程。

**範圍**

- IN: `packages/app/src/components/prompt-input.tsx`, `packages/ui/src/components/tooltip.tsx`
- OUT: 其他 UI 流程、非必要重構

**作法**

1. 針對 SlashCommand source 做型別收斂。
2. 將 model 的顯示/送出拆成不同變數，避免 `undefined`。
3. Tooltip 改用 `value` props，Icon 更換為既有名稱。

**任務**

1. [ ] 修正 SlashCommand source 型別
2. [ ] 修正 model optional 相關型別
3. [ ] 修正 Tooltip/Icon props

#### 功能：google_search Antigravity 認證失敗 RCA（log-based）

**需求**

- 以 logs（debug.log + 其他 \*.log）為唯一證據來源。
- 產出口頭 RCA，並寫入 DIARY 的 DEBUGLOG。
- 彙整多個可能失敗點與證據強弱。
- 不處理/不操作任何二進位 opencode。

**範圍**

- IN: `/home/pkcs12/opencode/logs/debug.log` 與 repo 內其他 `.log` 檔
- OUT: 程式碼修改、二進位檔案、非 log 的外部系統行為

**作法**

1. 盤點可用 log 檔與更新時間。
2. 依 google_search 觸發時間線讀取上下文。
3. 以關鍵字（auth/token/refresh/projectId/antigravity/401/403）定位失敗點。
4. 彙整 RCA（摘要/根因/修復重點/驗證/可能性清單）。
5. 更新 DIARY DEBUGLOG 並修正先前不正確的測試記錄。

**任務**

1. [ ] 列出 repo 內所有 .log 檔
2. [ ] 讀取 debug.log 關鍵區段與上下文
3. [ ] 搜索其他 logs 的認證錯誤訊息
4. [ ] 產出多重可能根因與證據強度
5. [ ] 更新 DIARY DEBUGLOG

**問題**

- logs 可能被清空或不存在，需確認實際可用證據

#### 功能：debug log JSON 行來源追查與統一

**需求**

- 全 repo 追查仍輸出 JSON/JSONL 的寫入點。
- debug.log 只允許純文字（含 [opencode] 前綴）。
- `bun run dev` 啟動即清空 debug.log。
- 允許暫時性偵測（堆疊/來源標記），完成後移除。

**範圍**

- IN: 全 repo 所有寫入 debug.log / debug writer 呼叫點
- OUT: 非 debug 的一般 log 系統與業務邏輯改動

**方法**

1. 全 repo 搜尋 debug.log 與 JSONL 寫入模式。
2. 若無直接命中，於統一 writer 加入暫時性堆疊記錄以定位來源。
3. 以 `bun run dev -- --version` 驗證是否仍有 JSON 行。
4. 修正來源後移除暫時偵測，確認只剩純文字輸出。

**任務**

1. [x] 全 repo 掃描 debug.log 寫入點與 JSONL pattern
2. [x] 加入暫時性堆疊/來源標記（若需要）
3. [ ] 追查並修正殘留寫入來源
4. [ ] 移除暫時偵測並驗證 `bun run dev`

**問題**

- JSON 行來源尚未定位

#### 功能：google_search 認證可用化（循環修正）

**需求**

- 以最小步驟觸發 google_search 並收集 debug.log。
- 針對認證失敗的循環/重試策略進行修正。
- 確保 google_search 能返回有效搜尋結果。

**範圍**

- IN: `src/plugin/antigravity/index.ts`, `src/plugin/antigravity/plugin/search.ts`, debug log
- OUT: UI/TUI 操作流程、外部 OAuth provider 行為變更

**方法**

1. 建立最小觸發腳本/流程，產生 debug.log。
2. 根據 log 判斷認證卡點與循環行為。
3. 最小修正循環/重試策略並再次驗證。

**任務**

1. [x] 觸發 google_search 產生日誌
2. [x] 分析 debug.log 並定位認證卡點
3. [ ] 修正循環/重試策略
4. [x] 驗證 google_search 可用

**驗證**

- smoke script 以 query「free model」成功回應，debug.log 顯示 response ok（length 2941）。
- 認證/refresh 流程可正常執行，未見失敗循環。

**問題**

- 目前無。

#### 功能：google_search tool call 認證流程（避免要求 opencode auth login）

**需求**

- 在 tool call 情境下，避免回傳「請先 opencode auth login」的提示。
- 優先使用 accounts.json 的 antigravity 帳號；gemini-cli 作為可選 fallback。
- 只調整 google_search tool 相關流程與訊息。

**範圍**

- IN: `src/plugin/antigravity/index.ts`
- OUT: 其他 tool/provider、UI 流程

**方法**

1. 調整 gemini-cli fallback 條件與錯誤訊息。
2. 當 gemini-cli 未配置時，回傳明確的 antigravity 帳號設定指引。
3. 用 `script/google-search-smoke.ts` 驗證。

**任務**

1. [x] 調整 google_search fallback 與錯誤訊息
2. [ ] 使用 smoke test 驗證

#### 功能：google_search tool call 追加 checkpoint（僅補 log）

**需求**

- 只新增 debugCheckpoint，不調整 warn/error 等級。
- 聚焦 tool registry / session resolveTools / google_search 入口與分支的執行鏈路。
- 由使用者在 UI 觸發 google_search，回收 debug.log 進行判讀。

**範圍**

- IN: `src/tool/registry.ts`, `src/session/prompt.ts`, `src/plugin/antigravity/index.ts`, `src/plugin/antigravity/plugin/search.ts`
- OUT: 功能邏輯改動、測試新增、錯誤訊息語意變更

**作法**

1. 在 ToolRegistry 註冊與過濾階段加入 checkpoint（工具清單摘要）。
2. 在 Session resolveTools 流程加入 checkpoint（候選與最終工具列表）。
3. 在 google_search 入口/分支補上 checkpoint（選帳號/取得 token/確立 provider）。
4. 請使用者透過 UI 觸發 google_search，擷取 debug.log 進行分析。

**任務**

1. [ ] 盤點並新增 tool registry / resolveTools / google_search 入口 checkpoint
2. [ ] 請使用者以 UI 觸發一次 google_search 並提供 debug.log
3. [ ] 依新 log 判斷是否仍需補 checkpoint

**問題**

- 需要使用者配合 UI 觸發與提供最新 debug.log。

#### 功能：google_search 工具來源衝突修正（本地檢查）

**需求**

- 不透過 UI 觸發，先以本地工具層面檢查定位重複 tool ID。
- 允許新增 warn 以標示覆蓋與來源衝突。
- 需要修正載入順序或停用重複工具來源。
- 完成後執行測試指令。

**範圍**

- IN: `src/tool/registry.ts`, `src/plugin/index.ts`, `src/session/prompt.ts` 及相關插件註冊
- OUT: UI 互動流程、外部認證行為、非必要的功能邏輯重構

**作法**

1. 盤點重複 tool ID 的來源與載入順序。
2. 明確標示被覆蓋來源（含 warn）。
3. 調整載入順序或停用重複來源（最小改動）。
4. 跑測試驗證。

**任務**

1. [ ] 盤點 google_search 來源與重複註冊位置
2. [ ] 加入 warn 並記錄覆蓋來源
3. [ ] 修正載入順序或停用重複工具
4. [ ] `bun run typecheck`
5. [ ] `bun test`

**問題**

- 是否需要保留次要來源作為顯式 fallback？

#### 功能：tool call 共用 debug log checkpoint 強化

**需求**

- 在共用 tool call 執行流程建立完整 checkpoint（請求/回應摘要、錯誤與重試、provider/工具資訊）。
- 每次重啟 opencode 時清除舊 debug.log（重啟從新檔開始）。
- 不遮罩內容。

**範圍**

- IN: `src/session/prompt.ts`（tool resolve/execute 共用流程）、`src/util/debug-log.ts`
- OUT: 各別 tool 內部邏輯

**方法**

1. 在 tool call start/end/error 增加 args 與回應摘要。
2. MCP tool wrapper 同步補齊 checkpoint。
3. 確認 debug log 啟動即清空（若已滿足則註記）。

**任務**

1. [x] 回退 google_search fallback 訊息改動
2. [ ] 補齊共用 tool call checkpoint（先回退避免影響對話）
3. [ ] smoke test 驗證 debug.log

**驗證**

- `bun run script/google-search-smoke.ts "free model"` 成功。
- debug.log 於啟動即清空（模組載入時重寫檔案）。
- debug log 路徑統一為 <codebase>/logs/debug.log（以 repo root 為基準）。

**問題**

- 共用 tool call checkpoint 變更導致對話流程錯誤（需重新設計導入點）。

#### 功能：debug log 路徑與清空機制校正

**需求**

- debug log 一律寫入 `/home/pkcs12/opencode/logs/debug.log`。
- 每次啟動即清空舊檔案。

**範圍**

- IN: `src/util/debug.ts`, `src/util/debug-log.ts`
- OUT: 其他 log 系統

**作法**

1. debug.ts 與 debug-log.ts 統一使用固定路徑。
2. 模組載入時清空檔案，並保留初始化護欄。

**任務**

1. [x] 修正 debug.ts 寫入路徑
2. [x] 修正 debug-log.ts 寫入路徑
3. [x] 啟動即清空舊檔案

**問題**

- 目前無。

#### 功能：debug system 統一與全鏈路追蹤

**需求**

- 合併為單一 debug API 與單一路徑輸出。
- 追蹤每一個步驟與資訊流（含 trace/span、scope、事件、耗時、結果）。
- 啟動即清空 debug.log。

**範圍**

- IN: `src/util/debug.ts`, `src/util/debug-log.ts`, 全部 debug 呼叫點
- OUT: 一般 Log 系統（`src/util/log.ts`）

**作法**

1. 盤點 debugCheckpoint/debugSpan/debugLog 使用點與資料需求。
2. 設計單一 debug API 與統一 JSONL 格式。
3. 逐步遷移呼叫端並移除/封裝 debug-log.ts。
4. 在 tool/session/provider 主要流程補齊 checkpoint。

**任務**

1. [ ] 盤點所有 debug 使用點
2. [ ] 設計單一 debug API/格式
3. [ ] 遷移呼叫端與刪除/封裝 debug-log.ts
4. [ ] 補齊全鏈路 checkpoint
5. [ ] 驗證 debug.log 連貫性

**問題**

- 目前無。

#### 功能：統一 debug log system（純文字）

**需求**

- 全部 debug/legacy log 統一輸出到 `/home/pkcs12/opencode/logs/debug.log`。
- 輸出格式為純文字（可讀格式）。
- `bun run dev` 啟動即清空舊檔案。
- 以單一 writer 承接所有 debug/legacy/log 呼叫端。

**範圍**

- IN: `src/util/debug.ts`, `src/util/log.ts`, `src/plugin/antigravity/plugin/debug.ts`, `src/plugin/gemini-cli/plugin/debug.ts`, legacy debug 寫入點
- OUT: 一般非 debug 的業務流程（不改功能邏輯）

**作法**

1. 盤點所有 debug/legacy 寫入來源與路徑。
2. 建立單一純文字 debug writer，統一輸出到固定路徑。
3. debugCheckpoint/debugSpan/外掛 debug/Log.debug 全部改為導向統一 writer。
4. 在 `bun run dev` 啟動流程中確保清空 debug.log。
5. 以最小流程驗證只剩單一路徑輸出。

**任務**

1. [x] 盤點所有 debug/legacy 寫入來源
2. [x] 建立統一純文字 writer 與格式
3. [x] 串接 debugCheckpoint/debugSpan 與外掛 debug
4. [x] 串接 util/log 的 debug 等級輸出
5. [x] `bun run dev` 驗證路徑與清空行為
6. [x] 掃描殘留寫入點並修正

**問題**

- legacy writer 的來源仍需定位與替換

#### 功能：debugLog 殘留清理與統一 API

**需求**

- 清理剩餘 `debugLog` 呼叫與舊引用，統一改為 `debugCheckpoint`。
- 確保全專案只保留單一 debug API 與單一路徑輸出。

**範圍**

- IN: `src/**` 全部 debugLog 呼叫點、auto-update-checker hooks
- OUT: 一般 Log 系統、功能行為改動

**作法**

1. 盤點剩餘 `debugLog(` 與 `debug-log` 引用。
2. 逐檔替換為 `debugCheckpoint` 並移除別名。
3. 檢查 auto-update-checker 本地 helper 是否可刪除/改用共用 API。

**任務**

1. [x] 盤點 debugLog 殘留清單
2. [x] 替換為 debugCheckpoint 並移除別名
3. [x] 檢查 auto-update-checker helper 一致性
4. [x] 驗證無 debug-log 舊引用

**問題**

- 目前無。

### DEBUGLOG

#### google_search 429（RESOURCE_EXHAUSTED）

**問題摘要**

- google_search 在 hardcoded antigravity 帳號上回傳 429。
- response body 明確為 `RESOURCE_EXHAUSTED`。

**根本原因**

- 目標帳號/專案配額耗盡（非 client 模擬錯誤）。

**證據**

- debug.log 顯示 response body：`{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}`。
- trace 顯示使用 hardcoded 帳號 `yeatsluo@gmail.com`、模型 `gemini-3-pro-low`。

**修復重點**

- 若需解除：更換帳號/專案配額、等待配額恢復、或調整 hardcoded 路徑策略。

**驗證**

- [x] 2026-02-04 05:22:40 讀到 429 回應 body（RESOURCE_EXHAUSTED）。

#### google_search 測試流程 RCA

**問題摘要**

- 需求為「只測 google_search」，不要求處理 JSON log 或 binary 來源。
- 以 `bun run dev` 啟動後，透過 UI 觸發一次 google_search。
- 檢視 `/home/pkcs12/opencode/logs/debug.log`，確認輸出為純文字 `[opencode]` 格式。

**根本原因**

- 測試目標單純為功能驗證，未涉及 JSON/JSONL writer；debug.log 僅需提供可讀紀錄。

**修復重點**

- 無需修復（本次為驗證流程）。

**驗證**

- [x] `bun run dev` 啟動後完成 google_search 測試。
- [x] debug.log 內容為 `[opencode]` 純文字格式，未見 JSON/JSONL 行（檢視已讀範圍）。

## 2026-02-03

### CHANGELOG

**來源**：本次變更整理

- 新增 Session Monitor snapshot 與 `/session/top` API，並同步 SDK 型別。
- 貼圖時略過自動 subagent workflow，統一走主會話流程。
- Sidebar Monitor 僅追蹤目前 session 與子孫 session，2 秒輪詢更新，完成即隱藏。
- Sidebar 移除 Subagents 區塊。
- Session 預設標題改為純時間戳。
- New Session 首句自動截斷為 session 名稱（不再依賴模型生成）。
- Monitor 的 tool/agent 條目若為預設時間戳，改顯示父 session 標題。
- Monitor 若 session title 尚未更新，改用首則 user 訊息推導顯示。
- Session 預設時間戳格式改為 `YYYY-MM-DD hh:mm`。
- Read 工具在父目錄不存在時改用全域搜尋建議路徑，降低 ENOENT 噪音。
- google_search 改為一律透過 Antigravity 多帳號管理機制選取帳號並執行搜尋（不再依賴 cached OAuth）。
- google_search 支援 Gemini CLI OAuth（當沒有 Antigravity 帳號時）。
- google_search 增加標準化 debug log checkpoint，輸出至 `~/.local/share/opencode/log/debug.log`。
- 模型回傳 not found / not supported / 404 時，會自動把該模型從 favorites 永久移除。
- Model Health 改為列出完整 provider/account/model 清單，並以符號顯示 Ready / Rate limit / Untracked 狀態。
- Antigravity 429 流程同步更新全域 RateLimitTracker，讓 Model Health Dashboard 即時顯示 rate limit。
- Monitor 狀態改為單行顯示，分隔符改為空白。
- Debug log 寫入路徑改為 repo root 的 `logs/debug.log`（不受 cwd 影響）。

### PLANNING

#### 功能：影像貼圖只使用 Rotation3D（移除本地 fallback）

**需求**

- 影像模型選擇只依賴 Rotation3D，移除本地硬編碼 fallback。
- Rotation3D 找不到可用模型時直接中止並提示，不隱藏問題。
- 清理影像相關的本地例外邏輯（包含硬編碼模型排除）。

**範圍**

- IN: `src/session/prompt.ts` 影像旋轉/丟棄流程、提示訊息
- OUT: 非影像的模型輪替流程、subagent workflow 判斷邏輯

**方法**

1. 移除 `selectImageModel` 的本地 rescue 清單與手動掃描邏輯。
2. `resolveImageRequest` 僅使用 Rotation3D 候選，若無可用模型則回報錯誤並中止。
3. 移除硬編碼的影像模型排除規則，改由 Rotation3D/全域狀態決定。

**任務**

1. [ ] 移除影像本地 fallback（rescue 清單）
2. [ ] Rotation3D 無候選時中止並提示
3. [ ] 清理硬編碼影像模型例外
4. [ ] 手動驗證貼圖流程（本機/非 SSH）

**待解問題**

- Rotation3D 是否需要新增影像能力篩選欄位（未來擴充）？

#### 功能：google_search 認證失敗 RCA

**需求**

- 釐清為何 google_search 需要 Antigravity 登入且認證失敗。
- 追查實際呼叫路徑、帳號選取與 token 取得流程。
- 產出完整 RCA（時間線、影響範圍、根因、修復/預防建議）。

**範圍**

- IN: tool/google_search、Antigravity plugin、auth/accounts、CLI/配置與環境偵測
- OUT: 實際修復與程式碼修改

**作法**

1. 盤點 google_search tool 與 plugin 綁定流程。
2. 追查 Antigravity 帳號管理與 auth 取得邏輯。
3. 比對錯誤訊息與日誌輸出路徑，定位失敗點。
4. 彙整 RCA 與修復建議。

**任務**

1. [ ] 追查 google_search tool 入口與 provider 選取
2. [ ] 追查 Antigravity auth/account 流程與 token 取得
3. [ ] 對照錯誤訊息與 debug log checkpoint
4. [ ] 產出完整 RCA 報告

**問題**

- 是否存在「需要 Antigravity 但未安裝/未登入」的 fallback 分支？
- CLI 是否有環境變數或設定可覆寫 provider？

#### 功能：全域 Account 快取同步與 google_search 自動 refresh

**需求**

- 修復全域 Account 快取，避免 google_search 因快取落後誤判未認證。
- google_search 在缺 accessToken 時自動 refresh，降低手動登入依賴。
- 補測試覆蓋快取刷新與 refresh 分支。

**範圍**

- IN: `src/account/index.ts`, `src/plugin/antigravity/index.ts`, `src/plugin/antigravity/plugin/accounts.ts`
- OUT: UI 登入流程、外部 OAuth provider 行為

**作法**

1. 在 Account 模組提供安全的快取刷新入口，統一刷新策略。
2. google_search 執行前強制同步 Account/AccountManager。
3. 當 antigravity 帳號缺 accessToken 時自動走 refresh 分支。
4. 補上單元測試，涵蓋快取刷新與 token refresh。

**任務**

1. [ ] Account 快取刷新入口（可被 tool 強制呼叫）
2. [ ] google_search 執行前刷新 Account/AccountManager
3. [ ] 自動 refresh accessToken（缺 token 時）
4. [ ] 新增/更新測試

**問題**

- refresh 失敗時是否應清除 access token 或標記帳號冷卻？

#### 功能：google_search 全鏈路 checkpoint

**需求**

- 在工具層、session、plugin 與 provider 分支加入 debug checkpoint。
- 釐清 google_search 未進入 plugin 時的實際阻擋點。

**範圍**

- IN: `src/tool/registry.ts`, `src/session/prompt.ts`, `src/plugin/antigravity/index.ts`, `src/plugin/antigravity/plugin/search.ts`
- OUT: 功能邏輯改動、測試新增

**作法**

1. ToolRegistry 記錄註冊/過濾後的工具清單。
2. Session prompt 記錄 resolveTools 流程與工具列表。
3. google_search 入口與分支流程加入 debugLog。

**任務**

1. [ ] ToolRegistry 加入註冊/過濾 checkpoint
2. [ ] Session resolveTools 加入工具清單 checkpoint
3. [ ] google_search 入口與 provider 分支 checkpoint

#### 功能：Typecheck 錯誤修復（TUI / Antigravity / Monitor）

**需求**

- 修正 TUI Model Health Dashboard 的型別推斷與索引錯誤。
- 修正 antigravity 內 Gemini CLI OAuth 客戶端型別不相容。
- 修正 Session Monitor 的文字 part 型別縮小錯誤。

**範圍**

- IN: `src/cli/cmd/tui/component/dialog-model-health.tsx`, `src/plugin/antigravity/index.ts`, `src/session/monitor.ts`
- OUT: 其他功能行為變更

**作法**

1. 為 TUI 資料源補上明確型別，避免 `{}`/`unknown` 擴散。
2. 建立 Gemini CLI client adapter，並針對 OAuth 型別做安全縮小。
3. 在 Monitor 使用型別守衛縮小 TextPart。

**任務**

1. [ ] 補齊 dialog-model-health 資料型別
2. [ ] 修正 Gemini CLI OAuth client 型別相容
3. [ ] 補上 Monitor TextPart 型別守衛
4. [ ] `bun run typecheck`

**問題**

- Subscription 型別的 Gemini CLI auth 是否需要另行處理？

#### 功能：Bun 套件開發技能擴充

**需求**

- 提供 Bun 套件開發相關的 skill 指引與可直接使用的模板。
- 納入建置/測試、專案模板、API/工具封裝、CLI/發佈、文件/紀錄流程。
- 與本 repo 規範整合（DIARY、Bun 指令）。
- 提供必要的自動化腳本或產生器。

**範圍**

- IN: skill 指引文件、程式碼模板、腳本/產生器、測試/驗證流程
- OUT: 非 Bun 生態的通用開發指南、外部 CI 平台整合

**作法**

1. 盤點現有 skill 目錄與 repo 內可復用範本。
2. 定義 Bun 套件開發的標準流程（install/run/typecheck/test/publish）。
3. 製作 skill 指引與模板（Tool.define/Zod/Result pattern）。
4. 補上自動化腳本（產生檔案、更新 DIARY 片段）。
5. 建立測試/驗證清單與示例。

**任務**

1. [ ] 盤點現有 skill/模板位置與命名
2. [ ] 撰寫 Bun 套件開發 skill 指引（含流程與規範）
3. [ ] 建立程式碼模板/產生器（含 Tool.define/Zod/Result）
4. [ ] 加入自動化腳本（更新 DIARY/建立骨架）
5. [ ] 補測試與驗證流程（bun test/typecheck）

**問題**

- skill 檔案需放在 repo 內或集中於個人 skills 目錄？
- CLI 發佈流程是否要內建預設 npm 發佈腳本？

#### 功能：剪貼簿貼圖與子代理影像容錯

**需求**

- WSL/SSH 環境貼上剪貼簿圖片時避免送出無效 base64。
- 子代理自動任務遇到影像時不應造成整個 session 失敗。
- 支援貼上/拖拉/檔案影像輸入的基礎容錯。

**範圍**

- IN: `src/cli/cmd/tui/util/clipboard.ts`, `src/tool/task.ts`
- OUT: 影像解析/縮圖、UI 顯示與額外功能設計

**作法**

1. WSL 讀取剪貼簿改用 UTF-8 輸出並驗證 base64/PNG。
2. 子代理自動任務預設不帶影像，避免模型端失敗。
3. 遇到不合法的 data URL 直接略過。

**任務**

1. [ ] 更新 WSL clipboard 讀取輸出與驗證
2. [ ] 子代理影像帶入條件化
3. [ ] 驗證貼上/拖拉/檔案貼上流程

**問題**

- 是否要提供 UI 提示（如：子代理忽略影像）？

#### 功能：主會話影像模型旋轉與降級處理

**需求**

- 貼上圖片只在主 session 顯示，不自動轉 subagent。
- 當前模型不支援圖片時，僅本次臨時 rotate 到可處理影像的模型並提示。

#### 功能：google_search OAuth 重構後的認證修復

**需求**

- google_search 在 OAuth 重構後仍能取得有效 access token 與 projectId。
- 不依賴舊版 cached OAuth，維持 Antigravity 多帳號選取邏輯。

**範圍**

- IN: `packages/opencode/src/plugin/antigravity/index.ts`, `packages/opencode/src/plugin/antigravity/plugin/accounts.ts`, `packages/opencode/src/auth/index.ts`
- OUT: UI 登入流程變更、外部 OAuth provider 行為調整

**作法**

1. `Auth.set` 在 `antigravity` family 時保留 `projectId`/`managedProjectId`（從 refresh 字串解析後寫入 Account）。
2. `AccountManager.loadFromDisk` 讀取 Account 模組的 `accessToken`/`expiresAt`，補齊 ManagedAccount access 狀態。
3. google_search tool 先嘗試 refresh 全域 AccountManager（使用 cached `getAuth` 或 fallback auth），避免拿到空帳號。

**任務**

1. [ ] 補上 antigravity OAuth 儲存 projectId 的邏輯
2. [ ] AccountManager 從 Account 模組同步 access token / expires
3. [ ] google_search tool 初始化前同步帳號狀態
4. [ ] 補測試：AccountManager 讀取 accessToken、Auth.set 保留 projectId

#### 功能：google_search 透過 AccountManager 取得認證

**需求**

- google_search 不依賴 `opencode auth login`，改由 AccountManager/Account 模組取得 OAuth 認證（accounts.json 為核心）。
- 缺 access token 時能自動 refresh，並回寫 accounts.json。
- 若 antigravity 認證需要額外欄位，允許擴充 accounts.json。
- 以 debug.log 追蹤認證與 refresh 流程，便於抓蟲。
- 確保 antigravity 帳號的 projectId/managedProjectId 可被 google_search 使用。

**範圍**

- IN: `src/plugin/antigravity/index.ts`, `src/plugin/antigravity/plugin/accounts.ts`, `src/account/index.ts`
- OUT: UI 登入流程、外部 OAuth provider 行為

**作法**

1. 在 AccountManager 補上同步 accessToken/expires 回 Account 模組的能力。
2. google_search 取得帳號時優先走 AccountManager，缺 token 自動 refresh 並回寫。
3. 如需，擴充 accounts.json 欄位並同步讀寫。
4. 強化 debug log 以利觀察帳號來源與 refresh 流程。

**任務**

1. [ ] AccountManager 回寫 accessToken/expires
2. [ ] google_search 認證流程改為 AccountManager
3. [ ] accounts.json 擴充欄位同步（若 refresh 回傳新增資訊）
4. [ ] 更新/新增 antigravity 相關測試

**問題**

- 是否需要在無 projectId 時回退到 managedProjectId 或提示重新授權？

#### 功能：google_search 認證測試補齊與 debug log 補強

**需求**

- 補齊 antigravity/google_search 相關測試（全量覆蓋）。
- debug.log 增補欄位以利追蹤（不改業務行為）。

**範圍**

- IN: `src/plugin/antigravity/index.ts`, `src/plugin/antigravity/plugin/accounts.test.ts`
- OUT: 其他功能行為變更、執行測試命令

**作法**

1. 擴充 debugLog 欄位內容（如 accountIndex/projectId）。
2. 新增測試覆蓋 saveToDisk 回寫、metadata、ensureProjectContext 流程。

**任務**

1. [ ] 補充 debug.log 欄位
2. [ ] 新增/更新 antigravity 測試（全量覆蓋）

**問題**

- 是否需要針對 refresh 失敗補充 debugLog 分支覆蓋？

- 若無可用影像模型，移除圖片並改成文字提示。

**範圍**

- IN: `src/session/prompt.ts`
- OUT: Provider capabilities 定義調整、額外 UI 版面變更

**作法**

1. 檢測 user message 是否含 image parts，決定 rotate 或 drop。
2. 依 provider 健康狀態挑選可用影像模型並顯示 Toast。
3. 無可用影像模型時，將圖片 part 轉成文字 placeholder。

**任務**

1. [x] 在 SessionPrompt loop 內注入 image rotate/drop 流程
2. [x] 調整 processor/process 使用 active model
3. [x] 補齊 Toast 與降級提示內容
4. [x] `bun run typecheck`

**問題**

- Toast 文案是否需要可配置或多語系？

#### 功能：/agents 選單停用 native search

**需求**

- 取消 /agents 選單的內建搜尋模式（/ 進入 search mode）。

**範圍**

- IN: `src/cli/cmd/tui/component/dialog-agent.tsx`
- OUT: 其他 DialogSelect 的搜尋行為

**作法**

1. 在 /agents 對應的 DialogSelect 隱藏搜尋輸入。

**任務**

1. [x] 停用 /agents 選單搜尋輸入

**問題**

- 是否需要在 UI 提示搜尋已停用？

#### 功能：TUI /tasks 指令退役

**需求**

- 指令清單不再顯示 `/tasks`。
- 使用者輸入 `/tasks` 不觸發任何動作。

**範圍**

- IN: `src/cli/cmd/tui/app.tsx`
- OUT: Task Dashboard UI、任務資料結構、後端路由

**作法**

1. 移除 `/tasks` 的 slash 指令註冊與對應 command entry。

**任務**

1. [x] 移除 `/tasks` 指令入口

#### 功能：移除 Task Dashboard UI 檔案

**需求**

- 刪除未使用的 Task Dashboard UI 檔案。

**範圍**

- IN: `src/cli/cmd/tui/component/dialog-tasks.tsx`
- OUT: 其他指令、資料結構與後端路由

**作法**

1. 刪除 `dialog-tasks.tsx` 檔案。

**任務**

1. [x] 刪除 `dialog-tasks.tsx`

**問題**

- 無

**問題**

- 無

#### 功能：thoughtSignature 插件 / QUOTA 清理

**來源**：`packages/opencode/PLANNING.md:3`（未提交變更）

**需求**

- 確認 `src/plugin/google-api/plugin.ts` 存在並於 `src/plugin/index.ts` 註冊。
- 移除 `src/session/processor.ts` 的 QUOTA 模擬碼。
- 修復 LSP/型別錯誤（`src/config/config.ts`, `src/task/task.ts`）。
- 通過 `bun run typecheck`、`bun test`。

**範圍**

- IN: `src/plugin/google-api/plugin.ts`, `src/plugin/index.ts`, `src/session/processor.ts`, `src/config/config.ts`, `src/task/task.ts`
- OUT: 其他功能與非文件行為變更

**作法**

1. 盤點 plugin 註冊狀態。
2. 移除 QUOTA 模擬碼。
3. 修正型別/LSP。
4. 跑型別與測試。

**任務**

1. [ ] 驗證 thoughtSignature 插件註冊
2. [ ] 移除 QUOTA 模擬
3. [ ] 修復型別錯誤
4. [ ] `bun run typecheck`
5. [ ] `bun test`

**問題**

- 是否同步更新 DIARY？

---

#### 功能：自動多 Subagent 分工與模型選擇

**來源**：`packages/opencode/PLANNING.md:33`（未提交變更）

**需求**

- 非瑣碎任務自動分派 subagent（coding/review/testing/docs）。
- 依 subagent 預設 model 或任務特性選模。
- Monitor 顯示 subagent 與模型資訊。

**範圍**

- IN: `src/session/prompt.ts`, `src/agent/agent.ts`, `src/agent/prompt/*`
- OUT: CLI/TUI 顯示調整、Provider/Rotation 行為變更

**作法**

1. 在 `createUserMessage` 注入分工判斷與 SubtaskPart。
2. 補齊 subagent prompt 與 model 設定。
3. 驗證 Monitor 顯示。

**任務**

1. [ ] 新增/調整 subagent 定義
2. [ ] 分工判斷邏輯
3. [ ] SubtaskPart 帶入 model
4. [ ] 驗證 Monitor

**問題**

- 非瑣碎判斷條件要多保守？

---

#### 功能：手動切換模型與 AGENTS 規則載入釐清

**需求**

- 釐清手動切換模型是否會重新載入 AGENTS 規則。
- 確認 subagent 模型選擇是否以 AGENTS.md 為 SSOT。
- 找出「規則未生效」的具體原因與修正方向。

**範圍**

- IN: TUI model switch 流程（local.model）、SessionPrompt/LLM system 指令載入、ModelScoring。
- OUT: Provider/SDK 端行為調整（除非為根因）。

**作法**

1. 追查 model 切換 → prompt 送出 → SessionPrompt → LLM system 的資料流。
2. 檢查 InstructionPrompt.system 是否每次讀取 AGENTS。
3. 比對 AGENTS 與 ModelScoring/選模邏輯的一致性。

**任務**

1. [ ] 確認模型切換生效點與是否需要重送訊息
2. [ ] 比對 AGENTS 規則與 ModelScoring 硬編碼差異
3. [ ] 提出修正建議或最小改動方案

**問題**

- 是否需要在 UI 明確提示「切換模型僅影響下一次訊息」？
- 是否要將 ModelScoring 改成讀取 AGENTS/config 以避免規則漂移？

---

#### 功能：完成 repo 內待辦後才自動清除 todo

**需求**

- 先完成目前 todo 中「屬於本 repo/OpenCode」的未完成項目。
- 完成後才導入「使用者送出新訊息時自動清除 todo（改資料）」。
- 不處理跨專案/非本 repo 的 todo。

**範圍**

- IN: 本 repo 內對應 todo 的修正（TUI/測試/capabilities/腳本/指令）、todo 自動清除行為
- OUT: 其他專案的待辦

**作法**

1. 盤點 todo 對應的檔案與目前狀態（只限本 repo）。
2. 逐項完成未完成修正與測試。
3. 完成後再導入「新訊息自動清除 todo」行為。
4. 驗證 sidebar 不再顯示已完成項目。

**任務**

1. [ ] 盤點本 repo 內未完成 todo 對應範圍
2. [ ] 完成 TUI 型別錯誤相關修正
3. [ ] 完成測試相關修正與 `bun test`
4. [ ] 完成 capabilities 重構相關項目（若在本 repo）
5. [ ] 完成 Windows 轉發腳本（若在本 repo）
6. [ ] 完成 ping/exit 指令（若在本 repo）
7. [ ] 導入新訊息自動清除 todo
8. [ ] 驗證 todo 顯示

**問題**

- 其餘 todo 是否確實存在於本 repo 範圍？

### DEBUGLOG

#### 手動切換模型規則未生效

**問題摘要**

- 使用者手動切換 model 後，覺得 AGENTS 規則沒有被重新載入。
- Subagent 選模行為與 AGENTS.md 記錄不一致。

**根本原因**

- UI 切換只更新本地 model，真正套用發生在「下一次送出 prompt」。
- `ModelScoring` 使用硬編碼權重/分數，未讀取 AGENTS.md，導致規則漂移。
- 缺少 UI 提示，造成「切換後立即生效」的誤解。

**修復重點**

- 以 AGENTS.md 的 `opencode-model-scoring` 區塊作為選模 SSOT。
- `ModelScoring` 改為動態讀取 AGENTS 規則並合併預設值。
- UI 提示「模型切換僅影響下一次訊息，system prompt 送出時重新載入」。

**驗證**

- [ ] 切換模型後送出新訊息，system prompt 仍含最新 AGENTS 指令。
- [ ] Subagent 選模與 AGENTS scoring 一致。

#### 影像讀取觸發 Subagent 與模型旋轉

**問題摘要**

- 貼圖/讀圖時會自動開啟 subagent，並顯示 model rotated/fallback，導致錯誤處理影像。

**根本原因**

- 本地 `src/session/prompt.ts` 新增自動 subagent workflow 與 image rotate/drop；origin/dev 沒有這段流程。
- 本地 `src/tool/task.ts` 會把父訊息的影像附件直接帶入 subagent，即使是 auto task 或模型不支援 image。

**修復重點**

- 對齊 origin/dev：移除/關閉自動 subagent workflow 與 image rotate/drop。
- Task tool 不自動帶入影像，必要時改成明確配置開關。

**驗證**

- [ ] 貼圖不再觸發 subagent 或模型旋轉。
- [ ] 影像只由主 session 處理，影像錯誤訊息不再出現。

## 2026-02-02

### PLANNING

#### 功能：Subagent Monitor Panel

**來源**：`PLANNING.md`（commit 2026-02-02）

**狀態**

- 後端 `SessionMonitor.snapshot()` 與 `/session/top` 已完成，聚焦 TUI panel 與資料流。

**範圍**

- IN: `/session/top` 快照、sidebar monitor panel
- OUT: 歷史 log、CLI 新指令、過細 telemetry

**作法**

1. 確認 snapshot 欄位（agent/parentID/status/model/requests/tokens/active tool）。
2. 生成 SDK/OpenAPI，供 `sdk.client.session.top()` 使用。
3. Sidebar 實作 MonitorPanel（排序、狀態點、點擊跳轉）。
4. 透過 poll 或 event 刷新。

**任務**

- [x] 定義 snapshot 欄位
- [x] 新增 `/session/top`
- [x] 更新 SDK/OpenAPI
- [x] Sync store 加入 monitor
- [x] Sidebar 實作 panel

**問題**

- 顯示上限與刷新頻率（預設 8 筆 / 3 秒）。

---

#### 功能：共享測試 Plugin Cache

**來源**：`PLANNING.md`（commit 2026-02-02）

**需求**

- 建立 `test/shared/plugin-cache`，加速測試依賴。
- `script/setup-plugin-cache.ts`：缺 `node_modules` 時才跑 `bun install`。
- `Config.installDependencies()` 偵測 cache 並用符號連結。
- `package.json` 加 `prepare:plugin-cache`。

**範圍**

- IN: `test/shared/plugin-cache/*`, `script/setup-plugin-cache.ts`, `package.json`, `src/config/config.ts`
- OUT: 其他 CI 流程

**任務**

- [x] 建 cache 結構與 `.gitignore`
- [x] 加 setup script
- [x] 加 `prepare:plugin-cache`
- [x] 使用 cache 連結
- [ ] README/PLANNING 補充說明

**問題**

- 是否在 CI 加 `bun run prepare:plugin-cache`？

---

#### 功能：Sidebar Monitor Improvements

**來源**：`PLANNING.md`（commit 2026-02-02）

**需求**

- 只顯示活躍狀態：`busy`, `working`, `retry`, `compacting`, `pending`。
- 壓縮 UI 間距。

**範圍**

- IN: `src/cli/cmd/tui/routes/session/sidebar.tsx`
- OUT: 後端/SDK

**任務**

- [x] 狀態過濾
- [x] UI 緊湊化

---

### PLANNING

#### 程式碼審查：OpenCode 系統

**來源**：`packages/opencode/PLANNING.md:1`（commit 2026-02-02 19:06 +0800）

**目標**

- 全系統審查：Architecture / Antigravity / Session & LLM / Tools & Security / CLI & TUI

**任務**

- [ ] Phase 1~5 審查
- [ ] 產出 `CODEREVIEW.md`

---

#### Provider Capabilities / Model Family / Transformer Pipeline

**來源**：`PLANNING.md:800`（commit 2026-02-02 07:56 +0800）

**Phase 1：Capabilities**

- 建立 `src/provider/capabilities.ts`
- `llm.ts` 改用 capabilities
- 移除 `isCodex` 等硬編碼判斷

**Phase 2：Model Family**

- `Provider.Model` 加 `family`
- 解析/覆寫 family，取代字串嗅探

**Phase 3：Options Transformer Pipeline**

- 抽離 `transform.ts`
- 各 SDK 模組化 transformer
- 支援 plugin 註冊

**效益**

- 新增 provider 成本下降
- 降低 model 誤判
- 轉換集中易測

**風險**

- 重構範圍大，需分階段與測試

---

## 2026-02-01

### DEBUGLOG

#### Provider 名稱正規化與 Model Health Dashboard

**來源**：`DEBUGLOG.md:1`

**問題摘要**

- Provider 名稱混用 `google` / `google-api`。
- Dashboard 跨進程無法共享。

**根本原因**

- Provider ID 分散且無規範。
- `globalThis` / `Symbol.for` 無法跨進程共享。

**修復重點**

- 統一 provider ID：`anthropic`, `openai`, `google-api`, `gemini-cli`, `antigravity`, `opencode`, `github-copilot`。
- 狀態改用 `~/.local/state/opencode/model-health.json`。
- Dashboard 4 欄表格與快捷鍵（`R` / `C` / `←`）。

**驗證**

- [x] Provider 名稱已統一
- [x] Dashboard 跨進程同步成功
- [x] Rate Limit 倒數顯示正常

---

## 2026-01-31

### DEBUGLOG

#### DialogPrompt 輸入與 Google-API 配置流程修復

**來源**：`DEBUGLOG.md`（2026-01-31）

**問題摘要**

- Enter 清空輸入，流程卡住。

**根本原因**

- `textarea` submit 競爭。
- `Show` 切換未完整重掛載。

**修復重點**

- 移除 `textarea` submit。
- `onContentChange` 快照內容。
- `Switch/Match` + `step`。
- 加入 debug checkpoint。

**驗證**

- [x] Enter 流程順暢
- [x] 日誌可追溯

---

#### /admin Google-API 編輯器與調試鏈完善

**來源**：`DEBUGLOG.md`（2026-01-31）

**問題摘要**

- 新增/刪除不穩、焦點丟失。

**根本原因**

- Dialog 重建、焦點未回復。

**修復重點**

- 改用 `dialog.push` overlay。
- 增加 dialog stack trace / error boundary / key trace。
- Dialog 關閉後自動聚焦輸入框。

**驗證**

- [x] 新增/刪除穩定
- [x] 模型選完可回到輸入

---

#### Rate limit 重導向與草稿保留

**來源**：`DEBUGLOG.md`（2026-01-31）

**問題摘要**

- Rate limit 後需手動導航，草稿易中斷。

**修復重點**

- Rate limit 進入 `retry` 時自動開啟 `/admin` 並定位模型列表。
- 關閉後恢復草稿與游標。

**驗證**

- 🤖 `/admin` 自動開啟
- ✏️ 草稿與游標可恢復

---

### PLANNING

#### CMS 模組化重構計畫（核心摘要）

**來源**：`PLANNING.md:1`（commit 2026-01-31 17:15 +0800）

**依賴關係**

- /admin TUI 依賴 Account Module 與 Google Provider Suite
- cms Auth patch 至 origin/dev

**設計決策**

- Provider 維持 `antigravity`、`gemini-cli` 獨立。
- Auth 改以 Account 模組為單一來源。
- Rate Limit 以 Toast + Favorites 自動切換。
- `/admin` 完整管理，`/provider` 保留，`/accounts` 退役。

**Account System**

- API：`Account.list/add/remove/setActive/getActiveInfo/forceFullMigration`
- 旋轉：`getNextAvailable/recordSuccess/recordRateLimit/recordFailure/isRateLimited/getMinWaitTime/getRotationStatus`

**Google Provider Suite**

- `google-api`（API Key）/ `gemini-cli`（OAuth）/ `antigravity`（OAuth + rotation）
- 目的：分散配額、維持多帳號輪替

**Admin TUI**

- 三層導覽：Root / Accounts / Models
- `/admin` 為主、`/models`/`/provider` 保留

---

#### Auth 系統統一

**來源**：`PLANNING.md:210`（commit 2026-01-31 17:15 +0800）

**差異**

- origin/dev：`auth.json` 單帳號
- cms：`accounts.json` 多帳號

**策略**

- `accounts.json` 為唯一來源
- 啟動時強制遷移 `auth.json`（備份後移除）

---

#### 跨模型相容性處理

**來源**：`PLANNING.md:370`（commit 2026-01-31 17:15 +0800）

**問題**

- Gemini/Claude 的 thinking signature 互相污染

**策略**

- 在 `LLM.stream()` 統一入口做 cross-model sanitize

---

#### Rate Limit 處理策略

**來源**：`PLANNING.md:405`（commit 2026-01-31 17:15 +0800）

**行為**

- Toast 通知 → Favorites 自動切換 → 不可用時提示手動
- Gemini 優先在 Google Provider Suite 內輪替

---

## 2026-01-30

### DEBUGLOG

#### Antigravity 模型通信修復

**來源**：`DEBUGLOG.md`（2026-01-30）

**問題摘要**

- 版本錯誤、請求卡住、簡單訊息無回應。

**根本原因**

- 版本陣列含舊版（隨機挑選）。
- Gemini transform 未套用。
- 硬編碼 debug log 干擾。

**修復重點**

- 固定版本 `1.15.8`。
- 補齊 Gemini transform 檢查與參數。
- 移除硬編碼 `console.log`。

### DEBUGLOG

#### 貼上功能失效 (Text/Image Paste Failure)

**問題摘要**

- 使用者回報貼上文字與圖片功能失效。
- debug.log 顯示 `tool.call` 正常，無針對貼上動作的錯誤堆疊，呈現「靜默失敗」狀態。

**根本原因**

- **觸發條件**：在某些終端環境（如 WSL/Windows Terminal），TUI 的 `textarea.onPaste` 事件可能接收到空字串或格式異常，導致程式觸發 fallback 指令 `prompt.paste`。
- **邏輯缺漏**：`src/cli/cmd/tui/component/prompt/index.tsx` 中的 `prompt.paste` 指令實作不完整。它透過 `Clipboard.read()` 讀取剪貼簿後，**僅檢查並處理 `image/` MIME type**。
- **結果**：當剪貼簿內容為 `text/plain` 且走入 fallback 路徑時，程式碼完全忽略該內容，導致使用者操作後無任何反應。

**修復重點**

- 修改 `prompt.paste` 指令邏輯。
- 新增 `text/plain` 的處理分支。
- 補回文字貼上策略：
  - 檢查是否啟用 `disable_paste_summary`。
  - 若內容過長（>3 行或 >150 字），轉換為 `[Pasted ~N lines]` 虛擬文字。
  - 否則直接插入文字內容。

**驗證**

- [x] 程式碼審查確認 `prompt.paste` 已包含 `text/plain` 處理邏輯。
- [ ] 待使用者於實際環境驗證。
