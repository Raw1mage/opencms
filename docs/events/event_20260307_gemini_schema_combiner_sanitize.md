# Event: gemini schema combiner sanitize guard

Date: 2026-03-07
Status: Done

## 需求

- 修正 Gemini schema sanitize 對 combiner nodes（`anyOf` / `oneOf` / `allOf`）的誤注入
- 避免在 Gemini tool/schema 轉換時，把不該存在的 sibling keys（如 `type` / `properties`）塞進 combiner node
- 只做 `ProviderTransform.schema(...)` 的最小安全修正

## 範圍

### IN

- `packages/opencode/src/provider/transform.ts`
- `packages/opencode/test/provider/transform.test.ts`
- upstream commit `7e3e85ba5`

### OUT

- 不重構整個 provider transform pipeline
- 不修改非 Gemini provider 的 schema 路徑
- 不改動 tool/runtime orchestration

## 任務清單

- [x] 建立 Gemini schema combiner 專題 event
- [x] 比對 upstream sanitize intent 與 cms 現況
- [x] 定義 minimum safe first slice
- [x] 補上 regression tests
- [x] 執行驗證並完成 commit
- [x] 更新 Validation 與 Architecture Sync 記錄

## Debug Checkpoints

### Baseline

- cms 目前的 Gemini sanitize 會對 `array.items` 空 schema 自動補 `type = string`，也會對非 object type 移除 `properties/required`。
- 若某個 node 實際上是 combiner schema（例如 `items: { anyOf: [...] }`），上述修正可能把 sibling keys 注入到 combiner node，造成 Gemini schema 結構失真。

### Execution

- Upstream `7e3e85ba5` matches a real cms-safe transform-layer gap: current Gemini sanitize injects fallback schema fields into empty `items` nodes, but it does not distinguish truly empty child schema from combiner nodes.
- Minimum safe first slice:
  - add helper guards for plain-object / combiner / schema-intent detection inside `ProviderTransform.schema(...)`
  - only synthesize `items.type = "string"` when the child schema is actually empty
  - avoid stripping/adding sibling object keys on nodes that already use `anyOf` / `oneOf` / `allOf`
- Implementation:
  - `packages/opencode/src/provider/transform.ts` now preserves Gemini combiner nodes during sanitize
  - `packages/opencode/test/provider/transform.test.ts` adds regression coverage for `items.anyOf` and generic combiner-node sibling preservation

### Validation

- `bun test /home/pkcs12/projects/opencode/packages/opencode/test/provider/transform.test.ts` 通過（87 pass / 0 fail）。
- `bun run typecheck` 通過（repo-wide）。
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪僅修正 Gemini schema sanitize 的 transform 規則與對應 regression tests，未改動 provider graph、session contract、或 routing/runtime ownership 邊界。
