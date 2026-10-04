# Gamer Sidekick — what is covering the game window, as JSON.
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File occluders.ps1 <hwnd>
#
# Not cosmetic. An occluded frame is a frame the model will describe confidently
# and wrongly, so the caption has to be able to say "your terminal was on top of
# this". Empty array means nothing is covering the window.

param([Parameter(Mandatory = $true)][string]$Hwnd)

. (Join-Path $PSScriptRoot 'bootstrap.ps1')

$hits = [GsWin32]::Occluders([long]$Hwnd)
if ($null -eq $hits -or $hits.Count -eq 0) { '[]' } else { $hits | ConvertTo-Json -Compress }