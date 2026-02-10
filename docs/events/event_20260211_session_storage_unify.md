# Event: Session Storage Unification

Date: 2026-02-11
Status: Done

## Objective

將 session metadata / messages / parts / truncated outputs 集中在同一個 session 目錄，實現「刪 session = 刪全部」。

## New Layout

```text
~/.local/share/opencode/storage/session/<projectID>/<sessionID>/
  info.json
  messages/
    <messageID>/
      info.json
      parts/
        <partID>.json
  output/
    output_tool_<id>
```

## Key Changes

1. `Storage` 層新增路徑解析與索引機制，保留既有 `Storage.read/write/list/remove` 呼叫介面。
2. 新增 migration（`MIGRATIONS` 第 3 段）將舊結構搬移到新結構：
   - `session/<project>/<session>.json` -> `session/<project>/<session>/info.json`
   - `message/<session>/<message>.json` -> `session/<project>/<session>/messages/<message>/info.json`
   - `part/<message>/<part>.json` -> `session/<project>/<session>/messages/<message>/parts/<part>.json`
   - `tool-output/<session>/tool_*` -> `session/<project>/<session>/output/output_tool_*`
3. `Truncate` 輸出改為優先寫入 session 目錄下 `output/`。
4. `Session.remove` 不再額外清理獨立 `tool-output` 目錄（session 目錄整體刪除時一併處理）。

## Verification

- ✅ `packages/opencode/test/tool/truncation.test.ts`
- ✅ `packages/opencode/test/session/session.test.ts`

Notes:
- `packages/opencode/test/server/session-*.test.ts` 在當前環境返回 401（auth gate），與本次 storage refactor 無直接關聯。
