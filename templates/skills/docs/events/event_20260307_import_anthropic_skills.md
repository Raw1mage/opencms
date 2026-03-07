# Event: Import Anthropic Skills

Date: 2026-03-07
Status: Done

## 1. 需求

- 從 `https://github.com/anthropics/skills.git` 下載 skills。
- 更新目前 workdir 內的 skills。
- 若遇到重複 skill，不可直接覆蓋；需分析後重構為新版 skills。
- 本次整合策略：**來源優先合併**。

## 2. 範圍

### IN

- 取得外部 skill repository 內容並比對本地 skill。
- 匯入新增 skill。
- 對重複 skill 進行內容分析、保留本地特化、吸收來源版更新。
- 補上事件紀錄與驗證結果。
- 建立 GitHub repository `raw1mage/skills` 並發布目前 skills 集合。
- 補上 repo README、調整預設分支為 `main`、完善 GitHub metadata。
- 補上 GitHub Actions 驗證、整理 `.gitignore`、建立首個 release/tag。
- 補上 README badges、release notes template、issue / PR templates。

### OUT

- 未經需求明示，不修改與 skill 匯入無關的程式或設定。
- 不直接覆蓋同名 skill。
- 不做未經使用者授權的 git commit / push。

## 3. 任務清單

- [x] 建立基線與盤點本地 skill/文件狀態。
- [x] 下載 `anthropics/skills` 並列出可匯入 skill。
- [x] 找出重複 skill 與差異。
- [x] 依來源優先策略重構整合重複 skill。
- [x] 匯入新增 skill。
- [x] 執行驗證並同步 Architecture 記錄。
- [x] 建立 GitHub 遠端 repository。
- [x] 整理本次變更並建立 commit。
- [x] 推送至 `raw1mage/skills`。
- [x] 建立 README。
- [x] 將預設分支由 `master` 調整為 `main`。
- [x] 更新 GitHub description / topics。
- [x] 建立 GitHub Actions workflow。
- [x] 補上或整理 `.gitignore`。
- [x] 建立首個 release/tag。
- [ ] 補上 README badges。
- [ ] 建立 release notes template。
- [ ] 建立 issue / PR templates。

## 4. Debug Checkpoints

### Baseline

- 症狀：使用者要求以外部 skills repository 更新本地 skill 集合。
- 重現步驟：比對本地 skill 目錄與外部 repository skill 清單。
- 影響範圍：`/home/pkcs12/projects/skills/*/SKILL.md` 與必要的文件記錄。

### Execution

- 已以 shallow clone 下載 `https://github.com/anthropics/skills.git` 至 `/tmp/anthropic-skills-20260307`。
- 比對結果：重複 skill 16 個；新增 skill 1 個（`claude-api`）。
- 採來源優先合併，將 `docx`、`pptx`、`xlsx`、`skill-creator` 的主要說明升級為 upstream 版本。
- 匯入 upstream 缺少於本地的支援檔案與子目錄（如 `scripts/office/**`、`agents/**`、`eval-viewer/**`、語言分層 API 參考檔等）。
- 對既有重複 skill 未做盲目整目錄覆蓋，而是：
  - 先比對重複檔案與新增檔案
  - 新增 upstream 缺少檔案
  - 僅挑選必要重疊檔案升級
  - 保留本地非衝突資產
- `pdf` skill 保留本地有價值特化：
  - 補回 ReportLab 上下標（subscript/superscript）注意事項
  - 將檔名參照正規化為目前 repo 內實際存在的小寫 `forms.md` / `reference.md`
- 新增 `docs/ARCHITECTURE.md`，同步目前 repo 的 skills-based 架構與匯入策略。
- 使用者後續要求將目前 skills 集合獨立發布到 GitHub `raw1mage/skills`。
- 已建立公開 GitHub repository：`https://github.com/Raw1mage/skills`。
- 已建立提交：`c74d63b feat: publish merged skills catalog`。
- 已將 `master` 推送到 `github` remote，追蹤 `github/master`。
- 使用者同意依建議補做 README、分支更名與 repo metadata 整理。
- 已新增 repo root `README.md`，說明 skills catalog、維護模式與 GitHub 位置。
- 已建立提交：`99eb5fb docs: add repo readme and publishing notes`。
- 已將本地與 GitHub 預設分支由 `master` 調整為 `main`，並刪除 GitHub 舊的 `master` 分支。
- 已更新 GitHub repo description 與 topics：`skills`, `ai-agents`, `automation`, `claude`。
- 使用者要求繼續補做：GitHub Actions、`.gitignore`、初始 release/tag。
- 已新增 `.github/workflows/validate-skills.yml`，在 push / pull_request 時驗證所有 top-level skills。
- 已新增 repo-level `.gitignore`，忽略常見 OS / Python / Node / local-env 噪音。
- 為使 CI 可通過，補正了 4 個既有 skill 的 metadata 問題：
  - `codex-sidebar-focus-rca/SKILL.md` 移除 BOM
  - `graphrag-memory/SKILL.md` 補上 YAML frontmatter
  - `hello_world/SKILL.md` 將 frontmatter name 正規化為 `hello-world`
  - `miatdiagram/SKILL.md` 補上 YAML frontmatter
- 已建立提交：`c8be63a ci: add skill validation workflow`。
- 已建立首個 GitHub release / tag：`v0.1.0`。
- 使用者要求繼續補做：README badges、release notes template、issue / PR templates。
- 已新增 README badges（Validate Skills / Release）。
- 已新增 GitHub repository templates：
  - `.github/release.yml`
  - `.github/pull_request_template.md`
  - `.github/ISSUE_TEMPLATE/bug_report.md`
  - `.github/ISSUE_TEMPLATE/skill_request.md`
  - `.github/ISSUE_TEMPLATE/config.yml`
- 已建立提交：`cf51209 docs: add repository contribution templates`。

### Validation

- 驗證重點：
  - upstream 新增 skill `claude-api/` 已完整匯入。
  - `docx`、`pdf`、`pptx`、`skill-creator`、`xlsx` 與 upstream 比對後，所有 upstream 檔案均已在本地存在。
  - 剩餘與 upstream 不同的重疊檔案僅 2 個，且均為**刻意保留的本地整合差異**：
    - `pdf/SKILL.md`
    - `skill-creator/SKILL.md`
- Architecture Sync: Updated `docs/ARCHITECTURE.md` to reflect current repository layout and imported skill topology.
- GitHub 驗證：`master` 已成功推送至 `https://github.com/Raw1mage/skills`。
- Architecture Sync: Verified (No doc changes after publish step).
- GitHub 驗證：repo 預設分支已為 `main`，repo 為公開，description 與 topics 已更新。
- Working tree 驗證：本地目前為 `main...github/main` 且無未提交變更。
- Architecture Sync: Verified (No doc changes after branch/metadata step).
- 本地驗證：已用 `skill-creator/scripts/quick_validate.py` 驗證全部 40 個 top-level skills，結果全數通過。
- Architecture Sync: Updated `docs/ARCHITECTURE.md` to include CI automation location and validation flow.
- GitHub 驗證：`c8be63a` 已推送到 `main`，release `v0.1.0` 已建立於 `https://github.com/Raw1mage/skills/releases/tag/v0.1.0`。
- Architecture Sync: Verified (No doc changes after release step).
- Architecture Sync: Updated `docs/ARCHITECTURE.md` to include GitHub contribution/release metadata files.
- GitHub 驗證：`.github` 內容已存在於 `main` 分支，包含 workflow、release template、issue templates 與 PR template。
- Architecture Sync: Verified (No doc changes after template publish step).

## 5. 關鍵結果

- 新增 skill：`claude-api`
- 升級並重構的重複 skill：
  - `docx`
  - `pdf`
  - `pptx`
  - `skill-creator`
  - `xlsx`
- 其餘 upstream 已相同的重複 skill 無需變更。
