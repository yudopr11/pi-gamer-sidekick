# Gamer Sidekick — render the bound window to a finished JPEG frame.
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File capture-jpeg.ps1 <hwnd> <maxEdge> <quality>
#
# Scaling and encoding happen here rather than in JavaScript so the intermediate
# bitmap never crosses the process boundary. A 2560x1440 window drawn to PNG is
# ~5.9 MB of base64; decoding that in Node just to resize it again costs more
# than the resize itself. The only thing that should leave this process is the
# finished frame, ~150 KB.
#
# PrintWindow asks the window to draw itself, so this ignores occlusion — the
# terminal the player is typing the question in cannot appear in the frame.
#
# Emits `null` when the window cannot be rendered, which is the caller's signal
# to fall back to grab-region.ps1.

param(
    [Parameter(Mandatory = $true)][string]$Hwnd,
    [int]$MaxEdge = 1280,
    [int]$Quality = 80
)

. (Join-Path $PSScriptRoot 'bootstrap.ps1')

$shot = [GsWin32]::CaptureJpeg([long]$Hwnd, $MaxEdge, $Quality)
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
