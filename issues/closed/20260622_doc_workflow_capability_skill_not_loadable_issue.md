# Bug Report: doc-workflow capability skill 已 projection 進 `<data>/skills` 卻無法被 `skill()` 載入

## 0. Handoff Summary

docxmcp 透過 capability-sync 機制把 `doc-workflow` skill 正確 projection 進 opencode 的權威 skill 目錄（`~/.local/share/opencode/skills/doc-workflow/`，含合規 SKILL.md + `.capability-installed.json`），但 `skill()` 工具始終回報 `Skill "doc-workflow" not found`——它不在 `skill()` 的可用清單裡，即使檔案實體、frontmatter、目錄型態都與能正常載入的 skill（如 `docx`）無異。`system-manager_skill_loader` 的 `reload` / `load` action 重建出的 index（`count: 53`）也**不含** doc-workflow，且 `load` 把路徑寫進 `skills.paths` 後仍無效——因為 `skill.ts` 的 scan 邏輯**刻意只掃 `<data>/skills`、不讀 `skills.paths`**。這是 opencode skill 索引機制的 bug，責任在 opencode 端（docxmcp 已正確完成 projection）。本 BR 為**已確認 (confirmed)** bug，但**精確失效點未定**（為何同目錄下 docx 掃得到、doc-workflow 掃不到）。下一個 session 應先在 `skill.ts:createState()` 加 log 印出 glob 掃到的每個 match 與被 addSkill 接受/拒絕的原因，定位 doc-workflow 在哪一步掉出。

## 1. Bug Identity

| Field                         | Value                                                |
| ----------------------------- | ---------------------------------------------------- |
| Title                         | doc-workflow capability skill projection 後無法被 skill() 載入 |
| Component                     | opencode `packages/opencode/src/skill/skill.ts`（Skill index scan）+ capability-sync projection |
| Reporter                      | Main session（利善美月會 docx 任務，2026-06-22）          |
| Date                          | 2026-06-22                                           |
| Severity                      | high — 整個 doc-workflow 方法論無法經正規 skill() 載入，AI 被迫憑印象操作 docxmcp，已導致多輪錯誤（自創歸檔結構違反 §A.2、誤用 clean_headings 剝標號） |
| Priority                      | P1 — 不阻斷 docxmcp 工具本身，但讓其方法論層長期不可用，反覆踩同類坑 |
| Status                        | confirmed（失效現象確認；精確失效行未定）             |
| Affected versions/tools/paths | `~/.local/share/opencode/skills/doc-workflow/`；`packages/opencode/src/skill/skill.ts`；`packages/opencode/src/mcp/skill-resync.ts`；`system-manager_skill_loader` |

## 2. Environment

- opencode repo: `/home/pkcs12/projects/opencode`
- skill 權威目錄: `/home/pkcs12/.local/share/opencode/skills/`（= `Global.Path.data/skills`）
- doc-workflow 來源 (capability SSOT): `/home/pkcs12/projects/docxmcp/skills/doc-workflow/`
- projection 落點: `/home/pkcs12/.local/share/opencode/skills/doc-workflow/`（真目錄，非 symlink）
- OS/runtime: Linux, bun daemon
- 相關服務: docxmcp MCP（capability-sync projection 來源）
- config: `/home/pkcs12/.config/opencode/opencode.json`（`skills.paths`）

## 3. Expected Behavior

- capability-sync 把 MCP-carried skill projection 進 `<data>/skills/<name>/` 後，`skill()` 工具應能在下一次 scan（或 `skill_loader reload`）後看見並載入它。
- `skill_loader reload` / `load` 重建的 index 應涵蓋 `<data>/skills` 下**所有**含合規 SKILL.md 的目錄。
- frontmatter 合規（有 `name` + `description`）+ 真目錄 + SKILL.md 存在 ⇒ 必然出現在可用清單。
- 不變量：同一個 `<data>/skills` 目錄下，`docx` 掃得到，結構等價的 `doc-workflow` 也必須掃得到。

## 4. Actual Behavior

- `skill({name:"doc-workflow"})` → `Error: Skill "doc-workflow" not found. Available skills: …`（53 個，無 doc-workflow）。
- `system-manager_skill_loader({action:"reload"})` → `index.count: 53`，列表**不含** doc-workflow。
- `system-manager_skill_loader({action:"load", path:".../doc-workflow"})` → `configChanged:true`、`pathsAfter` 含該路徑、回傳 index 仍 `count:53` **不含** doc-workflow。
- 但 enablement snapshot 的 `skills available` **列出** doc-workflow（registry 宣告與實際 scan 脫鉤）。
- doc-workflow 的 SKILL.md frontmatter 與 docx 結構相同（`name:` 在第 2 行）；目錄是真 directory；`find` 用同款 glob 能掃到 `./doc-workflow/SKILL.md`。

## 5. Steps To Reproduce

1. 確認 projection 存在：`ls -la ~/.local/share/opencode/skills/doc-workflow/SKILL.md` → 檔案存在、frontmatter 有 `name: doc-workflow`。
   - 預期：存在。實際：存在（含 `.capability-installed.json`）。
2. 呼叫 `skill({name:"doc-workflow"})`。
   - 預期：載入成功。實際：`not found`，可用清單無它。
3. 呼叫 `system-manager_skill_loader({action:"reload"})`，檢查回傳 `index.skills`。
   - 預期：含 doc-workflow。實際：`count:53`，不含。
4. 呼叫 `system-manager_skill_loader({action:"load", path:"~/.local/share/opencode/skills/doc-workflow"})`。
   - 預期：載入並出現在 index。實際：`configChanged:true` 但 index 仍不含它。
5. 再次 `skill({name:"doc-workflow"})`。
   - 預期：成功。實際：仍 `not found`。

## 6. Evidence

| Evidence | Type      | Reference                                                                 | What it shows |
| -------- | --------- | ------------------------------------------------------------------------- | ------------- |
| E1       | file      | `/home/pkcs12/.local/share/opencode/skills/doc-workflow/SKILL.md:1-4`      | frontmatter 合規：`name: doc-workflow` 在第 2 行，與 docx skill 結構相同 |
| E2       | file      | `/home/pkcs12/.local/share/opencode/skills/doc-workflow/.capability-installed.json` | projection 來源 `sourceRepoPath:/home/pkcs12/projects/docxmcp`，`installedAt:2026-06-21T15:35:24Z` — capability-sync 確實安裝過 |
| E3       | code      | `packages/opencode/src/skill/skill.ts:83-108`                             | scan「Single authoritative skill source: `<data>/skills` only」，glob `**/SKILL.md`，`followSymlinks:true`；Line 102-103 過濾 `_` 前綴段 |
| E4       | code      | `packages/opencode/src/skill/skill.ts:61-62`                             | `Info.pick({name,description}).safeParse` 失敗則靜默 `return`（skip，無 log）— 可能的靜默吞點 |
| E5       | tool call | `system-manager_skill_loader({action:"reload"})`                         | 回傳 `index.count:53`，skills 陣列不含 doc-workflow |
| E6       | tool call | `system-manager_skill_loader({action:"load", path:".../doc-workflow"})`  | `configChanged:true`、`pathsAfter` 含路徑、index 仍 `count:53` 不含它 |
| E7       | code      | `packages/opencode/src/skill/skill.ts:83-86`                             | 註解明言**刻意不讀 `skills.paths`**，故 `skill_loader load` 寫的 paths 對 scan 無效 |
| E8       | tool call | `skill({name:"doc-workflow"})`（多次）                                    | 一律 `not found`；可用清單 53 個無它 |

## 7. Impact / Risk

- **user-visible**：doc-workflow 方法論（`<stem>.src/` 歸檔、Mode A/B docx 流程契約）無法經正規 `skill()` 載入。AI 退而憑印象操作 docxmcp，已實際導致：(1) 自創 `src/`+`refs/` 歸檔違反 §A.2；(2) 誤開 `clean_headings=true` 剝掉 heading 標號又外掛事後 fix。多輪返工。
- **reliability**：registry 宣告「available」但 scan 不可見 → AI 與使用者反覆困惑於「到底有沒有這 skill」。
- **blast radius**：所有 MCP-carried capability skill（凡走 capability-sync projection 進 `<data>/skills` 者）都可能同樣不可見；docxmcp 的 doc-workflow 只是首個被發現的。
- 無資料損毀風險；無安全風險。

## 8. Root-Cause Hypotheses

### H1: scan 結果被快取，projection 發生在 daemon 啟動掃描之後，且 reload 沒真正重掃 `<data>/skills`

Confidence: medium

Why plausible:
- `skill.ts:120-135` `state()` 用 `Instance.state(createState)` 快取，`reset()` 清快取。
- doc-workflow 的 `.capability-installed.json` 顯示 installedAt 2026-06-21，可能在某次 daemon 啟動掃描後才落地。
- `skill_loader reload` 回傳的 53 個固定不含它，像是讀到一份**不涵蓋它的快取/別處 index**，而非真正重掃 `<data>/skills`。

How to confirm:
- 在 `createState()` 開頭加 log 印 `skillRoot` 與每個 glob match；呼叫 `skill_loader reload` 看 doc-workflow/SKILL.md 是否出現在 match 列表。
- 對照 `skill_loader` 的 reload 實作是否真的呼叫 `Skill.reset()` + 重跑 `createState()`，還是讀另一個 module 的 index。

How to refute:
- 若 log 顯示 glob 根本沒掃到 doc-workflow/SKILL.md，則非快取問題，轉 H2/H3。

### H2: `safeParse` 因 frontmatter 某欄位（非 name/description）不符 schema 而靜默 skip

Confidence: low

Why plausible:
- `skill.ts:61-62` parse 失敗靜默 return、無 log。
- doc-workflow SKILL.md 可能含 docx 沒有的 frontmatter 欄位觸發 schema 嚴格失敗。

How to confirm:
- 手動對 doc-workflow SKILL.md 跑 `ConfigMarkdown.parse` + `Info.pick({name,description}).safeParse`，看 success。

How to refute:
- E1 已顯示 frontmatter 只有 name+description（與 docx 同構），`pick` 只取這兩欄 → 極可能 success。故信心低。

### H3: `skill_loader` 的 reload/load 操作的 index 與 `skill()` 工具實際讀的 index 是兩個不同實例（daemon 多 instance / Instance.state 隔離）

Confidence: medium

Why plausible:
- `skill_loader load` 回傳 index `count:53` 不含 doc-workflow，但同次 enablement snapshot 卻列它 available → 至少兩份 index 來源不一致。
- `Instance.state` 是 per-instance；reload 可能只 reset 了某個 instance 的快取，`skill()` 工具在另一 instance 解析。

How to confirm:
- 查 `skill()` tool（`packages/opencode/src/tool/skill.ts`）解析 name 時讀的是哪個 `Skill.state()`，與 `skill_loader` reload 的是否同 instance。

How to refute:
- 若兩者證實同 instance/同 state，排除。

## 9. Workarounds

- **手動 symlink**（已試，無效）：`ln -sfn .../doc-workflow <data>/skills/doc-workflow` — projection 已是真目錄，symlink 多餘且不改變 scan 不可見。
- **改用 `read` SKILL.md 套方法論**（當前可行繞道）：`read /home/pkcs12/projects/skills/doc-workflow/SKILL.md` 直接套用 §A.2 等規範。SYSTEM.md §2.4 允許 review skill 時 read。**這是目前唯一可靠繞道**，但不觸發 SkillLayerRegistry（無 sidebar 可見性 / pin / token 計帳）。
- 不要依賴 enablement snapshot 的「available」當作「skill() 可載入」。

## 10. Proposed Fix Direction

- 先用 H1/H3 的 log 定位：在 `skill.ts:createState()` 印出 skillRoot + 每個 glob match + addSkill 接受/拒絕原因；在 `skill_loader` reload 路徑確認真的 `Skill.reset()` 後重掃。
- 若是快取/instance 隔離（H1/H3）：讓 `skill_loader reload` 確實對 `skill()` 工具讀的同一個 `Skill.state` 觸發 `reset()`；或讓 capability-sync projection 完成後主動發 `Skill.reset()`（projection 與 index 之間補一條 invalidation）。
- 若是靜默 skip（H2）：把 `safeParse` 失敗從靜默 return 改為 `log.warn`（含 skill 路徑 + zod issue），杜絕「掃到卻無聲消失」。
- 一併修 registry/scan 脫鉤：enablement「available」應由實際 scan index 派生，而非獨立宣告，避免假訊號。
- 測試：加一個 fixture skill projection 進 `<data>/skills`，斷言 reload 後 `Skill.state().skills` 含它、`skill()` 能載入。

## 11. Acceptance Criteria

- 正向：capability projection 一個 skill 進 `<data>/skills/<name>/` 後，`skill_loader reload`（或 capability-sync 完成時自動 invalidation）使 `skill({name})` 載入成功。
- 正向：`skill_loader reload` 回傳的 index 含 `<data>/skills` 下所有合規 SKILL.md（含 doc-workflow）。
- 負向：frontmatter 不合規的 skill 被 skip 時必有 `log.warn`，不再靜默。
- 一致性：enablement「available」清單與 `skill()` 實際可載入清單一致（無「宣告 available 卻 not found」）。
- 回歸：既有 53 個 skill 仍正常載入，doc-workflow（第 54 個）也載入。

## 12. Open Questions

- `skill_loader reload` 是否真的重掃 `<data>/skills`，還是讀別處 index？（決定 H1 vs H3）
- `skill()` tool 與 `skill_loader` 是否共享同一 `Skill.state` instance？
- capability-sync projection 完成後，有沒有任何機制通知 Skill module invalidate 快取？（目前看來沒有）
- enablement snapshot 的「skills available」資料源是什麼？為何能列出 scan 不可見的 doc-workflow？

## 13. Next Session Checklist

1. 開檔：`packages/opencode/src/skill/skill.ts`（看 `createState()` Line 45-114、`state()` Line 120-128）。
2. 開檔：`packages/opencode/src/tool/skill.ts`（看 name 解析讀哪個 state）。
3. 開檔：`system-manager_skill_loader` 的 reload/load 實作（確認是否真 `Skill.reset()`）。
4. 加 log：在 `createState()` 印 skillRoot + 每個 glob match + addSkill verdict；跑 `skill_loader reload` 觀察 doc-workflow/SKILL.md 是否在 match 列表。
5. recall evidence：E5/E6（skill_loader reload/load 回傳 count:53 不含 doc-workflow）、E3/E7（skill.ts 只掃 data/skills、不讀 skills.paths）。
6. 重現：`skill({name:"doc-workflow"})` → 應仍 not found（修復前）。
7. 預期停點：log 明確指出 doc-workflow 在「未掃到 / safeParse skip / 快取未含 / instance 隔離」四者中的哪一個，即可定 H 並進入修復。
