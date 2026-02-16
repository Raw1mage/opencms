#!/bin/bash
# setup-websocket-monitor.sh
# 在 Synology 上設置 WebSocket 配置監控

set -e

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

SCRIPT_PATH="/root/ensure-websocket-config.sh"
CRON_JOB="*/5 * * * * $SCRIPT_PATH >> /var/log/websocket-config-monitor.log 2>&1"

echo "🚀 設置 WebSocket 配置監控..."

# 1. 複製腳本到 Synology
echo "📋 步驟 1: 複製監控腳本到 Synology..."
scp "$PROJECT_ROOT/ensure-websocket-config.sh" yeatsluo@rawdb:/tmp/
ssh yeatsluo@rawdb "sudo mv /tmp/ensure-websocket-config.sh $SCRIPT_PATH && sudo chmod +x $SCRIPT_PATH"
echo "✅ 腳本已複製到: $SCRIPT_PATH"

# 2. 測試腳本
echo "📋 步驟 2: 測試監控腳本..."
ssh yeatsluo@rawdb "sudo $SCRIPT_PATH"
echo "✅ 腳本測試通過"

# 3. 設置 cron job
echo "📋 步驟 3: 設置 cron job (每 5 分鐘檢查一次)..."
ssh yeatsluo@rawdb "sudo bash -c '(crontab -l 2>/dev/null | grep -v ensure-websocket-config.sh; echo \"$CRON_JOB\") | crontab -'"
echo "✅ Cron job 已設置"

# 4. 顯示當前 cron jobs
echo ""
echo "📋 當前的 cron jobs:"
ssh yeatsluo@rawdb "sudo crontab -l | grep -v '^#' | grep -v '^$'"

echo ""
echo "🎉 設置完成！"
echo ""
echo "監控詳情:"
echo "  - 腳本位置: $SCRIPT_PATH"
echo "  - 檢查頻率: 每 5 分鐘"
echo "  - 日誌位置: /var/log/websocket-config-monitor.log"
echo ""
echo "查看日誌:"
echo "  ssh yeatsluo@rawdb 'sudo tail -f /var/log/websocket-config-monitor.log'"
echo ""
echo "手動執行檢查:"
echo "  ssh yeatsluo@rawdb 'sudo $SCRIPT_PATH'"
