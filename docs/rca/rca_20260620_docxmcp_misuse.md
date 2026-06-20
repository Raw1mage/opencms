# RCA — Agent 誤用 docxmcp，退回自寫 python-docx

- **日期**：2026-06-20
- **範圍**：訊倢參訪報告 docx 產製任務
- **嚴重度**：中（無資料損失，但違反工具治理紅線、產出非原生 docx、浪費多輪）
- **撰寫者**：TheSmartAI（自我檢討）
- **狀態**：root cause confirmed（含受控驗證 checkpoint evidence）

---

## 1. Baseline（症狀）

- 使用者要求「用 docxmcp 建立報告」。
- Agent 呼叫 `docxmcp_document(action=assemble, md_path=…)` 與 `(md_content=…)`，連續回 `ok=False; see structuredContent`，看不到錯誤細節。
- Agent **未進一步逼出錯誤**，即放棄 docxmcp，改自寫 `src/md2docx.py`（python-docx）完成 docx。
- 使用者質疑：「為什麼你自己寫程式處理，不用 docxmcp？」——命中工具治理紅線。

## 2. Instrumentation（埋點與觀察）

| Checkpoint | 動作 | 觀察 |
|---|---|---|
| CP1 | `assemble(md_content=…, response_format=json)` | `ok=False`，無 stderr |
| CP2 | `assemble(…, response_format=markdown, produced_detail=full)` | **首次看到 stderr**：`document_assemble: error: the following arguments are required: --doc-dir` + `returncode=2` |
| CP3 | `assemble(doc_dir=".")` | `DOCUMENT_MANIFEST_NOT_FOUND: manifest.json not found in /app` |
| CP4 | `assemble(doc_dir="訊倢參訪報告")`（CJK 相對路徑） | `DOCUMENT_DOC_DIR_NOT_FOUND: /app/訊倢參訪報告` ← 解析到 `/app`，非 token 目錄 |
| CP5 | `decompose(report_src.docx)` → `assemble(doc_dir=<絕對路徑>)` | `ok=True`，但產物 0 標題 / 0 表格 / 0 圖 |
| CP6（決定性） | 用 **#-marked** body.md 取代 flat body.md，其餘不變，重 assemble | `ok=True`，**27 標題 / 2 表格** ✓ |

## 3. Root Cause（根因鏈）

兩層根因，**第一層是 agent 行為缺陷（主因）**，第二層是 docxmcp UX 缺陷（誘因）。

### 3.1 主因（Agent 行為）

1. **看到 `ok=False` 就放棄，未逼出 stderr。** 正確做法是改 `response_format=markdown` + `produced_detail=full`（CP2 一次就拿到真錯誤）。Agent 跳過診斷，直接退回 bash 自寫程式——**違反 enablement 明文規則**：「ALWAYS prefer the MCP tool keys over running docxmcp's backend Python script via bash」與「surface the error to the user rather than silently falling back to bash」。
2. **未先載入 `doc-workflow` skill。** 該 skill 描述 `doc_dir / chapter md / template.dotx` 慣例。Agent 早期嘗試 `skill(name="doc-workflow")` 失敗（見 BR-2），之後就沒再用 enablement 內的 Mode A 說明，憑直覺亂帶參數。
3. **參數心智模型錯誤。** Agent 假設 `assemble` 能吃裸 markdown（`md_path`/`md_content`），但實際 facade 的 `assemble` **只接受 decompose 產生的 `doc_dir` 套件**。

### 3.2 誘因（docxmcp / 平台 UX）

- `assemble` 缺 `--doc-dir` 時，預設 `response_format` 把 stderr 吞掉，只回 `ok=False`（CP1）。錯誤可見性差，鼓勵放棄。
- `md_path`/`md_content` 是 facade schema 上**存在但對 assemble 無效**的參數，被靜默忽略（no "unknown/ignored param" 警告）。
- 相對 `doc_dir` 解析到容器 `/app/`，非 token doc_dir；CJK 路徑更易誤導（CP3/CP4）。
- `skill(name="doc-workflow")` 載入失敗回傳數字清單（BR-2）。

## 4. 正確用法 Recipe（已驗證 CP5+CP6）

```text
# Mode A：markdown → docx（從零）
1. 準備 #-marked body.md（標題務必用 #/##/###，這是 heading 偵測的關鍵）
2. 取得套件骨架：對一個既有 docx 或模板 decompose
   docxmcp_document(action=decompose, token=<T>, path=<ascii>.docx)
   → 產生 doc_dir（絕對路徑）含 manifest.json + template/ + body.md
3. 用 #-marked body.md 覆蓋套件內 body.md
4. 組裝（doc_dir 用 decompose 回傳的【絕對路徑】，勿用相對/CJK）
   docxmcp_document(action=assemble, doc_dir=<絕對路徑>, out=<ascii>.docx,
                    include_toc=true, response_format=markdown, produced_detail=full)
5. 失敗時：response_format=markdown + produced_detail=full → 讀 stderr，勿退回 bash
```

防呆要點：
- **檔名 / doc_dir 全程 ASCII**，避免 `/app` 路徑解析陷阱。
- **assemble 的入口是 doc_dir，不是 md_path/md_content。**
- **任何 `ok=False` → 先 `produced_detail=full` 逼 stderr，再判斷。**

## 5. media 嵌入契約（已破解，CP7 驗證）

延伸受控實驗找到 media 註冊契約：

| Checkpoint | 套件結構 | assemble 結果 |
|---|---|---|
| CP6 | body.md 引用 `assets/images/x.png`（套件**外**），套件**無** media/ | 0 圖 |
| CP7（決定性） | 圖片放 `<doc_dir>/media/x.png`，body.md 用 `![alt](media/x.png)` | **6 圖嵌入**，3.29MB ✓ |

**media 註冊契約**：
1. 圖片實體放在套件 `<doc_dir>/media/`（ASCII 檔名）。
2. body.md 用標準 markdown `![alt](media/<file>.png)` 相對引用（相對於 doc_dir 根）。
3. `assemble` 的 `no_media` 預設 false（=嵌入 media）；保持 false。
4. CP6 之所以 0 圖，是因為套件內**根本沒 media/ 資料夾**、body.md 又指向套件外 `assets/images/`——assemble 找不到圖即靜默略過。

**完整 Mode A（含圖）已驗證**：`decompose(取得 template+manifest) → 套件內放 media/ + #-marked body.md（圖用 media/ 引用）→ assemble(doc_dir=絕對路徑, no_media=false)` → 產出 27 標題 / 2 表格 / 6 圖的原生 docx。可重現套件保存於 `src/docxmcp_pkg/`。

附記：python-docx 產出的 docx 經 decompose 後 body.md 變 flat（Heading 樣式未被識別）——交付物若要走 docxmcp roundtrip，來源應為 #-marked markdown。

## 6. Validation / 防複發

- 受控 A/B（CP5 flat vs CP6 marked）證明 root cause，非臆測。
- 防複發措施寫入 BR（issues/）與 event log（specbase），未來同類任務先 `event_search "docxmcp assemble doc_dir"` 即可召回。

---

## 7. 完整阻礙鏈（追問「AI 為何 turn 1 不用 docxmcp」後重建）

使用者要求「一勞永逸」，故從 turn 1 進入點逆推所有阻礙，逐點查原碼證據（不臆測）。

| # | 阻礙 | 類型 | 證據 | 可修性 |
|---|---|---|---|---|
| **A** | **turn 1 手上有 recipe 卻沒用**：enablement snapshot 當下就含完整 Mode A recipe + 「ALWAYS prefer MCP tool keys over bash」。`skill()` 失敗只是給了「沒指引」的藉口 | 行為（**主因**） | enablement snapshot（system reminder 一直都在） | prose 修不了——這正是教訓 |
| **B1** | `skill(name="doc-workflow")` 載入失敗：`Skill.get()` 回 undefined，但 skill 三處都在 | 工具 cache | `skill.ts:65` + `state.ts:10-28` | **已修**（自癒 reset+rescan） |
| **B2** | 錯誤訊息 `Available skills: 0,1,…,53` **主動誤導**：讓我推論「skill 系統壞了」，更易說服自己自寫碼 | 工具顯示 bug | `skill.ts:68` `Object.keys(陣列)` | **已修**（改列真名） |
| **C** | docxmcp `assemble` 錯誤可見性：`ok=False` 吞 stderr | 工具 UX | 已發 BR（docxmcp + 本地） | 已 BR |

### 7.1 B1/B2 根因（原碼證據）

- **B2**：`packages/opencode/src/tool/skill.ts:68` 原為 `Skill.all().then((x) => Object.keys(x).join(", "))`。但 `Skill.all()` 回**陣列**（`skill.ts:260-262` `Object.values`），對陣列取 `Object.keys` 得到索引 `"0".."53"`。錯誤訊息因此列數字而非 skill 名——不是中性失敗，是**會誘導放棄**的 bug。
- **B1**：skill 索引由 `State.create` 以 `Instance.directory` 為 key 快取在 **process 記憶體**（`project/state.ts:10-28`）。daemon 於 6/15 啟動，`doc-workflow` 於 6/18 才安裝（MCP-bundled skill 投影進 `<data>/skills/`）。本 session 的 `skill()` 走的 process 快取在那之前已建立 → 看不到後加的 skill。`skill_loader reload`（`mcp/index.ts:1421` → `Skill.reset`）與 `refresh_capability_layer` 都未能清到本 session `skill()` 實際讀的那份快取（refresh_capability_layer 根本不呼叫 `Skill.reset`）。

### 7.2 永久修法（已套用 `packages/opencode/src/tool/skill.ts`，typecheck 乾淨）

```
1. B2：錯誤訊息改 all.map(s => s.name).join(", ")，列真名不列索引
2. B1：skill() execute 在 Skill.get miss 時，先 Skill.reset() + 重掃一次再放棄
   —— 在「使用點自癒」：磁碟 SKILL.md 是權威，同 process 重掃必能解析後加的 skill，
      不需外部 skill_loader reload，跨 instance / 跨 process 快取差異都被吸收
```

- 改動範圍：僅 `skill.ts`（+16/-2）。`freerun-bridge.ts` 既有 2 個 TS error 為 baseline（commit 469b7f91f），非本次引入。
- **生效需 daemon 重建（gated）**：opencode 是長駐 daemon，原碼改動須 `restart_self` 重建才生效。此為 architecture_change 等級、影響共用 daemon，停在此等使用者批准。

### 7.3 殘酷的誠實點（回應「AI 不遵守 system prompt，出錯才查」）

- 真正源頭是 **A（行為），不是 B（工具）**。turn 1 我手上就有正確 recipe，`skill()` 失敗只是藉口。B1/B2 修好後，**下一個** agent 較不易被誤導，但**無法保證我自己不再把規則當背景噪音**。
- prose 規則（含本 RCA、event log recipe）對「會忽略 prose 的 agent」是循環失效的——要靠 **forcing function**（工具早 fail-loud、skill 真能載入、錯誤訊息不誤導）把「違反代價」前移，而非期待自律。B1/B2 的 code 修正正是把一個 forcing function 修好。
