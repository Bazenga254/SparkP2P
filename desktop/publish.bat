@echo off
echo ================================
echo   SparkP2P Publisher
echo ================================
echo.

:: Show current version
for /f "tokens=2 delims=:, " %%a in ('findstr /i "\"version\"" package.json') do (
    set CURRENT=%%~a
    goto :found
)
:found
echo Current version: %CURRENT%
echo.

set /p NEW_VERSION="Enter new version (e.g. 1.0.2): "

if "%NEW_VERSION%"=="" (
    echo No version entered. Aborting.
    pause
    exit /b 1
)

:: Update version in package.json
powershell -Command "(Get-Content package.json) -replace '\"version\": \"%CURRENT%\"', '\"version\": \"%NEW_VERSION%\"' | Set-Content package.json"

echo.
echo Version updated: %CURRENT% → %NEW_VERSION%
echo Publishing to GitHub...
echo.

if "%GH_TOKEN%"=="" set /p GH_TOKEN="Enter GitHub token: "
npm run publish

echo.
echo ================================
echo   Done! v%NEW_VERSION% published.
echo ================================
pause
