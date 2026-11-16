# 运行与配置指南

## 一、Windows 最快启动

### 1. 安装基础软件

- Python 3.11 64 位
- llama.cpp 的 `llama-server.exe`
- 一个适合对话的 GGUF Instruct 模型

不要直接使用 Python 3.13。这个项目的固定依赖组合优先按 Python 3.11 测试。

### 2. 首次安装项目

1. 解压项目到英文路径，例如：`D:\DentalAI`
2. 双击 `setup_windows.bat`
3. 安装成功后，项目会自动创建 `.env`

命令行方式：

```bat
cd /d D:\DentalAI
py -3.11 -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env
```

### 3. 启动本地大模型

复制 `start_llama_windows.example.bat`，改名为 `start_llama_windows.bat`，修改：

```bat
set "LLAMA_SERVER=D:\llama.cpp\llama-server.exe"
set "MODEL_FILE=D:\models\your-instruct-model-Q4_K_M.gguf"
```

然后双击运行。

打开浏览器访问：

```text
http://127.0.0.1:8080/health
```

看到 `{"status":"ok"}` 才表示模型已加载完成。

`start_llama_windows.bat` 中的：

```bat
set "MODEL_ALIAS=dental-qwen"
```

必须与 `.env` 中的：

```env
MODEL_NAME=dental-qwen
```

完全一致。

### 4. 启动病历系统

双击：

```text
start_windows.bat
```

浏览器访问：

```text
http://127.0.0.1:8000
```

系统健康检查：

```text
http://127.0.0.1:8000/api/health
```

## 二、推荐配置档位

### CPU 电脑，16 GB 内存

```env
WHISPER_MODEL=base
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
WHISPER_BEAM_SIZE=3
```

llama.cpp：

```bat
set "CONTEXT_SIZE=8192"
set "GPU_LAYERS=0"
set "CPU_THREADS=8"
```

### RTX 3060 12 GB / RTX 4060 Ti 16 GB

```env
WHISPER_MODEL=small
WHISPER_DEVICE=cuda
WHISPER_COMPUTE_TYPE=float16
WHISPER_BEAM_SIZE=5
```

llama.cpp：

```bat
set "CONTEXT_SIZE=8192"
set "GPU_LAYERS=99"
set "CPU_THREADS=8"
```

显存不足时，把 `GPU_LAYERS` 从 99 逐步降到 35、20，或使用更小的 GGUF 量化模型。

### 仅先验证功能

```env
WHISPER_MODEL=tiny
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
WHISPER_BEAM_SIZE=1
```

## 三、重要配置说明

### APP_HOST

```env
APP_HOST=127.0.0.1
```

仅本机访问，推荐默认值。

```env
APP_HOST=0.0.0.0
```

允许局域网访问。当前版本没有账号登录和权限控制，不能直接暴露到互联网；用于局域网时也应限制 Windows 防火墙来源地址。

### LLM_JSON_MODE

```env
LLM_JSON_MODE=true
```

开启 llama.cpp 的 JSON 输出约束，减少病历 JSON 解析失败。若使用较旧版本 llama.cpp，程序会自动尝试无 JSON 约束的兼容请求。

### LLM_DISABLE_THINKING

```env
LLM_DISABLE_THINKING=true
```

对于支持 thinking 的 Qwen 模型，关闭长思考通常更适合结构化病历输出。若模型不支持，相应参数会自动降级。

### WHISPER_INITIAL_PROMPT

可继续加入诊所常见术语、材料名、医生姓名和本地口音易错词，用逗号分隔。不要加入患者隐私信息。

### 数据目录

```env
DB_PATH=data/dental_records.db
EXPORT_DIR=exports
WHISPER_MODEL_DIR=models
```

病历数据库、导出文档和 Whisper 模型会分别保存在这些目录中。

## 四、诊断问题

进入项目目录执行：

```bat
.venv\Scripts\python.exe diagnose.py
```

重点检查：

- 所有 `packages` 是否为 `true`
- `/health` 是否返回 200
- `/v1/models` 中的模型 ID 是否与 `MODEL_NAME` 一致
- 数据目录是否可写

## 五、备份

双击 `backup_data_windows.bat`，会备份：

- SQLite 病历数据库
- 已导出的 Word 病历
- 当前 `.env` 配置

建议每日备份到加密硬盘或诊所受控的备份位置。
