# OpenCode 環境從零建置指南

本指南將協助您在全新的 WSL/Linux 機器上，快速建置一套功能完整的 OpenCode 開發環境。最重要的是，這套環境具備 **雙路認證機制 (Dual-Path Authentication)**：同時整合了 Antigravity 的託管算力 (Pro) 與個人的 AI Studio 免費額度 (Free)。

## 1. 前置需求 (Prerequisites)

請確保您的新機器已安裝以下軟體：

- **WSL2** (推薦使用 Ubuntu 22.04 或更高版本)
- **Node.js 20+** (強烈建議使用 `nvm` 安裝：`nvm install 20`)
- **Git**

## 2. 快速安裝 (Quick Install)

我們提供了一個自動化腳本，能幫您完成大部分的繁雜設定：

```bash
cd opencode_installation
chmod +x setup.sh
./setup.sh
```

執行過程中，腳本會詢問您的 **Google AI Studio API Key**，請準備好並貼上。

## 3. 手動安裝步驟 (Manual Installation)

如果您偏好手動設定，或想了解細節，請依序執行以下步驟：

### 步驟 3.1: 安裝 OpenCode CLI

```bash
npm install -g opencode
```

### 步驟 3.2: 初始化設定目錄

```bash
mkdir -p ~/.config/opencode
cd ~/.config/opencode
npm init -y
```

### 步驟 3.3: 建立設定檔 (`opencode.json`)

建立 `~/.config/opencode/opencode.json`，並寫入以下內容。這份設定檔以 canonical Google providers 為核心：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "google": {
      "models": {
        "gemini-2.5-flash": { "name": "Gemini 2.5 Flash (Free Tier)" },
        "gemini-2.5-pro": { "name": "Gemini 2.5 Pro (Free Tier)" }
      }
    }
  }
}
```

### 步驟 3.5: 設定認證 (Authentication)

本環境使用 API Key 路徑：

**路徑 A: 免費額度 (Free Tier - API Key)**

1. 前往 [Google AI Studio](https://aistudio.google.com/) 獲取您的 API Key (以 `AIza` 開頭)。
2. 將其加入環境變數：
   ```bash
   echo 'export GOOGLE_API_KEY=AIzaSyCy...' >> ~/.bashrc
   source ~/.bashrc
   ```
   _用途：當您呼叫 `gemini-2.5-flash` 等標準模型時，會走這條路徑，使用您的個人免費額度。_

## 4. Skills 設定

建議建立專案 Skills 目錄：

```bash
mkdir -p ~/projects/skills
# 範例：如果有自定義的 skill repo，可在這裡 clone
# git clone https://github.com/your-repo/skills.git ~/projects/skills/my-skills
```

## 5. 驗證安裝 (Verification)

執行健康檢查，確認兩條路徑都暢通：

```bash
opencode-check-health
```

或直接測試免費通道：

```bash
opencode run -m google/gemini-2.5-flash "你好，請自我介紹"
```
