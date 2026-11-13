# Run the whole hunt-c probe set, one probe at a time, each with the sample it
# was written for. Keys are `?scenario=` values from scenarios/hunt-c.mjs.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\browser\run-hunt-c.ps1 -Port 10490
#   ... -Only c-pw,c-stack          # just these
#   ... -Sample outline.pdf         # force one sample on every probe
#
# Why the per-probe sample matters: `c-find-count` and `c-find-typing` type
# "Page 2 of" / "Page 3 of", and `c-find-index-late` types "Page 199 of". Run
# them against a document that does not contain those words and they report a
# clean, plausible, completely empty reading -- a green line measuring air.
#
# Exit codes are the driver's: 0 = probe finished (read the notes), 1 = probe
# reported ERROR=, 14 = the driver itself failed (socket/timeout/no port), and
# those three must not be confused with each other.
param(
  [int] $Port = 10490,
  [string] $Only = '',
  [string] $Sample = '',
  [int] $GapSeconds = 3
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $here 'run-scenario.ps1'
$utf8 = [System.Text.UTF8Encoding]::new($false)

# name -> @(sample, extra, why this sample)
$plan = @(
  @{ N = 'c-find-count';      S = 'plain.pdf';   E = '&prod=1'; W = 'types Page 2 of / Page 3 of' },
  @{ N = 'c-find-step';       S = 'outline.pdf'; E = '&prod=1'; W = '' },
  @{ N = 'c-find-esc';        S = 'outline.pdf'; E = '&prod=1'; W = '' },
  @{ N = 'c-find-jump';       S = 'outline.pdf'; E = '&prod=1'; W = '' },
  @{ N = 'c-aria';            S = 'outline.pdf'; E = '&prod=1'; W = '' },
  @{ N = 'c-find-index';      S = 'outline.pdf'; E = '&prod=1'; W = '' },
  @{ N = 'c-find-typing';     S = 'plain.pdf';   E = '&prod=1'; W = 'types Page 2 of / Page 199 of' },
  @{ N = 'c-find-index-late'; S = 'big.pdf';     E = '&prod=1'; W = 'types Page 199 of: needs 200 pages' },
  @{ N = 'c-live';            S = 'outline.pdf'; E = '&prod=1'; W = '' },
  @{ N = 'c-narrow';          S = 'outline.pdf'; E = '&prod=1&pane=260'; W = '' },
  @{ N = 'c-pw';              S = 'pw-aes.pdf';  E = '&prod=1'; W = 'encrypted, password secret' },
  @{ N = 'c-pw-cancel';       S = 'pw-aes.pdf';  E = '&prod=1'; W = 'encrypted, password secret' },
  @{ N = 'c-stack';           S = 'pw-aes.pdf';  E = '&prod=1'; W = 'encrypted, password secret' },
  @{ N = 'c-stack2';          S = 'outline.pdf'; E = '&prod=1'; W = '' },
  @{ N = 'hunt-c-switchcache'; S = 'outline.pdf'; E = '&prod=1'; W = 'loads big.pdf itself' },
  @{ N = 'hunt-c-fonts';      S = 'outline.pdf'; E = '&prod=1'; W = '' }
)

$wanted = @()
if ($Only -ne '') { $wanted = $Only.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' } }

$rows = @()
$unknown = @()
foreach ($item in $plan) {
  if ($wanted.Count -gt 0 -and $wanted -notcontains $item.N) { continue }
  # NB: `$sample` and `$Sample` are the same variable in PowerShell (names are
  # case-insensitive), so this one is called `$chosen`. With `$sample` the first
  # probe's sample stuck and every later probe silently ran with it -- eleven
  # probes "passing" against a document they were not written for.
  $chosen = if ($Sample -ne '') { $Sample } else { $item.S }
  if ($item.W -ne '') { Write-Host ("# {0}: {1}" -f $item.N, $item.W) }
  $line = & powershell -NoProfile -ExecutionPolicy Bypass -File $runner -Name $item.N -Sample $chosen -Port $Port -Extra $item.E 2>$null
  $exit = ($line | Where-Object { $_ -like 'DRIVER_EXIT=*' }) -join ''
  $stale = ($line | Where-Object { $_ -like 'STALE=*' }) -join ''
  $errs = @($line | Where-Object { $_ -like 'err:*' })
  # run-scenario.ps1 already strips the driver's `log: ` prefix and prints the
  # notes raw, so "the notes" are simply every line that is not one of the
  # bookkeeping lines.
  $notes = ($line | Where-Object {
      $t = $_.ToString()
      $t -notlike 'err:*' -and $t -notlike 'ERR:*' -and $t -notlike 'DRIVER_EXIT=*' -and $t -notlike 'STALE=*' -and $t.Trim() -ne ''
    }) -join ' '
  $rows += [pscustomobject]@{
    probe = $item.N
    sample = $chosen
    exit = ($exit -replace 'DRIVER_EXIT=', '')
    stale = if ($stale -eq '') { '-' } else { ($stale -replace 'STALE=', 'STALE:') }
    errLines = $errs.Count
    notes = $notes.Trim()
  }
  Start-Sleep -Seconds $GapSeconds
}

if ($wanted.Count -gt 0) {
  $known = $plan | ForEach-Object { $_.N }
  $unknown = $wanted | Where-Object { $known -notcontains $_ }
  if ($unknown.Count -gt 0) { Write-Host ("unknown probe name(s): {0}" -f ($unknown -join ', ')) }
}

# One screen: verdict per probe, then the full note line for whoever wants it.
Write-Host ''
Write-Host ('{0,-18} {1,-13} {2,-4} {3,-14} {4}' -f 'probe', 'sample', 'ex', 'stale', 'err')
foreach ($row in $rows) {
  Write-Host ('{0,-18} {1,-13} {2,-4} {3,-14} {4}' -f $row.probe, $row.sample, $row.exit, $row.stale, $row.errLines)
}
$driverFails = @($rows | Where-Object { $_.exit -eq '14' })
$probeFails = @($rows | Where-Object { $_.exit -eq '1' })
Write-Host ''
if ($driverFails.Count -eq 0 -and $probeFails.Count -eq 0) {
  Write-Host 'all probes finished (exit 0) -- now read the notes, exit 0 does not mean green'
} else {
  if ($probeFails.Count -gt 0) {
    Write-Host ('probe reported ERROR= : {0}' -f (($probeFails | ForEach-Object { $_.probe }) -join ', '))
  }
  if ($driverFails.Count -gt 0) {
    Write-Host ('driver problem (nothing measured) : {0}' -f (($driverFails | ForEach-Object { $_.probe }) -join ', '))
  }
  Write-Host 'exit 14 = driver (socket/timeout/no port), exit 1 = the probe itself said ERROR='
}
$reportDir = Join-Path $env:TEMP 'hunt-c-report'
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir | Out-Null }
$path = Join-Path $reportDir ('run-' + (Get-Date -Format 'HHmmss') + '.txt')
[System.IO.File]::WriteAllLines($path, ($rows | ForEach-Object { "$($_.probe)|$($_.sample)|exit=$($_.exit)|$($_.stale)|err=$($_.errLines)|$($_.notes)" }), $utf8)
Write-Host ('notes saved: ' + $path)
