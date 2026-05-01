# 2026-05-01 Frontend Dialog Stream Flattening

## 需求

- 啟動新計畫：把 frontend dialog stream 平坦化。
- 使用者定義的產品模型：整個 dialog stream 是單一連續往下擴增的畫布；使用者輸入、AI 輸出、工具呼叫、狀態、錯誤都是一張張卡片。
- 所有狀態追蹤固定用 turn status line；不要為前端顯示新增 runloop bubble 或管理狀態。
- 高層畫面現狀模型：整個畫面只有 header、sidebar、中間 stream window、底部 text input box；其中 stream window 自己有 title bar 顯示 session name。
- 重要動機：長期追底模式畫面亂跳 anchor 的問題，應透過前端 stream ownership / 單一畫布 / 單一 scroll owner 重構解決，而不是繼續疊局部補丁。

## 範圍(IN/OUT)

- IN: 建立 plan artifacts，定義產品模型、設計邊界、任務清單。
- IN: 明確區分 frontend display behavior 與 backend/session/runloop semantics。
- OUT: 本步不實作程式碼。
- OUT: 不重啟 daemon/gateway。

## 任務清單

- [x] 建立 frontend dialog stream 平坦化 plan 與 event log
- [x] 定義單一畫布 + 卡片流水帳 + turn status line 的設計契約
- [x] 規劃實作任務、驗證與停止條件

## Key Decisions

- DD-1: Dialog stream 的產品語言改為「畫布 + 卡片」，不再用 turn/part/wrapper 作為使用者認知層級。
- DD-2: Status display only belongs to the turn status line.
- DD-3: Frontend DOM/layout flattening must not introduce backend-like runloop grouping state.
- DD-4: 所有輸出內容仍是畫布上的卡片；本計畫只移除多餘大泡泡容器，不改變 user/assistant/tool/result/error/metadata 卡片的基本組成。
- DD-5: Tool call card 只在本計畫中定義為畫布上的卡片邊界；不要求它們一定能展開內容，也不統一各 tool card 內部世界。各 tool card 的內部呈現到時候再各別定義。
- DD-6: 第一個實作 slice 只做 TaskDetail 內嵌 dialog stream；完整 session page 不動。
- DD-7: 保留 TaskDetail 的 Output 標題列與 Clear 按鈕，只平坦化其內部 stream 區。
- DD-8: Tool call/result 只保留現有顯示，不新增展開/收合能力。
- DD-9: 狀態收斂只保證 TaskDetail 內嵌 stream 的 live status 走 turn status line；完整 session page 的 compaction/toast 收斂另案處理。
- DD-10: bottom-follow / anchor-jump 是本計畫的一級 frontend layout motivation；實作必須定義 `DialogStreamCanvas` 的單一 scroll owner 與 bottom anchor contract。
- DD-11: 全畫面產品 layout 保留現狀：header / sidebar / stream window（含顯示 session name 的 title bar）/ text input box；平坦化不得新增平行的 footer、泡泡區或內層 stream universe。

## Open Gaps Resolved

| Gap         | Decision                                                   |
| ----------- | ---------------------------------------------------------- |
| 實作層級    | 先做 TaskDetail 內嵌 dialog stream，完整 session page 不動 |
| Output 外框 | 保留 Output 標題列與 Clear 按鈕                            |
| Tool card   | 保留現有顯示，不新增展開/收合                              |
| Status line | 只收斂 TaskDetail 內嵌 stream 的 live status               |

## Layout Deformation Risk Assessment

- 已評估移除容器後可能造成的排版變形：寬度改變、間距 collapse、卡片內距變動、scroll owner 變動、status line 位移、tool/result 視覺群組變形、empty/loading/error 狀態不一致。
- Guardrail: 每次只移除一個 wrapper，並先確認它實際擁有的是 width、spacing、scroll 或 status placement；若 wrapper 擁有卡片內容結構，則不在本計畫移除。
- Guardrail: 卡片內部 padding、內容組成、message/part render semantics 不屬於本計畫變更範圍。
- Guardrail: 不因平坦化而強制 tool call card 採用同一套 expandable content 模型。
- Guardrail: 驗證時必須包含追底/anchor 行為：在底部時新內容應跟隨；使用者捲離底部時不得被新內容拉回或亂跳。

## Verification

- XDG Backup: `/home/pkcs12/.config/opencode.bak-20260501-1821-frontend-dialog-stream-flattening`（白名單快照；僅供需要時手動還原）。
- Plan artifacts created under `plans/20260501_frontend-dialog-stream-flattening/`.
- Architecture Sync: Pending until implementation changes are made; current step is planning-only.
