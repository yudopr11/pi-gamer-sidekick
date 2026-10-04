# Gamer Sidekick — grab one region of one display, as a finished JPEG frame.
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File grab-region.ps1 <display> <left> <top> <w> <h> [maxEdge] [quality]
#
# The fallback for a window that will not draw itself. Unlike capture-jpeg.ps1
# this records whatever is on top of the region, so the caller has to say so in
# the caption — a vision model reads a hole as content and fills it in
# confidently.
#
# Coordinates are display-relative, matching what Screens() reports from the
# same DPI-virtualised context.

param(
    [Parameter(Mandatory = $true)][int]$Display,
    [Parameter(Mandatory = $true)][int]$Left,
    [Parameter(Mandatory = $true)][int]$Top,
    [Parameter(Mandatory = $true)][int]$Width,
    [Parameter(Mandatory = $true)][int]$Height,
    [int]$MaxEdge = 1280,
    [int]$Quality = 80
)

. (Join-Path $PSScriptRoot 'bootstrap.ps1')

$shot = [GsWin32]::GrabRegion($Display, $Left, $Top, $Width, $Height, $MaxEdge, $Quality)
if ($null -eq $shot) { 'null' } else {
    [ordered]@{
        jpeg         = $shot.Jpeg
        width        = $shot.Width
        height       = $shot.Height
        sourceWidth  = $shot.SourceWidth
        sourceHeight = $shot.SourceHeight
        redMean      = $shot.RedMean
    } | ConvertTo-Json -Compress
}
