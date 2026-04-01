@echo off
echo ============================================================
echo  SparkP2P - Local Dev Environment
echo ============================================================
echo.
echo  Backend  -^> http://localhost:8002
echo  Frontend -^> http://localhost:5174
echo  API Docs -^> http://localhost:8002/docs
echo.
echo  Database: sparkp2p_dev (local, separate from production)
echo ============================================================
echo.

REM Start backend in a new window
start "SparkP2P Backend (DEV)" cmd /k "cd /d %~dp0backend && call venv\Scripts\activate && set ENV_FILE=.env.local && uvicorn app.main:app --reload --port 8002 --log-level info"

REM Wait 3 seconds for backend to initialize
timeout /t 3 /nobreak >nul

REM Start frontend in a new window
start "SparkP2P Frontend (DEV)" cmd /k "cd /d %~dp0frontend && npm run dev"

echo  Opening browser in 5 seconds...
timeout /t 5 /nobreak >nul
start http://localhost:5174

echo.
echo  Both servers are running. Close their windows to stop.
pause
