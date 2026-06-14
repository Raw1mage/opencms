# Issues — 三態生命週期

本目錄用**子目錄位置**表示 issue 的生命週期狀態,單一真實來源。每個 issue 檔頭部的 `Status:` 行記錄細節,但**權威狀態由它所在的目錄決定**。

## 三態

| 位置 | 狀態 | 意義 | 進入條件 | 離開條件 |
|---|---|---|---|---|
| `issues/*.md`(root) | **open** | 未解 / 偵查中 / 修復未完成 | 新回報;或從 observing 退回(復發+新 root cause) | 修復完成且部署+驗證 → `observing/`;判定非缺陷 → `closed/` |
| `issues/observing/` | **observing** | 修復已部署+即時行為驗證通過,但**待 soak 觀察**確認無復發 | root cause 確認 + fix commit + 部署 + 即時驗證(log/journal 無復發訊號) | soak 數日無復發 → `closed/`;復發且查得新 root cause → 退回 root(open) |
| `issues/closed/` | **closed** | 已徹底結案 | observing soak 通過;或判定為環境/跨 repo/非缺陷 | (終態) |

## 為何需要 `observing` 中間態

「修復已部署」≠「問題已根除」。部署當下的行為驗證(例如「部署後 N 分鐘 0 復發」)只證明**即時**生效,無法涵蓋:

- 偶發性故障(需更長時間窗才會再現)
- 與使用者特定使用模式相關的觸發條件(大 prompt-cache、長 session、特定 provider 組合)
- 多個並存真因中可能還有未發現的第三因

把這類 issue 直接丟 `closed/` 會喪失「待觀察」的訊號,復發時也難追溯。`observing/` 讓「已修但待確認」與「已徹底結案」物理分離。

## 每個 issue 檔的 Status 行慣例

- **open**:`Status: <偵查/修復進度>`
- **observing**:`Status: OBSERVING — <真因+fix commit+部署驗證摘要>` + `Observing since:` + `Exit → closed/` 條件 + `Regress → open` 條件
- **closed**:`Status: CLOSED — <最終處置>`(或保留結案時的摘要)

## 注意

- `issues/` 整個目錄 gitignore(本地留痕),用 `mv` 移動,非 `git mv`。
- 移動 issue 時務必同步更新檔內 `Status:` 行,避免目錄位置與檔頭不一致。
