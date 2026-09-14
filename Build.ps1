param([switch]$SkipDependencyInstall)
$ErrorActionPreference = 'Stop'
try {
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) { throw 'Node.js was not found. Install Node.js 20 or newer from https://nodejs.org/ and run Build.cmd again. No TV changes were made.' }
    $version = & $node.Source --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.') { throw 'Node.js version could not be checked.' }
    if ([int]$Matches[1] -lt 20) { throw 'The build requires Node.js 20 or newer. TV runtime requirements are checked separately.' }
    $npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $npm) { throw 'npm.cmd was not found. Repair the Node.js installation before building.' }
    Push-Location $PSScriptRoot
    try {
        Write-Host "Node $(& $node.Source --version); preparing Unknown module" -ForegroundColor Cyan
        if (-not $SkipDependencyInstall) {
            & $npm.Source ci --ignore-scripts --no-fund --no-audit
            if ($LASTEXITCODE -ne 0) { throw 'Locked dependency installation failed.' }
        }
        & $npm.Source test
        if ($LASTEXITCODE -ne 0) { throw 'Tests failed; release build stopped.' }
        & $npm.Source run build
        if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' }
        Write-Host "Build complete: $PSScriptRoot\dist" -ForegroundColor Green
        Write-Host 'No TV connection, installation or GitHub publication was performed.'
    } finally { Pop-Location }
} catch { Write-Error $_ -ErrorAction Continue; exit 1 }
