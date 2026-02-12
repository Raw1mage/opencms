# OpenCode Terminal Clipboard 使用指南

## 🎯 問題解決：OpenCode 無法貼上內容

### ✅ 已解決！

根據 [GitHub Issue #909](https://github.com/anomalyco/opencode/issues/909) 和官方文檔，OpenCode 在 Linux 上需要安裝 clipboard 工具。

**已安裝的工具：**
- ✅ `xclip` - X11 clipboard 工具
- ✅ `xsel` - X11 selection 工具

---

## 📋 OpenCode Clipboard 快捷鍵

### 在 OpenCode Terminal 中：

| 功能 | 快捷鍵 | 說明 |
|------|--------|------|
| **複製** | 選取文字（自動複製） | OpenCode 預設選取即複製 |
| **貼上** | `Ctrl + V` | 主要貼上方式 |
| **貼上（替代）** | `Ctrl + Shift + V` | Linux terminal 標準貼上 |
| **貼上（替代2）** | `Shift + Insert` | 傳統 Linux 貼上方式 |
| **中鍵貼上** | 滑鼠中鍵點擊 | Linux X11 primary selection |

### 在 OpenCode 對話框中：

| 功能 | 快捷鍵 | 說明 |
|------|--------|------|
| **貼上文字** | `Ctrl + V` | 標準貼上 |
| **貼上圖片** | `Ctrl + V` | 直接貼上圖片（在對話框中，非 terminal） |

---

## 🔧 驗證 Clipboard 功能

### 測試 xclip：

```bash
# 複製文字到 clipboard
echo "Hello from xclip" | xclip -selection clipboard

# 從 clipboard 貼上
xclip -selection clipboard -o
```

### 測試 xsel：

```bash
# 複製文字到 clipboard
echo "Hello from xsel" | xsel --clipboard

# 從 clipboard 貼上
xsel --clipboard
```

---

## 🖼️ 圖片處理

### ⚠️ 重要：Terminal vs 對話框

- **Terminal（命令列）**：不支援直接貼上圖片
- **OpenCode 對話框**：支援貼上圖片（`Ctrl + V`）

### 在 Terminal 中處理 Clipboard 圖片：

使用我們創建的輔助腳本：

```bash
# 從 clipboard 保存圖片到文件
./clipboard_image_helper.sh

# 或指定保存目錄
./clipboard_image_helper.sh ~/my_images
```

然後在 OpenCode 對話中引用該圖片路徑。

---

## 🐛 故障排除

### 如果貼上仍然不工作：

1. **重啟 OpenCode**
   ```bash
   # 關閉所有 opencode 進程
   pkill -f opencode
   
   # 重新啟動
   opencode
   ```

2. **檢查 DISPLAY 環境變數**（如果在 WSL 或遠端 SSH）
   ```bash
   echo $DISPLAY
   # 應該顯示類似 :0 或 localhost:10.0
   ```

3. **使用 tmux 作為替代方案**
   ```bash
   # 在 tmux 中啟動 opencode
   tmux
   opencode
   
   # 在 tmux 中複製：Ctrl+B [ 然後選取文字
   ```

4. **嘗試不同的快捷鍵組合**
   - `Ctrl + V`
   - `Ctrl + Shift + V`
   - `Shift + Insert`
   - 滑鼠中鍵點擊

---

## 📚 相關資源

- [OpenCode 官方文檔](https://opencode.ai)
- [GitHub Issue #909](https://github.com/anomalyco/opencode/issues/909)
- [xclip 文檔](https://github.com/astrand/xclip)

---

## ✨ 快速參考

### 最常用的貼上方式（依優先順序）：

1. **`Ctrl + V`** - 首選
2. **`Ctrl + Shift + V`** - 如果 Ctrl+V 不工作
3. **`Shift + Insert`** - 傳統方式
4. **滑鼠中鍵** - X11 primary selection

### 圖片處理流程：

```bash
# 1. 複製圖片到 clipboard（在其他應用中 Ctrl+C）
# 2. 保存圖片到文件
./clipboard_image_helper.sh

# 3. 在 OpenCode 對話中引用路徑
# 或直接在對話框中 Ctrl+V 貼上圖片
```

---

**最後更新：** 2026-01-26  
**狀態：** ✅ Clipboard 工具已安裝並可用
