# Proposal

## Why

- 2026-04-01 的大回歸之後，`main` 相對舊 `cms` 強基線仍有約 32~42 commits 規模的殘餘差集。
- 使用者已持續在修復過程中踩到實際回歸，例如 browser tab title / icon branding 已再次退回 `OpenCode`。
- 但不是所有舊 commit 都該直接救回，因為有些功能群已被使用者重做，若盲目恢復舊歷史會覆蓋新工作。

## Original Requirement Wording (Baseline)

- "開一個plan \"restore_missing_commits\"把盤點結果記錄下來變成回復計畫。"
- "但你要用ask question的方式帶我一個一個走過決定要不要回復。"
- "因為有一些功能我已經花時間重做了，就不用再回復。"

## Requirement Revision History

- 2026-04-02 planning kickoff: 使用者要求把 forensic 盤點轉成正式回復計畫，且必須逐題決策是否回復。
- 2026-04-02 decision pass: branding 納入回復；provider manager 視為已重做而跳過；rebind/checkpoint/continuation 納入回復。
- 2026-04-02 clarification pass: 使用者要求先用白話說明 `Claude Native / claude-provider` 與 `user-init / onboarding / marketplace` 的價值，再做決策；兩組最終都納入回復。
- 2026-04-02 scope refinement: `copilot reasoning variants` 與 `llm packet debug / tests` 也納入回復，但仍需 diff-first 分析避免重複回帶。
- 2026-04-02 inventory constraint: 使用者明確要求不得故意忽略剩餘 missing commits；計畫必須保留完整附錄，逐條或逐桶標註是否回復，而不是只留下已核准大桶。
- 2026-04-02 restore safety rule: 使用者明確要求功能回復必須尊重 commit 歷史與主線新演化，不能發生舊功能覆蓋新功能。
- 2026-04-02 supersession rule: 使用者補充每一筆回復都要檢查後續歷史是否已調整改版或推翻舊實作；若有，只能補最後仍缺的部分。
- 2026-04-02 claude-series rule: 使用者明確要求 claude 系列既然曾經 commit 並可用，分析與回復時應以「完整功能恢復」為前提，而不是縮成零碎小修。
- 2026-04-02 ordered-claude-reconstruction rule: 使用者進一步要求 claude 剩餘項應盡量依序理解/重建，還原為最終最新可運作版；若能高信心直接計算出最終樣貌，也可直接復現最終版。
- 2026-04-02 global-ordered-reconstruction rule: 使用者明確要求「依序還原到最終最新可運作版」的原則適用所有 missing commits，不限於 claude。
- 2026-04-02 docs-artifacts rule: 使用者補充此原則同樣適用於 `plans/specs` 等文件，不只功能程式碼。
- 2026-04-02 deprecation-override authority: 使用者授權 assistant 在有充分比較證據時，可判定某些舊功能不應回復、應維持廢棄，因為現有版本更好。

## Effective Requirement Description

1. 建立 `restore_missing_commits` active plan，把 4/1 之後仍殘留的舊 `cms` 差集整理成可執行的恢復計畫。
2. 只回復使用者核准的功能桶，並跳過已重做的 provider manager 差集。
3. 每個恢復桶都必須先做「現況 vs 舊 commit」差異分析，再決定怎麼落回 `main`。
4. 即使某些 commits 暫時不回復，也必須在 plan 中完整列出並標記原因，不能因為不在第一輪大桶裡就被忽略。
5. 功能回復必須保留主線後來的新演化，只能補缺口，不能把舊 commit 形狀整塊壓回來覆蓋新功能。
6. 每一筆功能回復都必須檢查其後續 commit 歷史是否已經改版或推翻原始做法；若有 supersession，只能回復最終仍缺的 delta。
7. `claude` 系列既然曾經是可用成果，預設目標是恢復完整能力鏈，只是在技術上以 history-aware / delta-only 方式安全落地。
8. `claude` 剩餘項原則上應依序重建到最終最新可運作版；若可高信心直接算出最終樣貌，允許直接復現最終版，但仍必須保留迭代/覆蓋關係證據。
9. 上述「依序重建到最終最新可運作版」的原則是全域規則，適用所有 remaining commits，而不只 `claude` 系列。
10. 此全域規則也適用於 `plans/specs/docs/events` 等文件工件：目標是恢復到最終最新可讀/可用版，而不是回到某一個中間舊版。
11. 若比較後能證明最新 `HEAD` 的現有方案在能力、可維護性、整合度或體驗上更好，assistant 可判定舊功能維持廢棄而不回復，但必須在 plan/event 中留下明確理由與證據。

## Scope

### IN

- branding/browser-tab 回復
- rebind / checkpoint / continuation / session hardening
- GitHub Copilot reasoning variants
- `llm packet debug / tests`
- `Claude Native / claude-provider`
- `user-init / onboarding / marketplace`
- 差異分析、分 phase 恢復、驗證與 event/documentation 同步

### OUT

- provider manager / `模型提供者` 舊 commit 回復
- 無差別整批 cherry-pick 32~42 commits
- 覆蓋使用者已重做的新實作
- destructive git 歷史修復
- 在 plan 中靜默遺漏剩餘 missing commits

## Non-Goals

- 不追求把舊 `cms` 歷史一字不漏直接搬回來；但會完整盤點並標記每一批遺失 commits 的處置狀態。
- 不把所有缺失都視為必須回復的產品需求。
- 不在本計畫中預設修復尚未獲批准的新 bucket。

## Constraints

- 必須用功能桶/產品行為來決定回復，而不是只看 commit 是否存在。
- 若現行主線已有更新版本的等價實作，不能盲目以舊 commit 覆蓋。
- 對使用者而言，白話可理解的功能價值比 commit 技術細節更重要。
- 計畫必須保留完整 missing-commit appendix，避免後續再出現「其實還有東西缺但沒被列進來」的情況。
- 執行時必須尊重新舊 commit 的時間關係與行為差異，優先採用補缺口式 restore，而不是歷史覆寫式 restore。
- 執行時必須檢查每筆舊 commit 在後續歷史中的 supersession 關係，避免把已被後案淘汰的舊設計重新帶回主線。
- `claude` 系列的分析預設不做 scope shrink；若某筆屬於完整能力鏈相依，預設朝完整恢復處理，除非證據顯示主線已有更新等價實作。
- 對 `claude` 剩餘項，規劃優先順序不再以單筆舊→新問答為主，而是以「還原到最終最新可運作版」為總目標來吸收剩餘 commit。
- 對所有 remaining commits，規劃優先順序不再以單筆舊→新問答為主，而是以「還原到最終最新可運作版」為總目標來吸收剩餘 commit。
- 對文件工件也同樣如此：若可高信心整理出最終版文件，可直接沉澱成最終樣貌，不必機械重播每一版 wording。

## What Changes

- 新增一份 selective restore plan，將 missing commits 盤點轉為按桶執行的恢復流程。
- 將每個批准的 bucket 拆為：差異分析、恢復實作、驗證、文件同步。
- 將已跳過、待證明、已重做與未歸桶的 commits 全量記錄在 appendix 與 stop gates，避免執行時又回到「只修已看見的那幾桶」思維。

## Capabilities

### New Capabilities

- selective restore matrix: 讓後續實作可依使用者批准的功能桶逐一恢復，而不是憑歷史直覺亂補。
- decision-aware recovery workflow: 把「已重做」「待分析」「核准回復」正式寫進計畫契約。

### Modified Capabilities

- post-regression recovery: 從先前偏 git forensic 的盤點，升級為一份產品/功能導向的恢復路線圖。

## Impact

- 影響 `plans/20260402_commits/` 內全部執行契約文件。
- 後續將影響 branding、session runtime、provider/native、global init 等程式區域。
- 影響 `docs/events/event_20260401_cms_codex_recovery.md` 的後續驗證與恢復紀錄方式。
