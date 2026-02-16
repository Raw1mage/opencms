#### 功能：精確區分永久失效模型與暫時禁閉機制 (Rotation3D V2)

**需求**

- **永久性不可用 (Permanent Failure)**：如 404, Not Found, Not Supported 等，必須從 Favorites 中移除。
- **暫時性不可用 (Temporary Failure)**：如 429, Quota, Server Error 等，必須在 5 分鐘內禁閉，不參與 Rotation。
- 解決 Session/Sub-agent 頻繁嘗試已知失敗模型的問題。

**範圍**

- IN：`src/session/llm.ts`, `src/session/processor.ts`

**方法**

- 在 `llm.ts` 將 `markRateLimited` 的冷卻時間從 30 秒延長至 5 分鐘 (300,000ms)。
- 在 `processor.ts` 建立 `isModelPermanentError` 與 `isModelTemporaryError`。
- 只有命中 `isModelPermanentError` 才會執行 `removeFavorite`。

**任務**

1. [x] 建立 event_20260206_rotation_v2.md 計畫文件
2. [x] 更新 docs/DIARY.md 索引
3. [x] 修改 llm.ts：將禁閉冷卻時間延長至 5 分鐘
4. [x] 修改 processor.ts：精確區分永久移除與暫時禁閉邏輯

**DEBUGLOG**

- [2026-02-06] 之前將 30 秒視為足夠，但實際在高併發 sub-agent 場景下會導致回彈重試，決定統一延長至 5 分鐘。
