---
name: bun-package-dev
description: Bun 套件開發技能（建置/測試/模板/工具/DIARY/Docker）
---

## 使用時機

- 在本 repo 內開發 Bun 套件或工具（私用、不上 npm）
- 需要建置二進位並封裝到 Docker（參照 `webctl.sh`）
- 需要 Tool.define + Zod schema 的模板與產生器
- 需要 DIARY 的規劃/紀錄模板

## 標準流程（私用、不發佈 npm）

1. 安裝依賴：`bun install`
2. 型別檢查：`bun run typecheck`
3. 測試：`bun test`
4. 建置（本 repo）：`bun run build --single`（產出 binary）
5. Docker：`./webctl.sh build` 或 `./webctl.sh deploy`

> 不使用 `npm publish`。這裡只維護私用 build 與 Docker 流程。

## 模板與產生器

模板位置：`.opencode/skills/bun-package-dev/templates/`

### 產生 Tool.define 模板

```bash
bun scripts/bun-skill.ts --kind tool --name my-tool
```

### 產生新套件樣板（monorepo）

```bash
bun scripts/bun-skill.ts --kind package --name my-package
```

### 產生 DIARY 規劃片段

```bash
bun scripts/bun-skill.ts --kind diary --name "功能名稱"
```

## 模板內容

- `templates/tool.ts`：Tool.define + Zod schema 樣板
- `templates/package/*`：Bun 套件樣板（package.json/tsconfig/src/README）
- `templates/diary.md`：DIARY 片段

## 注意事項

- 路徑一律使用 `/scripts`（已合併 `script/` → `scripts/`）。
- 工具/腳本需符合 repo 風格：使用 Bun API、避免不必要的 try/catch。
- DIARY 需依日期排序，繁體中文維護。
