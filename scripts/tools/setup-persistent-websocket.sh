#!/bin/bash
# setup-persistent-websocket.sh
# 設置 Synology 反向代理 WebSocket 配置的持久化方案

set -e

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

echo "🚀 設置 Synology 反向代理 WebSocket 持久化配置..."
echo ""

# 方案選擇
echo "請選擇持久化方案："
echo "  1. Cron Job 監控方案 (每 5 分鐘檢查，推薦)"
echo "  2. synow3tool Hook 方案 (配置重新生成時自動修復，進階)"
echo "  3. 兩者都設置 (最安全)"
echo ""
read -p "請輸入選擇 (1/2/3): " choice

case $choice in
    1|3)
        echo ""
        echo "📋 設置方案 1: Cron Job 監控..."
        
        # 複製腳本到 Synology
        echo "📤 上傳持久化腳本..."
        scp "$PROJECT_ROOT/persistent-websocket-config.sh" yeatsluo@rawdb:/tmp/
        ssh yeatsluo@rawdb "sudo mv /tmp/persistent-websocket-config.sh /root/ && sudo chmod +x /root/persistent-websocket-config.sh"
        
        # 測試腳本
        echo "🧪 測試腳本..."
        ssh yeatsluo@rawdb "sudo /root/persistent-websocket-config.sh"
        
        # 設置 cron job
        echo "⏰ 設置 Cron Job..."
        CRON_JOB="*/5 * * * * /root/persistent-websocket-config.sh"
        ssh yeatsluo@rawdb "sudo bash -c '(crontab -l 2>/dev/null | grep -v persistent-websocket-config.sh; echo \"$CRON_JOB\") | crontab -'"
        
        echo "✅ Cron Job 監控方案設置完成！"
        ;;
esac

case $choice in
    2|3)
        echo ""
        echo "📋 設置方案 2: synow3tool Hook..."
        
        # 複製持久化腳本
        echo "📤 上傳持久化腳本..."
        scp "$PROJECT_ROOT/persistent-websocket-config.sh" yeatsluo@rawdb:/tmp/
        ssh yeatsluo@rawdb "sudo mv /tmp/persistent-websocket-config.sh /root/ && sudo chmod +x /root/persistent-websocket-config.sh"
        
        # 複製 hook 腳本
        echo "📤 上傳 hook 腳本..."
        scp "$PROJECT_ROOT/synow3tool-hook.sh" yeatsluo@rawdb:/tmp/
        ssh yeatsluo@rawdb "sudo mv /tmp/synow3tool-hook.sh /root/ && sudo chmod +x /root/synow3tool-hook.sh"
        
        # 備份原始 synow3tool 並替換為 hook
        echo "🔧 安裝 synow3tool hook..."
        ssh yeatsluo@rawdb "sudo bash -c '
            if [ ! -f /usr/syno/bin/synow3tool.original ]; then
                cp /usr/syno/bin/synow3tool /usr/syno/bin/synow3tool.original
            fi
            cp /root/synow3tool-hook.sh /usr/syno/bin/synow3tool
            chmod +x /usr/syno/bin/synow3tool
        '"
        
        echo "✅ synow3tool Hook 方案設置完成！"
        ;;
esac

echo ""
echo "🎉 設置完成！"
echo ""
echo "📊 驗證配置："
echo "  ssh yeatsluo@rawdb \"sudo grep -A 5 'WebSocket support' /usr/local/etc/nginx/sites-available/*.w3conf\""
echo ""
echo "📝 查看日誌："
echo "  ssh yeatsluo@rawdb \"sudo tail -f /var/log/websocket-config-persistent.log\""
echo ""
echo "🔧 手動執行修復："
echo "  ssh yeatsluo@rawdb \"sudo /root/persistent-websocket-config.sh\""
echo ""

if [ "$choice" == "2" ] || [ "$choice" == "3" ]; then
    echo "⚠️  注意：synow3tool hook 方案已安裝"
    echo "   如需移除 hook："
    echo "   ssh yeatsluo@rawdb \"sudo mv /usr/syno/bin/synow3tool.original /usr/syno/bin/synow3tool\""
    echo ""
fi
