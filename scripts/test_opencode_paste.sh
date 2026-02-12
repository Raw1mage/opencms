#!/bin/bash
# test_opencode_paste.sh - 完整的 OpenCode 貼上功能測試

echo "🧪 OpenCode Paste 功能測試"
echo "=========================================="
echo ""

# 顏色定義
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 測試 1: 檢查配置文件
echo "📝 測試 1: 檢查配置文件"
echo "----------------------------------------"
if [ -f ~/.inputrc ]; then
    echo -e "${GREEN}✅ ~/.inputrc 存在${NC}"
    if grep -q "enable-bracketed-paste off" ~/.inputrc; then
        echo -e "${GREEN}✅ bracketed-paste 已在配置文件中禁用${NC}"
    else
        echo -e "${RED}❌ bracketed-paste 設定未找到${NC}"
    fi
else
    echo -e "${RED}❌ ~/.inputrc 不存在${NC}"
fi
echo ""

# 測試 2: 檢查當前 shell 設定
echo "⚙️  測試 2: 檢查當前 Shell 設定"
echo "----------------------------------------"
BRACKETED=$(bind -v 2>/dev/null | grep "enable-bracketed-paste" || echo "")
if [ -n "$BRACKETED" ]; then
    if echo "$BRACKETED" | grep -q "off"; then
        echo -e "${GREEN}✅ 當前 shell 中 bracketed-paste 已禁用${NC}"
        echo "   $BRACKETED"
    else
        echo -e "${YELLOW}⚠️  當前 shell 中 bracketed-paste 仍啟用${NC}"
        echo "   $BRACKETED"
    fi
else
    echo -e "${YELLOW}⚠️  無法檢測 bracketed-paste 狀態${NC}"
fi
echo ""

# 測試 3: 檢查 clipboard 工具
echo "🔧 測試 3: 檢查 Clipboard 工具"
echo "----------------------------------------"
if command -v xclip &> /dev/null; then
    echo -e "${GREEN}✅ xclip 已安裝${NC}"
else
    echo -e "${RED}❌ xclip 未安裝${NC}"
fi

if command -v xsel &> /dev/null; then
    echo -e "${GREEN}✅ xsel 已安裝${NC}"
else
    echo -e "${RED}❌ xsel 未安裝${NC}"
fi
echo ""

# 測試 4: 環境資訊
echo "🌍 測試 4: 環境資訊"
echo "----------------------------------------"
echo "SESSION_TYPE: ${XDG_SESSION_TYPE:-未設定}"
echo "DISPLAY: ${DISPLAY:-未設定}"
echo "TERM: ${TERM:-未設定}"
echo "SHELL: ${SHELL:-未設定}"
echo ""

# 測試 5: OpenCode 進程檢查
echo "🔍 測試 5: OpenCode 進程檢查"
echo "----------------------------------------"
OPENCODE_PROCS=$(pgrep -f opencode | wc -l)
if [ "$OPENCODE_PROCS" -gt 0 ]; then
    echo -e "${YELLOW}⚠️  發現 $OPENCODE_PROCS 個 OpenCode 進程正在運行${NC}"
    echo "   建議先關閉: pkill -f opencode"
else
    echo -e "${GREEN}✅ 沒有 OpenCode 進程運行${NC}"
fi
echo ""

# 總結
echo "=========================================="
echo "📊 測試總結"
echo "=========================================="
echo ""

# 計算通過的測試
PASS=0
TOTAL=5

[ -f ~/.inputrc ] && grep -q "enable-bracketed-paste off" ~/.inputrc && ((PASS++))
echo "$BRACKETED" | grep -q "off" && ((PASS++))
command -v xclip &> /dev/null && ((PASS++))
command -v xsel &> /dev/null && ((PASS++))
[ "$OPENCODE_PROCS" -eq 0 ] && ((PASS++))

echo "通過測試: $PASS / $TOTAL"
echo ""

if [ "$PASS" -eq "$TOTAL" ]; then
    echo -e "${GREEN}🎉 所有測試通過！${NC}"
    echo ""
    echo "✨ 建議的下一步："
    echo "   1. 啟動 OpenCode: opencode"
    echo "   2. 複製一些文字（在其他應用中）"
    echo "   3. 在 OpenCode 中按 Ctrl+V 測試貼上"
    echo ""
elif [ "$PASS" -ge 3 ]; then
    echo -e "${YELLOW}⚠️  大部分測試通過，應該可以正常工作${NC}"
    echo ""
    echo "💡 建議："
    if [ "$OPENCODE_PROCS" -gt 0 ]; then
        echo "   - 先關閉舊的 OpenCode: pkill -f opencode"
    fi
    if ! echo "$BRACKETED" | grep -q "off"; then
        echo "   - 重新載入 shell: exec bash"
    fi
    echo "   - 然後啟動 OpenCode: opencode"
else
    echo -e "${RED}❌ 多個測試失敗${NC}"
    echo ""
    echo "🔧 修復步驟："
    echo "   1. 執行修復腳本: ./quick_fix_opencode_paste.sh"
    echo "   2. 重新載入 shell: exec bash"
    echo "   3. 重新運行此測試: ./test_opencode_paste.sh"
fi

echo ""
echo "=========================================="
echo "📚 更多資訊請查看:"
echo "   ~/README_OPENCODE_FIX.md"
echo "   ~/OPENCODE_PASTE_FIX.md"
echo "=========================================="
