#!/bin/bash
# synow3tool-hook.sh
# Hook script to automatically add WebSocket support after synow3tool regenerates configs

# 原始的 synow3tool 命令
/usr/syno/bin/synow3tool.original "$@"
RESULT=$?

# 如果 synow3tool 成功執行，則運行我們的持久化腳本
if [ $RESULT -eq 0 ]; then
    if [ -f /root/persistent-websocket-config.sh ]; then
        echo "🔧 Running WebSocket persistence hook..."
        /root/persistent-websocket-config.sh
    fi
fi

exit $RESULT
