@echo off
setlocal

:: Try node directly first
where node >nul 2>nul
if %errorlevel%==0 (
    node "%~dp0smart-approve.mjs"
    exit /b %errorlevel%
)

:: Try fnm exec (winget-installed fnm)
where fnm >nul 2>nul
if %errorlevel%==0 (
    fnm exec -- node "%~dp0smart-approve.mjs"
    exit /b %errorlevel%
)

:: Try common Node.js install paths
if exist "%ProgramFiles%\nodejs\node.exe" (
    "%ProgramFiles%\nodejs\node.exe" "%~dp0smart-approve.mjs"
    exit /b %errorlevel%
)

if exist "%LOCALAPPDATA%\fnm_multishells" (
    for /d %%d in ("%LOCALAPPDATA%\fnm_multishells\*") do (
        if exist "%%d\node.exe" (
            "%%d\node.exe" "%~dp0smart-approve.mjs"
            exit /b %errorlevel%
        )
    )
)

:: nvm for Windows
if exist "%APPDATA%\nvm\current\node.exe" (
    "%APPDATA%\nvm\current\node.exe" "%~dp0smart-approve.mjs"
    exit /b %errorlevel%
)

:: Volta
if exist "%LOCALAPPDATA%\Volta\bin\node.exe" (
    "%LOCALAPPDATA%\Volta\bin\node.exe" "%~dp0smart-approve.mjs"
    exit /b %errorlevel%
)

:: Node not found — exit silently (default flow)
exit /b 0
