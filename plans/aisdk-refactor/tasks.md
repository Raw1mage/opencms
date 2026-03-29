# Tasks

## 1. 分析 @ai-sdk/openai responses adapter

- [ ] 1.1 讀 `@ai-sdk/openai/dist/index.js` 的 `responses()` 方法，文件化它構建的 request body 包含哪些欄位
- [ ] 1.2 確認 `include`、`store`、`service_tier`、`context_management` 是否已被 AI SDK 支援
- [ ] 1.3 確認 encrypted_content 在 response parse 時是否被保留到 providerMetadata
- [ ] 1.4 確認 `prompt_cache_key` 是否被 AI SDK 支援（或需要 fetch interceptor 補）

## 2. 盤點 custom fetch interceptor 現有能力

- [ ] 2.1 列出 codex.ts fetch interceptor 目前做的所有 body transform
- [ ] 2.2 列出 codex.ts fetch interceptor 目前做的所有 header 操作
- [ ] 2.3 確認 fetch interceptor 能否修改 @ai-sdk/openai 構建的 body（additive transform 是否安全）

## 3. 搬遷功能到 fetch interceptor

- [ ] 3.1 context_management（inline compaction threshold）— 加到 body transform
- [ ] 3.2 encrypted_content include — 確認 AI SDK 是否已處理，否則加到 body transform
- [ ] 3.3 store: false — 加到 body transform
- [ ] 3.4 service_tier — 加到 body transform（如果 AI SDK 沒處理）
- [ ] 3.5 驗證：所有功能在 AI SDK path 上正常運作

## 4. 停用 CUSTOM_LOADER

- [ ] 4.1 移除 provider.ts 中的 CUSTOM_LOADER codex 分支
- [ ] 4.2 確認 codex provider 完全走 AI SDK `sdk.responses()` path
- [ ] 4.3 驗證：tool call loop 正常、subagent 正常、text streaming 正常

## 5. 清理

- [ ] 5.1 評估 codex-language-model.ts 是否保留（參考用）或移除
- [ ] 5.2 評估 codex-websocket.ts 是否保留或移除
- [ ] 5.3 評估 C binary (codex-provider) 是否保留或移除
- [ ] 5.4 更新 codex-efficiency plan tasks.md 標記廢棄項
