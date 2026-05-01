# system-manager DB dialog refactor

## Requirement

使用者要求在 session persistence 已全面改為 DB 後，重構 system-manager 相關 tools，讓 session dialog 讀取改以 DB 內的 session/message 資料為單一真實來源。

## Scope

IN:

- `packages/mcp/system-manager` 中與 session list/search/read/subsession/dialog 相關工具的讀取路徑。
- 對應 focused tests。
- 本次任務 event log 與 architecture sync 記錄。

OUT:

- 不改 daemon/gateway lifecycle。
- 不新增 fallback mechanism；找不到 DB/session 資料時應 fail fast 或回傳明確空結果語意。
- 不改 provider/account rotation 行為。

## Constraints

- DB session/message stream 是 dialog 讀取 SSOT。
- 不用舊檔案掃描或 silent fallback 掩蓋 DB 讀取失敗。
- 遵守既有 Bus / Instance / SharedContext infrastructure，不自製 polling 或跨層狀態同步。
