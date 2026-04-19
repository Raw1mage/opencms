# 2026-04-19 — AGENTS.md 第二條：執行 Plan 前必備份 XDG Config

## Scope

- 本 repo 的 `AGENTS.md` 加入第二條規則：plan 執行前必須快照 `~/.config/opencode/` 等 XDG 目錄，且備份 ≠ 還原目標。
- Global `templates/AGENTS.md`（ships to `~/.config/opencode/AGENTS.md`）僅補一句「每個 repo 各自維護自己的 `docs/events/`」——XDG 備份條文本身屬 repo-dev 規則，不對外擴散。

## Trigger

2026-04-18 codex-rotation hotfix 測試跑 `family-normalization.test.ts`：

- beta 與 main 在同一 uid 共用 `~/.config/opencode/`
- 測試走 `Global.Path.user` 直接寫實體 accounts.json
- 14 個 codex family 被壓成 1 個，**永久失去 5 個 codex 帳號 token**
- 無法還原：log 不記 refreshToken，NAS rsync 自 3/3 壞掉

## 規則本體（已 commit b5b18f3ae）

- 備份範圍：`~/.config/opencode/` 全目錄，必要時含 `~/.local/state/opencode/`、`~/.local/share/opencode/`
- 備份位置：`~/.config/opencode.bak-<YYYYMMDD-HHMM>-<plan-slug>/`
- 還原政策：AI 絕不可自行覆蓋現行 XDG；只有使用者明確要求還原時才 restore
- 例外：純 read-only inspection（`git log` / `grep` / `cat`）可略過；進入實作階段不可跳過
- 違規判定：沒有 `opencode.bak-*` 快照存在就跑 `bun test` / `bun run ...` / 重啟 daemon

## Template/Runtime 同步判斷

對照 repo AGENTS.md「維護原則 #1：Template 與 Runtime 需同步」，審查結果：

| 規則                        | 範圍                                  | 是否 sync 到 `templates/` |
| --------------------------- | ------------------------------------- | ------------------------- |
| 第零條：新功能必須先有 Plan | repo-dev contract                     | 否（歷史慣例）            |
| 第一條：禁止靜默 Fallback   | repo-dev contract                     | 否（歷史慣例）            |
| 第二條：plan 前備份 XDG     | repo-dev contract（限本 repo 雙 uid） | 否                        |
| 每個 repo 維護 docs/events/ | 跨 repo 通用慣例                      | **是**（本次補上）        |

結論：repo AGENTS.md 第零/一/二條是 opencode repo dev-time 專用，不屬 runtime 或 release artifact；`templates/` sync 檢查清單的「runtime 對應檔案」不適用。docs/events/ 慣例則是跨 repo 通用，這次一併明文化到 global。

## Commits

- `b5b18f3ae` docs(agents): 第二條 — 執行 Plan 前必備份 XDG Config
- （本 commit）docs(templates): global AGENTS.md 明文化 docs/events/ per-repo 慣例 + event 留痕
