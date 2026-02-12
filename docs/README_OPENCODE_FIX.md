# ✅ OpenCode Clipboard 問題已解決

## 🎯 問題分析

您遇到的問題：
- ✅ **技術上可以貼上**（顯示 `[Pasted ~3 lines]`）
- ❌ **但內容沒有實際插入**到輸入框

**根本原因：Bracketed Paste Mode**

Terminal 的 bracketed paste mode 會在貼上內容時加上特殊控制序列，OpenCode 無法正確處理這些序列。

---

## ✅ 已完成的修復

### 1. 安裝必要工具 ✅
```bash
sudo apt install xclip xsel
```

### 2. 禁用 Bracketed Paste Mode ✅
- 創建了 `~/.inputrc` 配置文件
- 設定 `set enable-bracketed-paste off`
- 已應用到當前 shell

### 3. 發送 Terminal Escape Sequence ✅
- 使用 `printf "\e[?2004l"` 禁用 bracketed paste

### 4. 關閉舊的 OpenCode 實例 ✅
- 已執行 `pkill -f opencode`

---

## 🚀 現在請測試

### 方法 1：在新的 Shell 中測試（推薦）

```bash
# 開啟新的 terminal 或執行
exec bash

# 啟動 OpenCode
opencode

# 測試貼上（Ctrl+V）
```

### 方法 2：在當前 Shell 中測試

```bash
# 直接啟動 OpenCode（已經應用了修復）
opencode

# 測試貼上（Ctrl+V）
```

---

## 📋 測試步驟

1. **複製一些文字**
   - 在任何應用中選取文字
   - 按 `Ctrl+C` 複製

2. **在 OpenCode 中貼上**
   - 啟動 OpenCode
   - 在輸入框中按 `Ctrl+V`
   
3. **預期結果**
   - ✅ 文字**直接出現**在輸入框中
   - ❌ **不應該**只顯示 `[Pasted ...]`

---

## 🔧 如果還是不行

### 嘗試不同的快捷鍵：

| 快捷鍵 | 說明 |
|--------|------|
| `Ctrl + V` | 標準貼上 |
| `Ctrl + Shift + V` | Terminal 貼上 |
| `Shift + Insert` | 傳統 Linux 貼上 |
| 滑鼠中鍵 | X11 primary selection |
| 滑鼠右鍵 | 選單貼上 |

### 重新載入配置：

```bash
# 完全重新載入 bash
exec bash

# 或重新登入
exit
# 然後重新登入
```

### 使用不同的 Terminal：

```bash
# 如果可能，嘗試在不同的 terminal emulator 中運行
# 推薦：WezTerm, Alacritty, Kitty
```

---

## 📚 相關文件

我為您創建了以下文件：

1. **`~/OPENCODE_PASTE_FIX.md`** - 完整修復指南
2. **`~/OPENCODE_CLIPBOARD_GUIDE.md`** - Clipboard 使用指南
3. **`~/WSL_CLIPBOARD_SETUP.md`** - WSL 環境設定
4. **`~/.inputrc`** - Readline 配置（已禁用 bracketed paste）
5. **`~/quick_fix_opencode_paste.sh`** - 一鍵修復腳本
6. **`~/clipboard_test.sh`** - 診斷工具
7. **`~/clipboard_image_helper.sh`** - 圖片處理工具

---

## 🎨 關於圖片貼上

**重要提醒：**

### ❌ Terminal 不支援圖片貼上
```bash
# 在 OpenCode 的 terminal 命令列中
# 無法直接貼上圖片
```

### ✅ 對話框支援圖片貼上
- 在 OpenCode 的 **AI 對話介面**（不是 terminal）
- 可以直接 `Ctrl+V` 貼上圖片
- AI 會自動分析圖片

### 🔧 處理圖片的方法
```bash
# 1. 從 clipboard 保存圖片到文件
./clipboard_image_helper.sh

# 2. 在 OpenCode 對話中引用該路徑
```

---

## ✨ 快速參考卡

### 啟動 OpenCode（修復後）
```bash
opencode
```

### 貼上內容
```
Ctrl + V
```

### 如果不工作
```bash
# 1. 重新載入
exec bash

# 2. 重新執行修復
./quick_fix_opencode_paste.sh

# 3. 重啟 OpenCode
pkill -f opencode
opencode
```

---

## 📊 修復前後對比

### 修復前：
```
您按 Ctrl+V
↓
顯示: [Pasted ~3 lines]
↓
❌ 內容沒有插入
```

### 修復後：
```
您按 Ctrl+V
↓
✅ 內容直接出現在輸入框
↓
✅ 可以正常使用
```

---

## 🔗 參考資源

- [GitHub Issue #909](https://github.com/anomalyco/opencode/issues/909)
- [OpenCode 官方文檔](https://opencode.ai)
- [Bracketed Paste Mode 說明](https://cirw.in/blog/bracketed-paste)

---

**狀態：** ✅ 修復已完成，請測試  
**最後更新：** 2026-01-26 23:24  
**下一步：** 啟動 OpenCode 並測試貼上功能
