$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root
$infoPath = Join-Path $root "data\server.json"
if (Test-Path $infoPath) {
  $old = Get-Content $infoPath | ConvertFrom-Json
  if ($old.pid -and (Get-Process -Id $old.pid -ErrorAction SilentlyContinue)) {
    Write-Host "server already running: http://127.0.0.1:$($old.port) (pid $($old.pid))"
    exit 0
  }
}
$p = Start-Process node -ArgumentList "--experimental-sqlite","--import","tsx","src/server.ts" -PassThru -WindowStyle Hidden
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 300
  if (Test-Path $infoPath) {
    $info = Get-Content $infoPath | ConvertFrom-Json
    if ($info.pid -eq $p.Id) {
      Write-Host "pxrd API listening on http://127.0.0.1:$($info.port) (pid $($p.Id))"
      exit 0
    }
  }
}
Write-Error "server did not publish data/server.json in time"
exit 1
