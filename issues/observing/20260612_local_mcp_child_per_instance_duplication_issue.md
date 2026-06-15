# Bug Report: 同一 daemon 對每個 project 目錄各 spawn 一份 local MCP 子行程（per-Instance 重複；非洩漏但有界堆積）

## 1. Bug Identity

| Field | Value |
| --- | --- |
| Title | local stdio MCP 子行程按 Instance.directory 重複 spawn，且 "Global dedup" 註解未真正達成跨-Instance 共用 |
| Component | opencode MCP 生命週期（`packages/opencode/src/mcp/index.ts`）+ Instance state scoping |
| Date | 2026-06-12 |
| Severity | low-medium — 非無界洩漏，不致命；但 heavy 多專案 daemon 下子行程數 = 專案數 × local-MCP 數，浪費記憶體/PID，且舊專案 Instance 若不被 dispose 會長留 |
| Priority | P3 |
| Status | OBSERVING — 方向 1 已實作+部署+live 驗證。process-global ref-counted pool（`packages/opencode/src/mcp/local-mcp-pool.ts`），commits `87d903ba7`(pool) + `23c3902d1`(keying refine)。**Live 驗證**：對 daemon 52952 觸發 3 個不同 project dir（/home/pkcs12、bodesign、games）的 MCP connect，全部 connected，但 system-manager / drawmiat 各只 **1 個共用子行程**（修前會是 3+3=6）。詳見 §10。 |

## 2. 觀測

某時點 `pgrep -f 'packages/mcp/src/index.ts'` 列出 ~10 個 specbase 子行程。分群（依 ppid）後並非單一來源洩漏，而是**多個獨立 MCP host 各自 spawn**：

- opencode daemon（`opencode serve`，pid 74247）→ **5 個** specbase child
- opencode `session worker`（兩個獨立 process）→ 各 1 個
- Antigravity/Claude-Code 擴充（VSCode 環境，另一個 MCP host）→ 3 個

daemon 下那 5 個：全部 `state=S`（睡眠，**非 zombie、非 defunct**）、ppid 皆為活著的 74247（**非 orphan**）、env/cwd 完全相同（`SPECBASE_TARGET_REPO`、`cwd` 都是 mcp.json 靜態值，無法區分 Instance）。spawn 時間 12:40 / 13:34 / 21:16 / 21:17 / 21:18（後三者 1 分鐘內，像快速切換專案）。

## 3. 根因（機制）

- MCP state 以 `Instance.state(createState, cleanupState)` 建立，而 `Instance.state` 用 **`Instance.directory` 當 key**（[project/instance.ts:85-86](packages/opencode/src/project/instance.ts#L85-L86) → `State.create(() => Instance.directory, init, dispose)`）。→ **每個不同的 project 目錄 = 一份獨立 MCP state = 一份獨立 clients map**。
- specbase 在 `mcp.json` 是**靜態 `enabled: true`**（不是 on-demand），故每個 Instance 在 phase-2 auto-connect 時都各自 spawn 一個 specbase stdio child；且不受 on-demand idle-disconnect（`AUTO_MCP_IDLE_MS`）回收——它跟著 Instance 活到 Instance 被 dispose。
- 結論：daemon 服務 N 個不同 project 目錄 → N 個 specbase child（+ N 個 drawmiat + N 個 docxmcp …）。**這是 per-Instance 設計的直接結果，不是 reconnect 洩漏。** 子行程數有界（≤ 活 Instance 數 × local-MCP 數）。

## 4. 真正的瑕疵：「Global dedup」註解 overpromise

[mcp/index.ts](packages/opencode/src/mcp/index.ts) `createInFlight` 上方註解宣稱：

> "Global dedup: prevents multiple Instance workspaces from spawning duplicate stdio MCP servers for the same config key. The first Instance that calls create() wins; subsequent callers get the same client."

但實作只是一個 **module-level 的 in-flight Promise map**，且 `create()` 在 `.finally` 立刻 `createInFlight.delete(key)`。因此：

- **只有並行（concurrent）create 會共用 client**（B join A 的 in-flight promise）。
- **時間錯開（sequential）的 create 各自 spawn 新 child**——entry 已從 map 刪除。

而不同 project 目錄通常是**先後**打開（如 21:16/17/18），不是同一瞬間 → 不會命中 dedup → 每個各 spawn 一份。**所以註解承諾的「跨 Instance 不重複 spawn」實際未達成**，這是註解與行為的落差。

## 5. 潛在 soft-leak（待確認，非本 issue 主張）

per-Instance child 只在 Instance 被 dispose（`cleanupState` → `client.close()`）時收掉。若 daemon 對「已不再使用的 project 目錄」的 Instance 不做 dispose/eviction，其 child 會長留至 daemon 結束（堆積上界 = daemon 生命期內曾造訪的不同目錄數）。12:40 的 child 在 ~11h 後仍活，與此一致（也可能該 Instance 仍活）。需 daemon 側確認 Instance eviction 策略才能判定是「正常長壽 Instance」還是「dispose 沒被呼叫」。

## 6. Proposed Fix Direction（擇一/併用，皆非緊急）

1. **真正的跨-Instance 共用**：對 `local`（且非 per-project 的）MCP，讓多個 Instance 共用單一 child——把 client/transport 提升為 process-global（以 config key + 解析後 command+cwd+env 為 key），而非 per-Instance。需處理 ref-count 與最後一個 Instance 離開才 close。這才兌現第 4 節註解的承諾。
2. **若維持 per-Instance**：把第 4 節的誤導性註解改正為「per-Instance child；createInFlight 僅去重並行 create」，避免後人誤以為已跨-Instance 去重。
3. **確認 Instance dispose**：加 log/檢查確保不再使用的 Instance 會被 dispose 且 `cleanupState` 真的 close 掉其 MCP children（堵 soft-leak）。

## 7. 與 stale-child fix（76cae876c）的關係

剛落地的 stale-child 自動重連 fix 在重連時會 `old.close()` 再 `create()`，**不會新增本問題的堆積**（一進一出）。本 issue 與該 fix 正交，可獨立處理。

## 8. Acceptance Criteria（若決定修）

- daemon 服務 M 個 project 目錄時，每個靜態-enabled `local` MCP 的子行程數為 **1（共用）** 而非 M（採方向 1）；或註解誠實反映 per-Instance 行為（採方向 2）。
- 不再使用的 Instance 被 dispose 後，其 MCP children 確實退出（採方向 3，補 soft-leak）。
- regression：單一專案 session 的 MCP 工具行為不變。

---

## 9. Update (2026-06-12) — specbase 已不再貢獻本問題

specbase 改 native（plan `specbase/internal-toolcall-dual-track` 已部署），不再有 per-Instance 子行程。**但本問題的一般情形（docxmcp/drawmiat 等仍為 local MCP）未解**，§4 的「Global dedup 註解 overpromise」仍成立。保持 OPEN。

## 10. Resolution (2026-06-15) — 方向 1，ref-counted pool，已 live 驗證

採方向 1（使用者裁定）。實作 `local-mcp-pool.ts`：process-global ref-counted pool，acquire() **monkey-patch client.close() 做引用計數**，所以既有 5 個 close site（cleanupState / toggle / connect-replace / disconnect / refreshStale）全部不動就自動平衡；單一 Instance（refs 1）立即 close，與舊行為位元相同。`createInFlight`（只去重並行 create）退役，§4 的 overpromise 註解一併移除。

**share key 設計**（commit `23c3902d1` 修正 `87d903ba7` 的不足）：
- key = 解析後 command（cmd + finalArgs）+ env + source mtime；**cwd 僅在使用者明設 `mcp.cwd` 時才入 key**。預設 Instance.directory 屬偶然，不入 key 才能真正共用。
- filesystem MCP 把 cwd 注入 finalArgs → 靠 args 天然分離，無需 cwd 入 key。
- source mtime 入 key → stale-refresh（檔案內容變更）產生新 key → 全新子行程，pool 不會回傳 stale client。
- 共用子行程跑在「第一個 spawn 者的 cwd」，對 cwd-無關 server（system-manager 走 socket/env；drawmiat 吃絕對路徑）無副作用。

**為何 `87d903ba7` 不夠**：live 量到兩個 local MCP 都解析成 per-project cwd（system-manager 因 `config.ts:66` source-alias 走原始碼而非 /tmp-cwd 編譯檔；drawmiat 是 venv python script），cwd 入 key 等於每專案一份，沒達成 N→1。改為偶然-cwd 不入 key 後才真正共用。

**驗證**：16 個 pool 單元測試（ref-count / 共用 / 併發 / respawn / 失敗 passthrough / key 推導 / filesystem args 分離 / 明設 cwd 分離）；mcp suite 全綠；typecheck 乾淨；live：3 個 project dir → system-manager / drawmiat 各 1 共用子行程，全部 connected 無 regression。

Status: OBSERVING — 方向 1 已部署+即時驗證（3-Instance 共用 1 子行程、MCP 連線正常）。**Exit → closed/**：使用者重度多專案 daemon 日常運作下，靜態-enabled local MCP 子行程數維持「每 share-key 1 份」而非每專案一份，soak 數日無 MCP 連線/工具異常。**Regress → open**：同一 share-key 出現多份子行程；或共用子行程的 cwd-無關假設被打破（某 server 對 cwd 敏感卻被誤共用 → 工具行為跨專案串味）。
