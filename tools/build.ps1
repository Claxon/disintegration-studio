# Builds dist/DisintegrationStudio.ccx and dist/DisintegrationStudio-<version>-Installer.zip
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$plugin = Join-Path $root 'disintegration-studio'
$dist = Join-Path $root 'dist'
$version = (Get-Content (Join-Path $plugin 'manifest.json') -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Force $dist | Out-Null
# Windows' own bsdtar; Git for Windows puts a GNU tar on PATH that can't write zips
$tar = Join-Path $env:SystemRoot 'System32/tar.exe'

$ccx = Join-Path $dist 'DisintegrationStudio.ccx'
$zip = Join-Path $dist 'plugin.zip'
if (Test-Path $zip) { Remove-Item $zip }
Push-Location $plugin
& $tar -a -c -f $zip manifest.json index.html styles.css ui-controls.css ui-tips.css ui-previews.css js icons -C $root LICENSE
Pop-Location
Move-Item -Force $zip $ccx

$stage = Join-Path $dist 'installer'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory $stage | Out-Null
Copy-Item $ccx $stage
Copy-Item (Join-Path $root 'installer\*') $stage
Copy-Item (Join-Path $root 'LICENSE') $stage
$inst = Join-Path $dist "DisintegrationStudio-$version-Installer.zip"
if (Test-Path $inst) { Remove-Item $inst }
Push-Location $stage
& $tar -a -c -f $inst *
Pop-Location
Remove-Item -Recurse -Force $stage
Write-Host "Built $ccx and $inst"
