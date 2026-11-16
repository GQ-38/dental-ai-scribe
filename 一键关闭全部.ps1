$ErrorActionPreference = "SilentlyContinue"
Set-Location -LiteralPath $PSScriptRoot

$RuntimeDir = Join-Path $PSScriptRoot "runtime"
$pidFiles = @(
    @{ Name = "病历系统"; Path = (Join-Path $RuntimeDir "app.pid") },
    @{ Name = "本地模型"; Path = (Join-Path $RuntimeDir "llama.pid") }
)

foreach ($entry in $pidFiles) {
    if (Test-Path -LiteralPath $entry.Path) {
        $savedPid = Get-Content -LiteralPath $entry.Path -Raw
        $savedPid = $savedPid.Trim()

        if ($savedPid -match '^\d+$') {
            $process = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
            if ($process) {
                Stop-Process -Id $process.Id -Force
                Write-Host "已关闭：$($entry.Name)（PID $savedPid）" -ForegroundColor Green
            }
        }

        Remove-Item -LiteralPath $entry.Path -Force
    }
}

# 兜底：关闭当前项目监听的两个端口对应进程。
foreach ($port in @(8000, 8080)) {
    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
        if ($connection.OwningProcess) {
            Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
            Write-Host "已关闭端口 $port 对应进程。" -ForegroundColor Green
        }
    }
}

Write-Host "处理完成。" -ForegroundColor Cyan
Start-Sleep -Seconds 2

Remove-Item -LiteralPath (Join-Path $PSScriptRoot "runtime\vision-mmproj.pid") -Force -ErrorAction SilentlyContinue
