# Event: Webapp Provider gemini-cli Account Overwrite Fix

## 需求
- 在 webapp 的 `gemini-cli` 帳號新增介面，因為缺少帳號名稱輸入欄位，新增時一律強制使用預設的 `gemini-cli`，導致新增第二個帳號時，會覆蓋掉先前的帳號。
- 需要補上「帳號名稱」輸入欄位，並且後端要能夠接住此名稱來產生不會重複的 `accountId`。

## 範圍 (IN / OUT)
- **IN**: Webapp 端的 `dialog-connect-provider.tsx` 新增可選的「Account Name」欄位。
- **IN**: Webapp i18n 多國語言設定，加入 Account Name 的文案。
- **IN**: `@opencode-ai/sdk` 及 `packages/opencode/src/auth/index.ts` 支援接收 `name` 並以此產生不會重複的 `accountId`。若未傳名稱但已存在同名 ID，自動補上 suffix 避免覆蓋。
- **OUT**: TUI 介面的 account name 新增，目前未動（若缺名稱後端也已能利用 random suffix 避免覆蓋）。

## 任務清單
- [x] 在 `packages/opencode/src/auth/index.ts` 中 `ApiAuth` Payload 加入 `name` (optional)。
- [x] 更新 `auth.set` 邏輯：接收 `info.name`，且若沒有提供名稱但發生 ID 衝突時，自動給予 Random Suffix 避免無聲覆蓋。
- [x] 在 `packages/app/src/components/dialog-connect-provider.tsx` 的 API 金鑰輸入介面，加上「Account Name (optional)」文字框。
- [x] 更新所有 `packages/app/src/i18n/*.ts` 的翻譯檔，加上 `accountName.label`, `placeholder`, `default` 文案。
- [x] 執行 `bun turbo typecheck --filter=@opencode-ai/app` 驗證改動。

## 對話重點摘要
發現原因是：Webapp 的 `ApiAuthView` 沒有送出名稱，且後端 `auth.set` 若沒有提供 `info.name`，會統一使用 `raw || providerId` 作為 label。此導致 `accountId` 重複而發生無聲覆蓋 (`Account.add` 直接對 Dictionary 進行 assign)。

## Debug Checkpoints
- **Baseline**: 使用者指出新增 gemini-cli 帳號會被覆蓋。
- **Instrumentation Plan**: 檢查 `Account.add` 與 `auth.set` 的 Payload，發現缺少 Name。
- **Execution**: 寫入新的 TextField 供前端輸入，並且讓後端產生 AccountID 時套用輸入的值。如果沒有提供名稱，後端若發現 `accountId` 重複，會自動使用 `Date.now().toString(36)` 作為 suffix。
- **Root Cause**: `auth.set` 當沒有給予 `name` 時，重複呼叫產生的 `accountId` 完全一樣，而在 `Account.add` 時會直接覆蓋原先 `providersOf(storage)[provider].accounts[accountId]` 的內容。
- **Validation**: 
  - `bun turbo typecheck` 通過。
  - 後端若無提供 `name` 且已存在，會自動加後綴。
  - Webapp 若提供 `name` 則直接使用。

## Verification
- Webapp 編譯成功
- 驗證後端 Schema (透過 hey-api 重生 sdk.gen.ts 包含 `name?: string`) 已同步
- Architecture Sync: Verified (No doc changes) 系統架構概念與資料流邊界無異動，只屬於功能修復。

