<!--
AGENTS.md is intentionally NOT imported here.

AGENTS.md governs the opencode runtime's own AI agent (the prompts opencode
ships to its sessions). It is not a Claude Code instruction file. Pulling it
in via `@AGENTS.md` caused Claude Code to misapply opencode-runtime rules
(XDG backup, daemon-spawn denylist, prompt-pipeline conventions) as if they
were its own constraints.

The rules below are extracted from AGENTS.md sections that DO apply to anyone
(including Claude Code) working on this repo. When working on this repo, read
AGENTS.md as project context (with a Read tool call) when relevant — but do
not load it as governing instructions.
-->

# OpenCMS — Claude Code 開發規範

以下規則從 AGENTS.md 中篩選出**對 Claude Code 開發本 repo 同樣適用**的條目。

---

## XDG Config 備份

進入 plan 實作階段前（第一個程式碼編輯/測試指令前），必須備份 `~/.config/opencode/` 下的關鍵設定檔。

- **白名單**：`accounts.json`、`opencode.json`、`managed-apps.json`、`gauth.json`、`mcp.json`、`mcp-auth.json`、`openai-codex-accounts.json`、`models.json`、`providers.json`、`AGENTS.md`；`~/.local/share/opencode/accounts.json`（legacy，若存在）。
- **備份位置**：`~/.config/opencode.bak-<YYYYMMDD-HHMM>-<plan-slug>/`
- **不備份**：node_modules、lock 檔、log、snapshot、storage、runtime state。
- **還原**：備份 ≠ 還原目標。絕不自行用舊備份覆蓋現行 XDG，只有使用者明確要求才還原。
- **例外**：純 read-only inspection 可略過；進入實作即不可跳過。
- **Why**：beta 與 main 共用 `~/.config/opencode/`，測試可能透過 `Global.Path.user` 直寫真實檔案。

---

## Daemon Lifecycle

**禁止自行 spawn / kill / restart opencode daemon 或 gateway。** 唯一合法路徑是 `system-manager:restart_self` MCP tool（或 `webctl.sh restart`）。

- 禁止：`bun ... serve --unix-socket ...`、`opencode serve`、`opencode web`、針對 daemon pid 的 `kill`、`systemctl restart opencode-gateway`。
- rebuild 失敗：讀 `restart_self` 回傳的 `errorLogPath`，修正後再呼叫。絕不繞過。
- 系統自癒腳本（`scripts/gateway-self-heal.sh` 等）不得視為 lifecycle 入口。

---

## 整合規範

- **PR 預設策略**：本 repo 已獨立維護，預設不建 PR，除非使用者明確要求。

---

## Enablement Registry

- Runtime 真相：`packages/opencode/src/session/prompt/enablement.json`
- Template 真相：`templates/prompts/enablement.json`
- 擴充能力後必須**同步更新兩處**。

---

## Web Runtime 入口

只允許透過 `webctl.sh` 啟動。禁止直接 `bun ... opencode ... web` / `opencode web`。Server runtime 參數定義於 `/etc/opencode/opencode.cfg`。

---

## 變更留痕

規範或架構變更需記錄於 `docs/events/`。

---

## 分支規範

`beta/*`、`test/*` 分支僅作一次性實作/驗證。merge/fetch-back 回 `main` 後必須立即刪除，禁止長留 stale branch。
