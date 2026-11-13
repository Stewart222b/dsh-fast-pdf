# Drive one harness scenario in headless Edge and print what the page reported.
# The static server blocks by design, so start it in another window first:
#   node tests\host-route-live.mjs --serve 8899 tests\browser
# Then, for example:
#   run-scenario.ps1 -Name find -Sample outline.pdf -Port 9900 -Extra '&dark=1'
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$Sample,
  [int]$Port = 9900,
  [string]$Extra = ""
)

$ErrorActionPreference = 'Continue'
# A run that spans an edit of the plugin's own sources measures two builds at
# once: the page pulls client.js and the helper modules in lazily, so the
# version that opened is not necessarily the version under test. Take a
# fingerprint before the browser starts and compare it after; the driver's exit
# code is left alone.
$watched = @('client.js', 'index.js', 'translate.js') |
  ForEach-Object { Join-Path $PSScriptRoot "..\..\$_" }
$watched += Get-ChildItem (Join-Path $PSScriptRoot "..\..\public") -Filter '*.mjs' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName }
$watched += Get-ChildItem (Join-Path $PSScriptRoot "scenarios") -Filter '*.mjs' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName }
$watched += (Join-Path $PSScriptRoot "index.html")
$stamp = @{}
foreach ($file in $watched) {
  if (Test-Path $file) {
    $item = Get-Item $file
    $stamp[$item.FullName] = "$($item.LastWriteTimeUtc.Ticks)/$($item.Length)"
  }
}
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$node = 'C:\Users\SW0178\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$driver = 'C:\Users\SW0178\Documents\deepseek-harness\default-workspace\plugins\dsh-fast-pdf\tests\browser\drive.mjs'
# The profile has to carry the port as well as the name: two runs of the same
# scenario on two ports are meant to overlap (that is what two ports are for),
# and with the name alone the second one deletes the first one's profile out
# from under its live browser — measured as `DRIVER_SOCKET_CLOSED the socket
# closed (1006)` in the first run, and earlier tonight as an exit 13 with no
# cause at all.
$profile = Join-Path $env:TEMP "fp-run-$Name-$Port"
if (Test-Path $profile) { Remove-Item $profile -Recurse -Force }

# The pane reads renderer bodies through the plugin's own route, which needs a
# real path on disk — so the harness is told where the sample actually lives.
$disk = Join-Path $PSScriptRoot "samples\$Sample"
$diskParam = "&disk=" + [System.Uri]::EscapeDataString($disk)
$url = "http://127.0.0.1:8899/index.html?scenario=$Name&pdf=./samples/$Sample&primitives=1$Extra$diskParam"
$proc = Start-Process -FilePath $edge -PassThru -WindowStyle Hidden -ArgumentList @(
  '--headless=new', "--remote-debugging-port=$Port", "--user-data-dir=$profile",
  '--window-size=520,820', '--disable-gpu', '--enable-precise-memory-info',
  '--no-first-run', '--no-default-browser-check', $url
)

$result = & $node $driver $Port (Join-Path $env:TEMP "fp-$Name.png") 90000 2>&1
$line = ($result | Where-Object { $_.ToString().StartsWith('log:') }) -join ''
if ($line) { $line.Substring(4) } else { "ERR: " + (($result | Select-Object -First 3) -join ' | ') }
# Driver errors used to be dropped here, so a scenario that threw looked exactly
# like a scenario that simply said less. Print them, and the code they came with.
$result | Where-Object { $_.ToString().StartsWith('err:') } | ForEach-Object { $_.ToString() }
"DRIVER_EXIT=$LASTEXITCODE"

# Anything that moved while the browser was open makes this reading belong to no
# single build. Printed after the exit code, which keeps its own meaning.
$changed = @()
foreach ($file in $watched) {
  if (-not (Test-Path $file)) { continue }
  $item = Get-Item $file
  if ($stamp[$item.FullName] -ne "$($item.LastWriteTimeUtc.Ticks)/$($item.Length)") {
    $changed += (Split-Path $file -Leaf)
  }
}
if ($changed.Count -gt 0) { "STALE=1 changed=" + ($changed -join ',') }

# Clean up this run's browser only, by process tree. Sweeping every `msedge`
# started in the last two minutes also takes out another run's headless browser
# (two scenarios on two ports are meant to be able to overlap) and the user's
# own Edge window.
try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
& taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
