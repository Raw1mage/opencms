# Errors: prompt-cache-and-compaction-hardening

## Error Catalogue

每個錯誤碼必含：使用者可見訊息、復原策略、責任層、telemetry 標籤。

## E-CROSS-ACCOUNT-REBIND-FAILED

| 欄位 | 值 |
|---|---|
| **Code** | `CROSS_ACCOUNT_REBIND_FAILED` |
| **Source** | `capability-layer.ts` (DD-8, [data-schema.json CrossAccountRebindError](./data-schema.json)) |
| **Layer** | session/capability |
| **Throw site** | `CapabilityLayer.get` 在 fallback entry account 與 requested account 不符時 |
| **User-visible message** | "切換 provider 時 capability 重新載入失敗（從 {from} 換到 {to}）。請重試或檢查 account 設定。" |
| **Recovery** | (1) runloop 顯示訊息給使用者；(2) 不發送任何 LLM 請求；(3) 保留 RebindEpoch 已 bump 的狀態，下次 user retry 重新嘗試 reinject |
| **Why hard-fail** | 用上個 account 的 BIOS 跑新 account 是正確性問題（auth header / quota / model 限制都錯）。對齊 [feedback_no_silent_fallback](../../.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_no_silent_fallback.md) |
| **Telemetry** | `capability_layer.cross_account_rebind_failed { from, to, failures: [...] }` |

## W-IDLE-COMPACTION-DEFERRED

不算 error，是 deferred warning — 但 telemetry 與處理都遵循 error contract。

| 欄位 | 值 |
|---|---|
| **Code** | （無 throw；emit telemetry only） |
| **Source** | `compaction.ts idleCompaction` (DD-7) |
| **Layer** | session/compaction |
| **Trigger** | `checkCleanTail(messages, N=2)` 回 `{clean:false}` |
| **User-visible** | 預設不顯示（內部訊號）；debug log 印 `compaction.idle.deferred {reason, scannedMessageCount}` |
| **Recovery** | 自然：下次 idleCompaction tick（subagent settle 完成、tool_result 寫入後）會重新評估 |
| **Telemetry** | `compaction.idle.deferred { reason, scannedMessageCount }` |
| **Reasons** | `unmatched tool_use {id}` ｜ `multiple unmatched tool_use [{id1}, {id2}]` |

## W-CACHE-MISS-DIAGNOSIS

也不算 error；是 diagnosis 結果。

| 欄位 | 值 |
|---|---|
| **Source** | `compaction.ts shouldCacheAwareCompact` (DD-10) |
| **Layer** | session/compaction |
| **User-visible** | 無 |
| **Telemetry** | `compaction.cache_miss_diagnosis { kind, lastSystemHashes, conversationTailTokens }` |
| **Possible kinds** | `system-prefix-churn` (略過 compaction) ｜ `conversation-growth` (執行 compaction) ｜ `neither` (略過) |
| **Operator action** | `system-prefix-churn` 持續出現代表 system block 在 session 中頻繁變動（AGENTS.md / SYSTEM.md 改、cwd 跳）— 看是不是有人在編 SYSTEM.md 或 AGENTS.md 過程中操作 session |

## E-PLUGIN-CONTEXT-TRANSFORM-FAILED

| 欄位 | 值 |
|---|---|
| **Code** | `PLUGIN_CONTEXT_TRANSFORM_FAILED` |
| **Source** | `plugin/index.ts` 觸發 `experimental.chat.context.transform` 時 plugin 拋例外 |
| **Layer** | session/plugin |
| **Throw site** | hook 呼叫 wrapper |
| **User-visible message** | "Plugin '{plugin-name}' 在改 context preface 時失敗：{error}。已忽略 plugin 的修改，繼續執行。" |
| **Recovery** | 不阻擋 LLM 呼叫；丟棄該 plugin 對 preface 的修改；繼續用 unmodified preface |
| **Why soft-fail (vs cross-account)** | plugin 是 optional 擴充；它失敗不應該阻止主流程，與「正確性 vs 擴充性」的取捨一致 |
| **Telemetry** | `plugin.context_transform.failed { pluginName, error }` |

## W-LEGACY-DYNAMIC-IN-SYSTEM-HOOK

| 欄位 | 值 |
|---|---|
| **Source** | `plugin/index.ts` 偵測到 `experimental.chat.system.transform` 注入了非 static 內容 |
| **Layer** | session/plugin |
| **User-visible** | 無；console WARN 給 plugin 開發者 |
| **Telemetry** | `plugin.legacy_dynamic_injection_warn { pluginName, sample: '...' }` |
| **Behavior** | 一個 release 內：注入仍生效（兼容期）；下個 release：silent drop |
| **Migration message** | "Plugin '{name}' injected dynamic content via experimental.chat.system.transform. This will stop working next release. Migrate to experimental.chat.context.transform." |

## E-ANCHOR-SANITIZE-FAILED

| 欄位 | 值 |
|---|---|
| **Code** | `ANCHOR_SANITIZE_FAILED` |
| **Source** | `anchor-sanitizer.ts` (DD-6) — 理論上不該發生，是 defensive |
| **Layer** | session/compaction |
| **Throw site** | `sanitizeAnchor` 內部不可能失敗（純字串處理），這個 code 保留給 schema 驗證或未來擴充 |
| **User-visible** | 無 |
| **Recovery** | fall back 到原 raw text + WARN log（暫時容許未經 sanitize 的 anchor 寫入，避免 compaction 整體掛）— 但同時 emit 高優先 telemetry 讓 ops 注意 |
| **Telemetry** | `compaction.anchor.sanitize_failed { kind, error }` |

## Error budget / SLO

| Error | 容忍度 | 警報 |
|---|---|---|
| `CROSS_ACCOUNT_REBIND_FAILED` | 預期罕見（< 1/天/session）；多了表示 loader 或 account 設定有問題 | 同 session 連 3 次 → page |
| `compaction.idle.deferred` | < 5% 的 idle 評估次數 | 持續 > 20% → 看 task dispatch / subagent settle 路徑 |
| `cache_miss_diagnosis.kind=system-prefix-churn` | < 10% | 持續 > 30% → 看是不是 SYSTEM.md / AGENTS.md 被頻繁改 |
| `plugin.context_transform.failed` | < 0.1% 的 turn | 任何單一 plugin 一天 > 10 次 → 通知 plugin 作者 |
| `compaction.anchor.sanitize_failed` | 0（理論上） | 任何 1 次都告警 |
