---
slug: cli-reversed-spec
status: living
auto_generated: true
derived_from: ["proposal.md", "design.md", "tasks.md", ".state.json", "idef0.json", "grafcet.json", "events/"]
created: 2026-05-11
updated: 2026-05-11
lang: zh-hant
translated_from: en
source_mtime: 1778493749621
translated_at: 2026-05-11T10:12:07.186Z
---

# 提案：codex/cli-reversed-spec

_語言：**zh-hant** · [en](./README.en.md)_

> `cli-reversed-spec` 主題的自動生成索引。請編輯來源檔案；本 README 只是鏡像。請勿直接修改本檔。

## 狀態

**Living** · 6 筆歷史紀錄 · 最近一次推進 2026-05-11（mode `promote`，由 verified 升級）

## 來源檔案

- [`proposal.md`](./proposal.md) — 為何存在 · 修改於 2026-05-11
- [`design.md`](./design.md) — 架構與決策 · 修改於 2026-05-11
- [`tasks.md`](./tasks.md) — 檢核表 · 12/12 完成（100%）· 修改於 2026-05-11
- [`idef0.json`](./idef0.json) + _尚無 SVG_ — 形式化功能分解
- [`grafcet.json`](./grafcet.json) + _尚無 SVG_ — 形式化執行期行為
- [`events/`](./events/) — 12 筆事件紀錄
- `.state.json` — 生命週期狀態機

## Why（節錄）

每次 OpenCode 的 codex provider 與上游 codex-cli 行為不一致，我們就要重新掃同一批 Rust 檔案：`core/src/client.rs`、`core/src/session/`、`core/src/installation_id.rs`、`codex-api/src/endpoint/responses.rs`、`login/src/default_client.rs`、`core/src/context/environment_context.rs`。每次掃描都消耗 context，也增加 anchor 錯置風險（5/11 的 cache-4608 誤判就是這樣：byte-diff 找到一個長期存在的缺口，敘事卻把它跟兩天前才出現的回歸混為一談，事後 time-ordering 稽核才查出真因）。

本 spec 透過產出一份**經過嚴謹稽核的逆向工程參考文件**來終結這個重掃迴圈，範圍涵蓋所有**形塑 outbound wire 請求、解讀 inbound 回應**的環節。一旦 graduate 進入 `/specs/codex/cli-reversed-spec/`，所有下游的 OpenCode codex-provider 工作（目前的 `provider_codex-prompt-realign/`、暫緩的 `provider_codex-bundle-slow-first-refinement/`、未來的 drift 修補）都引用本 spec，而不是重新 grep 推導。

[完整內容 →](./proposal.md)

## 最近動態

- 2026-05-11: `promote` verified → living — 使用者確認 graduate
- 2026-05-11: `promote` implementing → verified — 12 章全部稽核完成，144/144 anchor 鎖定在 pinned SHA
- 2026-05-11: `promote` planned → implementing — 章節撰寫進行中
- 2026-05-11: `promote` designed → planned — 必要檔案已撰寫
- 2026-05-11: `promote` proposed → designed — 框架檔案完成（proposal + spec + design + idef0 root + grafcet + c4 + sequence + data-schema），可開始章節批次撰寫
- 2026-05-11: [`events/event_2026-05-11_chapter-01-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-01-audit-pass-12-claims-12-anchors-sha-768.md)
- 2026-05-11: [`events/event_2026-05-11_chapter-03-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-03-audit-pass-12-claims-12-anchors-sha-768.md)
- 2026-05-11: [`events/event_2026-05-11_chapter-09-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-09-audit-pass-12-claims-12-anchors-sha-768.md)
- 2026-05-11: [`events/event_2026-05-11_chapter-07-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-07-audit-pass-12-claims-12-anchors-sha-768.md)
- 2026-05-11: [`events/event_2026-05-11_chapter-05-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-05-audit-pass-12-claims-12-anchors-sha-768.md)

## 交叉引用

### 程式碼錨點

- `refs/codex/codex-rs/cli/src/main.rs:1` — `cli::main imports` — C1 anchor — Imports 列出所有 entry-binary crate，由統一的 `codex` dispatcher 統籌：tui、exec、app-server、mcp-server、cloud-tasks、chatgpt apply、responses-api-proxy、execpolicy。確認多 binary 拓樸。
- `refs/codex/codex-rs/app-server/src/main.rs:51` — `arg0_dispatch_or_else` — C2 anchor — app-server binary 的 main() 包裝 `arg0` crate 的 `arg0_dispatch_or_else`。mcp-server (mcp-server/src/main.rs:6) 使用相同 wrapper。讓單一實體 binary 依 argv[0] 名稱服務多個 subcommand。
- `refs/codex/codex-rs/tui/src/lib.rs:709` — `tui::run_main` — C3 anchor — TUI 入口的 async run_main(cli, arg0_paths, loader_overrides, remote, remote_auth_token)。exec/src/lib.rs:233 `pub async fn run_main(cli, arg0_paths)` 是對稱模式。每個 binary 都有一個可被 dispatcher 呼叫的 public async 入口。
- `refs/codex/codex-rs/core/src/client.rs:311` — `ModelClient::new` — C4 anchor — ModelClient::new 建構子簽章。11 個參數（auth_manager、session_id、thread_id、installation_id、provider_info、session_source、model_verbosity、enable_request_compression、include_timing_metrics、beta_features_header、attestation_provider）。Doc comment：「All arguments are expected to be stable for the lifetime of a Codex session.」→ session 期間不變的約束被明文化。
- `refs/codex/codex-rs/core/src/client.rs:315` — `ModelClient::new param installation_id` — C5 anchor — installation_id 參數型別為 `String`（非內部產生）。確認必須由早期 bootstrap 步驟在呼叫 ModelClient::new 前先解析好。

_…還有 140 個 · [完整清單 →](./design.md#code-anchors)_

### 事件記錄

- 2026-05-11: [`event_2026-05-11_chapter-01-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-01-audit-pass-12-claims-12-anchors-sha-768.md)
- 2026-05-11: [`event_2026-05-11_chapter-03-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-03-audit-pass-12-claims-12-anchors-sha-768.md)
- 2026-05-11: [`event_2026-05-11_chapter-09-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-09-audit-pass-12-claims-12-anchors-sha-768.md)
- 2026-05-11: [`event_2026-05-11_chapter-07-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-07-audit-pass-12-claims-12-anchors-sha-768.md)
- 2026-05-11: [`event_2026-05-11_chapter-05-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-05-audit-pass-12-claims-12-anchors-sha-768.md)
- 2026-05-11: [`event_2026-05-11_chapter-02-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-02-audit-pass-12-claims-12-anchors-sha-768.md)
- 2026-05-11: [`event_2026-05-11_chapter-06-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-06-audit-pass-12-claims-12-anchors-sha-768.md)
- 2026-05-11: [`event_2026-05-11_chapter-11-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-11-audit-pass-12-claims-12-anchors-sha-768.md)
- 2026-05-11: [`event_2026-05-11_chapter-12-audit-pass-12-claims-12-anchors-final-c.md`](./events/event_2026-05-11_chapter-12-audit-pass-12-claims-12-anchors-final-c.md)
- 2026-05-11: [`event_2026-05-11_chapter-08-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-08-audit-pass-12-claims-12-anchors-sha-768.md)
- 2026-05-11: [`event_2026-05-11_chapter-10-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-10-audit-pass-12-claims-12-anchors-sha-768.md)
- 2026-05-11: [`event_2026-05-11_chapter-04-audit-pass-12-claims-12-anchors-sha-768.md`](./events/event_2026-05-11_chapter-04-audit-pass-12-claims-12-anchors-sha-768.md)

<!-- AUTO-GENERATED by plan-builder MCP plan_sync · 2026-05-11T10:02:29Z · do not edit this file. -->
