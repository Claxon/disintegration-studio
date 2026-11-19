# Installs Disintegration Studio into Photoshop using Adobe's Unified Plugin Installer Agent.
#
# Installing over an earlier version doesn't always retire it: Photoshop's plugin list (PS.json)
# can be left with both versions enabled, and Photoshop then loads whichever comes first, often
# the old one, every time it starts. So after installing, every other version of the plugin is
# marked "uninstalling" (what the agent does when it works); Photoshop deletes those at its next
# start. Photoshop has to be closed for that, since it may write the list back when it quits.
param([string]$Ccx, [switch]$NoWait)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Ccx) { $Ccx = Join-Path $here 'DisintegrationStudio.ccx' }
if (-not (Test-Path $Ccx)) { Write-Host "Can't find $Ccx" -ForegroundColor Red; exit 1 }
$Ccx = (Resolve-Path $Ccx).Path
$pluginId = 'com.claxo.disintegrationstudio'

$upia = Join-Path ${env:CommonProgramFiles} 'Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe'
if (-not (Test-Path $upia)) {
  Write-Host 'Adobe''s plugin installer was not found. Install Photoshop via Creative Cloud first.' -ForegroundColor Red
  exit 1
}

# the version being installed, from the package's manifest
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($Ccx)
try {
  $entry = $zip.Entries | Where-Object { $_.FullName -eq 'manifest.json' } | Select-Object -First 1
  $reader = New-Object System.IO.StreamReader($entry.Open())
  $manifest = $reader.ReadToEnd() | ConvertFrom-Json
  $reader.Close()
} finally { $zip.Dispose() }
$version = $manifest.version
if ($manifest.id -ne $pluginId) { Write-Host "That package is $($manifest.id), not $pluginId." -ForegroundColor Red; exit 1 }

# Photoshop must be closed
if (Get-Process Photoshop -ErrorAction SilentlyContinue) {
  if ($NoWait) { Write-Host 'Photoshop is running. Quit it and run this again.' -ForegroundColor Red; exit 2 }
  Write-Host 'Please quit Photoshop (save your work first). Waiting for it to close...' -ForegroundColor Yellow
  while (Get-Process Photoshop -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 2 }
  Start-Sleep -Seconds 3 # let it finish writing its files
}

# The installer agent refuses some source locations (status -631), so install from a temp copy.
$tmp = Join-Path $env:TEMP ('DisintegrationStudio-' + [guid]::NewGuid().ToString('N') + '.ccx')
Copy-Item $Ccx $tmp
try {
  Write-Host "Installing Disintegration Studio $version..."
  & $upia /install $tmp | Out-Host
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
}

# Retire every other version in Photoshop's plugin list.
$list = Join-Path $env:APPDATA 'Adobe\UXP\PluginsInfo\v1\PS.json'
if (-not (Test-Path $list)) { Write-Host "Photoshop's plugin list was not found at $list." -ForegroundColor Red; exit 1 }
$json = Get-Content $list -Raw | ConvertFrom-Json
$mine = @($json.plugins | Where-Object { $_.pluginId -eq $pluginId })
$new = @($mine | Where-Object { $_.versionString -eq $version })
if (-not $new) { Write-Host "Installation failed: version $version is not in Photoshop's plugin list. Make sure you are signed in to Creative Cloud." -ForegroundColor Red; exit 1 }
$changed = $false
foreach ($p in $mine) {
  if ($p.versionString -eq $version) {
    if ($p.status -ne 'enabled') { $p.status = 'enabled'; $changed = $true }
  } elseif ($p.status -ne 'uninstalling') {
    Write-Host "Retiring version $($p.versionString)."
    $p.status = 'uninstalling'; $changed = $true
  }
}
if ($changed) {
  Copy-Item $list ($list + '.before-' + $version) -Force
  # (no byte-order mark: Windows PowerShell's Set-Content -Encoding UTF8 would add one)
  [System.IO.File]::WriteAllText($list, ($json | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding $false))
}

$enabled = @((Get-Content $list -Raw | ConvertFrom-Json).plugins | Where-Object { $_.pluginId -eq $pluginId -and $_.status -eq 'enabled' })
if ($enabled.Count -eq 1 -and $enabled[0].versionString -eq $version) {
  Write-Host ''
  Write-Host "Disintegration Studio $version is installed." -ForegroundColor Green
  Write-Host 'Start Photoshop, then use Plugins > Disintegration Studio > Open Disintegration Studio...'
  Write-Host "The dialog shows v$version at the right of its toolbar."
  exit 0
}
Write-Host "Something is wrong with Photoshop's plugin list: $($enabled.Count) enabled versions." -ForegroundColor Red
exit 1
