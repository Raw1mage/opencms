#!/bin/bash

# Fix Nginx CORS configuration for OpenCode Web
# This script adds CORS headers and increases timeouts for long-running operations
# Allowed origins: *.sob.com.tw, *.thesmart.cc, 192.168.100.*, 127.0.0.1

BACKUP_SUFFIX=$(date +%Y%m%d-%H%M%S)
CONFIG_FILE="/usr/local/etc/nginx/sites-enabled/server.ReverseProxy.conf"

echo "Creating backup..."
ssh yeatsluo@rawdb "sudo cp $CONFIG_FILE ${CONFIG_FILE}.backup-${BACKUP_SUFFIX}"

echo "Updating nginx configuration for crm.sob.com.tw..."

# Create a temporary file with the updated configuration
ssh yeatsluo@rawdb "sudo bash -c 'cat > /tmp/nginx_cors_update.conf << \"EOF\"
# CORS configuration map
map \$http_origin \$cors_origin {
    default \"\";
    \"~*^https?://(.*\\.)?sob\\.com\\.tw\$\" \$http_origin;
    \"~*^https?://(.*\\.)?thesmart\\.cc\$\" \$http_origin;
    \"~*^https?://192\\.168\\.100\\.[0-9]+\" \$http_origin;
    \"~*^https?://127\\.0\\.0\\.1\" \$http_origin;
    \"~*^http://localhost\" \$http_origin;
}
EOF
'"

# Check if map already exists in nginx.conf
if ssh yeatsluo@rawdb "sudo grep -q 'map \$http_origin \$cors_origin' /etc/nginx/nginx.conf"; then
    echo "CORS map already exists in nginx.conf"
else
    echo "Adding CORS map to nginx.conf..."
    ssh yeatsluo@rawdb "sudo sed -i '/http {/r /tmp/nginx_cors_update.conf' /etc/nginx/nginx.conf"
fi

# Update the crm.sob.com.tw server block
ssh yeatsluo@rawdb "sudo bash -c 'cat > /tmp/nginx_location_update.txt << \"EOFBLOCK\"
    location / {

        # CORS headers
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

        proxy_pass http://192.168.100.10:1080;

    }
EOFBLOCK
'"

# Replace the location block for crm.sob.com.tw
ssh yeatsluo@rawdb "sudo bash -c '
    # Find the crm.sob.com.tw server block and replace its location block
    awk \"
    BEGIN { in_crm_server=0; in_location=0; skip=0 }
    /server_name crm\\.sob\\.com\\.tw/ { in_crm_server=1 }
    in_crm_server && /^    location \/ {/ { 
        in_location=1
        skip=1
        while ((getline line < \"/tmp/nginx_location_update.txt\") > 0) {
            print line
        }
        close(\"/tmp/nginx_location_update.txt\")
        next
    }
    in_location && /^    }/ {
        in_location=0
        skip=0
        next
    }
    in_crm_server && /^}/ { in_crm_server=0 }
    !skip { print }
    \" $CONFIG_FILE > /tmp/nginx_updated.conf
    
    # Backup and replace
    cp $CONFIG_FILE ${CONFIG_FILE}.backup-${BACKUP_SUFFIX}
    mv /tmp/nginx_updated.conf $CONFIG_FILE
'"

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

# Cleanup
ssh yeatsluo@rawdb "sudo rm -f /tmp/nginx_cors_update.conf /tmp/nginx_location_update.txt"
