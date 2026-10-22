# Sets up and starts Olliviero Spaces on Windows. Run it through start.bat.
# The first run installs what is missing; later runs start in a few seconds.

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
$Host.UI.RawUI.WindowTitle = "Olliviero Spaces"
$Url = "http://localhost:8000"

function Say($text) { Write-Host "`n$text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "`n$text" -ForegroundColor Red; exit 1 }
function Have($command) { [bool](Get-Command $command -ErrorAction SilentlyContinue) }

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
}

function Install-Package($id, $name) {
    if (-not (Have "winget")) {
        Fail "Fant ikke $name, og Windows mangler winget til å installere det. Installer $name selv og start på nytt."
    }
    Say "Installerer $name. Det skjer bare første gang og kan ta noen minutter ..."
    winget install --id $id --exact --silent --accept-source-agreements --accept-package-agreements
    Refresh-Path
}

# Already running? Then just open the page.
try {
    Invoke-WebRequest "$Url/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
    Say "Appen kjører allerede. Åpner $Url"
    Start-Process $Url
    exit 0
} catch {}

# 1. Python
function Find-Python {
    if (Have "py") {
        foreach ($version in "3.12", "3.13", "3.11", "3.10") {
            & py "-$version" -c "import sys" 2>$null
            if ($LASTEXITCODE -eq 0) { return @("py", "-$version") }
        }
    }
    return $null
}

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    $python = Find-Python
    if (-not $python) {
        Install-Package "Python.Python.3.12" "Python"
        $python = Find-Python
        if (-not $python) { Fail "Python ble installert, men Windows finner det ikke ennå. Lukk vinduet og start start.bat på nytt." }
    }
    Say "Lager et eget Python-miljø for appen ..."
    & $python[0] $python[1] -m venv .venv
    if ($LASTEXITCODE -ne 0) { Fail "Klarte ikke å lage Python-miljøet." }
}

# 2. ffmpeg, which cuts the videos
if (-not (Have "ffmpeg")) {
    Install-Package "Gyan.FFmpeg" "ffmpeg"
    if (-not (Have "ffmpeg")) { Fail "ffmpeg ble installert, men Windows finner det ikke ennå. Lukk vinduet og start start.bat på nytt." }
}

# 3. Python packages, reinstalled only when requirements.txt changes
$requirements = Join-Path $PSScriptRoot "server\requirements.txt"
$stamp = Join-Path $PSScriptRoot ".venv\requirements.sha256"
$hash = (Get-FileHash $requirements -Algorithm SHA256).Hash
if (-not (Test-Path $stamp) -or (Get-Content $stamp) -ne $hash) {
    Say "Installerer pakkene appen trenger. Første gang tar dette noen minutter ..."
    & $venvPython -m pip install --upgrade pip --quiet
    & $venvPython -m pip install -r $requirements
    if ($LASTEXITCODE -ne 0) { Fail "Installasjonen av pakkene feilet. Se feilmeldingen over." }
    Set-Content $stamp $hash
}

# 4. Claude API key, asked for once and kept in data\api-key.txt
New-Item -ItemType Directory -Force -Path "data" | Out-Null
$keyFile = Join-Path $PSScriptRoot "data\api-key.txt"
if (-not (Test-Path $keyFile)) {
    Say "Har du en API-nøkkel fra console.anthropic.com? Med den velger Claude de beste klippene."
    $key = Read-Host "Lim inn nøkkelen og trykk Enter (eller bare Enter for å hoppe over)"
    Set-Content $keyFile $key.Trim()
    Write-Host "Nøkkelen er lagret i data\api-key.txt. Der kan du endre eller fjerne den senere."
}
$key = (Get-Content $keyFile -Raw)
if ($key) { $env:ANTHROPIC_API_KEY = $key.Trim() }

# 5. Start
$env:Path = (Join-Path $PSScriptRoot ".venv\Scripts") + ";" + $env:Path
$env:CAPTION_FONT = "Arial"
$env:WHISPER_DEVICE = "cpu"

Say "Starter appen på $Url. La dette vinduet stå åpent mens du bruker den, og lukk det for å stoppe."
# A hidden helper opens the browser as soon as the server answers. The command
# is passed encoded so no quoting can break on its way to the new process.
$opener = "for (`$i = 0; `$i -lt 60; `$i++) { try { Invoke-WebRequest '$Url/api/health' -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process '$Url'; break } catch { Start-Sleep 1 } }"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($opener))
Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile -EncodedCommand $encoded"
& $venvPython -m uvicorn app:app --app-dir server --host 127.0.0.1 --port 8000
