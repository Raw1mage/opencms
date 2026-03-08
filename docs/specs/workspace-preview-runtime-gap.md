# Workspace Preview Runtime Gap

Date: 2026-03-09
Status: Drafted

## 1. 結論

目前 `opencode-beta` **沒有可直接接入 workspace attachment model 的 preview runtime domain**。

因此：

- `attachments.previewIds` 目前只能視為 **reserved field**
- 不應先做 `attachPreview()/detachPreview()`
- 不應先做 `workspace.preview.updated` 實作
- 正確順序是先建立 preview SSOT，再接 workspace

---

## 2. 本輪檢查結果

本輪找到的 `preview` 主要屬於以下類型，而非 workspace runtime preview：

1. **UI preview**
   - sidebar/project hover preview
   - theme preview / color scheme preview

2. **content preview**
   - image preview
   - SVG/file content preview
   - selection preview text

3. **provider/model naming**
   - Gemini/OpenAI model preview
   - web-search-preview tool naming

這些都不是「一個 workspace 擁有的 preview runtime instance」。

---

## 3. 缺少的核心能力

若要把 preview 納入 workspace attachment，至少需要以下其中一種真實來源：

### A. Preview process domain

例如一個被 runtime 管理的 dev server / preview server：

- `previewID`
- `workspaceDirectory`
- `pid` / `port`
- `url`
- `status`
- `startedAt`
- `lastActiveAt`

### B. Preview session/domain registry

例如一個集中 registry：

- `Preview.get(id)`
- `Preview.listByDirectory(directory)`
- `Preview.Event.Created/Updated/Deleted`

### C. Preview API boundary

例如：

- `GET /preview`
- `GET /preview/current`
- `POST /preview/start`
- `POST /preview/:id/stop`

沒有這些東西，就沒有可信的 preview ownership 可言。

---

## 4. 建議的最小未來 contract

若後續要正式接線，推薦最小資料形狀：

```ts
type PreviewInfo = {
  id: string
  directory: string
  workspaceID?: string
  port?: number
  url?: string
  status: "starting" | "active" | "stopped" | "failed"
  source: "runtime" | "detected"
}
```

以及 bus event：

```ts
preview.created
preview.updated
preview.deleted
```

接著才由 `WorkspaceService` 訂閱：

- `preview.created` -> `attachPreview`
- `preview.deleted` -> `detachPreview`
- `preview.updated` -> optional status refresh / `workspace.preview.updated`

---

## 5. 現階段規則

在 preview SSOT 建立前，請維持以下規則：

1. `previewIds` 保留在 schema 中，但視為 **未啟用欄位**
2. 不新增 preview attachment mutation API
3. 不在 app/runtime 中假設任何 directory 可直接推出 preview instance
4. 若 UI 需要 preview 呈現，應明確標示為 UI/content preview，不要混稱為 workspace preview

---

## 6. 建議下一步

最合理順序：

1. 先確認 repo 是否需要真正的 preview runtime（dev server / browser preview / app preview）
2. 若需要，先建立獨立 `preview` domain（types + registry + events）
3. 再由 workspace service 以 attachment observer 方式接線
4. 最後才補 `/workspace` 或 `/preview` API 給 app 消費
