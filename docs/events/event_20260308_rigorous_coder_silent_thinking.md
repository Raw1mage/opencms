# Event: Rigorous Coder Silent Thinking

Date: 2026-03-08
Status: Done

## 1. 需求

- 改善 `rigorous-coder` skill 的使用者體驗。
- 保留嚴謹檢查與雙階段操作精神，但不要再要求對使用者輸出固定的 `<thinking>...</thinking>` 鏈。
- 同步更新 runtime 與 template skill，避免 release 漂移。

## 2. 範圍

### IN

- `/home/pkcs12/.config/opencode/skills/rigorous-coder/SKILL.md`
- `/home/pkcs12/projects/opencode/templates/skills/rigorous-coder/SKILL.md`

### OUT

- 其他 skill 規則
- tool routing 行為
- 非 skill 文件

## 3. 任務清單

- [x] 盤點 runtime/template skill 現況
- [x] 建立 event 與 checkpoints
- [x] 更新 skill 使推理過程改為靜默內部檢查
- [x] 驗證 runtime/template 一致性與 architecture sync

## 4. Debug Checkpoints

### Baseline

- 現況：`rigorous-coder` 明確要求在任何變更前，對使用者輸出固定 `<thinking>...</thinking>` 文字區塊。
- 問題：這段內容大多是固定檢查清單，重複展示給使用者的資訊密度低、可讀性差。

### Execution

- 改為要求模型在內部完成同一套 SSOT / Blast Radius / Anti-Hallucination / Validation 檢查。
- 對外只需在必要時輸出精簡的「偵查結論 / 修改提案 / 驗證計畫」，不再暴露固定 `<thinking>` 模板。

### Validation

- `diff -u /home/pkcs12/.config/opencode/skills/rigorous-coder/SKILL.md /home/pkcs12/projects/opencode/templates/skills/rigorous-coder/SKILL.md` ✅ 無差異
- 驗證重點：固定 `<thinking>...</thinking>` 對外輸出要求已改為「內部檢查、對外精簡摘要」
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅調整 skill 互動規則，不影響系統架構、模組邊界與 runtime topology。
