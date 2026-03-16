# Event: Kill-switch 設計決策紀錄

日期：2026-03-16

Summary

- 決策：建立 Global 範圍的 kill-switch（緊急暫停鍵），採 Hybrid 模式（soft-pause -> timeout -> hard-kill）。
- 授權：RBAC + MFA，新增 permission `kill_switch:trigger`，僅限 role: ops/sre/admin。
- 觸發：提供 Web Admin 按鈕、TUI hotkey、以及受控 API endpoint（服務帳號 + signed JWT/mTLS）。
- 可觀測性：以系統 log 為主要應變資料；按下時拍攝 snapshot（active sessions、outstanding tasks、logs 摘要），並寫入 audit store，發出 Slack/Email 通知。

Decision rationale

- Global scope 能滿足緊急中止所有自動代理活動的需求，避免問題擴散。
- Hybrid 模式提供最小破壞的安全操作流程：先 soft-pause 以避免資料遺失，再在超時後執行強制終止以確保停擺效果。

Artifacts created

- Planner artifacts (specs/20260316_kill-switch/): implementation-spec.md, spec.md, design.md, tasks.md
- Implementation TODOs updated in working ledger (see todos)

Next actions

1. 建立 core API stub 與 state service（已排為下一步）。
2. Integrate RBAC/MFA & audit writes.
3. Implement agent/scheduler checks to short-circuit new task scheduling.

Owner: planner / backend / security

Note

- 礙於審計原則，planner 除了在 specs/ 下建立結構化計畫外，event ledger 用於記錄決策重點與審查紀錄，後續所有重大變更請同步更新此檔案。
