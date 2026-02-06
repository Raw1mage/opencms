# OpenCode 專案開發指引

本檔案定義 opencode 專案特有的開發規範。通用工作流程請參閱 `agent-workflow` skill。

---

## 專案背景

本專案源自 `origin/dev` 分支，現已衍生為 `cms` 分支作為主要產品線。

### cms 分支主要特色

- **全域多帳號管理系統** - 支援多個 provider 帳號的統一管理
- **rotation3d 多模型輪替系統** - 動態模型切換與負載平衡
- **Admin Panel (`/admin`)** - 三合一管理界面
- **Provider 細分化** - 將原本的 `google` provider 拆分為獨立的三個 providers：
  - `antigravity`
  - `gemini-cli`
  - `google-api`

  以便充分利用每一 provider 提供的資源

---

## 整合規範

### 從 origin/dev 引進更新

任何從 GitHub pull 的 `origin/dev` 新 commits，都必須經過分析後再到 `cms` 中重構，**不可直接 merge**。

### 外部 Plugin 管理

引進的外部 plugin 都集中放在 `/refs` 目錄。若有更新，也必須逐一分析後再到 `cms` 中重構，**不可直接 merge**。

---

## 部署架構

預計安裝到使用者端的設定檔都集中在 `templates/` 目錄，以 XDG 架構部署。
