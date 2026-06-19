# BUG: dispatcher 去重靜默吞掉 side-effecting 工具呼叫(誤導 caller debug)

- **Date**: 2026-06-19
- **Reporter**: TheSmartAI (orchestrator)
- **Target**: opencode runtime —— tool dispatcher 的 duplicate-call 去重層
- **Severity**: medium-high —— 不報錯、不阻斷,但**靜默改變語意**,使 caller 往錯方向 debug
- **Relates to**: SYSTEM.md §6 "Avoid duplicate tool calls";docxmcp BR `issue_20260619_pptx_addshape_native_shape_friction.md` 的 F3 歸因更正
- **Status**: RESOLVED (2026-06-19) —— D1 採行(放寬 dedup,mutating 呼叫一律放行)。MCP 側已由 closed BR `bug_20260619_dispatcher_dedup_short_circuits_forced_rebuild.md` 修好(只 readOnly/idempotent 才去重);本次補完 **native 側**:`isDedupEligible` 對 native `modify`-kind 工具(edit/write/multiedit/...)回 false → 重跑而非 stale reuse。唯一例外 `apply_patch` 保留去重(rotation/retry 重複套 patch 防護,closed BR `bug_20260529`)。決策動機:工具跳針(perseveration)機率已大幅下降,blanket native dedup 的防呆價值低於它吞 side-effecting 呼叫的損害。落點:`packages/opencode/src/tool/tool.ts`(`isDedupEligible` + `DEDUP_KEPT_MODIFY_TOOLS`)。測試:`tool.dedup-eligible.test.ts`(31 pass)。

---

## 1. Summary

dispatcher 對相同 `(tool_name, args)` 的工具呼叫做去重短路,回傳 `[already executed — reusing result]` 而**不實際送達該工具**。這對純查詢(idempotent read)是合理優化,但對**語意上有副作用 / 強制重建**的呼叫是錯的 —— 它會靜默吞掉這次操作,讓 caller 以為操作生效了,實際上沒有。

實證觸發:`docxmcp_pptx_bootstrap(out_dir=X, overwrite=true, title=同前)` 第二次以相同 args 呼叫時被去重,回 `[already executed — reusing result]`,**slide 沒有被重置**。caller(我)在一輪 pptx 從零生成的 debug 裡,把這個「殘留 shape」誤判成 docxmcp `bootstrap` 自己的 dedup short-circuit,寫進了 docxmcp BR 的 F3,並提出對 docxmcp 的改良請求(R3)。

事後乾淨重測證明:**真因在 opencode dispatcher,不在 docxmcp**。當 `overwrite=true` 以不同 args 真的送達 docxmcp 時,slide 正確被清空。R3 已撤回。

---

## 2. 因果鏈 + 證據

### 觸發條件

1. caller 呼叫 `pptx_bootstrap(out_dir=verify_probe, overwrite=true, title="F3 reset test")` —— ok。
2. caller 加入一個 marker shape。
3. caller **以完全相同 args** 再次呼叫 `pptx_bootstrap(out_dir=verify_probe, overwrite=true, title="F3 reset test")` —— 預期:強制重建,marker 消失。

### 觀察

- 第 3 步回傳 `[already executed — reusing result]`。
- `pptx_read action=shapes` 顯示 marker **仍在**(slide 未重置)。
- 改用**不同 title**(`F3-unique-title-alpha-9271`)呼叫 → 真送達 docxmcp → marker **被清空**(只剩 base placeholder)。

### 證據區分(關鍵)

- docxmcp 的 `bootstrap overwrite=true` 行為**正確**:真送達時確實重置。
- 失敗只發生在「相同 args 第二次呼叫」—— 這是 dispatcher 去重層的特徵,不是 docxmcp 的。
- 即 `[already executed — reusing result]` 這條訊息本身就是 opencode 端產生的,不是 docxmcp 的回傳。

---

## 3. 為何這是「沉默誤導」型缺陷

```
side-effecting call (overwrite=true / force-rebuild 語意)
   → dispatcher 視為 idempotent,去重短路
   → 不送達工具、不報錯、回 "reusing result"(看起來像成功)
   → caller 以為操作生效
   → 後續狀態與預期不符(殘留 shape)
   → caller 往「工具有 bug」方向 debug(本案:誤寫 docxmcp F3 + R3)
```

最傷的點:**失敗訊號(殘留狀態)與真因(去重沒送達)距離很遠**,且回傳字面是「成功重用」,沒有任何「這次被去重了」的旗標。caller 無從區分「工具執行後結果就長這樣」與「工具根本沒被呼叫」。

---

## 4. 改良請求(對 opencode dispatcher)

| ID  | 請求                                                                                                                                                | 理由                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| D1  | **去重不得套用於語意上 mutating / force 的工具呼叫**。判定來源:工具 schema 的副作用標註,或 args 含 `overwrite/force/reset` 等強制語意旗標時一律放行 | 根治:side-effecting 呼叫本來就預期可重複且每次都要真執行 |
| D2  | 若仍要去重,被去重的呼叫**必須回明確旗標**(如 `deduped:true` / `reused:true`),讓 caller 知道「這次沒真送達」                                         | 至少把「沉默」變「可觀測」,caller 能正確判讀             |
| D3  | `[already executed — reusing result]` 訊息應附上**原始呼叫的識別**(哪一次、何時),便於 caller 對齊                                                   | 降低 debug 誤導                                          |

優先序:**D1 > D2 > D3**(D1 根治,D2 是最低限度的可觀測性兜底)。

---

## 5. caller 端紀律(自省)

- 對 side-effecting 呼叫(bootstrap/reset/force),若需重複觸發,**刻意變動一個無害 arg**(如 title)以繞過去重 —— 本案最終靠此確認真因。
- 看到 `[already executed — reusing result]` 時,不得假設操作生效;對 mutating 呼叫應額外讀回狀態確認。
- 把「工具沒生效」與「工具生效後結果如此」當成兩個獨立假設分別驗證,不要預設是工具 bug。

---

## 6. 修復後重測 + 精準 RCA(2026-06-19,daemon restart 後)— REOPEN 候選

維護者已修(commit `f46636f4`,daemon 重啟撿到新 code),但**重測仍復現** —— 修復的判定條件漏接了 docxmcp 實際使用的 annotation。

### 重測證據
- 新包 `dedup_fix_postrestart`(overwrite=true)→ 加 marker → 相同 args 再 bootstrap → 仍 `[already executed — reusing result]`、**無 deduped 旗標**、marker 仍在(讀回 shape id 3 still alive)。
- daemon git HEAD `f46636f4`(20:30:45)、daemon 啟動 20:31:31 → 確實跑新 code,排除「沒部署」。
- 對照:不同 args 的 overwrite=true 真送達 → marker 被清空。⟹ `isDedupEligible("docxmcp_pptx_bootstrap")` 運行時回了 **true**。

### 真因:`idempotentHint` 被誤當成 dedup-safe
- `tool.ts:254` `isDedupEligible` 的 MCP 分支:
  ```ts
  return hints.readOnlyHint === true || hints.idempotentHint === true
  ```
- docxmcp 給 `pptx_bootstrap` 標的 annotation(`docxmcp/bin/_mcp_registry.py:2353`):
  ```py
  annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}
  ```
- → `false || true` = **true** = 判定可去重 → 仍被短路。修復只放行了 native modify 工具(`kind==="modify"`),MCP 分支保留的 `|| idempotentHint===true` 就是漏網點。

### 為何 idempotent ≠ 可去重(HTTP 動詞語意)
| hint | 語意 | 可去重? |
|------|------|---------|
| readOnly(GET) | 不改狀態 | ✅ |
| idempotent(PUT) | **重跑會改狀態,只是最終態相同** | ❌ |

`bootstrap(overwrite=true)` 是 PUT 語意:重跑確實 idempotent(最終都是乾淨 package),docxmcp 標 `idempotentHint:True` **語意正確**。但 PUT 冪等 ≠ 可快取 —— 中間若狀態被改(加了 marker),PUT 仍須**真正執行**才能回到目標態。把 idempotent 當「可省略重跑」是 HTTP 語意混淆。

### 補強請求(D4,接續 D1)
- `isDedupEligible` 的 MCP 分支應**移除 `|| hints.idempotentHint === true`**,只認 `readOnlyHint === true`。理由:idempotent 的契約是「最終態相同」,不是「可省略」;唯有 readOnly 才真正無副作用、可安全 reuse。
- 測試補洞:`tool.dedup-eligible.test.ts:46` 用虛構的 `{destructiveHint:true}` 斷言 bootstrap 不 eligible,但真實 docxmcp 標的是 `idempotentHint:true` → 測試覆蓋不到真實 annotation。應補一個 `{readOnlyHint:false, idempotentHint:true}` → 期望 **false** 的 case(目前實作會回 true,測試會抓到回歸)。

### 建議
此 BR 從 `closed/` **reopen**:D1 的 native 半邊已修,但 MCP 半邊(idempotent clause)仍讓 side-effecting MCP 工具被靜默去重。
