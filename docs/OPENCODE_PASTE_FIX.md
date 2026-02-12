# OpenCode Paste 問題修復指南

## 🔍 問題診斷

您遇到的問題是 **Bracketed Paste Mode** 導致的。

### 症狀：
- ✅ 貼上功能**技術上有效**（顯示 `[Pasted ~3 lines]`）
- ❌ 但貼上的內容**沒有正確插入**到輸入框
- ❌ 或者貼上後內容被**分段處理**

### 原因：
Bracketed paste mode 是 terminal 的一個功能，會在貼上的內容前後加上特殊控制序列：
- 開始：`^[[200~`
- 結束：`^[[201~`

OpenCode 可能無法正確處理這些序列，導致貼上失效。

---

## ✅ 解決方案

### 方案 1：禁用 Bracketed Paste Mode（推薦）

我已經為您創建了 `~/.inputrc` 文件，內容如下：

```bash
# Disable bracketed paste mode to fix OpenCode paste issues
set enable-bracketed-paste off
```

**啟用方法：**

```bash
# 方法 1：重新載入 bash
exec bash

# 方法 2：重新登入
exit
# 然後重新登入

# 方法 3：手動載入
bind -f ~/.inputrc
```

**測試：**
```bash
# 重啟 OpenCode
opencode

# 然後嘗試貼上內容（Ctrl+V）
```

---

### 方案 2：臨時禁用（立即生效）

在當前 shell 中執行：

```bash
# 禁用 bracketed paste mode
bind 'set enable-bracketed-paste off'

# 或使用 escape sequence
printf "\e[?2004l"

# 然後啟動 OpenCode
opencode
```

---

### 方案 3：使用不同的 Terminal Emulator

某些 terminal emulator 與 OpenCode 相容性更好：

**推薦的 Terminal：**
- ✅ **WezTerm** - 現代化，功能豐富
- ✅ **Alacritty** - 快速，簡潔
- ✅ **Kitty** - 功能強大
- ✅ **Windows Terminal**（如果在 Windows/WSL）

**安裝 WezTerm（推薦）：**
```bash
# Ubuntu/Debian
curl -fsSL https://apt.fury.io/wez/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/wezterm-fury.gpg
echo 'deb [signed-by=/usr/share/keyrings/wezterm-fury.gpg] https://apt.fury.io/wez/ * *' | sudo tee /etc/apt/sources.list.d/wezterm.list
sudo apt update
sudo apt install wezterm

# 然後在 WezTerm 中啟動 OpenCode
wezterm start -- opencode
```

---

### 方案 4：使用 tmux 作為中介層

```bash
# 安裝 tmux（如果尚未安裝）
sudo apt install tmux

# 在 tmux 中啟動 OpenCode
tmux
opencode

# 在 tmux 中複製：
# 1. Ctrl+B [ 進入 scroll mode
# 2. 使用方向鍵移動
# 3. Space 開始選取
# 4. Enter 複製
# 5. Ctrl+B ] 貼上
```

---

## 🧪 驗證修復

### 測試步驟：

1. **重新載入配置**
   ```bash
   exec bash
   ```

2. **驗證 bracketed paste 已禁用**
   ```bash
   # 這個命令應該不會顯示任何輸出
   bind -v | grep bracketed
   # 或應該顯示 "off"
   ```

3. **啟動 OpenCode**
   ```bash
   opencode
   ```

4. **測試貼上**
   - 複製一些文字
   - 在 OpenCode 中按 `Ctrl+V`
   - 文字應該**直接出現**在輸入框中，而不是顯示 `[Pasted ...]`

---

## 📊 對比：修復前 vs 修復後

### 修復前：
```
[Pasted ~3 lines]  ← 只顯示這個，內容沒有插入
```

### 修復後：
```
你實際複製的內容直接出現在這裡  ← 內容正確插入
```

---

## 🔧 其他可能的解決方法

### 如果上述方法都無效：

1. **清除 OpenCode 快取**
   ```bash
   rm -rf ~/.cache/opencode
   rm -rf ~/.local/share/opencode/log/*
   ```

2. **重置 OpenCode 設定**
   ```bash
   # 備份
   cp ~/.config/opencode/opencode.json ~/.config/opencode/opencode.json.backup
   
   # 重置（小心！）
   rm ~/.local/share/opencode/*.dat
   ```

3. **檢查 OpenCode 日誌**
   ```bash
   tail -f ~/.local/share/opencode/log/opencode.log
   # 然後在另一個 terminal 啟動 OpenCode 並嘗試貼上
   ```

4. **更新 OpenCode**
   ```bash
   npm update -g opencode-ai
   ```

---

## 🎯 快速修復命令（一鍵執行）

```bash
# 創建 .inputrc（如果不存在）
cat > ~/.inputrc << 'EOF'
set enable-bracketed-paste off
set completion-ignore-case on
set show-all-if-ambiguous on
EOF

# 重新載入 bash
exec bash

# 啟動 OpenCode
opencode
```

---

## 📝 驗證腳本

創建一個測試腳本：

```bash
#!/bin/bash
# paste_test.sh

echo "=== OpenCode Paste 修復驗證 ==="
echo ""

# 檢查 .inputrc
if [ -f ~/.inputrc ]; then
    echo "✅ ~/.inputrc 存在"
    if grep -q "enable-bracketed-paste off" ~/.inputrc; then
        echo "   ✅ bracketed-paste 已禁用"
    else
        echo "   ⚠️  bracketed-paste 設定未找到"
    fi
else
    echo "❌ ~/.inputrc 不存在"
fi

echo ""

# 檢查當前 bind 設定
echo "當前 bracketed-paste 狀態："
bind -v | grep bracketed || echo "   未設定（可能是預設值）"

echo ""
echo "=== 建議 ==="
echo "1. 執行: exec bash"
echo "2. 執行: opencode"
echo "3. 測試貼上功能"
```

---

**最後更新：** 2026-01-26  
**狀態：** 🔧 已創建修復配置，需要重新載入 bash
