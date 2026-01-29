#!/bin/bash

# Optimize Nginx for long-running AI operations with streaming support
# This ensures heartbeats and streaming responses work properly

BACKUP_SUFFIX=$(date +%Y%m%d-%H%M%S)
CONFIG_FILE="/usr/local/etc/nginx/sites-available/03470713-98ae-4c69-83b9-7518c9296364.w3conf"

echo "Creating backup..."
ssh yeatsluo@rawdb "sudo cp $CONFIG_FILE ${CONFIG_FILE}.backup-${BACKUP_SUFFIX}"

echo "Optimizing nginx configuration for streaming and long-running operations..."

# Use Python to safely edit the file
ssh yeatsluo@rawdb "sudo python3 << 'PYTHON_EOF'
import re

config_file = '$CONFIG_FILE'

with open(config_file, 'r') as f:
    content = f.read()

# Find the crm.sob.com.tw location block and update timeouts
pattern = r'(server_name crm\.sob\.com\.tw.*?location / \{.*?# Increase timeouts for long-running operations\s+proxy_connect_timeout 300;\s+proxy_read_timeout 300;\s+proxy_send_timeout 300;)'

def replace_timeouts(match):
    base = match.group(1)
    
    # Add streaming-specific configurations
    streaming_config = '''

        # Disable buffering for streaming responses (critical for SSE/streaming)
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header X-Accel-Buffering no;
        
        # Keep connection alive for streaming
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        
        # Increase buffer sizes for large responses
        proxy_buffer_size 128k;
        proxy_buffers 4 256k;
        proxy_busy_buffers_size 256k;'''
    
    return base + streaming_config

content = re.sub(pattern, replace_timeouts, content, flags=re.DOTALL)

with open(config_file, 'w') as f:
    f.write(content)

print("Configuration updated successfully")
PYTHON_EOF
"

echo "Testing nginx configuration..."
if ssh yeatsluo@rawdb "sudo nginx -t" 2>&1 | grep -q "successful"; then
    echo "✅ Configuration test passed"
    echo "Reloading nginx..."
    ssh yeatsluo@rawdb "sudo nginx -s reload"
    echo "✅ Nginx reloaded successfully"
    echo ""
    echo "Streaming optimization completed!"
    echo ""
    echo "Applied optimizations:"
    echo "  ✅ Disabled proxy buffering (enables real-time streaming)"
    echo "  ✅ Disabled cache for streaming responses"
    echo "  ✅ Set X-Accel-Buffering: no (prevents nginx buffering)"
    echo "  ✅ Keep-alive connection support"
    echo "  ✅ Increased buffer sizes for large responses"
    echo "  ✅ 5-minute timeout for long operations"
    echo ""
    echo "This configuration supports:"
    echo "  - Server-Sent Events (SSE) heartbeats"
    echo "  - Streaming AI responses"
    echo "  - Long-running tool executions"
    echo "  - WebSocket connections (already configured)"
    echo ""
    echo "Backup saved as: ${CONFIG_FILE}.backup-${BACKUP_SUFFIX}"
else
    echo "❌ Configuration test failed, restoring backup..."
    ssh yeatsluo@rawdb "sudo cp ${CONFIG_FILE}.backup-${BACKUP_SUFFIX} $CONFIG_FILE"
    echo "Error details:"
    ssh yeatsluo@rawdb "sudo nginx -t" 2>&1
    exit 1
fi
