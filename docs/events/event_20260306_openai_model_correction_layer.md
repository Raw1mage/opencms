# Event: OpenAI Model Correction Layer

## 需求

- 將 OpenAI model 清單治理從「最終輸出 hardcoded whitelist」改為「`models.dev` raw feed + manual correction layer」。
- correction layer 必須能表達：
  - 移除上游多顯示的錯誤模型
  - 補回上游漏掉但日常應可見的模型
- web/TUI/runtime/plugin 都應共用同一份 correction source，避免規則分散。

## 範圍

IN:
- `packages/opencode/src/provider/model-curation.ts`
- `packages/opencode/src/provider/models.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/plugin/codex.ts`
- `packages/opencode/src/cli/cmd/models.ts`
- `packages/opencode/src/plugin/antigravity/plugin/model-registry.ts`
- `docs/ARCHITECTURE.md`

OUT:
- 不處理非 OpenAI provider 的模型校正
- 不改動 models.dev 外部服務本身

## 任務清單

- [x] 建立 OpenAI 單一 correction layer
- [x] 將 ingest/runtime/plugin/fallback 改為共用 correction layer
- [x] 移除 final-output whitelist 直寫做法
- [x] 更新 Architecture 與 event 留痕
- [x] 驗證 web runtime 與 typecheck

## Debug Checkpoints

### Baseline

- `models.ts` 在 ingest 階段直接用 OpenAI 6-model allowlist 收斂資料。
- `provider.ts` 在最終 runtime output 再套一層 OpenAI whitelist。
- `codex.ts` 的 OAuth discovery 另有一份獨立 allowedModels。
- CLI fallback 與 model registry 也各自維護 OpenAI 列表，規則分散且維護成本高。

### Execution

- 新增 `provider/model-curation.ts` 作為單一 correction source。
- 將 OpenAI 校正改為 patch 語義：
  - `remove`: 移除 models.dev 多顯示的錯誤條目
  - `add`: 補回日常用但可能缺漏的模型定義
- `models.ts` 在 raw feed 進系統與 refresh cache 時套用 correction。
- `provider.ts` 與 `codex.ts` 改為重用同一 correction helper，不再各自維護 whitelist。
- CLI fallback 與 antigravity model registry 改為引用同一份 OpenAI fallback source。

### Validation

- `bun x tsc -p packages/opencode/tsconfig.json --noEmit`
  - 通過
- `./webctl.sh dev-refresh`
  - 通過，frontend rebuild 完成
- `./webctl.sh status`
  - 通過，`Health: {"healthy":true,"version":"local"}`
- 程式結構驗證：
  - OpenAI correction source 已集中到 `packages/opencode/src/provider/model-curation.ts`
  - `models.ts`、`provider.ts`、`codex.ts`、CLI fallback、model registry 不再各自維護獨立 OpenAI allowlist
- Architecture Sync: Verified (Doc updated)
  - 依據：provider graph assembly 現在正式包含 manual correction layer，屬架構契約更新
