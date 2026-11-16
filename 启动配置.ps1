# Dental AI Scribe 一键启动配置
# 当前路径已按你的电脑填写。以后文件位置改变时，只需修改本文件。

$LlamaServerExe = "C:\\path\\to\\llama-server.exe"
$ModelFile = "C:\\path\\to\\Qwen3.5-9B-Q4_K_M.gguf"

# 当前病历系统只需要文字模型，默认不加载 mmproj，可节省内存。
$UseMmproj = $false
$MmprojFile = "C:\\path\\to\\mmproj-F16.gguf"

$ModelAlias = "dental-qwen"
$LlamaHost = "127.0.0.1"
$LlamaPort = 8080
$AppHost = "127.0.0.1"
$AppPort = 8000

# 你的原脚本使用 -c 0，可能占用较多内存；这里固定为 4096。
$ContextSize = 4096
$ParallelSlots = 1

# 等待模型加载的最长时间（秒）
$ModelStartupTimeoutSeconds = 300
$AppStartupTimeoutSeconds = 60
