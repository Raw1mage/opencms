#### 功能：修復 Claude 模型思考區塊簽章錯誤

**需求**

- 解決 `Invalid signature in thinking block` 錯誤。
- Claude 模型不支援 `skip_thought_signature_validator` 哨兵值，導致注入後被 API 拒絕。

**範圍**

- IN：`src/plugin/antigravity/plugin/request-helpers.ts`

**方法**

- 在 `filterContentArray` 中，針對 Claude 模型且無有效簽章的思考區塊，直接捨棄而不是注入哨兵值。
- 這樣會遺失思考內容，但能確保請求成功。

**任務**

1. [x] 修改 `src/plugin/antigravity/plugin/request-helpers.ts`

**待解問題**

- 無
