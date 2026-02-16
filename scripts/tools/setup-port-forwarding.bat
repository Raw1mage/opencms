@echo off
setlocal enabledelayedexpansion

:: WSL OpenCode Web Port Forwarding Script
:: Place this in: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\

echo ============================================
echo  WSL OpenCode Web Port Forwarding Setup
echo ============================================
echo.

:: Get WSL IP address
echo [1/4] Detecting WSL IP address...
for /f "tokens=*" %%i in ('wsl -e hostname -I 2^>nul') do set "WSL_IP=%%i"
:: Trim spaces
for /f "tokens=1" %%a in ("%WSL_IP%") do set "WSL_IP=%%a"

if "%WSL_IP%"=="" (
    echo Warning: Could not detect WSL IP address
    echo WSL may not be running. Attempting to start...
    wsl -e echo "WSL started" >nul 2>&1
    timeout /t 3 >nul
    for /f "tokens=*" %%i in ('wsl -e hostname -I 2^>nul') do set "WSL_IP=%%i"
    for /f "tokens=1" %%a in ("%WSL_IP%") do set "WSL_IP=%%a"
)

if "%WSL_IP%"=="" (
    echo ERROR: Could not detect WSL IP address after retry
    echo Please ensure WSL is installed and running
    pause
    exit /b 1
)

echo    WSL IP: %WSL_IP%
echo.

:: Remove existing port forwarding rules
echo [2/4] Removing old port forwarding rules...
netsh interface portproxy delete v4tov4 listenport=1080 listenaddress=0.0.0.0 >nul 2>&1

:: Add new port forwarding rule
echo [3/4] Adding port forwarding rule (0.0.0.0:1080 -^> %WSL_IP%:1080)...
netsh interface portproxy add v4tov4 listenport=1080 listenaddress=0.0.0.0 connectport=1080 connectaddress=%WSL_IP%

if !errorlevel! neq 0 (
    echo ERROR: Failed to add port forwarding rule
    echo Please run this script as Administrator
    pause
    exit /b 1
)

:: Configure Windows Firewall
echo [4/4] Configuring Windows Firewall...
netsh advfirewall firewall delete rule name="WSL OpenCode Web" >nul 2>&1
netsh advfirewall firewall add rule name="WSL OpenCode Web" dir=in action=allow protocol=TCP localport=1080 >nul 2>&1

echo.
echo ============================================
echo  Port Forwarding Setup Complete!
echo ============================================
echo.
echo Current rules:
netsh interface portproxy show v4tov4
echo.
echo OpenCode Web will be accessible at:
echo   http://localhost:1080
echo   http://%COMPUTERNAME%:1080
echo.
echo To start OpenCode Web in WSL, run:
echo   ./start-opencode-web.sh
echo.
echo Username: opencode
echo.

:: Auto-close after 5 seconds (for startup)
if "%1"=="--silent" (
    exit /b 0
)
timeout /t 5