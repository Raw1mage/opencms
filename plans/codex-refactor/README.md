# Codex Provider Refactor — Plan Root

## 施工圖

- **[datasheet.md](datasheet.md)** — 完整 protocol 規格書（唯一施工圖）
- **[golden-request.json](golden-request.json)** — 舊 provider 實際 WS request dump（唯一真相來源）
- **[proposal.md](proposal.md)** — 原始需求與修訂歷史
- **[design.md](design.md)** — 架構設計決策
- **[implementation-spec.md](implementation-spec.md)** — 實作規格
- **[tasks.md](tasks.md)** — 任務追蹤
- **[handoff.md](handoff.md)** — 交接指引

## 參考資料（從 /specs/codex 搬入）

- **[specs/protocol/](specs/protocol/)** — Codex protocol whitepaper + IDEF0/Grafcet + AI SDK layer decomposition
- **[specs/websocket/](specs/websocket/)** — WS transport adapter spec
- **[specs/provider_runtime/](specs/provider_runtime/)** — Provider runtime strategy
- **[specs/continuation-reset/](specs/continuation-reset/)** — Continuation flush trigger model
- **[specs/incremental_delta/](specs/incremental_delta/)** — Incremental delta preservation

## 原則

1. **任何格式轉換都必須對照 golden-request.json 驗證**，不可憑 type definition 推導
2. **datasheet.md 是程式的 1:1 映射**，改程式必須同步改 datasheet
3. **specs/ 下的文件是歷史參考**，不是施工圖
