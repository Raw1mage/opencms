#### 功能：建立 Event 對照註解規範

**需求**

- 所有程式修改處都要註記對應的 `docs/events/event_*.md`，以便讀者快速了解變更來源。
- 註解格式統一為 `@event_<date>:<issue name>`，並可視需求精簡合併，避免註解不斷疊加。
- 在 AGENTS 指引中正式紀錄此規範，並引用本事件（方便日後查找）。

**範圍**

- IN：更新 `AGENTS.md` 的指引、現有變更加入註解（如 `script/install.ts`、README 中新增段落）、本事件/DIARY 記錄。
- OUT：不推動舊事件的 retrofitting；只針對此任務相關修改加入註解。

**方法**

- 在 AGENTS 說明新增一節「Event 註解規則」，強調格式與合併邏輯，並以 HTML 註解方式在 AGENTS 本體連結本事件檔案。
- 在新增的 `script/install.ts` 中加上對應的 `@event_2026-02-07_install` 註解，讓未來可追蹤此事件。
- 在 README 新增的「Local build + install」段落加入 HTML 註解，指出關聯事件。
- 暫緩 DIARY 更新直到變更完成，以確保列表與事件一致。

**任務**

1. [x] 在 `AGENTS.md` 增加 Event 註解規範說明，並以 `<!-- @event_2026-02-07_event-comments -->` 連動本事件。
2. [x] 在 `script/install.ts` 重要邏輯區塊註記 `// @event_2026-02-07_install`。
3. [x] 在 README 的新段落加上 HTML 註解提醒讀者本事件。
4. [x] 變更完成後更新 `docs/DIARY.md`，新增本事件的索引。

**變更紀錄**

- `AGENTS.md` 新增 Event 註解規範段落，包含註解格式、合併重構與追蹤要求。
- `script/install.ts` 與 README 的 local build 段落加上 `@event_2026-02-07_install` 標記，方便追溯。

**待解問題**

- 無。
