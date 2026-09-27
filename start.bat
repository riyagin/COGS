@echo off
setlocal

set NODE_DIR=C:\Users\USER\AppData\Local\nvm\v20.20.2
set PATH=%NODE_DIR%;%PATH%
set ROOT=%~dp0

echo Starting COGS Calculator...

start "COGS Backend" cmd /k "cd /d "%ROOT%backend" && node server.js"
start "COGS Frontend" cmd /k "cd /d "%ROOT%frontend" && npm run dev"

echo Waiting for servers to start...
timeout /t 4 /nobreak >nul

start "" "http://localhost:5173"

echo Done. Close the two terminal windows to stop the servers.
