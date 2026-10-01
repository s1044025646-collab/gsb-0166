$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$infoPath = Join-Path $root "data\server.json"
if (-not (Test-Path $infoPath)) {
  Write-Host "no data/server.json; nothing to stop"
  exit 0
}
$info = Get-Content $infoPath | ConvertFrom-Json
$proc = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
if ($proc) {
  Stop-Process -Id $info.pid
  Write-Host "stopped pxrd server pid $($info.pid)"
} else {
  Write-Host "pid $($info.pid) was not running"
}
Remove-Item $infoPath -Force
