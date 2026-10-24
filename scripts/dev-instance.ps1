<#
Launches a second, fully isolated QuickTerm instance for local testing
alongside one that's already running.

app.py's "one backend per port" check only looks at the requested port, but
every instance otherwise shares %APPDATA%\quickterm (config.json, the auth
token, workspaces/, assets/, logs/) - two instances on different ports would
still fight over the same files. This script points a throwaway instance at
its own %APPDATA%\quickterm-dev-appdata and a non-default port instead, so it
never touches a live instance's settings, workspace, or sessions.

`uv run quickterm` is only the launcher: it starts the backend detached (which
keeps this APPDATA) and returns at once. Quit the instance from its tray icon.

Usage: .\scripts\dev-instance.ps1 [-Port 8899]
#>
param(
    [int]$Port = 8899
)

$original = $env:APPDATA
$devAppData = Join-Path $env:TEMP "quickterm-dev-appdata"
New-Item -ItemType Directory -Force -Path $devAppData | Out-Null

try {
    $env:APPDATA = $devAppData
    Write-Host "QuickTerm dev instance: port $Port, config at $devAppData"
    uv run quickterm --port $Port
}
finally {
    $env:APPDATA = $original
}
