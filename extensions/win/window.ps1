# Gamer Sidekick — query one window by HWND as JSON.
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File window.ps1 <hwnd>
#
# The capture hot path. Emits the literal string `null` when the handle is gone,
# which is the signal to report a stale binding rather than to keep cropping
# whatever now owns that handle. (PRD §6.2.1, R-5)

param([Parameter(Mandatory = $true)][string]$Hwnd)

. (Join-Path $PSScriptRoot 'bootstrap.ps1')

$w = [GsWin32]::Query([long]$Hwnd)
if ($null -eq $w) { 'null' } else { $w | ConvertTo-Json -Compress -Depth 3 }
