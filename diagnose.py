from __future__ import annotations

import importlib.util
import json
import os
import platform
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


def load_simple_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


env = load_simple_env(BASE_DIR / ".env")
llama_url = env.get(
    "LLAMA_CPP_URL",
    "http://127.0.0.1:8080/v1/chat/completions"
)
base_url = llama_url.split("/v1/", 1)[0].rstrip("/")

packages = [
    "fastapi", "uvicorn", "httpx", "faster_whisper",
    "docx", "pydantic", "numpy", "dotenv"
]

report = {
    "python": sys.version,
    "platform": platform.platform(),
    "project_dir": str(BASE_DIR),
    "env_exists": (BASE_DIR / ".env").exists(),
    "packages": {},
    "paths": {},
    "llama": {}
}

for package in packages:
    report["packages"][package] = importlib.util.find_spec(package) is not None

for name, relative in {
    "static": "static/index.html",
    "knowledge_base": "kb/dental_knowledge.json",
    "database_dir": env.get("DB_PATH", "data/dental_records.db"),
    "exports": env.get("EXPORT_DIR", "exports"),
    "models": env.get("WHISPER_MODEL_DIR", "models")
}.items():
    path = Path(relative)
    if not path.is_absolute():
        path = BASE_DIR / path
    target = path.parent if name == "database_dir" else path
    report["paths"][name] = {
        "path": str(path),
        "exists": target.exists(),
        "writable": os.access(target if target.exists() else target.parent, os.W_OK)
    }

for endpoint in (f"{base_url}/health", f"{base_url}/v1/health", f"{base_url}/v1/models"):
    try:
        with urllib.request.urlopen(endpoint, timeout=5) as response:
            body = response.read(1000).decode("utf-8", errors="replace")
            report["llama"][endpoint] = {
                "status": response.status,
                "body": body
            }
    except urllib.error.HTTPError as exc:
        report["llama"][endpoint] = {"status": exc.code, "error": str(exc)}
    except Exception as exc:
        report["llama"][endpoint] = {"status": None, "error": str(exc)}

print(json.dumps(report, ensure_ascii=False, indent=2))
