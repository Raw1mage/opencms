#!/bin/bash

# Add CORS headers to OpenCode Web nginx configuration
# This is a simpler, more reliable approach

BACKUP_SUFFIX=$(date +%Y%m%d-%H%M%S)
CONFIG_FILE="/usr/local/etc/nginx/sites-available/03470713-98ae-4c69-83b9-7518c9296364.w3conf"

echo "Creating backup..."
ssh yeatsluo@rawdb "sudo cp $CONFIG_FILE ${CONFIG_FILE}.backup-${BACKUP_SUFFIX}"

echo "Adding CORS headers to crm.sob.com.tw location block..."

# Use Python to safely edit the file
ssh yeatsluo@rawdb "sudo python3 << 'PYTHON_EOF'
import re

config_file = '$CONFIG_FILE'

with open(config_file, 'r') as f:
    content = f.read()

# Find the crm.sob.com.tw server block
pattern = r'(server_name crm\.sob\.com\.tw.*?location / \{)(.*?)(proxy_pass http://192\.168\.100\.10:1080;)'

def replace_location(match):
    header = match.group(1)
    proxy_pass = match.group(3)
    
    new_content = '''

        # CORS headers
        set \$cors_origin \"\";
        if (\$http_origin ~* \"^https?://(.*\\.)?sob\\.com\\.tw\$\") {
            set \$cors_origin \$http_origin;
        }
        if (\$http_origin ~* \"^https?://(.*\\.)?thesmart\\.cc\$\") {
            set \$cors_origin \$http_origin;
        }
        if (\$http_origin ~* \"^https?://192\\.168\\.100\\.[0-9]+\") {
            set \$cors_origin \$http_origin;
        }
        if (\$http_origin ~* \"^https?://127\\.0\\.0\\.1\") {
            set \$cors_origin \$http_origin;
        }
        if (\$http_origin ~* \"^http://localhost\") {
            set \$cors_origin \$http_origin;
        }
        
        add_header Access-Control-Allow-Origin \$cors_origin always;
        add_header Access-Control-Allow-Methods \"GET, POST, PUT, DELETE, OPTIONS, PATCH\" always;
        add_header Access-Control-Allow-Headers \"Authorization, Content-Type, Accept, Origin, User-Agent, DNT, Cache-Control, X-Mx-ReqToken, Keep-Alive, X-Requested-With, If-Modified-Since, X-OpenCode-Session, X-OpenCode-Request, X-OpenCode-Project, X-OpenCode-Client\" always;
        add_header Access-Control-Allow-Credentials \"true\" always;
        add_header Access-Control-Max-Age 86400 always;

        # Handle preflight requests
        if (\$request_method = OPTIONS) {
            return 204;
        }

        # Increase timeouts for long-running operations
        proxy_connect_timeout 300;
        proxy_read_timeout 300;
        proxy_send_timeout 300;

        proxy_intercept_errors off;
        proxy_http_version 1.1;

        proxy_set_header        Host            \$http_host;
        proxy_set_header        X-Real-IP            \$remote_addr;
        proxy_set_header        X-Forwarded-For            \$proxy_add_x_forwarded_for;
        proxy_set_header        X-Forwarded-Proto            \$scheme;

        # WebSocket support for OpenCode PTY service
        proxy_set_header        Upgrade             \$http_upgrade;
        proxy_set_header        Connection          \"upgrade\";

        '''
    
    return header + new_content + proxy_pass

content = re.sub(pattern, replace_location, content, flags=re.DOTALL)

with open(config_file, 'w') as f:
    f.write(content)

print(\"Configuration updated successfully\")
PYTHON_EOF
"

echo "Testing nginx configuration..."
if ssh yeatsluo@rawdb "sudo nginx -t" 2>&1 | grep -q "successful"; then
    echo "✅ Configuration test passed"
    echo "Reloading nginx..."
    ssh yeatsluo@rawdb "sudo nginx -s reload"
    echo "✅ Nginx reloaded successfully"
    echo ""
    echo "CORS configuration updated successfully!"
    echo "Allowed origins:"
    echo "  - *.sob.com.tw"
    echo "  - *.thesmart.cc"
    echo "  - 192.168.100.*"
    echo "  - 127.0.0.1"
    echo "  - localhost"
    echo ""
    echo "Backup saved as: ${CONFIG_FILE}.backup-${BACKUP_SUFFIX}"
else
    echo "❌ Configuration test failed, restoring backup..."
    ssh yeatsluo@rawdb "sudo cp ${CONFIG_FILE}.backup-${BACKUP_SUFFIX} $CONFIG_FILE"
    echo "Error details:"
    ssh yeatsluo@rawdb "sudo nginx -t" 2>&1
    exit 1
fi
