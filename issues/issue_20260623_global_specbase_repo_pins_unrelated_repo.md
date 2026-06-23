# Issue: 全域 `specbase.repo` 釘死單一 repo,使任意 cwd 的 plan/event 都導向 opencode

- **Status**: open
- **建立日期**: 2026-06-23
- **嚴重度**: Medium
- **類別**: 設定 / 跨 repo 資料落點
- **相關元件**: `~/.config/opencode/opencode.json` 的 `specbase.repo`;消費端 specbase plugin `resolveDefaultRepo()`

## 症狀

在一個全新工作目錄 `/home/pkcs12/GoogleDrive/@利善美/20260623 longcare`(與 opencode 無關的專案,且為 Google Drive FUSE 掛載點)開 session。呼叫 `specbase_plan_create` 與 `specbase_event_record`,產物全部落到 `/home/pkcs12/projects/opencode/plans/` 與 opencode 的 `.specbase/events.sqlite`,污染了 opencode repo,且使用者的實際專案目錄反而沒有任何 KB。

## Root Cause(已驗證)

`~/.config/opencode/opencode.json` 含:
```json
{ "specbase": { "repo": "/home/pkcs12/projects/opencode" } }
```

specbase plugin 的 `resolveDefaultRepo()` 解析優先序為:env > session 目錄(需含 `.specbase/`)> **此全域 `specbase.repo`** > session 目錄 fallback。由於工作目錄不含 `.specbase/`,直接命中全域設定 → 所有寫入導向 opencode。

驗證:
- `SPECBASE_TARGET_REPO` unset
- `opencode.json` → `specbase.repo = /home/pkcs12/projects/opencode`
- 工作目錄 `.specbase/` 不存在(它是 GDrive 掛載點,本就不該放 KB 索引)

## 為什麼這是 opencode 側問題

`specbase.repo` 作為「全域單一預設 repo」的設定形態本身有問題:

1. **它把一個開發者自己的 repo(opencode)當成所有 session 的 KB 落點**,對任何在別處工作的 session 都是錯的預設。
2. **它讓 specbase 的「session 目錄 fallback」永遠無法生效** — 只要這行設定存在,L4 fallback 形同死碼。
3. 這條設定很可能是 opencode 自身開發時為了方便而設,但它是全域生效,會洩漏到所有非 opencode 的工作場景。

## 建議(需使用者批准)

- **A(推薦)**:移除 `opencode.json` 的全域 `specbase.repo`,改由各 repo 自帶 `.specbase/` 標記來宣告自己擁有 KB(specbase 已支援這個 marker)。opencode repo 自己 init 一個 `.specbase/` 即可繼續正常運作。
- **B**:若要保留全域預設,改為「僅在 session 目錄既非 specbase repo、又無法 init 時」才用,且需在工具輸出明示落點(對應 specbase 側 BR)。
- **C**:把 `specbase.repo` 從「全域單值」改為「per-directory 對應表」,讓不同工作根對應不同 KB。

## 連動
- specbase 側已開對應 BR:`issues/issue_20260623_plan_create_silent_fallback_to_global_repo.md`(主張寫入型操作在 target≠cwd 時應 fail-fast/警示,而非 silent fallback)。兩者同根因、互補。

## 注意
- 本次 longcare 的 plan/event 已落在 `opencode/plans/longcare_training-program/` 與 opencode events.sqlite。屬一次性落點,待決定正確落點後可搬遷;非本 issue 的修復對象。
