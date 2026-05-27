@echo off
REM Speakflow launcher — clears ELECTRON_RUN_AS_NODE (persistently set on this
REM machine via user env vars). If left set, electron.exe runs as plain Node
REM and require('electron') returns a path string instead of the API surface.
setlocal
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" .
exit /b 0
