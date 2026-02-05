#### 功能：修復 google-api 模型清單回填

**需求**

- admin panel 的 google-api provider 在 model select 頁面需顯示可選 models。
- model 清單由後端 API 回傳，ModelsDev 仍可能使用 legacy `google` ID。
- google-api 應能自動對應 models.dev 的 google models。

**範圍**

- IN：`src/provider/models.ts`（ModelsDev provider 正規化）、必要時後端 `/provider` 合併邏輯。
- OUT：新增功能或 UI 改版。

**方法**

- 在 ModelsDev.get 載入後正規化 provider ID：若存在 `google` 則映射為 `google-api`。
- 避免與既有 `google-api` provider 衝突，採用安全覆寫策略。

**任務**

1. [x] 正規化 ModelsDev provider ID（google -> google-api）。
2. [ ] 確認 admin panel model list 可顯示 google-api models。
3. [ ] 放寬 favorites / rotation3d，避免依賴 provider.models 清單。
4. [ ] 補齊 google-api model selector 顯示的 gemini-3-pro / gemini-3-flash。

**變更紀錄**

- 更新 google-api 的 AI Studio whitelist 為官方 model ID 清單（Gemini 3/2.5/2.0/1.5、latest aliases、specialized）。

**變更紀錄**

- `ModelsDev.get()` 追加 provider ID 正規化（google -> google-api），避免 legacy ID 造成空模型列表。
- Favorites/rotation3d 不再依賴 provider.models 清單，僅要求 provider 存在。
- google-api model selector 額外補上 gemini-3-pro / gemini-3-flash（若 provider.models 缺失）。

**待解問題**

- 若 models.dev 同時提供 google-api 與 google，需確認合併策略。
