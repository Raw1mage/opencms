# Opencode Docker 部署指南

## 概述

本文件說明如何將 opencode 建置成 Docker 容器並在生產環境中執行。

## 目錄結構

### 本機 config 目錄 (建置時)

執行 `./scripts/sync-config.sh` 後產生：

```
./config/
├── opencode/                  # XDG_CONFIG_HOME/opencode
│   ├── opencode.json          # 主配置檔
│   ├── commands/              # 自訂命令
│   ├── skills/                # Skills
│   ├── bin/                   # 自訂腳本
│   └── antigravity-accounts.json
├── data/                      # XDG_DATA_HOME/opencode
│   ├── accounts.json          # 認證憑證 (多帳號)
│   ├── mcp-auth.json          # MCP OAuth tokens
│   └── ignored-models.json
└── state/                     # XDG_STATE_HOME/opencode
    ├── model.json             # 模型選擇偏好
    ├── model-health.json      # 模型健康狀態
    └── kv.json
```

### 容器內 (執行時)

建置映像檔時，config 會複製到 `/opt/opencode`：

```
/opt/opencode/
├── config/
│   └── opencode/              # 來自 ./config/opencode/
├── data/
│   └── opencode/              # 來自 ./config/data/
├── state/
│   └── opencode/              # 來自 ./config/state/
├── cache/
│   └── opencode/
│       └── models.json        # 模型快照快取
└── logs/                      # 容器日誌
```

## 快速開始

### 1. 初始化目錄

```bash
# 執行設定腳本 (需要 root 權限)
sudo ./scripts/docker-setup.sh
```

### 2. 同步配置文件

將本機的 opencode 配置同步到 `./config/` 目錄：

```bash
# 同步配置 (從 ~/.config/opencode, ~/.local/share/opencode 等)
./scripts/sync-config.sh
```

這會複製以下檔案：

| 來源路徑 | 目標路徑 | 內容 |
|----------|----------|------|
| `~/.config/opencode/` | `./config/opencode/` | opencode.json, commands/, skills/ |
| `~/.local/share/opencode/` | `./config/data/` | accounts.json, mcp-auth.json |
| `~/.local/state/opencode/` | `./config/state/` | model.json, model-health.json |

### 3. 建置映像檔

```bash
# 使用 webctl.sh (自動同步配置並建置)
./webctl.sh build

# 或手動建置
./scripts/sync-config.sh
docker build -f Dockerfile.production -t opencode:latest .
```

### 4. 啟動容器

```bash
# 使用 webctl.sh (建議)
./webctl.sh start

# 或使用 docker-compose
docker-compose -f docker-compose.production.yml --profile web up -d
```

## 配置說明

### 環境變數

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `OPENCODE_DATA_HOME` | `/opt/opencode` | 統一數據根目錄 |
| `OPENCODE_SERVER_PASSWORD` | (空) | Web UI 密碼 |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Web UI 用戶名 |
| `WORKSPACE` | `./workspace` | 工作目錄掛載點 |
| `TZ` | `UTC` | 時區設定 |

### Volume 掛載對應

| 主機路徑 | 容器路徑 | 用途 |
|----------|----------|------|
| `/opt/opencode/config` | `/opt/opencode/config` | 配置文件 |
| `/opt/opencode/data` | `/opt/opencode/data` | 持久化數據 |
| `/opt/opencode/cache` | `/opt/opencode/cache` | 快取 |
| `/opt/opencode/state` | `/opt/opencode/state` | 運行狀態 |
| `/opt/opencode/logs` | `/opt/opencode/logs` | 日誌 |
| `$WORKSPACE` | `/workspace` | 代碼工作區 |

## 使用方式

### 互動式 CLI

```bash
# 進入容器執行 opencode
docker exec -it opencode opencode

# 或直接執行指令
docker exec opencode opencode --version
```

### Web UI

啟動 Web 模式後，訪問 `http://localhost:8080`：

```bash
# 啟動 Web 服務
docker-compose -f docker-compose.production.yml --profile web up -d

# 設定密碼 (建議)
export OPENCODE_SERVER_PASSWORD="your-secure-password"
docker-compose -f docker-compose.production.yml --profile web up -d
```

### 查看日誌

```bash
# 容器日誌
docker logs -f opencode

# 應用程式日誌
tail -f /opt/opencode/data/log/*.log
```

## API Key 配置

### 方式一：環境變數

```yaml
# docker-compose.production.yml
environment:
  - ANTHROPIC_API_KEY=sk-ant-xxx
  - OPENAI_API_KEY=sk-xxx
  - GOOGLE_API_KEY=AIzaSyxxx
```

### 方式二：配置文件 (建議)

```bash
# 編輯 auth.json
sudo vim /opt/opencode/config/opencode/auth.json
```

```json
{
  "anthropic": {
    "type": "api",
    "key": "sk-ant-xxx"
  },
  "openai": {
    "type": "api",
    "key": "sk-xxx"
  }
}
```

## 備份與還原

### 備份

```bash
# 備份所有配置和狀態
tar -czvf opencode-backup-$(date +%Y%m%d).tar.gz /opt/opencode
```

### 還原

```bash
# 停止容器
docker-compose -f docker-compose.production.yml down

# 還原備份
tar -xzvf opencode-backup-YYYYMMDD.tar.gz -C /

# 重新啟動
docker-compose -f docker-compose.production.yml up -d
```

## 故障排除

### 權限問題

```bash
# 確保目錄權限正確
sudo chown -R 1000:1000 /opt/opencode
```

### 無法連接 API

```bash
# 檢查認證配置
cat /opt/opencode/config/opencode/auth.json

# 檢查容器網路
docker exec opencode curl -I https://api.anthropic.com
```

### 模型健康狀態

```bash
# 查看模型健康狀態
cat /opt/opencode/state/opencode/model-health.json | jq
```

## 安全建議

1. **密碼保護**：生產環境務必設定 `OPENCODE_SERVER_PASSWORD`
2. **配置文件權限**：`chmod 700 /opt/opencode/config`
3. **網路隔離**：Web UI 建議放在反向代理後面
4. **定期備份**：設定自動備份 cron job
