@echo off
setlocal

set "SCRIPT=%~dp0smart-approve.mjs"

:: 1. node in PATH
where node >nul 2>nul
if %errorlevel%==0 (
    node "%SCRIPT%"
    exit /b %errorlevel%
)

:: 2. fnm (suppress "no version in dotfiles" error, fall through on failure)
where fnm >nul 2>nul
if %errorlevel%==0 (
    fnm exec -- node "%SCRIPT%" 2>nul
    if not errorlevel 1 exit /b 0
)

:: 3. Program Files (official installer)
if exist "%ProgramFiles%\nodejs\node.exe" (
    "%ProgramFiles%\nodejs\node.exe" "%SCRIPT%"
    exit /b %errorlevel%
)

:: 4. fnm_multishells (fnm managed versions on Windows)
if exist "%LOCALAPPDATA%\fnm_multishells" (
    for /d %%d in ("%LOCALAPPDATA%\fnm_multishells\*") do (
        if exist "%%d\node.exe" (
            "%%d\node.exe" "%SCRIPT%"
            exit /b %errorlevel%
        )
    )
)

:: 5. nvm for Windows (check all installed versions)
if exist "%APPDATA%\nvm" (
    for /d %%d in ("%APPDATA%\nvm\v*") do (
        if exist "%%d\node.exe" (
            "%%d\node.exe" "%SCRIPT%"
            exit /b %errorlevel%
        )
    )
)

:: 6. Volta
if exist "%LOCALAPPDATA%\Volta\bin\node.exe" (
    "%LOCALAPPDATA%\Volta\bin\node.exe" "%SCRIPT%"
    exit /b %errorlevel%
)

:: Node not found — exit silently (default permission flow)
exit /b 0
