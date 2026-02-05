#### 功能：Fix Skill Tool Content TypeError

**需求**

- 修復 `Skill` 工具載入時發生的 `TypeError: undefined is not an object (evaluating 'skill.content.trim')`
- 確保 `Skill.get()` 回傳包含 skill 內容的完整資訊

**範圍**

- IN：`src/skill/skill.ts`
- OUT：`src/tool/skill.ts` (不需要修改，只要資料源正確即可)

**方法**

- 修改 `Skill.Info` Zod schema，加入 `content: z.string()`
- 修改 `Skill.state` 中的 `addSkill` 函數，在解析 markdown 後將 `content` 欄位一併存入 skill 物件

**任務**

1. [x] 修改 `src/skill/skill.ts` 加入 `content` 欄位
2. [x] 驗證修復結果

**CHANGELOG**

- 更新 `Skill.Info` Zod schema，加入 `content: z.string()` 欄位
- 修改 `addSkill` 函數，在解析 markdown 後將 `md.content` 賦值給 skill 物件的 `content` 欄位
- 建立測試檔案 `test/repro_skill_fix.ts` 驗證修復邏輯

**結果**

修復後，`Skill.get()` 回傳的物件將包含完整的 skill markdown 內容，不會再出現 `TypeError: undefined is not an object (evaluating 'skill.content.trim')` 錯誤。

**注意**

此修復需要重啟 OpenCode 服務才能生效，因為 `Skill.state` 使用了 `Instance.state` 做快取。

**待解問題**

- 無
