# Event: MCP 管理層重構 — App 擴充性標準化 (mcp-separation)

## 日期
2026-04-06

## 需求演進

### 初始需求
盤點 MCP Apps 架構分離程度。

### 最終需求
MCP 管理層完整重構：標準化檔案包 → 統一生命週期 → 對話驅動供應鏈 → 內建 App 統一化。

## 關鍵決策

| DD | 決策 |
|----|------|
| DD-1 | App 預設關閉，AI 自行判斷何時啟動 |
| DD-2 | 安裝目錄：`/opt/opencode-apps/` |
| DD-3 | mcp-apps.json 兩層（系統 + 使用者），系統優先 |
| DD-4 | 建立 opencode 系統帳號做檔案歸屬隔離，gateway 保持 root |
| DD-5 | Gmail/Calendar 用 `bun build --compile` 產生零依賴 binary |
| DD-6 | 交付範圍 Step 0-6 全做 |

## 架構

四層 + Foundation：
- **Foundation**: opencode 系統帳號（檔案歸屬隔離）+ gateway API 代寫
- **Layer 0**: 硬編碼拆離（BUILTIN_CATALOG）
- **Layer 1**: 檔案包規格（mcp.json manifest）
- **Layer 2**: Registry & Lifecycle（mcp-apps.json + Admin UI）
- **Layer 3**: Conversational Provisioning（system-manager install_mcp_app）

## 計畫位置
`plans/mcp-separation/`

## 狀態
設計完成，所有決策已確認，待實作（Step 0 起）
