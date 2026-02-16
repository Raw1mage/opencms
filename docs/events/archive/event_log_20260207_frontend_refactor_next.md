#### 功能：前端架構重構與優化 (Phase 7-11 規劃)

**需求** -

- 進一步提升 `packages/app` 的代碼品質與維護效率。
- 實現子組件層級的深度拆分，優化長對話場景下的渲染效能。
- 建立自動化測試與規範文件，確保架構演進的可持續性。

**範圍** -

- **IN**: `MessageTimeline` 組件拆分、Context 統一化、單元測試、架構文檔。
- **OUT**: 大規模 CSS 重構、後端協議變更。

**方法** -

1. **Atomic Refactoring (原子重構)**：每次僅針對一個子組件進行拆分與測試。
2. **Performance First (效能優先)**：在拆分 `MessageTimeline` 時導入 `Memo` 與 `For` 的優化，減少不必要的重繪。
3. **Doc-as-Code (文檔即代碼)**：在代碼重構完成後立即更新對應的規範文檔。

**任務** -

- [ ] **Phase 7**: 建立 `pages/session/components/` 目錄並拆分 `MessageTimeline`
- [ ] **Phase 8**: 重構 `ConfigContext` 與 `FileTree` (Virtual Scroll)
- [ ] **Phase 9**: `PromptInput` 冗餘代碼清理
- [ ] **Phase 10**: 編寫 Hooks 單元測試
- [ ] **Phase 11**: 產出 `frontend-architecture.md`

**待解問題** -

- `Virtual Scroll` 在 Solid.js 中與複雜的 `MessageGesture` 是否會產生衝突。
- 單元測試環境 (Bun Test + Happy Dom) 對瀏覽器滾動 API 的模擬程度。

@event_20260207:frontend_refactor_next
