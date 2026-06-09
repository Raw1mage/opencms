# Spec

## Purpose

- Give the event log the same SQLite-queryable recall the session log already has, via a separate FTS store; route knowledge recall across three tiers (session / event / spec); retire MEMORY.md without losing retrievability.

## Requirements

### Requirement: Separate Event Index

系統 SHALL 以復用的 specbase 引擎，把 event log markdown 索引進一個獨立於 spec 語料的 `events.sqlite` FTS5 store。

#### Scenario: 索引全部 event 檔

- **GIVEN** `docs/events/*.md`（912 檔）與 `plans/**/events/*.md`（81 檔）存在
- **WHEN** 觸發 event 索引重建
- **THEN** 每個檔成為一筆 `type='event'` entry，`slug` 與 `created` 由檔名推導，body 全文進 FTS5，html render 略過

#### Scenario: spec 語料不被污染

- **GIVEN** spec 索引（`.specbase/index.sqlite`，22 entries）已存在
- **WHEN** event 索引建立
- **THEN** events 寫入獨立的 `events.sqlite`，spec 的 FTS 表與 BM25 統計**不變**，spec 搜尋結果與索引前一致

#### Scenario: 缺日期檔名的降級

- **GIVEN** 某 event 檔名無可解析日期
- **WHEN** 索引該檔
- **THEN** `created` 為 null，該 entry 仍可被全文檢索到（不報錯、不中斷整批重建）

### Requirement: Event Recall Query

系統 SHALL 提供獨立於 `wiki_search`/`wiki_query` 的 event 查詢工具，回傳 BM25 排序的 snippet。

#### Scenario: 全文 event 檢索

- **WHEN** agent 以關鍵字呼叫 `event_search`
- **THEN** 回傳 ranked snippet（slug + title + snippet + rank），毫秒級，且不需把整檔載入 context

#### Scenario: 日期過濾

- **WHEN** agent 以 `event_query` 帶日期區間查詢
- **THEN** 只回傳該區間（由檔名 date）內的 events

### Requirement: Three-Tier Retrieval Routing

系統 SHALL 在 AGENTS.md 注入一條 eager 規則，讓 agent 依所需粒度選擇 session / event / spec 層查詢。

#### Scenario: 依粒度路由

- **GIVEN** AGENTS.md 已含三層路由規則
- **WHEN** 出現一個回憶需求
- **THEN** 「我剛做了什麼」→ session；「X 為何這樣決定 / 那次 RCA」→ event index；「X 現在的設計」→ specwiki

### Requirement: MEMORY.md Retirement

系統 SHALL 依分類法把 MEMORY.md 每一條路由到正確的家，驗證可被索引撈到後，最後才清空檔案。

#### Scenario: 分流落地

- **WHEN** 處理一條 MEMORY.md entry
- **THEN** 運作規則 → AGENTS.md；歷史/RCA/決策 → event log；觸發型程序 → skill/command；高變動狀態 → 丟棄

#### Scenario: 清空前的閘門

- **GIVEN** 仍有任一條遷移內容尚未驗證可被 `event_search` 撈到
- **WHEN** 嘗試清空 MEMORY.md
- **THEN** 清空動作不得執行（gated last）

### Requirement: Retire EVENT_LOG_UNIFIED.md

系統 SHALL 在 live 索引可用後，把 531KB 手工維護的 `EVENT_LOG_UNIFIED.md` 退役為指向 `event_search` 的 2 行 stub。

#### Scenario: 退役為 stub

- **GIVEN** event 索引可查
- **WHEN** 退役 UNIFIED 檔
- **THEN** 檔案內容縮為指向 `event_search` 的指標，原內容仍可由 git 還原

## Acceptance Checks

- **AC1**: `events.sqlite` 建成後，`SELECT COUNT(*) FROM entries WHERE type='event'` ≈ 993（±掃描誤差），且 fts_rows == entries。
- **AC2**: spec 索引（`.specbase/index.sqlite`）的 entries/links 計數與 BM25 排名在 event 索引建立前後**不變**（隔離驗證）。
- **AC3**: `event_search("<已知 RCA 關鍵字>")` 回傳含正確 event 檔的 ranked snippet，回應時間 < 50ms。
- **AC4**: `event_query` 以日期區間過濾，只回傳檔名 date 落在區間內的 events。
- **AC5**: 一個缺日期檔名的 event 不會使整批重建失敗；該 entry 仍可被全文撈到。
- **AC6**: AGENTS.md 含三層路由規則，且該規則 < 25 行（不把知識本體放常駐層）。
- **AC7**: MEMORY.md 清空前，每一條遷移內容都能由對應工具（`event_search` / AGENTS.md / skill）撈到或命中；未全數通過則清空被阻擋。
- **AC8**: `EVENT_LOG_UNIFIED.md` 退役後為 < 5 行 stub，git 仍保有原內容。
- **AC9**: full rebuild 全程 ~1–5s；`events.sqlite` 體積 < 35MB。
