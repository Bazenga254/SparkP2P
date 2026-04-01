@echo off
echo ============================================================
echo  SparkP2P - Local Dev Setup
echo ============================================================
echo.

REM Add PostgreSQL to PATH
set PGPATH=C:\Program Files\PostgreSQL\17\bin
if not exist "%PGPATH%\psql.exe" set PGPATH=C:\Program Files\PostgreSQL\16\bin
if not exist "%PGPATH%\psql.exe" set PGPATH=C:\Program Files\PostgreSQL\15\bin

set PATH=%PATH%;%PGPATH%

REM Check PostgreSQL is available
where psql >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] PostgreSQL not found in PATH.
    echo   Expected at: C:\Program Files\PostgreSQL\17\bin
    pause
    exit /b 1
)

echo [1/4] Creating local database: sparkp2p_dev ...
set PGPASSWORD=postgres
psql -U postgres -c "CREATE DATABASE sparkp2p_dev;" 2>nul
if %errorlevel% equ 0 (
    echo       Database created successfully.
) else (
    echo       Database already exists, skipping.
)

echo.
echo [2/4] Setting up Python virtual environment ...
cd backend
if not exist venv (
    python -m venv venv
    echo       Virtual environment created.
) else (
    echo       Virtual environment already exists, skipping.
)

echo.
echo [3/4] Installing Python dependencies ...
call venv\Scripts\activate.bat
pip install -r requirements.txt openai -q
echo       Dependencies installed.

echo.
echo [4/4] Initializing database tables ...
set ENV_FILE=.env.local
python -c "import asyncio; from app.models import *; from app.models.audit_log import AuditLog; from app.models.support_ticket import SupportTicket; from app.core.database import init_db; asyncio.run(init_db()); print('      All tables created.')"

echo.
echo ============================================================
echo  Setup complete! Run dev-start.bat to start the dev server.
echo ============================================================
pause
