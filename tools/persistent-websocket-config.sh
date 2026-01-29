#!/bin/bash
# persistent-websocket-config.sh
# 在 Synology 反向代理配置中持久化 WebSocket 支援
# 此腳本會在配置生成後自動添加 WebSocket headers

set -e

CONFIG_PATTERN="/usr/local/etc/nginx/sites-available/*.w3conf"
BACKUP_DIR="/root/nginx-websocket-backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="/var/log/websocket-config-persistent.log"

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "🔍 開始檢查 crm.sob.com.tw 的 WebSocket 配置..."

# 找到包含 crm.sob.com.tw 的配置文件
CONFIG_FILE=$(grep -l "server_name crm.sob.com.tw" $CONFIG_PATTERN 2>/dev/null | head -1)

if [ -z "$CONFIG_FILE" ]; then
    log "❌ 找不到 crm.sob.com.tw 的配置文件"
    exit 1
fi

log "📄 找到配置文件: $CONFIG_FILE"

# 檢查是否已包含 WebSocket 支援
if grep -q "proxy_set_header.*Upgrade.*\$http_upgrade" "$CONFIG_FILE" && \
   grep -q "proxy_set_header.*Connection.*\"upgrade\"" "$CONFIG_FILE"; then
    log "✅ WebSocket 配置已存在"
    exit 0
fi

log "⚠️  WebSocket 配置缺失，正在添加..."

# 創建備份目錄
mkdir -p "$BACKUP_DIR"

# 備份當前配置
cp "$CONFIG_FILE" "$BACKUP_DIR/$(basename $CONFIG_FILE)-$TIMESTAMP.bak"
log "📦 已備份到: $BACKUP_DIR/$(basename $CONFIG_FILE)-$TIMESTAMP.bak"

# 在 crm.sob.com.tw 的 location / 區塊中添加 WebSocket headers
# 策略：在 proxy_set_header X-Forwarded-Proto 之後、proxy_pass 之前插入
awk '
/server_name crm\.sob\.com\.tw/ { in_crm_block=1 }
in_crm_block && /location \// { in_location=1 }
in_crm_block && in_location && /proxy_set_header.*X-Forwarded-Proto.*\$scheme/ {
    print
    print ""
    print "        # WebSocket support for OpenCode PTY service"
    print "        proxy_set_header        Upgrade             $http_upgrade;"
    print ""
    print "        proxy_set_header        Connection          \"upgrade\";"
    next
}
in_crm_block && /^}$/ {
    if (in_location) {
        in_location=0
    } else {
        in_crm_block=0
    }
}
{ print }
' "$CONFIG_FILE" > "$CONFIG_FILE.tmp"

# 替換原文件
mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

# 驗證修改
if grep -q "proxy_set_header.*Upgrade.*\$http_upgrade" "$CONFIG_FILE" && \
   grep -q "proxy_set_header.*Connection.*\"upgrade\"" "$CONFIG_FILE"; then
    log "✅ WebSocket 配置已添加"
    
    # 測試 nginx 配置
    if nginx -t 2>&1 | grep -q "test is successful"; then
        log "✅ Nginx 配置測試通過"
        
        # 重新載入 nginx
        nginx -s reload
        log "✅ Nginx 已重新載入"
        log "🎉 WebSocket 配置持久化完成！"
    else
        log "❌ Nginx 配置測試失敗，正在回滾..."
        cp "$BACKUP_DIR/$(basename $CONFIG_FILE)-$TIMESTAMP.bak" "$CONFIG_FILE"
        exit 1
    fi
else
    log "❌ 添加 WebSocket 配置失敗"
    cp "$BACKUP_DIR/$(basename $CONFIG_FILE)-$TIMESTAMP.bak" "$CONFIG_FILE"
    exit 1
fi
