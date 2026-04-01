@echo off
echo ============================================================
echo  SparkP2P - Local Dev Setup
echo ============================================================
echo.

REM Check PostgreSQL is installed
where psql >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] PostgreSQL not found. Please install it first:
    echo   https://www.postgresql.org/download/windows/
    echo   - Default port: 5432
    echo   - Set postgres user password to: postgres
    pause
    exit /b 1
)

echo [1/4] Creating local database: sparkp2p_dev ...
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
pip install -r requirements.txt -q
pip install openai -q
echo       Dependencies installed.

echo.
echo [4/4] Setup complete!
echo.
echo ============================================================
echo  Run  dev-start.bat  to start the local dev server
echo ============================================================
pause
