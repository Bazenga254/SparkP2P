@echo off
title SparkP2P Binance Relay
echo ============================================
echo   SparkP2P Binance Relay + SSH Tunnel
echo ============================================
echo.

set RELAY_SECRET=45981a1b322cd4b442cd4ffdbd9a2045feda358fdfa03273b0162ba66fd2410e
set PORT=7842

:: Start the relay in a new window
echo [1] Starting local relay on port 7842...
start "SparkP2P Relay" cmd /k "set RELAY_SECRET=%RELAY_SECRET%&& set PORT=7842 && cd /d %~dp0 && python relay.py"

:: Wait for relay to be up
timeout /t 4 /nobreak >nul

:: Open SSH reverse tunnel in a new window
:: -R 7843:localhost:7842  = expose local:7842 as VPS:7843
:: -N                      = no command, just tunnel
:: -o ServerAliveInterval  = keep-alive ping every 30s
:: -o ExitOnForwardFailure = restart if port bind fails
echo [2] Opening SSH reverse tunnel to VPS...
start "SparkP2P SSH Tunnel" cmd /k "ssh -N -R 7843:localhost:7842 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes root@157.245.175.55"

echo.
echo Both windows are running.
echo - Relay:      localhost:7842
echo - VPS tunnel: localhost:7843 on 157.245.175.55
echo.
echo Keep both windows open while trading.
echo Close this window when done.
pause
