#### 功能：修復 Antigravity 400 (Tool Execution Failed) 不觸發 rotation

**需求**

- 當 Antigravity 收到 400 Bad Request（且非 prompt too long / thinking config 等已知錯誤）時，應觸發 provider/account rotation，而非直接回傳錯誤結束。
- 這能解決 subagent 遇到 "Invalid signature" 或其他 transient 400 錯誤時卡住的問題。

**範圍**

- IN: `src/plugin/antigravity/index.ts`
- OUT: 無

**方法**

- 修改 `src/plugin/antigravity/index.ts` 中的 400 錯誤處理邏輯。
- 原本直接 `return createSyntheticErrorResponse` 改為 `throw new Error(...)`。
- 外層的 retry loop 會捕捉到這個 error 並嘗試下一個 account/endpoint。

**任務**

- [x] 修改 `src/plugin/antigravity/index.ts` 讓未知 400 錯誤拋出異常
- [x] 驗證修改後的邏輯

**待解問題**

- 無
