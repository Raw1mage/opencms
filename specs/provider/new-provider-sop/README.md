# New Provider Registration SOP — OpenCMS Framework

**Based on**: copilot-cli implementation experience (2026-05-18)
**Purpose**: Step-by-step guide for adding a new LLM provider to OpenCMS
**DD-13**: This SOP was a design decision during copilot-cli development

---

## 概述

在 OpenCMS 中新增一個 LLM provider 需要觸碰兩個層面：

1. **Plugin 層**（`packages/opencode/src/plugin/`）：實作 auth、模型、fetch 邏輯
2. **Framework 層**（OpenCMS 框架）：讓 UI 和 API 看得到這個 provider

以下以 `copilot-cli` 為實例，列出每個 registration point。

---

## Registration Chain（13 步）

### Phase 1 — Plugin 宣告與初始化

#### Step 1: Plugin 入口宣告

**檔案**: `packages/opencode/src/plugin/index.ts` → `getInternalPlugins()`
**做什麼**: 把新 plugin 加到內建 plugin 陣列

```typescript
{ name: "copilot-cli", plugin: CopilotCLIPlugin }
```

> 這是系統知道你存在的第一步。沒加這行，後面全白做。

#### Step 2: Plugin.init() 觸發

**檔案**: `packages/opencode/src/plugin/index.ts` → `Plugin.init()`
**做什麼**: 系統啟動時自動呼叫所有 plugin 的 hook

- 在 bootstrap 階段由 `InstanceBootstrap` 觸發
- 每個 hook 的 `config` callback 會被呼叫（如果有定義）

#### Step 3: Auth Hooks 註冊

**檔案**: 你的 plugin 入口（例如 `plugin/copilot-cli/index.ts`）
**做什麼**: 回傳 `Hooks` 物件，宣告 auth 行為

```typescript
return {
  auth: {
    provider: "copilot-cli",           // provider ID
    loader: async (getAuth, provider) => { ... },  // token + fetch interceptor
    methods: [                          // UI 登入方式
      { type: "oauth", label: "Sign in with GitHub", handler: startDeviceFlow },
    ],
  },
  chat: {
    headers: (session) => ({ ... }),    // 每次 API 呼叫加的 header
  },
}
```

### Phase 2 — Provider Registry 宣告

#### Step 4: Supported Provider Registry

**檔案**: `packages/opencode/src/provider/supported-provider-registry.ts`
**做什麼**: 在 registry 物件加一筆

```typescript
"copilot-cli": {
  key: "copilot-cli",
  label: "Copilot CLI",
}
```

> 這讓 API 層知道「copilot-cli 是一個合法的 provider family」。

#### Step 5: Bundled Models 注入

**檔案**: `packages/opencode/src/provider/provider.ts` → `initState()`
**做什麼**: 把 hardcoded 的模型列表注入 provider database

- 定義 `GITHUB_COPILOT_DEFAULT_MODELS` 陣列
- 用 `createCopilotModel()` 建立每個模型的完整定義
- 所有模型的 cost 設為 0（Copilot 訂閱包含）

> 即使沒有 API 連線，UI 也能看到模型列表。

### Phase 3 — 動態模型發現

#### Step 6: Provider.list() 組裝

**檔案**: `packages/opencode/src/provider/provider.ts` → `Provider.list()`
**做什麼**: 組裝完整的 provider 目錄（bundled + dynamic 模型）

- 呼叫 `Plugin.discoverModels()` 取得動態模型
- 過濾 `disabled_providers` 設定
- 回傳包含 copilot-cli 的完整字典

#### Step 7: Plugin.discoverModels() Hook

**檔案**: `packages/opencode/src/plugin/index.ts` → `Plugin.discoverModels()`
**做什麼**: 啟動時從 plugin 的 `models()` function 取得動態模型

- 如果 plugin 定義了 `hook.models()`，會在這裡被呼叫
- copilot-cli 目前用 bundled models，沒有動態發現

#### Step 8: addDynamicModels() 合併

**檔案**: `packages/opencode/src/provider/provider.ts` → `Provider.addDynamicModels()`
**做什麼**: 把動態發現的模型合併到 provider state

### Phase 4 — API 層曝露

#### Step 9: Auth Methods API

**檔案**: `packages/opencode/src/provider/auth.ts` → `ProviderAuth.methods()`
**做什麼**: 把 plugin 的 auth methods 暴露給 REST API

- 前端呼叫 `/provider/auth` 就能拿到每個 provider 的登入方式

#### Step 10: Provider Listing API

**檔案**: `packages/opencode/src/server/routes/provider.ts` → `GET /provider/`
**做什麼**: 回傳所有 provider + 模型給前端

- 合併 bundled + dynamic + curated（ModelsDev）模型
- 正規化 provider rows

#### Step 11: Model Preferences API

**檔案**: `packages/opencode/src/server/routes/model.ts`
**做什麼**: 使用者的隱藏/最愛模型偏好

### Phase 5 — UI 渲染

#### Step 12: Model Selector State

**檔案**: `packages/app/src/components/model-selector-state.ts`
**做什麼**: 前端的 provider/model 選擇邏輯

- `KNOWN_PROVIDER_FAMILIES` 要加 `"copilot-cli"`
- `PROVIDER_LABEL_MAP` 要加顯示名稱

#### Step 13: Provider Section UI

**檔案**: `packages/console/app/src/routes/workspace/[id]/provider-section.tsx`
**做什麼**: Workspace console 的 provider 設定 UI

---

## Checklist

新增 provider 時，照以下 checklist 逐項確認：

- [ ] **plugin/index.ts** — `getInternalPlugins()` 加入新 plugin
- [ ] **plugin/your-provider/index.ts** — 實作 auth hooks + loader
- [ ] **provider/supported-provider-registry.ts** — 加入 registry entry
- [ ] **provider/provider.ts** — 加入 bundled models（`initState()` 內）
- [ ] **app/model-selector-state.ts** — `KNOWN_PROVIDER_FAMILIES` + `PROVIDER_LABEL_MAP`
- [ ] **console/provider-section.tsx** — PROVIDERS 列表（如需要）
- [ ] 測試：登入 → 模型列表顯示 → 對話可用

---

## Wire 層 vs Framework 層

| 面向 | Wire 層（Plugin） | Framework 層（OpenCMS） |
|------|------------------|----------------------|
| 職責 | Auth、API 通訊、格式轉換 | 模型管理、UI、設定持久化 |
| 自主性 | 完全自包含（DD-8） | 共用框架，只需註冊 |
| 檔案位置 | `plugin/your-provider/` | `provider/`、`server/routes/`、`app/` |
| 修改頻率 | 隨上游 API 變更 | 很少改 |
| 測試方式 | 單獨測 auth + API 回應 | 整合測 UI + API |
