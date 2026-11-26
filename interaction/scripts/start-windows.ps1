param(
    [string]$ConnectionFile,
    [string]$CharacterFile,
    [string]$SceneFile,
    [switch]$Demo,
    [string]$RestCharacterFile,
    [string]$WorkCharacterFile,
    [string]$DialogueCharacterFile
)

$ErrorActionPreference = "Stop"

$projectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$venvDir = Join-Path $projectDir ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    if ($env:MONA_INTERACTION_PYTHON) {
        $python = $env:MONA_INTERACTION_PYTHON
        $pythonArgs = @()
    } elseif (Get-Command py -ErrorAction SilentlyContinue) {
        $python = "py"
        $pythonArgs = @("-3")
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        $python = "python"
        $pythonArgs = @()
    } else {
        throw "Python 3.11 or later is required. Use an installed Python to continue."
    }

    & $python @pythonArgs -c "import sys; raise SystemExit(sys.version_info < (3, 11))"
    if ($LASTEXITCODE -ne 0) { throw "Python 3.11 or later is required." }
    & $python @pythonArgs -m venv $venvDir
    if ($LASTEXITCODE -ne 0) { throw "Could not create the project virtual environment." }
}

& $venvPython -c "import sys; raise SystemExit(sys.version_info < (3, 11))"
if ($LASTEXITCODE -ne 0) { throw "The project virtual environment requires Python 3.11 or later." }
& $venvPython -m pip install -e $projectDir
if ($LASTEXITCODE -ne 0) { throw "Could not install Mona Interaction into the project virtual environment." }

Write-Host "Open http://127.0.0.1:17880/ . Press Ctrl+C to stop."
$serveArgs = @("-m", "mona_interaction", "serve", "--host", "127.0.0.1", "--port", "17880")
if ($ConnectionFile) { $serveArgs += @("--connection-file", $ConnectionFile) }
if ($CharacterFile) { $serveArgs += @("--character-file", $CharacterFile) }
if ($SceneFile) { $serveArgs += @("--scene-file", $SceneFile) }
if ($RestCharacterFile) { $serveArgs += @("--rest-character-file", $RestCharacterFile) }
if ($WorkCharacterFile) { $serveArgs += @("--work-character-file", $WorkCharacterFile) }
if ($DialogueCharacterFile) { $serveArgs += @("--dialogue-character-file", $DialogueCharacterFile) }
if ($Demo) { $serveArgs += "--demo" }
& $venvPython @serveArgs
exit $LASTEXITCODE
