# Builds dist\dark-theme-everywhere.crx (and a .zip for stores / Firefox).
# The private key is kept in keys\dark-theme-everywhere.pem: keep it secret and reuse it for every
# update, otherwise the extension ID changes.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$name = 'dark-theme-everywhere'
$dist = Join-Path $root 'dist'
$build = Join-Path $dist $name
$keyDir = Join-Path $root 'keys'
$key = Join-Path $keyDir "$name.pem"

$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Chrome or Edge not found' }

if (Test-Path $build) { Remove-Item -Recurse -Force $build }
New-Item -ItemType Directory -Force $build | Out-Null
Copy-Item (Join-Path $root 'manifest.json') $build
foreach ($dir in 'src', 'popup', 'options', 'ui', 'icons') {
  Copy-Item -Recurse (Join-Path $root $dir) (Join-Path $build $dir)
}

# Zip (Chrome Web Store / Firefox upload)
$zip = Join-Path $dist "$name.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
# tar.exe (built into Windows 10+) writes zip entries with "/" separators, unlike Compress-Archive in PS 5.1
Push-Location $build
try { tar.exe -a -c -f $zip manifest.json src popup options ui icons } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'zip failed' }

# CRX
$profileDir = Join-Path $env:TEMP "$name-pack-profile"
$packArgs = @("--pack-extension=$build", "--no-message-box", "--user-data-dir=$profileDir")
if (Test-Path $key) { $packArgs += "--pack-extension-key=$key" }
$p = Start-Process -FilePath $browser -ArgumentList $packArgs -Wait -PassThru
$crx = "$build.crx"
if (-not (Test-Path $crx)) { throw "Packing failed (exit code $($p.ExitCode))" }
Move-Item -Force $crx (Join-Path $dist "$name.crx")

# First build: the browser created a new key next to the folder - move it to keys\
$newKey = "$build.pem"
if (Test-Path $newKey) {
  New-Item -ItemType Directory -Force $keyDir | Out-Null
  Move-Item -Force $newKey $key
  Write-Host "New private key: $key"
}
Write-Host "CRX: $(Join-Path $dist "$name.crx")"
Write-Host "ZIP: $zip"
