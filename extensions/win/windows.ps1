# Gamer Sidekick — list every visible top-level window as JSON.
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File windows.ps1

. (Join-Path $PSScriptRoot 'bootstrap.ps1')

[GsWin32]::Enumerate($true) | ConvertTo-Json -Compress -Depth 3
