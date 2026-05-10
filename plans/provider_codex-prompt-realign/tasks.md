# Tasks: provider_codex-prompt-realign

## Stage A — 把上游架構複製過來

### A.1 — 還原人格檔（已完成）
- [x] **A1-1** 替換 `packages/opencode/src/session/prompt/codex.txt` 為上游 default.md（275 行）
- [x] **A1-2** 替換 `templates/prompts/drivers/codex.txt` 為上游 default.md
- [x] **A1-3** 驗證三份 md5 一致：`7a62de0a7552d52b455f48d9a1e96016`
- [x] **A1-4** 記事件 `event_2026-05-11_persona-restored.md`

### A.2 — Fragment 框架
- [x] **A2-1** 建目錄 `packages/opencode/src/session/context-fragments/`
- [x] **A2-2** 寫 `fragment.ts`：定義 `ContextFragment` interface（`role: "user" | "developer"`, `startMarker`, `endMarker`, `body(): string`, `id: string`）
- [x] **A2-3** 寫 `assemble.ts`：定義 `assembleBundles(fragments) → { developerItem, userItem }`，按 ROLE 分桶並用 marker 包裹後 join
- [x] **A2-4** 實作 `environment-context.ts`：對齊上游 `EnvironmentContext`（cwd / shell / current_date / timezone）
- [x] **A2-5** 實作 `user-instructions.ts`：對齊上游 `UserInstructions`，constructor 接 `{ directory, text }`
- [x] **A2-6** 實作 `opencode-protocol-instructions.ts`：OpenCode 自有 fragment（developer-role, `<opencode_protocol>`），body 取 `SystemPrompt.system()` 結果
- [x] **A2-7** 實作 `role-identity.ts`：OpenCode 自有 fragment（developer-role, `<role_identity>`）
- [x] **A2-8** 單元測試 `assemble.test.ts`：驗證 ROLE 分桶、marker 包裹、空 body 跳過

### A.3 — Wire 結構改寫
- [x] **A3-1** 修 `packages/opencode-codex-provider/src/convert.ts`：`instructions` 只放第一個 system message（= driver），其餘 system message 全部丟棄（在 llm.ts 改完之前先這樣）
- [x] **A3-2** 修 `packages/opencode/src/session/llm.ts`：移除自創 `## CONTEXT PREFACE` 路徑；改成組裝 fragment list → assemble → 兩個 ResponseItem 插在 `input.messages` 的最前面
- [x] **A3-3** 拆 `static-system-builder.ts`：`buildStaticBlock()` 只回 driver text；其餘 layer 的 owner 改放各自 fragment producer
- [x] **A3-4** 加 feature flag `OPENCODE_CODEX_LEGACY_INSTRUCTIONS=1` 環境變數，預設 off；on 時走舊路徑（讓 rollback 簡單）
- [ ] **A3-5** Plugin trigger 適配：`experimental.chat.system.transform` 仍可運作（input 變窄為 driver only）；新增 `experimental.chat.context.fragment.transform` 給 plugin 操作 fragment list

### A.4 — `prompt_cache_key` 對齊
- [x] **A4-1** 修 `packages/opencode-codex-provider/src/provider.ts:163`，`cacheKey` 改回純 `threadId`（`= sessionId`）
- [ ] **A4-2** 驗證 `transport-ws.ts:756` 的 per-account swap 仍正常運作（per-account state 是 chain 而非 cache key）
- [x] **A4-3** 加單元測試確認同 sessionId 不同 accountId 的兩個請求帶相同 prompt_cache_key

### A.5 — Rollout safety
- [ ] **A5-1** Daemon 啟動時若偵測舊版 continuation state（disk persisted with old cache_key shape），broadcast 一次 `resetWsSession` 給每個 active codex session
- [ ] **A5-2** Smoke test：rebuild + restart，跑 2 個 turn，確認 cache_read 第二 turn 顯著大於 4608

## Stage B — 把 OpenCode 自有資產調和進來

### B.1 — 對齊上游已有 fragment
- [ ] **B1-1** 實作 `apps-instructions.ts`：對齊上游 `AppsInstructions`，list 來源 `ManagedAppRegistry`
- [ ] **B1-2** 實作 `available-skills-instructions.ts`：developer-role 單一 blob，列 available skill metadata（含 summarized state）
- [ ] **B1-3** 實作 `skill-instructions.ts`：user-role per-skill，body = SKILL.md 全文
- [ ] **B1-4** 實作 `personality-spec-instructions.ts`：對齊上游，當有 personality override 時注入

### B.2 — OpenCode-only fragment
- [ ] **B2-1** 實作 `lazy-catalog-instructions.ts`：developer-role, `<lazy_catalog>`
- [ ] **B2-2** 實作 `structured-output-directive.ts`：developer-role, `<structured_output>`
- [ ] **B2-3** 實作 `quota-low-notice.ts`：developer-role, `<quota_status>`
- [ ] **B2-4** 實作 `subagent-return-notice.ts`：user-role, `<subagent_return>`
- [ ] **B2-5** 實作 `enablement-snapshot.ts`：developer-role, `<enablement>`
- [ ] **B2-6** 實作 `attached-images-inventory.ts`：user-role, `<attached_images>`（圖片 binary 仍走對話訊息 multi-modal content，不在這個 fragment）

### B.3 — 廢除舊結構
- [ ] **B3-1** 刪除 `packages/opencode/src/session/context-preface.ts`
- [ ] **B3-2** 刪除 `packages/opencode/src/session/context-preface-types.ts`
- [ ] **B3-3** 移除 `## CONTEXT PREFACE — read but do not echo` 任何殘留引用
- [ ] **B3-4** 移除 T1/T2/trailing 概念在 telemetry / prompt-telemetry.blocks 的相關欄位

### B.4 — Model-specific persona routing
- [ ] **B4-1** 在 `SystemPrompt.provider(model)` 內加 model.api.id → prompt md 路由表
- [ ] **B4-2** 把 `gpt_5_2_prompt.md` / `gpt_5_codex_prompt.md` / `gpt_5_1_prompt.md` 等複製到 `packages/opencode/src/session/prompt/codex/`（保持上游 hash）
- [ ] **B4-3** Fallback 規則：找不到對應的 model-specific prompt 就用 default.md

### B.5 — Validation
- [ ] **B5-1** e2e test：兩 turn 連續送，第二 turn `cached_tokens >= 0.9 * input_tokens`
- [ ] **B5-2** Subagent regression test：subagent session 啟動時 `RoleIdentity.body() == "Current Role: Subagent..."`
- [ ] **B5-3** Hash stability test：同 session 同 driver 的兩個 turn `instructions` byte 完全一致
- [ ] **B5-4** Plugin transform regression：實作一個 mock plugin，驗證 `experimental.chat.system.transform` 仍能修改 driver
- [ ] **B5-5** Update `specs/architecture.md` 的 codex provider 段落

## 路標

- 階段 A 完成 = cache_read 在 healthy delta 模式下從 4608 跳到 100k+ 的觀測證據
- 階段 B 完成 = OpenCode 全部自有資產對應到 fragment，無 `## CONTEXT PREFACE` 殘留
