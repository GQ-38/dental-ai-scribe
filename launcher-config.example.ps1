# Copy this file to launcher-config.local.ps1 and edit the paths for your computer.
$LlamaServerExe = "C:\\path\\to\\llama-server.exe"
$ModelFile = "C:\\path\\to\\Qwen3.5-9B-Q4_K_M.gguf"
$UseMmproj = $true
$MmprojFile = "C:\\path\\to\\mmproj-F16.gguf"
$ModelAlias = "dental-qwen"
$LlamaHost = "127.0.0.1"
$LlamaPort = 8080
$AppHost = "127.0.0.1"
$AppPort = 8000
$ContextSize = 4096
$ParallelSlots = 1
$ModelStartupTimeoutSeconds = 360
$AppStartupTimeoutSeconds = 90
$ExpectedAppVersion = "2.3"
$RestartAppWhenVersionDiffers = $true

