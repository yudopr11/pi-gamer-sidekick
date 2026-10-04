# Gamer Sidekick — photograph one window's own content, ignoring occluders.
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File capture-window.ps1 <hwnd>
#
# Cropping a full-desktop grab records whatever is on top of the game. For this
# package that is always the terminal the player is typing the question in, so
# half of every frame used to be pi. PrintWindow asks the window to draw itself
# into our DC instead, which is immune to occlusion.
#
# Emits the literal string `null` when the window cannot be rendered, which is
# the caller's signal to fall back to the desktop grab.

param([Parameter(Mandatory = $true)][string]$Hwnd)

. (Join-Path $PSScriptRoot 'bootstrap.ps1')

$png = [GsWin32]::Capture([long]$Hwnd)
if ($null -eq $png) { 'null' } else { $png }