#!/bin/bash
# quick_fix_opencode_paste.sh - 快速修復 OpenCode 貼上問題

echo "🔧 OpenCode Paste 快速修復工具"
echo "================================"
echo ""

# 1. 確保 .inputrc 存在並配置正確
echo "📝 步驟 1: 配置 ~/.inputrc"
if [ ! -f ~/.inputrc ]; then
    cat > ~/.inputrc << 'EOF'
set enable-bracketed-paste off
set completion-ignore-case on
set show-all-if-ambiguous on
EOF
    echo "   ✅ 已創建 ~/.inputrc"
else
    if ! grep -q "enable-bracketed-paste off" ~/.inputrc; then
        echo "set enable-bracketed-paste off" >> ~/.inputrc
        echo "   ✅ 已更新 ~/.inputrc"
    else
        echo "   ✅ ~/.inputrc 已正確配置"
    fi
fi

echo ""

# 2. 立即應用到當前 shell
echo "⚡ 步驟 2: 立即應用設定"
bind 'set enable-bracketed-paste off' 2>/dev/null && echo "   ✅ 已應用到當前 shell" || echo "   ⚠️  無法應用（可能不在 bash 中）"

echo ""

# 3. 使用 escape sequence 禁用
echo "🔌 步驟 3: 發送 terminal escape sequence"
printf "\e[?2004l"
echo "   ✅ 已發送禁用序列"

echo ""

# 4. 驗證
echo "✓ 步驟 4: 驗證設定"
BRACKETED_STATUS=$(bind -v 2>/dev/null | grep "enable-bracketed-paste" || echo "未找到")
echo "   當前狀態: $BRACKETED_STATUS"

echo ""
echo "================================"
echo "🎉 修復完成！"
echo ""
echo "📋 下一步："
echo "   1. 關閉所有 OpenCode 實例: pkill -f opencode"
echo "   2. 啟動 OpenCode: opencode"
echo "   3. 測試貼上功能（Ctrl+V）"
echo ""
echo "💡 提示："
echo "   - 如果還是不行，請執行: exec bash"
echo "   - 然後重新啟動 OpenCode"
echo ""
echo "📚 詳細說明請查看: ~/OPENCODE_PASTE_FIX.md"
