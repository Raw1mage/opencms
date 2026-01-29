# OpenCode Web Port Forwarding Setup (Run as Administrator)
# Place shortcut in: shell:startup

$WSL_IP = (wsl hostname -I).Trim().Split()[0]
if (-not $WSL_IP) {
    Write-Host "Starting WSL..." -ForegroundColor Yellow
    wsl -e echo "WSL started" | Out-Null
    Start-Sleep -Seconds 3
    $WSL_IP = (wsl hostname -I).Trim().Split()[0]
}

if (-not $WSL_IP) {
    Write-Host "ERROR: Could not detect WSL IP" -ForegroundColor Red
    exit 1
}

Write-Host "WSL IP: $WSL_IP" -ForegroundColor Green

# Remove old rule
netsh interface portproxy delete v4tov4 listenport=1080 listenaddress=0.0.0.0 2>$null

# Add new rule
netsh interface portproxy add v4tov4 listenport=1080 listenaddress=0.0.0.0 connectport=1080 connectaddress=$WSL_IP

# Firewall
netsh advfirewall firewall delete rule name="WSL OpenCode Web" 2>$null
netsh advfirewall firewall add rule name="WSL OpenCode Web" dir=in action=allow protocol=TCP localport=1080

Write-Host "Port forwarding configured: 0.0.0.0:1080 -> ${WSL_IP}:1080" -ForegroundColor Green
Write-Host "Access: http://localhost:1080" -ForegroundColor Cyan
