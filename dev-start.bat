@echo off
echo ============================================================
echo  SparkP2P - Starting Local Dev Environment
echo ============================================================
echo.
echo  Backend  → http://localhost:8002
echo  Frontend → http://localhost:5174
echo  API Docs → http://localhost:8002/docs
echo.
echo  Press Ctrl+C in each window to stop.
echo ============================================================
echo.

REM Start backend in a new window
start "SparkP2P Backend" cmd /k "cd /d %~dp0backend && venv\Scripts\activate && set ENV_FILE=.env.local && uvicorn app.main:app --reload --port 8002"

REM Wait 3 seconds for backend to initialize
timeout /t 3 /nobreak >nul

REM Start frontend in a new window
start "SparkP2P Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

echo  Both servers are starting in separate windows.
echo  Open http://localhost:5174 in your browser.
echo.
pause
