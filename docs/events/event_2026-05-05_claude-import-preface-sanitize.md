# 2026-05-05 Claude Import — OpenCode Preface Sanitization

## 需求

- 防禦性修補 [packages/opencode/src/session/claude-import.ts](../../packages/opencode/src/session/claude-import.ts) 在匯入 Claude Code transcript 時可能引入 OpenCode 內部 preface 區塊污染。
- 起因：使用者擔心 Claude session import 觸發嚴重 session 污染與 context 爆炸。

## 範圍 (IN/OUT)

- IN: `claude-import.ts` `sanitizeImportedText` 重寫；相關 transcript-import 測試擴充。
- OUT: 不變更 `importTranscript` 主流程、不變更 `ClaudeImport.listNative` 行為、不變更 storage 層。

## RCA / 真實污染量盤點

- `~/.claude/projects/` 下 134 個 transcript jsonl：grep `CONTEXT PREFACE` 命中 5 個檔案，但所有命中都在 assistant text block（assistant 在討論 preface 設計），不是 user-message 注入。
- OpenCode storage 7597 個 session DB（sample 200）：2 個 DB 含 preface 字串，皆為 assistant 在做 RCA 摘要時引用。
- 匯入路徑使用統計：跨全 storage 7597 個 session，`messages.agent='claude-import'` 的訊息數 = 0。本修補對既有資料屬「未來防禦」，非「修補當下崩壞」。
- 本修補不改 commit message 框法為 fix；採 feat（為新增能力，預設不被啟用直到使用者觸發 import）。

## Decisions

- **Tag-list cascade strip + 自然 empty-skip**：純 preface 訊息經 cascade trim 後為 `""`，被 `importTranscript` 既有 `if (!text) continue` 守門句吃掉，不需另立「整段丟棄」分支。維持單一資料流。
- **Tag list 擴增**：相對舊版本新增 `preloaded_context` / `env_context` / `skill_context`（legacy envelope）、`attachment_ref`（[message-v2.ts:929](../../packages/opencode/src/session/message-v2.ts#L929) emit）、`deferred_tools`（底線變體與既有 hyphen 變體並列）。
- **結構化 `<skill>` 剝除**：對逃出父 envelope 的 `<skill name="..." state="...">…</skill>` 條目單獨剝除；只匹配帶 `name="..."` 屬性的，避免誤殺一般文本中的 `<skill>` 字面用法。
- **ENABLEMENT SNAPSHOT 終止條件放寬**：原版只認 `<attached_images>` 或 `<context_budget>` 為終止界線；改為 blank line / 任何 opening tag / EOF 為界，避免 snapshot 後接非預期 sibling 時整段殘留。
- **不引入 directive-header whole-discard 分支**：既有 cascade 已能將純 preface 自然壓縮為 `""`；額外加 header-only 分支會誤殺「混合 preface + 真實 user content」的 corner case 測試樣本。

## XDG Backup

- `/home/pkcs12/.config/opencode.bak-20260505-1803-claude-import-sanitize`（前一輪 agent 已建立白名單快照；僅供需要時手動還原，不自動 restore）。

## Verification

- 新增/更新測試三條於 [packages/opencode/test/server/session-list.test.ts](../../packages/opencode/test/server/session-list.test.ts)：
  - `sanitizes internal OpenCode prompt preface from Claude transcript import`：partial pollution + 結構化 `<skill name=…>` + `<attachment_ref>` 含 `<preview>` + `[ENABLEMENT SNAPSHOT]` 全 cover。
  - `drops pure-preface Claude messages entirely (no real user content survives)`：純 preface 訊息經 cascade 自然 collapse → 被 empty-text guard 跳過；同 transcript 中真實 prompt 仍正常匯入。
  - `strips legacy <preloaded_context> envelope from Claude transcript import`：legacy envelope 包覆 `<env_context>` / `<skill_context>` 也乾淨剝除。
- 4 條 sanitization 測試全綠（7 + 4 + 7 = 18 expects）。
- 同檔其他 8 條 OPENCODE_SERVER_PASSWORD dead-branch 測試在 HEAD 上即為 fail（pre-existing），與本修補無關，本 commit 不嘗試擴大 cleanup scope。

## Commit

- `11989db4b feat(session/claude-import): sanitize OpenCode preface tags from imported transcripts`

## Follow-up Notes

- 若日後 preface emitter 演化（新增 tag），同步更新 [claude-import.ts](../../packages/opencode/src/session/claude-import.ts) 的 `PREFACE_TAGS` 陣列即可。
- 若日後使用者實際觸發 claude-import 流量，可重跑「`messages.agent='claude-import'` count + storage scan」確認 sanitizer 命中率與 false-positive。
