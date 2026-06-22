# 跳針變體：preparation theater（同一 tool-call 反覆備料、從不發射）逃過 preface-paralysis detector

Status: CLOSED 2026-06-23 — RESOLVED-BY-SUPERSEDE for claude / WON'T-FIX (accepted, low-pri) for codex。
原始處置方向（新增 detector F + progress-credit gating，見下方「建議修法」）**已否決**：在追這個 BR 的過程中確認 autonomous runner 已退役（`config/tweaks.ts` `triggerPhrases:[]`），整個 paralysis detect→nudge→halt ladder 失去存在理由。改採反向修法：commit `6333a612a`（amends living spec `harness/paralysis-steer-provider-split` DD-8）對 **claude-class session 整塊跳過 paralysis ladder**，回歸原廠相容控制模式 —— claude 不再被 nudge / hard-halt，本 BR 的現場症狀（claude-cli session 被打斷）自此不可能發生。**codex (SS)** 仍跑偵測，所以「reformat 同一 artifact 拿假進度信用」這個偵測粒度 gap 對 codex 技術上仍在，但 codex 無認錯反射、halt 正是其解藥，故接受為 low-pri、不修。原 reported 內容保留於下供存查。
~~OPEN（reported 2026-06-23；現場 session 為 bodesign × GenAI Stars 提案，主 agent 在「產簡報」階段空轉 3 turn 後被 hard-halt。為既有 `bug_20260615_paralysis_guard_evaded_by_preface_perseveration` 的**新變體**：該 fix 的 halt 有效觸發了，但無法阻止模型**進入**這個新型態。）~~

Type: Bug Report
Severity: Medium-High（單 session 3 turn 空轉、~4 次純備料 tool call、被 runtime hard-halt 打斷；使用者需手動介入。token 浪費有限因 halt 及時，但模式本身會無限延續若無 halt。）

關聯前例：
- `issues/observing/bug_20260615_paralysis_guard_evaded_by_preface_perseveration.md`（直接母案；Detector D + progress-gated clean-streak）
- `issues/closed/bug_20260530_narrate_then_stall_regression.md`
- `issues/closed/bug_20260518_session_repetition_loop.md`

現場：session `ses_111617d41ffeH9OdlqQq2bpvWs`（directory `/home/pkcs12/GoogleDrive/@HIT/20260622 AIEDA`，bodesign 競賽提案）。事發 2026-06-23，「先做簡報 PDF」決策後的 deck_build 階段。

---

## Symptom

使用者選擇「先做簡報 PDF」後，主 agent：

1. **turn A**：`docxmcp_pptx_template(action=list)` 拿到 `clean` template → `write` 出 12-slide 的 `deck_payload.json`。✅ 真進度（mutate 檔案）。
2. **turn B**：narrate「Now apply the clean template」→ 只做 `read` 把剛寫的 payload 讀回來。
3. **turn C**：narrate「Now apply the clean template」→ 只做 `bash` 驗證 JSON valid。
4. **turn D**：narrate「Now apply the clean template」→ 只做 `bash` 把 JSON 重新 compact 成一行。

**從沒呼叫那一個決定性的 `docxmcp_pptx_template(action=apply)`。** 每個 turn 的開場敘述幾乎相同（「Now apply the clean template / I have the payload」），尾巴掛一個不同的、對同一個 artifact 的**唯讀或無語意推進**的微動作。runtime 在第 3 次重複後 hard-halt（"Loop halted: 3 consecutive turns repeated the same narrative EVEN AFTER a recovery nudge"）。

---

## RCA

### 為什麼 6-15 的 fix 沒擋住「進入」

6-15 fix（commit `49480bdbd`）做了兩件事：
- **Detector D `detectPrefaceParalysis`**：前 ~140 字 jaccard > 0.6 **且**最近 3 turn 無 file-mutating tool（write/edit/multiedit/apply_patch）才算 paralysis。
- **progress-gated clean-streak**：只有真正 mutate 檔案的 turn 才給 streak credit。

這次它**確實生效並 halt 了**——所以 fix 本身沒壞。問題在**偵測延遲**與**判進度的粒度**：

**缺陷 C — 「mutation = progress」太粗，備料動作被誤判為真進度。**
turn A 的 `write deck_payload.json` 是一次合法 mutation → 給了 streak credit / 重置偵測窗。但它其實是**進入空轉前的最後一次真動作**；之後 B/C/D 全在繞著「這個剛寫好的 payload」打轉（read 它、validate 它、reformat 它），沒有任何**朝目標推進**的新 mutation。Detector D 的「最近 3 turn 無 mutating tool」條件因為 turn A 的 write 落在窗內而**被滿足成『有進度』**，延後了偵測，直到窗滑過才觸發 halt。

→ 核心：**「寫了一個檔」≠「朝完成推進」**。對「同一個剛產生的 artifact 反覆做唯讀/格式化動作」這種 preparation theater，mutation-based progress gate 會給假信用。

**缺陷 D — detector 看不到「決定性下一步已備妥卻不發射」。**
模型自己的 narration 每輪都精準宣告了下一步（「Now apply the clean template」），payload 也早在 turn A 就備妥、turn C 已驗證 valid。**該發射的 tool（`docxmcp_pptx_template action=apply`）的所有前置條件都滿足了，模型卻持續用備料動作拖延。** 沒有任何 detector 訊號捕捉「intent stated + inputs ready + 決定性 call 缺席 N turn」這個型態。

### 行為層根因（非 runtime，但同源）

這是 LLM 的 **action-deferral / 完美主義備料**傾向：對一個「有點重」的 tool call（apply 會真的產生 src package，是不可逆的具體產出），模型傾向反覆確認輸入（讀回、驗證、reformat），把「準備」當成「進展」。narration 真誠地相信自己下一步要 apply，但每個 turn 都先插一個「再確認一下輸入」的安全動作 → 無限備料。

與母案的差異：
- 母案 = **固定開場白 + 變動微讀**（純 read 不同 offset）。
- 本案 = **固定開場白 + 對同一新生 artifact 的備料動作**（read→validate→reformat），其中夾了一次真 write 給了假進度信用。

---

## 影響範圍

- 任何「下一步是一個較重/不可逆的 generation tool call」的流程（pptx apply、docx assemble、emit_fab、render…），模型可能陷入「反覆備料同一輸入」的空轉。
- 6-15 的 mutation-based progress gate 對「先 write 一個輸入檔，再對它反覆唯讀備料」型態會給假信用、延後 halt。
- halt 有效但**事後**——使用者仍看到 3 turn 空轉並需手動介入。

---

## 建議修法（方向，未實作；主 loop 敏感，待範圍確認）

1. **缺陷 C：progress 不只看「有沒有 mutate 檔」，要看「mutate 的是不是同一個剛碰過的 artifact」。**
   - 對「最近 N turn 的 tool target（檔名/路徑/artifact id）」做去重。若連續 turn 的 tool 全部命中**同一個 target 集合**且無新 target 出現 → 視為「原地打轉」，不給 progress credit，即使其中有 write/edit。
   - 或更簡單：mutation credit 只在「新檔被建立 or 既有檔內容實質變更」時給；對「讀回 / 純格式化（內容語意不變）」不給。turn D 的 reformat（JSON 內容等價、只換排版）正是該被識破的。

2. **缺陷 D：新增「stated-next-action not executed」偵測訊號。**
   - 若模型 narration 跨 N turn 重複宣告同一個**具名 tool/動作**（「apply the template」「assemble」「render」），而該 tool **實際從未在這 N turn 內被呼叫** → 旗標。
   - 這與母案的「開場 n-gram 重複」正交：母案抓字面複誦，本案抓「宣告的決定性動作缺席」。可用「narration 提及的 tool 名」vs「實際 call 的 tool 名」差集偵測。

3. **行為層緩解（prompt 側，可較快落地）：**
   - 在 paralysis nudge 文案加一條具體指令：「若你已連續宣告同一個下一步動作，**這個 turn 必須直接呼叫該 tool**，不得再做任何『準備/驗證/讀回輸入』的前置動作。輸入不完美也先發射，失敗再修。」
   - 對「重 generation tool」明示：備料上限 1 次（驗證一次即發射），不得反覆確認同一輸入。

---

## 待辦 / 開放問題

- [ ] 確認 6-15 Detector D 的偵測窗計算：turn A 的 write 是否確實落在窗內、延後了 B/C/D 的偵測（需看現場 round telemetry `anomalyFlags` 與 `paralysisCleanStreak` log）。
- [ ] 缺陷 C：progress credit 是否該排除「same-target 唯讀/格式化」——範圍與誤判風險（合法的 read-then-edit 流程不能被誤殺）。
- [ ] 缺陷 D：「stated-next-action vs executed-tool 差集」detector 的 pure helper + 單元測試。
- [ ] 與母案 fix 合併防線，避免兩套 detector 重疊誤判。
- [ ] 復現：是否只在「下一步是重 generation tool」時觸發？輕量 tool（如下一步是 edit）會不會也誘發？
