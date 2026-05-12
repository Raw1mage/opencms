# SDD Framework — Spec-Driven Development 方法論（歷史文件）

> **狀態：archived / superseded（2026-05-12）**
>
> 本文件原描述早期 `planner` skill 框架（從 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 移植而來，使用 `bun run scripts/plan-init.ts` / `plan-validate.ts` 工具鏈）。該 skill 已於 2026-04-18 由 `plan-builder` skill 取代。
>
> 現行規劃流程請見 [`templates/skills/plan-builder/SKILL.md`](../templates/skills/plan-builder/SKILL.md)，以及 specbase MCP server 提供的 17 個 `plan_*` / `spec_*` / `wiki_*` 工具。

## 為何保留此文件

planner 框架 2026 H1 在此 repo 內運作了數月，留下大量歷史 plan/spec 包與 commit 訊息。保留此檔的歷史背景，便於後人讀到 2026-04 前的 commit / 文件時能理解 `proposal.md / design.md / tasks.md` 等 artifact 是怎麼來的、為什麼長那樣。

## 概念連續性（planner → plan-builder）

| Planner 概念 | plan-builder 處理方式 |
|---|---|
| OpenSpec 的 specs/ + changes/ 雙層結構 | 合併為單一 `/plans/<slug>/`（draft zone）→ `/specs/<scope>/<topic>/`（KB zone）兩階段；graduate 是 user-only gate |
| `proposal.md` / `design.md` / `tasks.md` 四層 artifact | 全部保留；額外加 `idef0.json` + `grafcet.json` 兩份正式建模 artifact（由 miatdiagram skill 產生與驗證）|
| `bun run scripts/plan-init.ts` | `plan_create` MCP tool（具 slash-form slug + 自動 zone 編碼）|
| `bun run scripts/plan-validate.ts` | `plan_check` / `wiki_validate` MCP tools |
| propose → apply → archive 三階段 | 七階段 lifecycle（proposed → designed → planned → implementing → verified → living → archived）|

## plan-builder 新增的能力

- 七狀態 lifecycle state machine + 八種 transition mode（new / promote / graduate / amend / revise / extend / refactor / sync / archive）
- 兩 zone 物理結構：draft (`/plans/`) vs KB (`/specs/`)，graduate 是 user-only gate
- IDEF0 functional decomposition + GRAFCET runtime behaviour 兩份必交付建模文件
- On-touch peaceful migration：碰到舊格式 `plans/<slug>/` 自動升級
- 每 artifact 三層歷史（inline delta marker / section supersede / refactor full snapshot）
- Specbase MCP server 17 工具讓 KB 在對話中即時同步
- Optional SSDLC profile，提供稽核級變更證據

## 仍然有效的核心觀念（與 planner 時代一致）

- **Spec 是產品、code 是 derivative**：80% spec effort、20% codegen
- **Plan 與 wiki 是同一份 artifact 在不同成熟度下的視圖**：README.md 由 source files 自動同步
- **每個變更（包含 bug fix）都走 spec**：sync 是強制要求，不是事後文件化
- 用 IDEF0 表達結構（system 在做什麼）、用 GRAFCET 表達 runtime 行為（系統如何演進），缺一不可

## 過渡與遺留

- 舊 `templates/skills/planner/` template 與 `bun .../plan-init.ts` / `plan-validate.ts` 腳本仍存在於 skills submodule 中（GitHub `Raw1mage/skills`），保留作為 legacy `/plans/` 包的應急工具。新工作請走 plan-builder。
- 環境變數 `OPENCODE_PLANNER_TEMPLATE_DIR` 已被 `OPENCODE_PLAN_BUILDER_TEMPLATE_DIR` 取代（舊名保留 backward-compat fallback）。
- 2026-05-12 release-gc sweep（[plans/maintenance_release-gc/](../plans/maintenance_release-gc/)）已把剩餘兩個 legacy slug-only plan 包遷移到 plan-builder 格式：`specs/daemon-agent/`、`specs/subagent-taxonomy/`。

## 延伸閱讀

- [OpenSpec 原專案](https://github.com/Fission-AI/OpenSpec)（本框架的源頭）
- [`templates/skills/plan-builder/SKILL.md`](../templates/skills/plan-builder/SKILL.md)（現行規劃方法論）
- [`templates/skills/miatdiagram/SKILL.md`](../templates/skills/miatdiagram/SKILL.md)（IDEF0 + GRAFCET 建模）
- [`docs/events/event_2026-04-18_plan-builder_launch.md`](events/event_2026-04-18_plan-builder_launch.md)（plan-builder 啟用紀錄）
