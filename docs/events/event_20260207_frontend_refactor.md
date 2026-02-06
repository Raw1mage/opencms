#### 功能：前端架構重構與優化 (偷學自 origin/dev)

**需求** -

- 提升 `packages/app` 前端代碼的可維護性，解決單一檔案過大的問題。
- 參考 `origin/dev` 的模組化設計，將複雜的 UI 邏輯與狀態管理拆分為專用模組。
- 保留 `cms` 分支特有的後端整合邏輯、Rotation3D 支援與 XDG 部署規範。

**範圍** -

- **IN**: `packages/app/src/context/global-sync.tsx` (已完成), `packages/app/src/components/prompt-input.tsx`, `packages/app/src/pages/session.tsx`。
- **OUT**: 後端 API 合約修改、CSS 樣式重設計、SDK 核心邏輯變更。

**方法** -

1. **Domain Split (領域拆分)**：不進行 Git Merge，而是人工分析 `origin/dev` 的模組劃分，在 `cms` 中對應建立目錄並重寫。
2. **Behavior Preservation (行為保留)**：每一步拆分後需確保 `cms` 特有的功能（如 `rotation3d` 事件響應）運作正常。
3. **Type Safety (型別安全)**：修復模組化後可能產生的 Solid Store Setter 型別不匹配問題。

**任務** -

- [x] 重構 `global-sync.tsx` 並拆分至 `context/global-sync/`
- [x] 建立 `components/prompt-input/` 目錄
- [x] 拆分 `prompt-input.tsx` 的 `history`, `attachments`, `submit`, `editor-dom` 邏輯 (文件已建立)
- [x] 將 `prompt-input.tsx` 切換至新模組並移除冗餘代碼
- [ ] 建立 `pages/session/` 目錄
- [ ] 拆分 `pages/session.tsx` 的 `file-tabs`, `terminal-panel`, `message-timeline` 邏輯
- [ ] 驗證全專案 Typecheck 通過

**待解問題** -

- `origin/dev` 的部分組件使用了 `specs/*.md` 中定義的新行為，需過濾掉這些行為以維持 `cms` 的穩定性。
- 拆分後 `solid-js` 的 `createEffect` 依賴追蹤是否受影響。
  @event_20260207:frontend_refactor
