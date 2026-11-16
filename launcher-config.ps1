# Dental AI Scribe launcher configuration

$LlamaServerExe = "C:\\path\\to\\llama-server.exe"
$ModelFile = "C:\\path\\to\\Qwen3.5-9B-Q4_K_M.gguf"
$UseMmproj = $true
$MmprojFile = "C:\\path\\to\\mmproj-F16.gguf"

$ModelAlias = "dental-qwen"
$LlamaHost = "127.0.0.1"
$LlamaPort = 8080

$AppHost = "127.0.0.1"
$AppPort = 8000

# Reduced memory configuration
$ContextSize = 4096
$ParallelSlots = 1

$ModelStartupTimeoutSeconds = 360
$AppStartupTimeoutSeconds = 90


# The launcher restarts port 8000 when an older project version is running.
$ExpectedAppVersion = "2.3"
$RestartAppWhenVersionDiffers = $true
