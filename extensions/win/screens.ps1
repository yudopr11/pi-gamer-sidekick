# Gamer Sidekick — every display's pixel bounds as JSON.
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File screens.ps1
#
# System.Windows.Forms.Screen is the only built-in that reports pixel geometry.
# DpiAwareScreen (the Win32 equivalent) reports only ~24 logical coordinates and
# cannot tell you where a window physically is, which is what cropping needs.

. (Join-Path $PSScriptRoot 'bootstrap.ps1')

[GsWin32]::Screens() | ConvertTo-Json -Compress -Depth 3
