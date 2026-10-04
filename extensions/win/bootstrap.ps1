# Gamer Sidekick — Win32 interop, compiled once into gs_win32.dll.
#
# Why this exists instead of `active-win`: that package is a native addon whose
# prebuilds were published in 2024. npm 12 blocks install scripts by default, so
# `node-pre-gyp install` never runs — the module then imports *successfully* and
# returns `undefined` instead of throwing. A load-bearing dependency that fails
# silently is worse than a P/Invoke shim. (PRD §11 R-3)
#
# Compiled once, then loaded with Add-Type -Path: ~50ms warm vs ~1s cold.

$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dll = Join-Path $dir 'gs_win32.dll'
$stamp = Join-Path $dir 'gs_win32.stamp'

# Recompile when the source is newer than the last successful build. The stamp
# is written only after a successful compile, so a failed build retries instead
# of leaving a half-written dll that loads forever.
$sourceFile = Join-Path $dir 'win32.cs'
$needsBuild = $true
if ((Test-Path $dll) -and (Test-Path $stamp)) {
    $needsBuild = (Get-Item $stamp).LastWriteTimeUtc -lt (Get-Item $sourceFile).LastWriteTimeUtc
}

if ($needsBuild) {
    $csharp = Get-Content -Raw -Encoding UTF8 $sourceFile
    Remove-Item $dll -Force -ErrorAction SilentlyContinue
    Add-Type -TypeDefinition $csharp -OutputAssembly $dll -OutputType Library `
        -ReferencedAssemblies 'System.Windows.Forms.dll', 'System.Drawing.dll'
    Set-Content -Path $stamp -Value ([datetime]::UtcNow.ToString('o')) -NoNewline
}

if (-not ('GsWin32' -as [type])) { Add-Type -Path $dll }
