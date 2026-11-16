$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Set-Location -LiteralPath $PSScriptRoot
. (Join-Path $PSScriptRoot "launcher-config.ps1")

$ProjectDir = $PSScriptRoot
$PythonExe = Join-Path $ProjectDir ".venv311\Scripts\python.exe"
$SetupScript = Join-Path $ProjectDir "setup_and_run.ps1"
$MainPy = Join-Path $ProjectDir "main.py"
$EnvFile = Join-Path $ProjectDir ".env"
$EnvExample = Join-Path $ProjectDir ".env.example"

$LogsDir = Join-Path $ProjectDir "logs"
$RuntimeDir = Join-Path $ProjectDir "runtime"
$StartupLog = Join-Path $LogsDir "startup-latest.log"
$LlamaOutLog = Join-Path $LogsDir "llama-server.log"
$LlamaErrLog = Join-Path $LogsDir "llama-server-error.log"
$AppOutLog = Join-Path $LogsDir "dental-app.log"
$AppErrLog = Join-Path $LogsDir "dental-app-error.log"
$VisionPidFile = Join-Path $RuntimeDir "vision-mmproj.pid"

New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
"" | Set-Content -LiteralPath $StartupLog -Encoding UTF8

function Write-Log([string]$Message, [string]$Color = "Gray") {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $Message
    Add-Content -LiteralPath $StartupLog -Value $line -Encoding UTF8
    Write-Host $line -ForegroundColor $Color
}

function Test-Url([string]$Url, [int]$TimeoutSeconds = 2) {
    try {
        $response = Invoke-WebRequest `
            -UseBasicParsing `
            -Uri $Url `
            -TimeoutSec $TimeoutSeconds `
            -ErrorAction Stop
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
    }
    catch {
        return $false
    }
}

function Test-LlamaReady {
    $healthUrl = "http://${LlamaHost}:${LlamaPort}/health"
    $modelsUrl = "http://${LlamaHost}:${LlamaPort}/v1/models"

    if (-not (Test-Url $healthUrl 2)) {
        return $false
    }

    try {
        $models = Invoke-RestMethod `
            -Uri $modelsUrl `
            -TimeoutSec 3 `
            -Method Get `
            -ErrorAction Stop
        $ids = @($models.data | ForEach-Object { $_.id })
        return ($ids -contains $ModelAlias)
    }
    catch {
        return $false
    }
}

function Test-VisionPidMatches {
    if (-not $UseMmproj) {
        return $true
    }
    if (-not (Test-Path -LiteralPath $VisionPidFile)) {
        return $false
    }

    try {
        $savedPid = [int](Get-Content -LiteralPath $VisionPidFile -Raw).Trim()
        $connections = Get-NetTCPConnection `
            -LocalPort $LlamaPort `
            -State Listen `
            -ErrorAction SilentlyContinue
        return @($connections | Where-Object {
            $_.OwningProcess -eq $savedPid
        }).Count -gt 0
    }
    catch {
        return $false
    }
}

function Test-CorrectLlamaModel {
    if (-not (Test-LlamaReady)) {
        return $false
    }

    if (-not $UseMmproj) {
        return $true
    }

    try {
        $models = Invoke-RestMethod `
            -Uri "http://${LlamaHost}:${LlamaPort}/v1/models" `
            -TimeoutSec 3 `
            -Method Get `
            -ErrorAction Stop
        $modelItem = @($models.data | Where-Object {
            $_.id -eq $ModelAlias
        }) | Select-Object -First 1
        $serialized = $modelItem | ConvertTo-Json -Depth 8 -Compress
        if (
            $serialized -match "multimodal" -or
            $serialized -match "vision"
        ) {
            return $true
        }
    }
    catch {
        # Older llama.cpp builds may not report model capabilities.
    }

    return (Test-VisionPidMatches)
}

function Stop-PortListener([int]$Port) {
    try {
        $connections = Get-NetTCPConnection `
            -LocalPort $Port `
            -State Listen `
            -ErrorAction SilentlyContinue

        foreach ($connection in $connections) {
            if ($connection.OwningProcess) {
                Write-Log "Stopping old process on port $Port (PID $($connection.OwningProcess))" "Yellow"
                Stop-Process `
                    -Id $connection.OwningProcess `
                    -Force `
                    -ErrorAction SilentlyContinue
            }
        }
        Start-Sleep -Seconds 2
    }
    catch {
        Write-Log "Could not inspect port ${Port}: $($_.Exception.Message)" "Yellow"
    }
}

function Test-PythonDependencies {
    if (-not (Test-Path -LiteralPath $PythonExe)) {
        Write-Log "Python environment was not found: $PythonExe" "Yellow"
        return $false
    }

    # A missing module writes a traceback to stderr. Under
    # ErrorActionPreference=Stop, PowerShell can incorrectly terminate the
    # whole launcher before the automatic repair step runs.
    $previousPreference = $ErrorActionPreference
    $output = @()
    $exitCode = 1

    try {
        $ErrorActionPreference = "SilentlyContinue"
        $output = @(
            & $PythonExe -c "import httpx, requests, fastapi, faster_whisper, docx, pypdf, PIL" 2>&1
        )
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($exitCode -ne 0) {
        $lastLine = ($output | Select-Object -Last 1 | Out-String).Trim()
        if ($lastLine) {
            Write-Log "Python dependency check failed: $lastLine" "Yellow"
        }
        return $false
    }

    return $true
}


function Get-AppHealth {
    $url = "http://${AppHost}:${AppPort}/api/health"
    try {
        return Invoke-RestMethod `
            -Uri $url `
            -Method Get `
            -TimeoutSec 3 `
            -ErrorAction Stop
    }
    catch {
        return $null
    }
}


function Test-CorrectAppVersion {
    $health = Get-AppHealth
    if ($null -eq $health) {
        return $false
    }

    return (
        $health.app -eq "ok" -and
        [string]$health.version -eq [string]$ExpectedAppVersion
    )
}


function Wait-ForCondition(
    [scriptblock]$Condition,
    [int]$TimeoutSeconds,
    [System.Diagnostics.Process]$Process,
    [string]$ServiceName
) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    while ((Get-Date) -lt $deadline) {
        if (& $Condition) {
            return $true
        }

        if ($null -ne $Process) {
            try {
                if ($Process.HasExited) {
                    throw "$ServiceName exited with code $($Process.ExitCode)"
                }
            }
            catch [System.InvalidOperationException] {
                throw "$ServiceName process state is unavailable"
            }
        }

        Start-Sleep -Seconds 2
    }

    return $false
}

function Set-EnvValue([string]$Name, [string]$Value) {
    if (-not (Test-Path -LiteralPath $EnvFile)) {
        if (Test-Path -LiteralPath $EnvExample) {
            Copy-Item -LiteralPath $EnvExample -Destination $EnvFile
        }
        else {
            New-Item -ItemType File -Path $EnvFile | Out-Null
        }
    }

    $lines = @(Get-Content -LiteralPath $EnvFile -Encoding UTF8)
    $pattern = "^\s*" + [regex]::Escape($Name) + "\s*="
    $found = $false

    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match $pattern) {
            $lines[$index] = "$Name=$Value"
            $found = $true
            break
        }
    }

    if (-not $found) {
        $lines += "$Name=$Value"
    }

    Set-Content -LiteralPath $EnvFile -Value $lines -Encoding UTF8
}

function Show-LogTail([string]$Path, [int]$Count = 30) {
    if (Test-Path -LiteralPath $Path) {
        Write-Host ""
        Write-Host "----- $Path -----" -ForegroundColor Yellow
        Get-Content -LiteralPath $Path -Tail $Count
    }
}

try {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host " Dental AI Scribe - Local model and application launcher" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Log "Launcher started" "Green"

    if (-not (Test-Path -LiteralPath $MainPy)) {
        throw "main.py was not found in $ProjectDir"
    }

    if (-not (Test-Path -LiteralPath $LlamaServerExe)) {
        throw "llama-server.exe was not found: $LlamaServerExe"
    }

    if (-not (Test-Path -LiteralPath $ModelFile)) {
        throw "Qwen model was not found: $ModelFile"
    }

    if ($UseMmproj -and -not (Test-Path -LiteralPath $MmprojFile)) {
        throw "Multimodal projector was not found: $MmprojFile"
    }

    $dependenciesReady = Test-PythonDependencies

    if (-not $dependenciesReady) {
        Write-Log "Python 3.11 environment is missing or incomplete. Repairing it..." "Yellow"

        if (-not (Test-Path -LiteralPath $SetupScript)) {
            throw "setup_and_run.ps1 was not found"
        }

        $setupArguments = @(
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", "`"$SetupScript`"",
            "-InstallOnly"
        )

        $setupProcess = Start-Process `
            -FilePath "powershell.exe" `
            -ArgumentList $setupArguments `
            -WorkingDirectory $ProjectDir `
            -Wait `
            -PassThru `
            -NoNewWindow

        if ($setupProcess.ExitCode -ne 0) {
            throw "Python 3.11 environment repair failed with code $($setupProcess.ExitCode)"
        }

        if (-not (Test-PythonDependencies)) {
            throw "Python dependencies are still incomplete after repair"
        }
    }

    Write-Log "Python 3.11 environment is ready" "Green"

    Set-EnvValue "APP_HOST" $AppHost
    Set-EnvValue "APP_PORT" ([string]$AppPort)
    Set-EnvValue "LLAMA_CPP_URL" "http://${LlamaHost}:${LlamaPort}/v1/chat/completions"
    Set-EnvValue "MODEL_NAME" $ModelAlias
    Set-EnvValue "LLM_DISABLE_THINKING" "true"
    Set-EnvValue "VISION_ENABLED" ($UseMmproj.ToString().ToLower())
    Set-EnvValue "LLM_MAX_TOKENS_VISION" "3072"

    $llamaProcess = $null
    $healthUrl = "http://${LlamaHost}:${LlamaPort}/health"

    if (Test-CorrectLlamaModel) {
        Write-Log "Correct local model is already running" "Green"
    }
    else {
        if (Test-Url $healthUrl 2) {
            Write-Log "A model is running on port $LlamaPort, but its alias is not $ModelAlias" "Yellow"
            Stop-PortListener $LlamaPort
        }

        Write-Log "Starting Qwen local model. This can take several minutes..." "Cyan"

        Remove-Item -LiteralPath $LlamaOutLog -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $LlamaErrLog -Force -ErrorAction SilentlyContinue

        $llamaArgumentLine = (
            '-m "{0}" --alias "{1}" --parallel {2} -c {3} ' +
            '--cache-type-k q4_0 --cache-type-v q4_0 -fa on ' +
            '--host {4} --port {5}'
        ) -f $ModelFile, $ModelAlias, $ParallelSlots, $ContextSize, $LlamaHost, $LlamaPort

        if ($UseMmproj) {
            $llamaArgumentLine += (' --mmproj "{0}"' -f $MmprojFile)
            Write-Log "Multimodal mmproj is enabled" "Cyan"
        }

        Remove-Item -LiteralPath $VisionPidFile -Force -ErrorAction SilentlyContinue

        $llamaProcess = Start-Process `
            -FilePath $LlamaServerExe `
            -ArgumentList $llamaArgumentLine `
            -WorkingDirectory (Split-Path -Parent $LlamaServerExe) `
            -RedirectStandardOutput $LlamaOutLog `
            -RedirectStandardError $LlamaErrLog `
            -WindowStyle Minimized `
            -PassThru

        Set-Content `
            -LiteralPath (Join-Path $RuntimeDir "llama.pid") `
            -Value $llamaProcess.Id `
            -Encoding ASCII

        $modelReady = Wait-ForCondition `
            -Condition { Test-LlamaReady } `
            -TimeoutSeconds $ModelStartupTimeoutSeconds `
            -Process $llamaProcess `
            -ServiceName "llama.cpp"

        if (-not $modelReady) {
            Show-LogTail $LlamaErrLog
            Show-LogTail $LlamaOutLog
            throw "Local model did not become ready within $ModelStartupTimeoutSeconds seconds"
        }

        if ($UseMmproj) {
            Set-Content `
                -LiteralPath $VisionPidFile `
                -Value $llamaProcess.Id `
                -Encoding ASCII
        }

        Write-Log "Local model is ready and model alias matches $ModelAlias" "Green"
    }

    $appUrl = "http://${AppHost}:${AppPort}"
    $appHealthUrl = "$appUrl/api/health"
    $appProcess = $null

    $currentAppHealth = Get-AppHealth
    $correctAppAlreadyRunning = Test-CorrectAppVersion

    if ($correctAppAlreadyRunning) {
        Write-Log "Dental application v$ExpectedAppVersion is already running" "Green"
    }
    else {
        if ($null -ne $currentAppHealth) {
            $runningVersion = [string]$currentAppHealth.version
            if (-not $runningVersion) {
                $runningVersion = "unknown/older"
            }

            Write-Log (
                "Port $AppPort is serving application version $runningVersion; " +
                "restarting it as v$ExpectedAppVersion"
            ) "Yellow"
            Stop-PortListener $AppPort
        }

        Write-Log "Starting dental application v$ExpectedAppVersion..." "Cyan"

        Remove-Item -LiteralPath $AppOutLog -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $AppErrLog -Force -ErrorAction SilentlyContinue

        $appArgumentLine = '"{0}"' -f $MainPy

        $appProcess = Start-Process `
            -FilePath $PythonExe `
            -ArgumentList $appArgumentLine `
            -WorkingDirectory $ProjectDir `
            -RedirectStandardOutput $AppOutLog `
            -RedirectStandardError $AppErrLog `
            -WindowStyle Minimized `
            -PassThru

        Set-Content `
            -LiteralPath (Join-Path $RuntimeDir "app.pid") `
            -Value $appProcess.Id `
            -Encoding ASCII

        $appReady = Wait-ForCondition `
            -Condition { Test-CorrectAppVersion } `
            -TimeoutSeconds $AppStartupTimeoutSeconds `
            -Process $appProcess `
            -ServiceName "Dental application"

        if (-not $appReady) {
            Show-LogTail $AppErrLog
            Show-LogTail $AppOutLog
            throw (
                "Dental application v$ExpectedAppVersion did not start " +
                "within $AppStartupTimeoutSeconds seconds"
            )
        }

        Write-Log "Dental application v$ExpectedAppVersion is ready" "Green"
    }

    Start-Process $appUrl
    Write-Host ""
    Write-Host "SUCCESS: The browser has been opened." -ForegroundColor Green
    Write-Host "Application: $appUrl" -ForegroundColor Green
    Write-Host "Health check: $appHealthUrl" -ForegroundColor DarkGray
    Write-Host "Close both services with: 一键关闭全部.bat" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "This window may now be closed." -ForegroundColor DarkGray
    exit 0
}
catch {
    $message = $_.Exception.Message
    $fullError = ($_ | Out-String).Trim()

    Write-Log "STARTUP FAILED: $message" "Red"
    if ($fullError) {
        Add-Content `
            -LiteralPath $StartupLog `
            -Value ("`r`nFULL ERROR:`r`n" + $fullError + "`r`n") `
            -Encoding UTF8
    }

    Show-LogTail $LlamaErrLog
    Show-LogTail $LlamaOutLog
    Show-LogTail $AppErrLog
    Show-LogTail $AppOutLog

    Write-Host ""
    Write-Host "Startup failed. The window will remain open." -ForegroundColor Red
    Write-Host "Log file: $StartupLog" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}
