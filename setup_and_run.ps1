param(
    [switch]$Reinstall,
    [switch]$InstallOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-Location -LiteralPath $PSScriptRoot

$ProjectDir = $PSScriptRoot
$VenvDir = Join-Path $ProjectDir ".venv311"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$RequirementsFile = Join-Path $ProjectDir "requirements.txt"
$EnvExample = Join-Path $ProjectDir ".env.example"
$EnvFile = Join-Path $ProjectDir ".env"
$LogDir = Join-Path $ProjectDir "logs"
$SetupLog = Join-Path $LogDir "setup-latest.log"
$DependencyMarker = Join-Path $VenvDir ".requirements.sha256"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor DarkCyan
    Write-Host $Text -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor DarkCyan
}

function Write-Fail([string]$Text) {
    Write-Host ""
    Write-Host "[失败] $Text" -ForegroundColor Red
    Write-Host "安装日志：$SetupLog" -ForegroundColor Yellow
}

function Test-Python311X64([string]$PythonExe) {
    if (-not $PythonExe -or -not (Test-Path -LiteralPath $PythonExe)) {
        return $false
    }

    try {
        & $PythonExe -c "import sys,platform,struct; raise SystemExit(0 if sys.version_info[:2] == (3,11) and struct.calcsize('P')*8 == 64 and platform.machine().upper() in ('AMD64','X86_64') else 1)" 2>$null
        return ($LASTEXITCODE -eq 0)
    }
    catch {
        return $false
    }
}

function Find-Python311X64 {
    try {
        $fromLauncher = (& py -3.11 -c "import sys; print(sys.executable)" 2>$null | Select-Object -Last 1)
        if ($fromLauncher) {
            $fromLauncher = $fromLauncher.Trim()
            if (Test-Python311X64 $fromLauncher) {
                return $fromLauncher
            }
        }
    }
    catch {}

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"),
        "C:\Program Files\Python311\python.exe",
        "C:\Python311\python.exe"
    )

    foreach ($candidate in $candidates) {
        if (Test-Python311X64 $candidate) {
            return $candidate
        }
    }

    if (Test-Path (Join-Path $env:LOCALAPPDATA "Programs\Python")) {
        $found = Get-ChildItem `
            -Path (Join-Path $env:LOCALAPPDATA "Programs\Python") `
            -Filter python.exe `
            -Recurse `
            -ErrorAction SilentlyContinue |
            Where-Object { Test-Python311X64 $_.FullName } |
            Select-Object -First 1

        if ($found) {
            return $found.FullName
        }
    }

    return $null
}

function Install-Python311 {
    Write-Step "未检测到 Python 3.11 x64，正在尝试自动安装"

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "系统没有 winget，无法自动安装 Python 3.11。请手动安装 Python 3.11 Windows 64-bit。"
    }

    & winget install `
        --id Python.Python.3.11 `
        --exact `
        --scope user `
        --silent `
        --accept-package-agreements `
        --accept-source-agreements

    if ($LASTEXITCODE -ne 0) {
        throw "winget 安装 Python 3.11 失败，错误代码：$LASTEXITCODE"
    }

    Start-Sleep -Seconds 3
}

function Get-RequirementsHash {
    return (Get-FileHash -LiteralPath $RequirementsFile -Algorithm SHA256).Hash
}

function Install-Dependencies {
    Write-Step "安装项目依赖（首次可能需要几分钟）"

    & $VenvPython -m pip install --upgrade pip setuptools wheel `
        --index-url https://pypi.org/simple 2>&1 |
        Tee-Object -FilePath $SetupLog -Append

    if ($LASTEXITCODE -ne 0) {
        throw "pip、setuptools 或 wheel 升级失败"
    }

    # 先强制安装 Windows 预编译 NumPy，避免尝试本地 C/C++ 编译。
    & $VenvPython -m pip install `
        --only-binary=:all: `
        --no-cache-dir `
        "numpy==1.26.4" `
        --index-url https://pypi.org/simple 2>&1 |
        Tee-Object -FilePath $SetupLog -Append

    if ($LASTEXITCODE -ne 0) {
        throw "NumPy 预编译包安装失败。请确认使用的是 Python 3.11 x64。"
    }

    & $VenvPython -m pip install `
        --prefer-binary `
        --no-cache-dir `
        -r $RequirementsFile `
        --index-url https://pypi.org/simple 2>&1 |
        Tee-Object -FilePath $SetupLog -Append

    if ($LASTEXITCODE -ne 0) {
        Write-Host "[提示] 官方源安装失败，尝试清华镜像..." -ForegroundColor Yellow

        & $VenvPython -m pip install `
            --prefer-binary `
            --no-cache-dir `
            -r $RequirementsFile `
            --index-url https://pypi.tuna.tsinghua.edu.cn/simple 2>&1 |
            Tee-Object -FilePath $SetupLog -Append

        if ($LASTEXITCODE -ne 0) {
            throw "项目依赖安装失败"
        }
    }

    & $VenvPython -m pip check 2>&1 |
        Tee-Object -FilePath $SetupLog -Append

    if ($LASTEXITCODE -ne 0) {
        throw "依赖完整性检查失败"
    }

    Get-RequirementsHash | Set-Content -LiteralPath $DependencyMarker -Encoding ASCII
}

try {
    Write-Step "Dental AI Scribe 一键安装与运行"

    $CurrentVersion = (& python --version 2>&1)
    if ($CurrentVersion) {
        Write-Host "当前系统 python 命令：$CurrentVersion" -ForegroundColor DarkGray
        Write-Host "一键脚本不会使用它，将固定使用独立的 Python 3.11 x64 环境。" -ForegroundColor Green
    }

    $Python311 = Find-Python311X64

    if (-not $Python311) {
        Install-Python311
        $Python311 = Find-Python311X64
    }

    if (-not $Python311) {
        throw "Python 3.11 x64 安装后仍未找到。请重启电脑后再次双击本脚本。"
    }

    Write-Host "使用解释器：$Python311" -ForegroundColor Green

    if ($Reinstall -and (Test-Path -LiteralPath $VenvDir)) {
        Write-Step "删除旧的独立运行环境"
        Remove-Item -LiteralPath $VenvDir -Recurse -Force
    }

    if (-not (Test-Python311X64 $VenvPython)) {
        if (Test-Path -LiteralPath $VenvDir) {
            Remove-Item -LiteralPath $VenvDir -Recurse -Force
        }

        Write-Step "创建项目专用 Python 3.11 环境"
        & $Python311 -m venv $VenvDir
        if ($LASTEXITCODE -ne 0 -or -not (Test-Python311X64 $VenvPython)) {
            throw "创建 .venv311 失败"
        }
    }
    else {
        Write-Host "独立运行环境已存在：$VenvDir" -ForegroundColor Green
    }

    $RequirementsHash = Get-RequirementsHash
    $InstalledHash = ""
    if (Test-Path -LiteralPath $DependencyMarker) {
        $InstalledHash = (Get-Content -LiteralPath $DependencyMarker -Raw).Trim()
    }

    if ($Reinstall -or $InstalledHash -ne $RequirementsHash) {
        Install-Dependencies
    }
    else {
        Write-Host "依赖已经安装且版本未变化，跳过重复安装。" -ForegroundColor Green
    }

    if (-not (Test-Path -LiteralPath $EnvFile)) {
        Copy-Item -LiteralPath $EnvExample -Destination $EnvFile
        Write-Host "已创建配置文件：.env" -ForegroundColor Green
    }

    Write-Step "环境自检"
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $VenvPython -c "import sys,numpy,httpx,requests,fastapi,faster_whisper,pypdf,PIL; print('Python:',sys.version.split()[0]); print('NumPy:',numpy.__version__); print('httpx:',httpx.__version__); print('requests:',requests.__version__); print('FastAPI:',fastapi.__version__); print('faster-whisper: OK'); print('pypdf:',pypdf.__version__)"
        $selfCheckCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($selfCheckCode -ne 0) {
        throw "环境自检失败"
    }

    if ($InstallOnly) {
        Write-Host ""
        Write-Host "安装完成。以后双击“一键启动.bat”即可。" -ForegroundColor Green
        exit 0
    }

    $Port = 8000
    if (Test-Path -LiteralPath $EnvFile) {
        $PortLine = Get-Content -LiteralPath $EnvFile |
            Where-Object { $_ -match '^\s*APP_PORT\s*=' } |
            Select-Object -First 1

        if ($PortLine) {
            $CandidatePort = ($PortLine -split '=', 2)[1].Trim()
            if ($CandidatePort -match '^\d+$') {
                $Port = [int]$CandidatePort
            }
        }
    }

    $AppUrl = "http://127.0.0.1:$Port"
    Write-Step "启动系统"
    Write-Host "浏览器地址：$AppUrl" -ForegroundColor Green
    Write-Host "停止系统：在本窗口按 Ctrl+C" -ForegroundColor Yellow
    Write-Host "首次语音转写会下载 Whisper 模型，请保持网络连接。" -ForegroundColor Yellow
    Write-Host "未启动 llama.cpp 时，患者管理和录音转写仍可使用，但 AI 病历生成会提示连接失败。" -ForegroundColor Yellow

    $BrowserCommand = @"
`$url = '$AppUrl'
for (`$i = 0; `$i -lt 60; `$i++) {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri `$url -TimeoutSec 1 | Out-Null
        Start-Process `$url
        exit 0
    }
    catch {
        Start-Sleep -Milliseconds 500
    }
}
Write-Host '服务未在预期时间内启动，请查看主窗口错误。'
"@

    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command", $BrowserCommand
    )

    & $VenvPython (Join-Path $ProjectDir "main.py")
    exit $LASTEXITCODE
}
catch {
    Write-Fail $_.Exception.Message
    Write-Host ""
    Write-Host "可把 logs\setup-latest.log 的最后部分发给技术人员排查。" -ForegroundColor Yellow
    Read-Host "按回车键退出"
    exit 1
}
