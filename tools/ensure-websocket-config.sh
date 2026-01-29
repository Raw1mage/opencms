#!/bin/bash
# ensure-websocket-config.sh
# 確保 crm.sob.com.tw 的 WebSocket 配置不被 Synology 系統覆蓋

set -e

CONFIG_FILE="/usr/local/etc/nginx/sites-available/4aa0b245-cc92-4b65-b712-310bf5cfc077.w3conf"
BACKUP_DIR="/root/nginx-websocket-backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🔍 檢查 crm.sob.com.tw 的 WebSocket 配置..."

# 檢查配置文件是否存在
if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}❌ 配置文件不存在: $CONFIG_FILE${NC}"
    exit 1
fi

# 檢查是否包含 WebSocket 支援
if grep -q "proxy_set_header.*Upgrade.*\$http_upgrade" "$CONFIG_FILE" && \
   grep -q "proxy_set_header.*Connection.*upgrade" "$CONFIG_FILE"; then
    echo -e "${GREEN}✅ WebSocket 配置已存在${NC}"
    exit 0
fi

echo -e "${YELLOW}⚠️  WebSocket 配置缺失，正在修復...${NC}"

# 創建備份目錄
mkdir -p "$BACKUP_DIR"

# 備份當前配置
cp "$CONFIG_FILE" "$BACKUP_DIR/config-before-fix-$TIMESTAMP.w3conf"
echo "📦 已備份到: $BACKUP_DIR/config-before-fix-$TIMESTAMP.w3conf"

# 使用 sed 在 crm.sob.com.tw 的 location / 區塊中添加 WebSocket headers
# 在 proxy_set_header X-Forwarded-Proto 之後插入
sed -i '/server_name crm\.sob\.com\.tw/,/^}$/ {
    /proxy_set_header.*X-Forwarded-Proto.*\$scheme/a\
\
        # WebSocket support for OpenCode PTY service\
        proxy_set_header        Upgrade             $http_upgrade;\
\
        proxy_set_header        Connection          "upgrade";
}' "$CONFIG_FILE"

# 驗證修改
if grep -q "proxy_set_header.*Upgrade.*\$http_upgrade" "$CONFIG_FILE" && \
   grep -q "proxy_set_header.*Connection.*upgrade" "$CONFIG_FILE"; then
    echo -e "${GREEN}✅ WebSocket 配置已添加${NC}"
    
    # 測試 nginx 配置
    if nginx -t 2>&1 | grep -q "test is successful"; then
        echo -e "${GREEN}✅ Nginx 配置測試通過${NC}"
        
        # 重新載入 nginx
        nginx -s reload
        echo -e "${GREEN}✅ Nginx 已重新載入${NC}"
        
        # 記錄修復日誌
        echo "[$TIMESTAMP] WebSocket 配置已自動修復" >> "$BACKUP_DIR/fix-log.txt"
    else
        echo -e "${RED}❌ Nginx 配置測試失敗，正在回滾...${NC}"
        cp "$BACKUP_DIR/config-before-fix-$TIMESTAMP.w3conf" "$CONFIG_FILE"
        exit 1
    fi
else
    echo -e "${RED}❌ 添加 WebSocket 配置失敗${NC}"
    cp "$BACKUP_DIR/config-before-fix-$TIMESTAMP.w3conf" "$CONFIG_FILE"
    exit 1
fi

echo -e "${GREEN}🎉 完成！${NC}"
