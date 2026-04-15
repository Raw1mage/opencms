# Event: Custom provider ollama frontend filter RCA

## 需求

- 修復透過「模型提供者」建立的自訂 provider（案例：`ollama`）未出現在前端 provider 清單的問題。
- 釐清是否仍有使用者無法控制的隱形 disabled/filter 邊界殘留。

## 範圍

### IN

- `packages/app/src/components/dialog-select-model.tsx`
- `packages/app/src/components/model-selector-state.test.ts`

### OUT

- 不改動後端 supported-provider registry / `/provider` canonical contract。
- 不改動 custom provider 儲存格式或 server-side provider universe 規則。

## 任務清單

- [x] 讀取 architecture 與既有 provider/custom-provider 事件文件
- [x] 定位 `ollama` 未出現在 provider list 的前端 root cause
- [x] 以最小修補改正 model manager provider universe
- [x] 新增 regression test 並執行最小驗證

## Debug Checkpoints

### Baseline

- 使用者透過「模型提供者」建立自訂 provider `ollama` 後，provider 清單沒有出現該項目。
- 使用者明確指出問題感受為「前端有一個隱形的 filter，是使用者控制不到的」。

### Evidence

- `packages/app/src/context/models.tsx` 已把 `globalSync.data.config.provider` 中的 `@ai-sdk/openai-compatible` custom provider models 合併進前端 model surface。
- `packages/app/src/components/dialog-select-model.tsx` 原本仍以 `globalSync.data.provider.all` 建立 provider rows。
- `globalSync.data.provider.all` 來自 server `/provider` canonical list，受 supported-provider registry 約束，不包含 `ollama` 這類 custom provider。
- 因此前端出現 split-brain：model surface 已有 custom provider models，但 provider universe 仍被 server canonical list 隱性過濾。

### Root Cause

- Root cause 是前端 model manager 的 provider row source 使用錯誤 authority boundary。
- `dialog-select-model.tsx` 直接吃 server canonical provider list，而不是吃已合併 custom providers 的 frontend provider surface。
- 結果造成 custom provider 被前端隱形 filter 掉，看起來像 lingering disabled list，但實際上是 provider-universe source 漏接。

### Implementation

- `packages/app/src/components/dialog-select-model.tsx`
  - 改為使用 `useProviders().all()` 的前端合併 provider surface 建立 `buildProviderRows(...)` 輸入。
  - 讓 config-backed custom providers（例如 `ollama`）可以進入 model manager provider list。
- `packages/app/src/components/model-selector-state.test.ts`
  - 新增 regression test，驗證 merged frontend provider surface 中的 `ollama` 可被 `buildProviderRows(...)` 納入。

## Validation

- `bun test /home/pkcs12/projects/opencode/packages/app/src/components/model-selector-state.test.ts` ✅
  - 19 pass / 0 fail
- Architecture Sync: Verified (No doc changes)
  - 依據：本次修補僅修正前端既有 provider surface 的取用邊界，未改變長期模組邊界、後端資料流、runtime state authority 或 supported-provider registry contract。
