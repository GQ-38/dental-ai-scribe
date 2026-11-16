"""
Dental AI Scribe - 口腔AI病历助手
针对 llama.cpp (Qwen3.5-9B) + Faster-Whisper 本地部署优化

启动前请确保：
1. llama.cpp server 已运行: ./server -m qwen3.5-9b.gguf -c 8192 --port 8080
2. 安装依赖: pip install -r requirements.txt
3. 运行: python main.py
"""

# 运行环境保护：本项目的 Windows 一键环境固定使用 Python 3.11 x64。
import sys as _startup_sys
import platform as _startup_platform

if _startup_sys.version_info >= (3, 13):
    print("=" * 68)
    print("[错误] 当前 Python 版本过新，项目依赖可能没有兼容的 Windows 安装包。")
    print(f"[当前] Python {_startup_sys.version.split()[0]} / {_startup_platform.machine()}")
    print("[解决] 请不要直接运行 python main.py。")
    print("[解决] 双击项目中的“一键安装并运行.bat”，程序会自动使用 Python 3.11 x64。")
    print("=" * 68)
    raise SystemExit(2)



import base64
import io
import json
import mimetypes
import os
import uuid
import re
import sqlite3
import asyncio
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any

try:
    import httpx
    import uvicorn
    from fastapi import FastAPI, UploadFile, File, Form, HTTPException
    from fastapi.staticfiles import StaticFiles
    from fastapi.responses import HTMLResponse, FileResponse
    from pydantic import BaseModel, Field
    from faster_whisper import WhisperModel
    from dotenv import load_dotenv
    from docx import Document
    from docx.shared import RGBColor, Pt
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from pypdf import PdfReader
    from PIL import Image, ImageOps
except ModuleNotFoundError as exc:
    print("=" * 68)
    print(f"[错误] 缺少 Python 依赖：{exc.name}")
    print("[解决] 请双击项目中的“一键安装并运行.bat”，脚本会自动补齐缺失依赖。")
    print("[说明] 一键脚本会创建独立的 Python 3.11 环境并安装全部依赖。")
    print("=" * 68)
    raise SystemExit(1) from exc

# ==================== 配置 ====================
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int, minimum: Optional[int] = None) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        print(f"[!] 环境变量 {name} 不是有效整数，已使用默认值 {default}")
        value = default
    if minimum is not None:
        value = max(minimum, value)
    return value


def env_float(name: str, default: float, minimum: Optional[float] = None) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        print(f"[!] 环境变量 {name} 不是有效数字，已使用默认值 {default}")
        value = default
    if minimum is not None:
        value = max(minimum, value)
    return value


def project_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else BASE_DIR / path


LLAMA_CPP_URL = os.getenv(
    "LLAMA_CPP_URL",
    "http://127.0.0.1:8080/v1/chat/completions"
).strip()
MODEL_NAME = os.getenv("MODEL_NAME", "dental-qwen").strip()

LLM_TIMEOUT_SECONDS = env_float("LLM_TIMEOUT_SECONDS", 240.0, 10.0)
LLM_MAX_TOKENS_EXTRACTION = env_int("LLM_MAX_TOKENS_EXTRACTION", 2048, 256)
LLM_MAX_TOKENS_RECORD = env_int("LLM_MAX_TOKENS_RECORD", 4096, 512)
LLM_MAX_TOKENS_CHAT = env_int("LLM_MAX_TOKENS_CHAT", 1536, 256)
LLM_JSON_MODE = env_bool("LLM_JSON_MODE", True)
LLM_DISABLE_THINKING = env_bool("LLM_DISABLE_THINKING", True)

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base").strip()
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu").strip().lower()
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8").strip()
WHISPER_BEAM_SIZE = env_int("WHISPER_BEAM_SIZE", 5, 1)
WHISPER_INITIAL_PROMPT = os.getenv(
    "WHISPER_INITIAL_PROMPT",
    "口腔科门诊医患对话，包含牙位、龋病、牙髓炎、根尖周炎、牙周炎、根管治疗、洁治、拔牙、种植、正畸等专业术语。"
).strip()

DB_PATH = project_path(os.getenv("DB_PATH", "data/dental_records.db"))
EXPORT_DIR = project_path(os.getenv("EXPORT_DIR", "exports"))
WHISPER_MODEL_DIR = project_path(os.getenv("WHISPER_MODEL_DIR", "models"))

APP_HOST = os.getenv("APP_HOST", "127.0.0.1").strip()
APP_PORT = env_int("APP_PORT", 8000, 1)

MAX_AUDIO_FILE_SIZE_MB = env_int("MAX_AUDIO_FILE_SIZE_MB", 500, 1)
MAX_AUDIO_FILE_SIZE_BYTES = MAX_AUDIO_FILE_SIZE_MB * 1024 * 1024
AUDIO_UPLOAD_CHUNK_MB = env_int("AUDIO_UPLOAD_CHUNK_MB", 1, 1)
AUDIO_UPLOAD_CHUNK_BYTES = AUDIO_UPLOAD_CHUNK_MB * 1024 * 1024

MAX_TEXT_FILE_SIZE_MB = env_int("MAX_TEXT_FILE_SIZE_MB", 20, 1)
MAX_TEXT_FILE_SIZE_BYTES = MAX_TEXT_FILE_SIZE_MB * 1024 * 1024
MAX_IMPORTED_TEXT_CHARS = env_int("MAX_IMPORTED_TEXT_CHARS", 21600, 2000)
TRANSCRIPT_CHUNK_CHARS = env_int("TRANSCRIPT_CHUNK_CHARS", 1800, 800)
MAX_TRANSCRIPT_CHUNKS = env_int("MAX_TRANSCRIPT_CHUNKS", 12, 1)

VISION_ENABLED = env_bool("VISION_ENABLED", True)
LLM_MAX_TOKENS_VISION = env_int("LLM_MAX_TOKENS_VISION", 3072, 512)
IMAGE_DIR = project_path(os.getenv("IMAGE_DIR", "data/case_images"))
MAX_IMAGE_FILE_SIZE_MB = env_int("MAX_IMAGE_FILE_SIZE_MB", 16, 1)
MAX_IMAGE_FILE_SIZE_BYTES = MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024
MAX_IMAGES_PER_VISIT = env_int("MAX_IMAGES_PER_VISIT", 24, 1)
MAX_IMAGES_PER_ANALYSIS = env_int("MAX_IMAGES_PER_ANALYSIS", 6, 1)
IMAGE_STORE_MAX_EDGE = env_int("IMAGE_STORE_MAX_EDGE", 1800, 640)
IMAGE_ANALYSIS_MAX_EDGE = env_int("IMAGE_ANALYSIS_MAX_EDGE", 768, 320)
IMAGE_THUMB_MAX_EDGE = env_int("IMAGE_THUMB_MAX_EDGE", 320, 120)

DB_PATH.parent.mkdir(parents=True, exist_ok=True)
EXPORT_DIR.mkdir(parents=True, exist_ok=True)
WHISPER_MODEL_DIR.mkdir(parents=True, exist_ok=True)
IMAGE_DIR.mkdir(parents=True, exist_ok=True)

SUPPORTED_AUDIO_EXTENSIONS = {
    ".webm", ".wav", ".mp3", ".m4a", ".mp4", ".ogg", ".oga",
    ".flac", ".aac", ".wma", ".opus", ".mpeg", ".mpga"
}
AUDIO_CONTENT_TYPE_SUFFIX = {
    "audio/webm": ".webm",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "video/mp4": ".mp4",
    "audio/ogg": ".ogg",
    "audio/flac": ".flac",
    "audio/aac": ".aac",
    "audio/x-ms-wma": ".wma",
    "audio/opus": ".opus",
}

SUPPORTED_TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".csv", ".json",
    ".srt", ".vtt", ".docx", ".pdf", ".log"
}
PLAIN_TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".csv", ".json",
    ".srt", ".vtt", ".log"
}

SUPPORTED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
SUPPORTED_IMAGE_MIME_TYPES = {
    "image/jpeg", "image/png", "image/webp", "image/bmp"
}
CLINICAL_SECTIONS = [
    "主诉", "现病史", "既往史", "口腔专科检查",
    "辅助检查", "诊断", "治疗计划", "处置", "医嘱"
]
IMAGE_SECTIONS = CLINICAL_SECTIONS + ["待归类"]


def validate_config() -> List[str]:
    warnings = []
    if WHISPER_DEVICE not in {"cpu", "cuda", "auto"}:
        warnings.append(
            f"WHISPER_DEVICE={WHISPER_DEVICE} 不常见，建议使用 cpu、cuda 或 auto"
        )
    if WHISPER_DEVICE == "cpu" and "float16" in WHISPER_COMPUTE_TYPE:
        warnings.append(
            "CPU 通常不适合 float16；建议 WHISPER_COMPUTE_TYPE=int8"
        )
    if APP_HOST == "0.0.0.0":
        warnings.append(
            "系统将允许局域网访问。当前版本没有登录鉴权，请仅在可信内网使用并配置防火墙。"
        )
    if not MODEL_NAME:
        warnings.append("MODEL_NAME 不能为空")
    return warnings


CONFIG_WARNINGS = validate_config()

# ==================== 初始化 ====================
APP_VERSION = "2.3"
app = FastAPI(title="Dental AI Scribe", version=APP_VERSION)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

# Whisper模型（延迟加载，避免启动过慢）
_whisper_model = None
_transcribe_lock = asyncio.Lock()

def get_whisper():
    global _whisper_model
    if _whisper_model is None:
        print(f"[*] 正在加载 Whisper 模型: {WHISPER_MODEL} (设备: {WHISPER_DEVICE}, 计算类型: {WHISPER_COMPUTE_TYPE})...")
        _whisper_model = WhisperModel(
            WHISPER_MODEL,
            device=WHISPER_DEVICE,
            compute_type=WHISPER_COMPUTE_TYPE,
            download_root=str(WHISPER_MODEL_DIR)
        )
        print("[*] Whisper 模型加载完成")
    return _whisper_model

# ==================== 数据库 ====================
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute("""
        CREATE TABLE IF NOT EXISTS patients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            gender TEXT,
            age INTEGER,
            phone TEXT,
            allergy TEXT DEFAULT '否认',
            extra_fields_json TEXT DEFAULT '[]',
            created_at TEXT
        )
    """)

    c.execute("PRAGMA table_info(patients)")
    patient_columns = {row[1] for row in c.fetchall()}
    if "extra_fields_json" not in patient_columns:
        c.execute(
            "ALTER TABLE patients ADD COLUMN extra_fields_json TEXT DEFAULT '[]'"
        )

    c.execute("""
        CREATE TABLE IF NOT EXISTS visits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            patient_id INTEGER,
            visit_date TEXT,
            visit_type TEXT DEFAULT '初诊',
            status TEXT DEFAULT 'draft',
            created_at TEXT,
            FOREIGN KEY (patient_id) REFERENCES patients(id)
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            visit_id INTEGER,
            section TEXT,
            content TEXT,
            source TEXT DEFAULT 'ai',
            is_ai_suggestion INTEGER DEFAULT 0,
            needs_confirm INTEGER DEFAULT 0,
            created_at TEXT,
            FOREIGN KEY (visit_id) REFERENCES visits(id)
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS case_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            patient_id INTEGER NOT NULL,
            visit_id INTEGER NOT NULL,
            filename TEXT,
            stored_path TEXT NOT NULL,
            analysis_path TEXT NOT NULL,
            thumb_path TEXT NOT NULL,
            mime_type TEXT DEFAULT 'image/jpeg',
            section TEXT DEFAULT '待归类',
            caption TEXT DEFAULT '',
            tooth_position TEXT DEFAULT '',
            image_type TEXT DEFAULT '其他',
            observations TEXT DEFAULT '',
            needs_confirm INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT,
            FOREIGN KEY (patient_id) REFERENCES patients(id),
            FOREIGN KEY (visit_id) REFERENCES visits(id)
        )
    """)

    conn.commit()
    conn.close()

init_db()

# ==================== 数据模型 ====================
class PatientCreate(BaseModel):
    name: str
    gender: Optional[str] = None
    age: Optional[int] = None
    phone: Optional[str] = None
    allergy: Optional[str] = "否认"
    extra_fields: List[Dict[str, str]] = Field(default_factory=list)


class PatientUpdate(BaseModel):
    name: str
    gender: Optional[str] = None
    age: Optional[int] = None
    phone: Optional[str] = None
    allergy: Optional[str] = "否认"
    extra_fields: List[Dict[str, str]] = Field(default_factory=list)


class CaseChatRequest(BaseModel):
    patient_id: int
    visit_id: Optional[int] = None
    question: str
    conversation: List[Dict[str, Any]] = Field(default_factory=list)
    record: Dict[str, Any] = Field(default_factory=dict)
    history: List[Dict[str, str]] = Field(default_factory=list)
    image_ids: List[int] = Field(default_factory=list)


class ImageMetadataUpdate(BaseModel):
    section: Optional[str] = None
    caption: Optional[str] = None
    tooth_position: Optional[str] = None


class MultimodalAnalyzeRequest(BaseModel):
    patient_id: int
    visit_id: int
    description: str = ""
    conversation: List[Dict[str, Any]] = Field(default_factory=list)
    record: Dict[str, Any] = Field(default_factory=dict)
    image_ids: List[int] = Field(default_factory=list)


class RecordGenerateRequest(BaseModel):
    visit_id: int
    conversation: List[Dict[str, Any]]

class RecordUpdateRequest(BaseModel):
    sections: Dict[str, Any]

# ==================== 页面路由 ====================
@app.get("/", response_class=HTMLResponse)
async def index():
    html_path = BASE_DIR / "static" / "index.html"
    if html_path.exists():
        return html_path.read_text(encoding="utf-8")
    return "<h1>请创建 static/index.html</h1>"

# ==================== 健康检查 ====================
@app.get("/api/health")
async def health_check():
    llm_status: Dict[str, Any] = {
        "status": "unreachable",
        "url": LLAMA_CPP_URL,
        "models": []
    }

    base_url = llama_base_url()
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            health_response = await client.get(f"{base_url}/health")
            if health_response.status_code == 404:
                health_response = await client.get(f"{base_url}/v1/health")

            llm_status["status"] = (
                "ok" if health_response.status_code == 200
                else f"http_{health_response.status_code}"
            )

            models_response = await client.get(f"{base_url}/v1/models")
            if models_response.status_code == 200:
                model_items = models_response.json().get("data", [])
                llm_status["models"] = [
                    item.get("id") for item in model_items if item.get("id")
                ]
                llm_status["model_name_matches"] = MODEL_NAME in llm_status["models"]

        except Exception as exc:
            llm_status["error"] = str(exc)

    return {
        "app": "ok",
        "version": APP_VERSION,
        "llm": llm_status,
        "vision": {
            "enabled": VISION_ENABLED,
            "max_images_per_analysis": MAX_IMAGES_PER_ANALYSIS
        },
        "whisper": {
            "model": WHISPER_MODEL,
            "device": WHISPER_DEVICE,
            "compute_type": WHISPER_COMPUTE_TYPE,
            "loaded": _whisper_model is not None
        },
        "storage": {
            "database": str(DB_PATH),
            "exports": str(EXPORT_DIR),
            "models": str(WHISPER_MODEL_DIR)
        },
        "warnings": CONFIG_WARNINGS
    }


# ==================== 患者管理 ====================
def normalize_patient_extra_fields(
    fields: Optional[List[Dict[str, str]]]
) -> List[Dict[str, str]]:
    normalized: List[Dict[str, str]] = []
    for item in fields or []:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "").strip()
        value = str(item.get("value") or "").strip()
        if not label and not value:
            continue
        normalized.append({
            "label": label or "补充信息",
            "value": value
        })
    return normalized[:30]


def parse_patient_extra_fields(value: Any) -> List[Dict[str, str]]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return []
    return normalize_patient_extra_fields(parsed if isinstance(parsed, list) else [])


def patient_row_to_dict(row: tuple) -> Dict[str, Any]:
    return {
        "id": row[0],
        "name": row[1],
        "gender": row[2],
        "age": row[3],
        "phone": row[4],
        "allergy": row[5],
        "extra_fields": parse_patient_extra_fields(row[6]),
        "created_at": row[7]
    }


@app.post("/api/patients")
async def create_patient(p: PatientCreate):
    clean_name = validate_patient_fields(p.name, p.age)
    gender = (p.gender or "").strip() or None
    phone = (p.phone or "").strip() or None
    allergy = (p.allergy or "").strip() or "否认"
    extra_fields = normalize_patient_extra_fields(p.extra_fields)

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    now = datetime.now().isoformat()
    c.execute("""
        INSERT INTO patients (
            name, gender, age, phone, allergy,
            extra_fields_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (
        clean_name,
        gender,
        p.age,
        phone,
        allergy,
        json.dumps(extra_fields, ensure_ascii=False),
        now
    ))
    patient_id = c.lastrowid
    conn.commit()
    c.execute("""
        SELECT id, name, gender, age, phone, allergy,
               extra_fields_json, created_at
        FROM patients WHERE id = ?
    """, (patient_id,))
    row = c.fetchone()
    conn.close()
    return patient_row_to_dict(row)

def validate_patient_fields(name: str, age: Optional[int]) -> str:
    clean_name = (name or "").strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="患者姓名不能为空。")
    if age is not None and (age < 0 or age > 150):
        raise HTTPException(status_code=400, detail="患者年龄应在 0 至 150 岁之间。")
    return clean_name


@app.put("/api/patients/{patient_id}")
async def update_patient(patient_id: int, p: PatientUpdate):
    clean_name = validate_patient_fields(p.name, p.age)
    gender = (p.gender or "").strip() or None
    phone = (p.phone or "").strip() or None
    allergy = (p.allergy or "").strip() or "否认"
    extra_fields = normalize_patient_extra_fields(p.extra_fields)

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id FROM patients WHERE id = ?", (patient_id,))
    if not c.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="患者不存在或已被删除。")

    c.execute("""
        UPDATE patients
        SET name = ?, gender = ?, age = ?, phone = ?,
            allergy = ?, extra_fields_json = ?
        WHERE id = ?
    """, (
        clean_name,
        gender,
        p.age,
        phone,
        allergy,
        json.dumps(extra_fields, ensure_ascii=False),
        patient_id
    ))
    conn.commit()

    c.execute("""
        SELECT id, name, gender, age, phone, allergy,
               extra_fields_json, created_at
        FROM patients WHERE id = ?
    """, (patient_id,))
    row = c.fetchone()
    conn.close()
    return patient_row_to_dict(row)


@app.get("/api/patients")
async def list_patients(q: Optional[str] = None):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    select_sql = """
        SELECT id, name, gender, age, phone, allergy,
               extra_fields_json, created_at
        FROM patients
    """
    if q:
        c.execute(
            select_sql + """
                WHERE name LIKE ? OR phone LIKE ?
                ORDER BY created_at DESC
            """,
            (f"%{q}%", f"%{q}%")
        )
    else:
        c.execute(select_sql + " ORDER BY created_at DESC LIMIT 100")
    rows = c.fetchall()
    conn.close()
    return {"patients": [patient_row_to_dict(row) for row in rows]}


@app.delete("/api/patients/{patient_id}")
async def delete_patient(patient_id: int):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute("SELECT id, name FROM patients WHERE id = ?", (patient_id,))
    patient = c.fetchone()
    if not patient:
        conn.close()
        raise HTTPException(status_code=404, detail="患者不存在或已被删除。")

    c.execute("""
        SELECT stored_path, analysis_path, thumb_path
        FROM case_images WHERE patient_id = ?
    """, (patient_id,))
    image_paths = c.fetchall()

    c.execute("SELECT id FROM visits WHERE patient_id = ?", (patient_id,))
    visit_ids = [row[0] for row in c.fetchall()]

    if visit_ids:
        placeholders = ",".join("?" for _ in visit_ids)
        c.execute(
            f"DELETE FROM records WHERE visit_id IN ({placeholders})",
            visit_ids
        )

    c.execute("DELETE FROM case_images WHERE patient_id = ?", (patient_id,))
    c.execute("DELETE FROM visits WHERE patient_id = ?", (patient_id,))
    c.execute("DELETE FROM patients WHERE id = ?", (patient_id,))
    conn.commit()
    conn.close()

    for paths in image_paths:
        for path_value in paths:
            if not path_value:
                continue
            try:
                Path(path_value).unlink(missing_ok=True)
            except Exception:
                pass

    return {
        "status": "deleted",
        "patient_id": patient_id,
        "name": patient[1]
    }

@app.post("/api/visits")
async def create_visit(patient_id: int, visit_type: str = "初诊"):
    """
    创建就诊记录。

    patient_id 和 visit_type 使用查询参数，与前端调用方式保持一致。
    旧版本后端使用 Form(...)，而前端发送查询参数，会导致 422，
    使 currentVisit 变成 undefined，进而无法开始录音。
    """
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute("SELECT id FROM patients WHERE id = ?", (patient_id,))
    if not c.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="患者不存在，请重新选择患者。")

    now = datetime.now().isoformat()
    c.execute("""
        INSERT INTO visits (patient_id, visit_date, visit_type, status, created_at)
        VALUES (?, ?, ?, ?, ?)
    """, (patient_id, now[:10], visit_type or "初诊", "recording", now))
    visit_id = c.lastrowid
    conn.commit()
    conn.close()

    return {
        "visit_id": visit_id,
        "patient_id": patient_id,
        "visit_type": visit_type or "初诊"
    }

# ==================== 语音转写 ====================
def resolve_audio_suffix(filename: Optional[str], content_type: Optional[str]) -> str:
    """根据文件名或MIME类型确定临时文件后缀。"""
    suffix = Path(filename or "").suffix.lower()
    if suffix in SUPPORTED_AUDIO_EXTENSIONS:
        return suffix

    mime = (content_type or "").split(";")[0].strip().lower()
    mapped_suffix = AUDIO_CONTENT_TYPE_SUFFIX.get(mime)
    if mapped_suffix:
        return mapped_suffix

    raise HTTPException(
        status_code=400,
        detail="不支持的录音格式。请上传 MP3、WAV、M4A、WEBM、OGG、FLAC、AAC、WMA、OPUS 或 MP4 文件。"
    )


def run_whisper_transcription(temp_path: Path):
    """在线程中完成同步的Whisper推理，避免阻塞FastAPI事件循环。"""
    model = get_whisper()
    segments, info = model.transcribe(
        str(temp_path),
        language="zh",
        vad_filter=True,
        condition_on_previous_text=True,
        beam_size=WHISPER_BEAM_SIZE,
        initial_prompt=WHISPER_INITIAL_PROMPT or None
    )
    text = "".join(segment.text for segment in segments).strip()
    return text, info


@app.post("/api/transcribe")
async def transcribe_audio(audio: UploadFile = File(...)):
    """
    接收浏览器实时录音或用户上传的录音文件并返回转写文本。
    支持常见音频格式，采用分块写入避免大文件一次性占用内存。
    """
    suffix = resolve_audio_suffix(audio.filename, audio.content_type)
    temp_path: Optional[Path] = None
    total_size = 0

    try:
        with tempfile.NamedTemporaryFile(
            prefix="dental_audio_",
            suffix=suffix,
            delete=False
        ) as temp_file:
            temp_path = Path(temp_file.name)

            while True:
                chunk = await audio.read(AUDIO_UPLOAD_CHUNK_BYTES)
                if not chunk:
                    break

                total_size += len(chunk)
                if total_size > MAX_AUDIO_FILE_SIZE_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"录音文件不能超过 {MAX_AUDIO_FILE_SIZE_MB} MB。"
                    )

                temp_file.write(chunk)

        if total_size == 0:
            raise HTTPException(status_code=400, detail="录音文件为空。")

        # 单机部署下串行转写，避免多个大文件同时占满CPU/GPU与内存。
        async with _transcribe_lock:
            text, info = await asyncio.to_thread(run_whisper_transcription, temp_path)

        return {
            "text": text,
            "language": info.language,
            "duration": round(info.duration, 2),
            "filename": audio.filename or f"recording{suffix}",
            "size_bytes": total_size
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"录音转写失败：{exc}") from exc
    finally:
        await audio.close()
        if temp_path:
            temp_path.unlink(missing_ok=True)

# ==================== 录音文字与文档导入 ====================
def decode_text_bytes(content: bytes) -> str:
    """兼容常见中文文本编码。"""
    encodings = ("utf-8-sig", "utf-8", "gb18030", "big5", "utf-16")
    for encoding in encodings:
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def normalize_imported_text(text: str) -> str:
    text = str(text or "").replace("\x00", "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text.strip()


def clean_subtitle_text(text: str) -> str:
    """移除 SRT/VTT 序号和时间轴，保留实际对话文字。"""
    output = []
    timestamp = re.compile(
        r"^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{3}\s*-->\s*"
        r"(?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{3}"
    )

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.upper() == "WEBVTT":
            continue
        if stripped.isdigit() or timestamp.match(stripped):
            continue
        stripped = re.sub(r"<[^>]+>", "", stripped)
        output.append(stripped)

    return "\n".join(output)


def extract_docx_text(content: bytes) -> str:
    document = Document(io.BytesIO(content))
    parts = [p.text.strip() for p in document.paragraphs if p.text.strip()]

    for table in document.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
            if cells:
                parts.append(" | ".join(cells))

    return "\n".join(parts)


def extract_pdf_text(content: bytes) -> str:
    reader = PdfReader(io.BytesIO(content))
    pages = []

    for index, page in enumerate(reader.pages, start=1):
        page_text = (page.extract_text() or "").strip()
        if page_text:
            pages.append(f"【第{index}页】\n{page_text}")

    return "\n\n".join(pages)


def limit_imported_text(text: str) -> tuple[str, bool, int]:
    original_chars = len(text)
    if original_chars <= MAX_IMPORTED_TEXT_CHARS:
        return text, False, original_chars

    # 同时保留开头问诊和结尾诊断/医嘱，比单纯截取开头更适合门诊录音。
    head_chars = int(MAX_IMPORTED_TEXT_CHARS * 0.72)
    tail_chars = MAX_IMPORTED_TEXT_CHARS - head_chars
    limited = (
        text[:head_chars]
        + "\n\n【中间内容因本地模型上下文限制已省略】\n\n"
        + text[-tail_chars:]
    )
    return limited, True, original_chars


def extract_uploaded_document(
    filename: Optional[str],
    content_type: Optional[str],
    content: bytes
) -> tuple[str, str]:
    suffix = Path(filename or "").suffix.lower()
    if suffix not in SUPPORTED_TEXT_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                "不支持该文件格式。请上传 TXT、MD、CSV、JSON、SRT、VTT、"
                "DOCX 或 PDF 文件。"
            )
        )

    if suffix in PLAIN_TEXT_EXTENSIONS:
        text = decode_text_bytes(content)
        if suffix in {".srt", ".vtt"}:
            text = clean_subtitle_text(text)
        elif suffix == ".json":
            try:
                parsed = json.loads(text)
                text = json.dumps(parsed, ensure_ascii=False, indent=2)
            except json.JSONDecodeError:
                pass
    elif suffix == ".docx":
        text = extract_docx_text(content)
    elif suffix == ".pdf":
        text = extract_pdf_text(content)
    else:
        text = ""

    text = normalize_imported_text(text)
    if not text:
        if suffix == ".pdf":
            raise HTTPException(
                status_code=400,
                detail="PDF 中没有可提取文字；扫描版 PDF 需要先进行 OCR。"
            )
        raise HTTPException(status_code=400, detail="文件中没有读取到有效文字。")

    return text, suffix.lstrip(".").upper()


@app.post("/api/import-text")
async def import_text_document(document: UploadFile = File(...)):
    """从常见文字、字幕、DOCX 和 PDF 文件中提取录音文字。"""
    content = await document.read()

    try:
        if not content:
            raise HTTPException(status_code=400, detail="上传文件为空。")
        if len(content) > MAX_TEXT_FILE_SIZE_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"文字文件不能超过 {MAX_TEXT_FILE_SIZE_MB} MB。"
            )

        text, format_name = await asyncio.to_thread(
            extract_uploaded_document,
            document.filename,
            document.content_type,
            content
        )
        limited_text, truncated, original_chars = limit_imported_text(text)

        return {
            "text": limited_text,
            "filename": document.filename or "imported-text",
            "format": format_name,
            "chars": len(limited_text),
            "original_chars": original_chars,
            "truncated": truncated
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"文字文件解析失败：{exc}") from exc
    finally:
        await document.close()


# ==================== 病例图片与多模态分析 ====================
def validate_visit_patient(patient_id: int, visit_id: int) -> None:
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "SELECT id FROM visits WHERE id = ? AND patient_id = ?",
        (visit_id, patient_id)
    )
    valid = c.fetchone() is not None
    conn.close()
    if not valid:
        raise HTTPException(status_code=400, detail="患者与就诊记录不匹配。")


def image_row_to_dict(row: tuple) -> Dict[str, Any]:
    return {
        "id": row[0],
        "patient_id": row[1],
        "visit_id": row[2],
        "filename": row[3],
        "mime_type": row[7],
        "section": row[8] or "待归类",
        "caption": row[9] or "",
        "tooth_position": row[10] or "",
        "image_type": row[11] or "其他",
        "observations": row[12] or "",
        "needs_confirm": bool(row[13]),
        "sort_order": row[14] or 0,
        "created_at": row[15],
        "url": f"/api/images/{row[0]}/file",
        "thumbnail_url": f"/api/images/{row[0]}/thumbnail"
    }


def fetch_image_rows(
    visit_id: Optional[int] = None,
    image_ids: Optional[List[int]] = None
) -> List[tuple]:
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    base = """
        SELECT id, patient_id, visit_id, filename, stored_path,
               analysis_path, thumb_path, mime_type, section, caption,
               tooth_position, image_type, observations, needs_confirm,
               sort_order, created_at
        FROM case_images
    """
    params: List[Any] = []

    if image_ids:
        placeholders = ",".join("?" for _ in image_ids)
        base += f" WHERE id IN ({placeholders})"
        params.extend(image_ids)
    elif visit_id is not None:
        base += " WHERE visit_id = ?"
        params.append(visit_id)

    base += " ORDER BY sort_order, id"
    c.execute(base, params)
    rows = c.fetchall()
    conn.close()

    if image_ids:
        order = {image_id: index for index, image_id in enumerate(image_ids)}
        rows.sort(key=lambda row: order.get(row[0], len(order)))
    return rows


def assert_image_access(
    rows: List[tuple],
    patient_id: int,
    visit_id: Optional[int]
) -> None:
    for row in rows:
        if row[1] != patient_id:
            raise HTTPException(status_code=403, detail="图片不属于当前患者。")
        if visit_id is not None and row[2] != visit_id:
            raise HTTPException(status_code=403, detail="图片不属于当前就诊记录。")


def fit_image(image: Image.Image, max_edge: int) -> Image.Image:
    image = ImageOps.exif_transpose(image)
    if image.mode not in {"RGB", "L"}:
        if "A" in image.getbands():
            background = Image.new("RGB", image.size, "white")
            background.paste(image, mask=image.getchannel("A"))
            image = background
        else:
            image = image.convert("RGB")
    elif image.mode == "L":
        image = image.convert("RGB")

    image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    return image


def save_normalized_image(
    content: bytes,
    patient_id: int,
    visit_id: int,
    original_filename: str
) -> Dict[str, Any]:
    visit_dir = IMAGE_DIR / str(patient_id) / str(visit_id)
    visit_dir.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex

    try:
        with Image.open(io.BytesIO(content)) as opened:
            opened.load()
            stored = fit_image(opened.copy(), IMAGE_STORE_MAX_EDGE)
            analysis = fit_image(opened.copy(), IMAGE_ANALYSIS_MAX_EDGE)
            thumb = fit_image(opened.copy(), IMAGE_THUMB_MAX_EDGE)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"无法读取图片：{exc}") from exc

    stored_path = visit_dir / f"{token}.jpg"
    analysis_path = visit_dir / f"{token}_analysis.jpg"
    thumb_path = visit_dir / f"{token}_thumb.jpg"

    stored.save(stored_path, format="JPEG", quality=92, optimize=True)
    analysis.save(analysis_path, format="JPEG", quality=88, optimize=True)
    thumb.save(thumb_path, format="JPEG", quality=84, optimize=True)

    return {
        "stored_path": str(stored_path),
        "analysis_path": str(analysis_path),
        "thumb_path": str(thumb_path),
        "mime_type": "image/jpeg",
        "filename": Path(original_filename or "case-image.jpg").name
    }


def image_to_data_url(path_value: str, mime_type: str = "image/jpeg") -> str:
    path = Path(path_value)
    if not path.exists():
        raise HTTPException(status_code=404, detail="病例图片文件不存在。")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def save_record_to_db(visit_id: int, record: Dict[str, Any]) -> None:
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    now = datetime.now().isoformat()
    c.execute("DELETE FROM records WHERE visit_id = ?", (visit_id,))

    for section, data in record.items():
        if section not in CLINICAL_SECTIONS:
            continue
        if isinstance(data, dict):
            content = str(data.get("content") or "")
            source = str(data.get("source") or "ai")
            needs_confirm = bool(data.get("needs_confirm"))
        else:
            content = str(data or "")
            source = "ai"
            needs_confirm = False

        c.execute("""
            INSERT INTO records (
                visit_id, section, content, source,
                is_ai_suggestion, needs_confirm, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            visit_id,
            section,
            content,
            source,
            1 if source == "ai_suggestion" else 0,
            1 if needs_confirm else 0,
            now
        ))

    conn.commit()
    conn.close()


@app.post("/api/images/upload")
async def upload_case_images(
    patient_id: int = Form(...),
    visit_id: int = Form(...),
    section: str = Form("待归类"),
    images: List[UploadFile] = File(...)
):
    validate_visit_patient(patient_id, visit_id)
    if section not in IMAGE_SECTIONS:
        raise HTTPException(status_code=400, detail="无效的病例图片归档版块。")
    if not images:
        raise HTTPException(status_code=400, detail="请选择至少一张图片。")

    existing_count = len(fetch_image_rows(visit_id=visit_id))
    if existing_count + len(images) > MAX_IMAGES_PER_VISIT:
        raise HTTPException(
            status_code=400,
            detail=f"每次就诊最多保存 {MAX_IMAGES_PER_VISIT} 张图片。"
        )

    created = []
    for index, upload in enumerate(images):
        content = await upload.read()
        try:
            suffix = Path(upload.filename or "").suffix.lower()
            content_type = (upload.content_type or "").lower()
            if (
                suffix not in SUPPORTED_IMAGE_EXTENSIONS
                and content_type not in SUPPORTED_IMAGE_MIME_TYPES
            ):
                raise HTTPException(
                    status_code=400,
                    detail=f"{upload.filename or '图片'} 格式不支持。"
                )
            if not content:
                raise HTTPException(status_code=400, detail="上传图片为空。")
            if len(content) > MAX_IMAGE_FILE_SIZE_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"单张图片不能超过 {MAX_IMAGE_FILE_SIZE_MB} MB。"
                )

            saved = await asyncio.to_thread(
                save_normalized_image,
                content,
                patient_id,
                visit_id,
                upload.filename or f"image-{index + 1}.jpg"
            )

            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute(
                "SELECT COALESCE(MAX(sort_order), 0) FROM case_images WHERE visit_id = ?",
                (visit_id,)
            )
            next_order = int(c.fetchone()[0] or 0) + 1
            c.execute("""
                INSERT INTO case_images (
                    patient_id, visit_id, filename, stored_path,
                    analysis_path, thumb_path, mime_type, section,
                    caption, tooth_position, image_type, observations,
                    needs_confirm, sort_order, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', '其他', '', 1, ?, ?)
            """, (
                patient_id,
                visit_id,
                saved["filename"],
                saved["stored_path"],
                saved["analysis_path"],
                saved["thumb_path"],
                saved["mime_type"],
                section,
                next_order,
                datetime.now().isoformat()
            ))
            image_id = c.lastrowid
            conn.commit()
            conn.close()

            row = fetch_image_rows(image_ids=[image_id])[0]
            created.append(image_row_to_dict(row))
        finally:
            await upload.close()

    return {"images": created, "count": len(created)}


@app.get("/api/images")
async def list_case_images(
    patient_id: int,
    visit_id: int
):
    validate_visit_patient(patient_id, visit_id)
    rows = fetch_image_rows(visit_id=visit_id)
    assert_image_access(rows, patient_id, visit_id)
    return {"images": [image_row_to_dict(row) for row in rows]}


@app.get("/api/images/{image_id}/thumbnail")
async def case_image_thumbnail(image_id: int):
    rows = fetch_image_rows(image_ids=[image_id])
    if not rows:
        raise HTTPException(status_code=404, detail="图片不存在。")
    path = Path(rows[0][6])
    if not path.exists():
        raise HTTPException(status_code=404, detail="缩略图文件不存在。")
    return FileResponse(path=path, media_type="image/jpeg")


@app.get("/api/images/{image_id}/file")
async def case_image_file(image_id: int):
    rows = fetch_image_rows(image_ids=[image_id])
    if not rows:
        raise HTTPException(status_code=404, detail="图片不存在。")
    path = Path(rows[0][4])
    if not path.exists():
        raise HTTPException(status_code=404, detail="图片文件不存在。")
    return FileResponse(path=path, media_type=rows[0][7] or "image/jpeg")


@app.put("/api/images/{image_id}")
async def update_case_image(image_id: int, req: ImageMetadataUpdate):
    rows = fetch_image_rows(image_ids=[image_id])
    if not rows:
        raise HTTPException(status_code=404, detail="图片不存在。")

    current = rows[0]
    section = req.section if req.section is not None else current[8]
    if section not in IMAGE_SECTIONS:
        raise HTTPException(status_code=400, detail="无效的病历版块。")

    caption = (
        req.caption.strip()
        if req.caption is not None
        else (current[9] or "")
    )
    tooth_position = (
        req.tooth_position.strip()
        if req.tooth_position is not None
        else (current[10] or "")
    )

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        UPDATE case_images
        SET section = ?, caption = ?, tooth_position = ?
        WHERE id = ?
    """, (section, caption, tooth_position, image_id))
    conn.commit()
    conn.close()

    return image_row_to_dict(fetch_image_rows(image_ids=[image_id])[0])


@app.delete("/api/images/{image_id}")
async def delete_case_image(image_id: int):
    rows = fetch_image_rows(image_ids=[image_id])
    if not rows:
        raise HTTPException(status_code=404, detail="图片不存在。")

    row = rows[0]
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM case_images WHERE id = ?", (image_id,))
    conn.commit()
    conn.close()

    for path_value in (row[4], row[5], row[6]):
        try:
            Path(path_value).unlink(missing_ok=True)
        except Exception:
            pass
    return {"status": "deleted", "image_id": image_id}


MULTIMODAL_RECORD_PROMPT = """你是口腔门诊多模态病历助手。你将同时收到患者资料、医患对话、医生描述、当前病历草稿以及按顺序编号的病例图片。

核心任务：
1. 将文字与图片中可以明确支持的信息整理到对应病历版块。
2. 根据医生描述中的“第一张、第二张、图片1、图片2”等表述，正确对应请求中的图片顺序。
3. 为每张图片选择最合适的病历位置并生成简洁图注。
4. 口内照片通常归入“口腔专科检查”；X线、CBCT、影像截图通常归入“辅助检查”；术中或术后照片可归入“处置”；不能确定时归入“待归类”。
5. 图像只能作为辅助证据。不得把仅凭图片无法确认的内容写成确诊事实。
6. 诊断和治疗计划必须标记为 AI 建议并由医生确认。
7. 不得虚构未提供的病史、牙位、检查、影像结果或已完成治疗。
8. 医生明确描述的内容优先作为临床文字证据；模型自己的图像观察必须标记 needs_confirm=true。
9. 图片中看不清、方向不明或牙位无法确定时，明确写“需确认”，不要猜测。

可用病历版块：
主诉、现病史、既往史、口腔专科检查、辅助检查、诊断、治疗计划、处置、医嘱。

只输出严格 JSON：
{
  "record": {
    "主诉": {"content":"","source":"ai","needs_confirm":false},
    "现病史": {"content":"","source":"ai","needs_confirm":false},
    "既往史": {"content":"","source":"ai","needs_confirm":false},
    "口腔专科检查": {"content":"","source":"ai","needs_confirm":true},
    "辅助检查": {"content":"","source":"ai","needs_confirm":true},
    "诊断": {"content":"","source":"ai_suggestion","needs_confirm":true},
    "治疗计划": {"content":"","source":"ai_suggestion","needs_confirm":true},
    "处置": {"content":"","source":"ai","needs_confirm":false},
    "医嘱": {"content":"","source":"ai_suggestion","needs_confirm":true}
  },
  "image_bindings": [
    {
      "image_id": 1,
      "section": "口腔专科检查",
      "caption": "简洁图注",
      "tooth_position": "可确定时填写FDI牙位，否则留空",
      "image_type": "口内照|面像|X线|CBCT|术中照|术后照|其他",
      "observations": "仅描述图片可见内容和局限性",
      "needs_confirm": true
    }
  ],
  "summary": "本次图文整合摘要"
}
"""


def format_multimodal_context(
    patient_info: str,
    description: str,
    conversation: List[Dict[str, Any]],
    record: Dict[str, Any],
    image_rows: List[tuple]
) -> str:
    conversation_text = format_chat_conversation(conversation)
    record_text = format_chat_record(record)
    image_lines = []
    for index, row in enumerate(image_rows, start=1):
        image_lines.append(
            f"图片{index}：image_id={row[0]}，原文件名={row[3]}，"
            f"当前归类={row[8] or '待归类'}，现有图注={row[9] or '无'}"
        )

    return f"""【患者资料】
{patient_info}

【医生本次描述】
{limit_text(description, 3200) or "未单独填写医生描述，请结合对话和图片。"}

【医患对话与录音转写】
{limit_text(conversation_text, 4200, keep_tail=True) or "暂无对话文字。"}

【当前病历草稿】
{limit_text(record_text, 4200) or "暂无病历草稿。"}

【图片编号对应关系】
{chr(10).join(image_lines)}

请严格按照图片编号关系完成图文归档。"""


@app.post("/api/multimodal/analyze")
async def analyze_multimodal_case(req: MultimodalAnalyzeRequest):
    if not VISION_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="系统未启用多模态能力，请在启动配置中启用 mmproj。"
        )

    validate_visit_patient(req.patient_id, req.visit_id)
    image_ids = list(dict.fromkeys(req.image_ids))[:MAX_IMAGES_PER_ANALYSIS]
    if not image_ids:
        raise HTTPException(status_code=400, detail="请选择至少一张病例图片。")

    image_rows = fetch_image_rows(image_ids=image_ids)
    if len(image_rows) != len(image_ids):
        raise HTTPException(status_code=404, detail="部分病例图片不存在。")
    assert_image_access(image_rows, req.patient_id, req.visit_id)

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        SELECT p.name, p.gender, p.age, p.allergy,
               p.extra_fields_json, v.visit_date, v.visit_type
        FROM visits v
        JOIN patients p ON v.patient_id = p.id
        WHERE v.id = ?
    """, (req.visit_id,))
    patient = c.fetchone()
    conn.close()

    if not patient:
        raise HTTPException(status_code=404, detail="患者或就诊记录不存在。")

    patient_info = (
        f"姓名：{patient[0]}；性别：{patient[1] or '未知'}；"
        f"年龄：{patient[2] if patient[2] is not None else '未知'}；"
        f"过敏史：{patient[3] or '否认'}；"
        f"就诊日期：{patient[5] or '未知'}；就诊类型：{patient[6] or '未知'}"
    )
    multimodal_extra_fields = parse_patient_extra_fields(patient[4])
    if multimodal_extra_fields:
        patient_info += "；" + "；".join(
            f"{item['label']}：{item['value'] or '未填写'}"
            for item in multimodal_extra_fields
        )

    context = format_multimodal_context(
        patient_info,
        req.description,
        req.conversation,
        req.record,
        image_rows
    )

    content: List[Dict[str, Any]] = [
        {
            "type": "text",
            "text": MULTIMODAL_RECORD_PROMPT + "\n\n" + context
        }
    ]

    for index, row in enumerate(image_rows, start=1):
        content.append({
            "type": "text",
            "text": f"下面是图片{index}，image_id={row[0]}。"
        })
        content.append({
            "type": "image_url",
            "image_url": {
                "url": image_to_data_url(row[5], row[7] or "image/jpeg")
            }
        })

    try:
        raw = await call_llm(
            [{"role": "user", "content": content}],
            temperature=0.15,
            max_tokens=LLM_MAX_TOKENS_VISION,
            require_json=True,
            extra_payload={"cache_prompt": False}
        )
    except HTTPException as exc:
        detail = str(exc.detail)
        if "image input is not supported" in detail.lower() or "mmproj" in detail.lower():
            raise HTTPException(
                status_code=503,
                detail=(
                    "本地模型尚未加载视觉投影文件 mmproj。"
                    "请使用 v2.1 一键启动器重新启动本地模型。"
                )
            ) from exc
        raise

    parsed = extract_json_from_text(raw)
    if not parsed or not isinstance(parsed.get("record"), dict):
        raise HTTPException(
            status_code=502,
            detail="多模态模型返回格式无法解析，请减少图片数量后重试。"
        )

    record = parsed["record"]
    bindings = parsed.get("image_bindings", [])
    allowed_ids = {row[0] for row in image_rows}
    normalized_bindings = []

    for binding in bindings:
        try:
            image_id = int(binding.get("image_id"))
        except (TypeError, ValueError):
            continue
        if image_id not in allowed_ids:
            continue

        section = str(binding.get("section") or "待归类")
        if section not in IMAGE_SECTIONS:
            section = "待归类"

        normalized = {
            "image_id": image_id,
            "section": section,
            "caption": str(binding.get("caption") or "").strip(),
            "tooth_position": str(binding.get("tooth_position") or "").strip(),
            "image_type": str(binding.get("image_type") or "其他").strip(),
            "observations": str(binding.get("observations") or "").strip(),
            "needs_confirm": bool(binding.get("needs_confirm", True))
        }
        normalized_bindings.append(normalized)

        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""
            UPDATE case_images
            SET section = ?, caption = ?, tooth_position = ?,
                image_type = ?, observations = ?, needs_confirm = ?
            WHERE id = ?
        """, (
            normalized["section"],
            normalized["caption"],
            normalized["tooth_position"],
            normalized["image_type"],
            normalized["observations"],
            1 if normalized["needs_confirm"] else 0,
            image_id
        ))
        conn.commit()
        conn.close()

    save_record_to_db(req.visit_id, record)
    updated_rows = fetch_image_rows(visit_id=req.visit_id)

    return {
        "record": record,
        "image_bindings": normalized_bindings,
        "images": [image_row_to_dict(row) for row in updated_rows],
        "summary": str(parsed.get("summary") or "").strip(),
        "patient_id": req.patient_id,
        "visit_id": req.visit_id,
        "model": MODEL_NAME
    }


# ==================== LLM 服务 ====================
def llama_base_url() -> str:
    marker = "/v1/"
    if marker in LLAMA_CPP_URL:
        return LLAMA_CPP_URL.split(marker, 1)[0].rstrip("/")
    return LLAMA_CPP_URL.rsplit("/", 1)[0].rstrip("/")


async def call_llm(
    messages: List[Dict],
    temperature: float = 0.3,
    max_tokens: int = 4096,
    require_json: bool = False,
    extra_payload: Optional[Dict[str, Any]] = None
) -> str:
    """调用 llama.cpp 的 OpenAI 兼容接口。"""
    payload: Dict[str, Any] = {
        "model": MODEL_NAME,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stop": ["<|im_end|>", "<|endoftext|>"]
    }

    if extra_payload:
        payload.update(extra_payload)

    if require_json and LLM_JSON_MODE:
        payload["response_format"] = {"type": "json_object"}

    if LLM_DISABLE_THINKING:
        payload["chat_template_kwargs"] = {"enable_thinking": False}
        payload["reasoning_effort"] = "none"

    async with httpx.AsyncClient(timeout=LLM_TIMEOUT_SECONDS) as client:
        try:
            response = await client.post(LLAMA_CPP_URL, json=payload)

            # 某些旧版 llama.cpp 不支持 response_format 或 thinking 参数，自动降级重试。
            if response.status_code in {400, 404, 422} and (
                "response_format" in payload
                or "chat_template_kwargs" in payload
                or "reasoning_effort" in payload
            ):
                fallback_payload = dict(payload)
                fallback_payload.pop("response_format", None)
                fallback_payload.pop("chat_template_kwargs", None)
                fallback_payload.pop("reasoning_effort", None)
                response = await client.post(LLAMA_CPP_URL, json=fallback_payload)

            response.raise_for_status()
            data = response.json()
            return data["choices"][0]["message"]["content"]

        except httpx.ConnectError as exc:
            raise HTTPException(
                status_code=503,
                detail=(
                    "无法连接本地大模型服务。请先启动 llama-server，并检查 "
                    f"LLAMA_CPP_URL={LLAMA_CPP_URL}"
                )
            ) from exc
        except httpx.TimeoutException as exc:
            raise HTTPException(
                status_code=504,
                detail=f"大模型生成超时（{LLM_TIMEOUT_SECONDS:.0f} 秒），可提高 LLM_TIMEOUT_SECONDS"
            ) from exc
        except httpx.HTTPStatusError as exc:
            response_text = ""
            try:
                response_text = exc.response.text[:800]
            except Exception:
                pass
            raise HTTPException(
                status_code=502,
                detail=f"大模型接口返回 HTTP {exc.response.status_code}：{response_text or exc}"
            ) from exc
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail=f"大模型接口返回异常：{exc}"
            ) from exc


def extract_json_from_text(text: str) -> Optional[Dict]:
    """从模型输出中提取JSON块"""
    try:
        if "```json" in text:
            json_str = text.split("```json")[1].split("```")[0]
        elif "```" in text:
            json_str = text.split("```")[1].split("```")[0]
        else:
            # 尝试直接解析
            json_str = text
        return json.loads(json_str.strip())
    except Exception:
        return None

# ==================== 知识库 ====================
def load_kb() -> Dict:
    kb_path = BASE_DIR / "kb" / "dental_knowledge.json"
    if kb_path.exists():
        return json.loads(kb_path.read_text(encoding="utf-8"))
    return {}

KB_ALIASES = {
    "龋病": ["龋病", "龋齿", "蛀牙", "虫牙", "烂洞", "龋洞", "深龋", "中龋", "浅龋"],
    "牙髓炎": ["牙髓炎", "牙神经疼", "神经疼", "自发痛", "夜间痛", "冷热痛", "放射痛"],
    "根尖周炎": ["根尖周炎", "咬合痛", "叩痛", "根尖", "牙根发炎", "牙龈脓包"],
    "牙周炎": ["牙周炎", "牙龈出血", "牙周袋", "牙齿松动", "牙槽骨吸收", "洁牙", "刮治"],
    "阻生齿": ["阻生齿", "阻生牙", "智齿", "第三磨牙", "长歪", "近中阻生", "水平阻生"],
    "牙列缺损": ["牙列缺损", "缺牙", "牙齿缺失", "活动义齿", "固定桥", "种植修复"],
    "牙列缺失": ["牙列缺失", "全口无牙", "全口义齿", "无牙颌"],
    "口腔溃疡": ["口腔溃疡", "阿弗他", "黏膜溃疡", "口疮"],
    "口腔扁平苔藓": ["扁平苔藓", "白色网纹", "黏膜糜烂"],
    "颞下颌关节紊乱": ["颞下颌关节", "关节弹响", "张口受限", "张口疼", "TMD"]
}


def search_kb(query: str, top_k: int = 3) -> str:
    """使用疾病名称、常见口语和临床关键词检索本地知识库。"""
    kb = load_kb()
    if not kb or not query:
        return ""

    query_text = str(query).lower()
    scores = []

    for disease, info in kb.items():
        score = 0.0
        if disease.lower() in query_text:
            score += 10.0

        for alias in KB_ALIASES.get(disease, [disease]):
            alias_lower = alias.lower()
            if alias_lower in query_text:
                score += max(2.0, len(alias_lower) * 0.8)

        for keyword in re.findall(r"[\u4e00-\u9fff]{2,6}", info):
            if keyword in query_text:
                score += 0.3

        if score > 0:
            scores.append((score, disease, info))

    scores.sort(key=lambda item: item[0], reverse=True)
    return "\n".join(
        f"【{disease}】{info}"
        for _, disease, info in scores[:top_k]
    )

# ==================== Prompt 模板 ====================
EXTRACTION_PROMPT = """你是口腔门诊病历信息提取助手。请只依据录音转写内容提取信息，输出严格JSON。

【录音转写】
{conversation}

【核心原则】
1. 录音没有提到的事实不得补写、猜测或套用常规模板。
2. 区分患者描述、医生检查结论和医生治疗建议。
3. 医患混合且说话人未区分时，只在语义明确时归类；有歧义就放入“需确认事项”。
4. 牙位优先转换为FDI两位数记录法；无法确定具体牙位时保留原部位并标注需确认。
5. 知识库只用于后续术语规范和建议，不能作为患者已经存在某项体征的证据。

【提取字段】
- 主诉：症状、部位、持续时间。
- 现病史：起病、诱因、症状特点、演变、既往处理。
- 既往史：系统疾病、手术史、长期用药、过敏史。
- 检查所见：医生明确说出的口内客观检查。
- 辅助检查：X线、CBCT、化验等明确结果。
- 已行处置：录音中明确已经完成的操作。
- 医嘱：录音中明确交代的注意事项和复诊安排。
- 诊断线索：仅列与录音证据相符的候选关键词。
- 需确认事项：牙位、时间、病史、检查等不清楚的信息。

【输出格式】只输出JSON，不要解释：
{{"主诉":"","现病史":"","既往史":"","检查所见":"","辅助检查":"","已行处置":"","医嘱":"","诊断线索":[],"需确认事项":[]}}"""

RECORD_PROMPT = """你是口腔门诊病历书写助手。请依据患者信息、录音提取结果和本地知识库，自动填写门诊病历模板。

【患者信息】
{patient_info}

【录音提取结果】
{extracted}

【本地知识库检索结果】
{kb_context}

【安全与证据规则】
1. 客观病史、检查结果、辅助检查、已行处置只能来自患者信息或录音证据。
2. 知识库只能用于专业术语规范、候选诊断和治疗建议，不能捏造患者体征。
3. 录音未提及的字段保持空字符串，不要自动写“正常”“无异常”或虚构阴性结果。
4. 诊断和治疗计划均为AI建议，必须 needs_confirm=true。
5. 牙位不明确时保留空牙位，并在内容中写“牙位需确认”。
6. 不要在content正文中加入“【AI生成】”“【AI建议】”等前缀，来源由source字段标记。
7. 内容应为可直接进入病历模板的专业中文，不写分析过程。

【模板字段】
- 主诉：症状+部位+时间，简洁。
- 现病史：按时间顺序整理。
- 既往史：仅写已知系统病史、用药、手术及过敏信息。
- 口腔专科检查：仅写录音中明确的客观检查。
- 辅助检查：仅写明确的影像或化验结果。
- 诊断：根据证据及知识库提出候选诊断。
- 治疗计划：根据候选诊断提出分阶段方案。
- 处置：只写本次明确已经实施的操作。
- 医嘱：优先采用录音中医生明确交代的内容；必要的通用建议标为AI建议。

【牙位结构格式】
“口腔专科检查、辅助检查、诊断、治疗计划”的content必须使用下列可解析格式。
每一个牙位/部位单独一行：
牙位（右上：16；左上：；右下：；左下：）：16牙远中邻面深龋，探诊敏感
牙位（右上：；左上：26；右下：；左下：）：26牙烤瓷冠边缘不密合

四个象限都必须保留；没有对应牙位时留空。
全口或无具体牙位内容示例：
牙位（右上：；左上：；右下：；左下：）：全口牙龈红肿，探诊出血

【输出格式】只输出以下JSON，不要输出其他文字：
{{"主诉":{{"content":"","source":"ai","needs_confirm":false}},
"现病史":{{"content":"","source":"ai","needs_confirm":false}},
"既往史":{{"content":"","source":"ai","needs_confirm":false}},
"口腔专科检查":{{"content":"","source":"ai","needs_confirm":false}},
"辅助检查":{{"content":"","source":"ai","needs_confirm":false}},
"诊断":{{"content":"","source":"ai_suggestion","needs_confirm":true}},
"治疗计划":{{"content":"","source":"ai_suggestion","needs_confirm":true}},
"处置":{{"content":"","source":"ai","needs_confirm":false}},
"医嘱":{{"content":"","source":"ai_suggestion","needs_confirm":true}}}}"""

# ==================== 长录音文字分段提取 ====================
EXTRACTION_TEXT_FIELDS = [
    "主诉", "现病史", "既往史", "检查所见",
    "辅助检查", "已行处置", "医嘱"
]
EXTRACTION_LIST_FIELDS = ["诊断线索", "需确认事项"]


def split_transcript_text(text: str) -> List[str]:
    text = normalize_imported_text(text)
    if not text:
        return []

    max_total_chars = TRANSCRIPT_CHUNK_CHARS * MAX_TRANSCRIPT_CHUNKS
    if len(text) > max_total_chars:
        head_chars = int(max_total_chars * 0.72)
        tail_chars = max_total_chars - head_chars
        text = (
            text[:head_chars]
            + "\n\n【中间录音内容因上下文限制已省略】\n\n"
            + text[-tail_chars:]
        )

    paragraphs = [item.strip() for item in text.splitlines() if item.strip()]
    chunks: List[str] = []
    current = ""

    for paragraph in paragraphs:
        if len(paragraph) > TRANSCRIPT_CHUNK_CHARS:
            if current:
                chunks.append(current)
                current = ""
            for start in range(0, len(paragraph), TRANSCRIPT_CHUNK_CHARS):
                chunks.append(paragraph[start:start + TRANSCRIPT_CHUNK_CHARS])
            continue

        candidate = f"{current}\n{paragraph}".strip()
        if current and len(candidate) > TRANSCRIPT_CHUNK_CHARS:
            chunks.append(current)
            current = paragraph
        else:
            current = candidate

    if current:
        chunks.append(current)

    return chunks[:MAX_TRANSCRIPT_CHUNKS]


def merge_extracted_chunks(parts: List[Dict[str, Any]]) -> Dict[str, Any]:
    merged: Dict[str, Any] = {
        field: "" for field in EXTRACTION_TEXT_FIELDS
    }
    for field in EXTRACTION_LIST_FIELDS:
        merged[field] = []

    for part in parts:
        if not isinstance(part, dict):
            continue

        for field in EXTRACTION_TEXT_FIELDS:
            value = str(part.get(field) or "").strip()
            if not value:
                continue
            existing = [
                item.strip()
                for item in str(merged[field]).split("\n")
                if item.strip()
            ]
            if value not in existing:
                existing.append(value)
            merged[field] = "\n".join(existing)

        for field in EXTRACTION_LIST_FIELDS:
            value = part.get(field, [])
            if isinstance(value, str):
                values = [
                    item.strip()
                    for item in re.split(r"[,，;；\n]+", value)
                    if item.strip()
                ]
            elif isinstance(value, list):
                values = [str(item).strip() for item in value if str(item).strip()]
            else:
                values = []

            for item in values:
                if item not in merged[field]:
                    merged[field].append(item)

    return merged


async def extract_conversation_data(conv_text: str) -> tuple[Dict[str, Any], int]:
    chunks = split_transcript_text(conv_text)
    if not chunks:
        return {
            field: [] if field in EXTRACTION_LIST_FIELDS else ""
            for field in EXTRACTION_TEXT_FIELDS + EXTRACTION_LIST_FIELDS
        }, 0

    extracted_parts = []
    total = len(chunks)

    for index, chunk in enumerate(chunks, start=1):
        if total > 1:
            segment = (
                f"以下是完整录音文字的第 {index}/{total} 段。"
                "只提取本段明确出现的事实，不要推测其他段内容。\n\n"
                + chunk
            )
        else:
            segment = chunk

        extraction_msg = EXTRACTION_PROMPT.format(conversation=segment)
        extraction_raw = await call_llm(
            [{"role": "user", "content": extraction_msg}],
            temperature=0.1,
            max_tokens=LLM_MAX_TOKENS_EXTRACTION,
            require_json=True
        )
        extracted = extract_json_from_text(extraction_raw)
        if extracted:
            extracted_parts.append(extracted)
        else:
            extracted_parts.append({
                "需确认事项": [f"第 {index} 段结构化信息解析失败，需人工核对原文"]
            })

    return merge_extracted_chunks(extracted_parts), total


# ==================== 病历生成核心 ====================
@app.post("/api/generate")
async def generate_record(req: RecordGenerateRequest):
    """
    生成病历主流程：
    1. 信息抽取（轻量级，低temperature确保准确）
    2. 知识库检索
    3. 病历生成（结合知识库，生成标准格式）
    """

    # 1. 获取患者和就诊信息
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        SELECT p.name, p.gender, p.age, p.phone, p.allergy,
               p.extra_fields_json, v.visit_date, v.visit_type
        FROM visits v JOIN patients p ON v.patient_id = p.id WHERE v.id = ?
    """, (req.visit_id,))
    row = c.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="就诊记录不存在，请重新选择患者。")

    patient_info = (
        f"姓名：{row[0]}，性别：{row[1] or '未知'}，"
        f"年龄：{row[2] if row[2] is not None else '未知'}，"
        f"过敏史：{row[4] or '否认'}，就诊类型：{row[7]}"
    )
    generation_extra_fields = parse_patient_extra_fields(row[5])
    if generation_extra_fields:
        patient_info += "，" + "，".join(
            f"{item['label']}：{item['value'] or '未填写'}"
            for item in generation_extra_fields
        )

    # 2. 格式化对话
    speaker_names = {
        "doctor": "医生",
        "patient": "患者",
        "mixed": "上传录音（说话人未区分）"
    }
    conv_text = "\n".join([
        f"{speaker_names.get(c.get('speaker'), '说话人未标注')}：{c.get('text', '')}"
        for c in req.conversation
        if c.get("text")
    ])

    # 3. 信息抽取。长录音文字会自动分段，避免本地模型上下文溢出。
    print(f"[*] Step 1: 信息抽取中...")
    extracted, extraction_chunks = await extract_conversation_data(conv_text)
    print(
        f"[*] 信息抽取完成（{extraction_chunks}段）: "
        f"{json.dumps(extracted, ensure_ascii=False)[:200]}..."
    )

    # 4. 知识库检索
    kb_query = f"{extracted.get('主诉','')} {extracted.get('诊断线索','')} {extracted.get('检查所见','')}"
    kb_context = search_kb(kb_query, top_k=3)
    print(f"[*] 知识库检索: {kb_context[:100] if kb_context else '无匹配'}...")

    # 5. 生成病历（Step 2: 主要任务）
    print(f"[*] Step 2: 病历生成中（约需15-30秒）...")
    record_msg = RECORD_PROMPT.format(
        patient_info=patient_info,
        extracted=json.dumps(extracted, ensure_ascii=False, indent=2),
        kb_context=kb_context or "无相关医学知识库匹配"
    )
    record_raw = await call_llm([{"role": "user", "content": record_msg}], temperature=0.3, max_tokens=LLM_MAX_TOKENS_RECORD, require_json=True)
    record = extract_json_from_text(record_raw)

    if not record:
        print(f"[!] 病历JSON解析失败，返回原始文本")
        record = {
            "parse_error": True,
            "raw": record_raw,
            "主诉": {"content": "【AI生成】解析失败，请查看原始输出\n\n" + record_raw[:500], "source": "ai", "needs_confirm": True}
        }

    # 6. 保存到数据库。自动回填会刷新同一次就诊，先清理上一版AI草稿。
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    now = datetime.now().isoformat()
    c.execute("DELETE FROM records WHERE visit_id = ?", (req.visit_id,))
    for section, data in record.items():
        if isinstance(data, dict) and "content" in data:
            c.execute("""
                INSERT INTO records (visit_id, section, content, source, is_ai_suggestion, needs_confirm, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                req.visit_id,
                section,
                data["content"],
                data.get("source", "ai"),
                1 if data.get("source") == "ai_suggestion" else 0,
                1 if data.get("needs_confirm") else 0,
                now
            ))
    conn.commit()
    conn.close()
    print(f"[*] 病历已保存到数据库")

    return {
        "record": record,
        "extracted": extracted,
        "kb_used": kb_context,
        "visit_id": req.visit_id,
        "auto_fill": True,
        "extraction_chunks": extraction_chunks,
        "generated_at": datetime.now().isoformat()
    }

# ==================== 本地病例问答 ====================
def limit_text(value: Any, max_chars: int, keep_tail: bool = False) -> str:
    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    if keep_tail:
        return "…（前文已省略）\n" + text[-max_chars:]
    return text[:max_chars] + "\n…（后文已省略）"


def format_chat_conversation(items: List[Dict[str, Any]]) -> str:
    speaker_names = {
        "doctor": "医生",
        "doctor_description": "医生描述",
        "patient": "患者",
        "mixed": "医患混合录音"
    }
    lines = []
    for item in items:
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        speaker = speaker_names.get(item.get("speaker"), "说话人未标注")
        lines.append(f"{speaker}：{text}")
    # 问答优先使用最近的对话，避免超过本地模型上下文。
    return limit_text("\n".join(lines), 2600, keep_tail=True)


def format_chat_record(record: Dict[str, Any]) -> str:
    lines = []
    for section in [
        "主诉", "现病史", "既往史", "口腔专科检查",
        "辅助检查", "诊断", "治疗计划", "处置", "医嘱"
    ]:
        value = record.get(section, "")
        if isinstance(value, dict):
            content = str(value.get("content") or "").strip()
        else:
            content = str(value or "").strip()
        if content:
            lines.append(f"【{section}】\n{content}")
    return limit_text("\n\n".join(lines), 3400)


def load_saved_record_for_chat(visit_id: Optional[int]) -> Dict[str, Any]:
    if not visit_id:
        return {}

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        SELECT section, content, source, needs_confirm
        FROM records WHERE visit_id = ? ORDER BY id
    """, (visit_id,))
    rows = c.fetchall()
    conn.close()

    return {
        row[0]: {
            "content": row[1] or "",
            "source": row[2] or "manual",
            "needs_confirm": bool(row[3])
        }
        for row in rows
    }


CASE_CHAT_SYSTEM_PROMPT = """你是本地部署的口腔门诊病例问答助手，只能依据本次请求提供的患者资料、录音对话、病历草稿、本次明确选择的病例图片和本地知识库回答。

证据与安全规则：
1. 不得虚构病史、检查结果、影像结果、诊断或已经实施的治疗。
2. 清楚区分“已有事实”“辅助判断”“仍需确认的信息”和“建议下一步”。
3. 资料不足时直接说明资料不足，并指出需要补充的问诊、临床检查或影像。
4. 诊断、治疗计划和用药建议仅供医生审核，不替代临床判断。
5. 不要声称看到了未提供或未选中的图片、影像和检查。
6. 附带图片时，只描述图片中可见表现和图像局限性；不得仅凭图片作最终确诊。
7. 图像相关结论只能写为“辅助判断”或“鉴别考虑”，并说明仍需哪些临床证据确认。
8. 多张图片必须按“图片1、图片2……”分别对应，不得把不同图片内容混为同一事实。
9. 用户询问患者之外的一般问题时，可以结合本地知识库回答，但必须说明并非该患者已证实情况。

输出与排版规则：
1. 只输出纯中文文本，不使用 Markdown。
2. 禁止输出任何星号字符，包括单星号和双星号。
3. 禁止使用井号标题、反引号代码块和 Markdown 横线。
4. 不使用星号或短横线作为项目符号，条目统一使用“1. 2. 3.”。
5. 标题直接写成“图像可见表现：”“辅助判断：”“仍需确认：”“建议下一步：”。
6. 每一条只写一个要点，段落之间保留一个空行，避免大段堆叠。
7. 附带图片时优先按以下顺序回答：
   结论概要：
   图像可见表现：
   辅助判断：
   仍需确认：
   建议下一步：
8. 没有证据支持的版块可以省略，不要为了凑格式重复内容。
"""


def normalize_case_chat_answer(text: Any) -> str:
    """Return clean clinical plain text even if the model emits Markdown."""
    value = str(text or "")
    value = value.replace("\r\n", "\n").replace("\r", "\n")

    # Remove fenced-code markers and all asterisks. The product UI must never
    # display raw Markdown emphasis symbols in clinical answers.
    value = re.sub(r"```[^\n]*", "", value)
    value = value.replace("```", "")
    value = value.replace("*", "")

    cleaned_lines: List[str] = []
    for raw_line in value.splitlines():
        line = raw_line.strip()
        if not line:
            if cleaned_lines and cleaned_lines[-1] != "":
                cleaned_lines.append("")
            continue

        line = re.sub(r"^#{1,6}\s*", "", line)
        line = re.sub(r"^>\s*", "", line)
        line = re.sub(r"^[-+•]\s+", "", line)

        # Convert common Markdown-style bullets into numbered clinical items.
        bullet_match = re.match(r"^[（(]?([一二三四五六七八九十]+)[）)]\s*", line)
        if bullet_match:
            line = line[bullet_match.end():].strip()

        line = re.sub(r"\s{2,}", " ", line).strip()
        if line:
            cleaned_lines.append(line)

    # Collapse excessive empty lines while keeping readable section spacing.
    normalized: List[str] = []
    previous_blank = False
    for line in cleaned_lines:
        is_blank = line == ""
        if is_blank and previous_blank:
            continue
        normalized.append(line)
        previous_blank = is_blank

    result = "\n".join(normalized).strip()
    return result or "当前资料不足，暂时无法形成可靠回答。"


@app.post("/api/chat")
async def case_chat(req: CaseChatRequest):
    question = (req.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="请输入要询问的问题。")
    if len(question) > 2000:
        raise HTTPException(status_code=400, detail="单次问题不能超过 2000 字。")

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        SELECT id, name, gender, age, phone, allergy, extra_fields_json
        FROM patients WHERE id = ?
    """, (req.patient_id,))
    patient = c.fetchone()

    if not patient:
        conn.close()
        raise HTTPException(status_code=404, detail="患者不存在，请重新选择患者。")

    visit_info = None
    if req.visit_id:
        c.execute("""
            SELECT id, patient_id, visit_date, visit_type, status
            FROM visits WHERE id = ?
        """, (req.visit_id,))
        visit_info = c.fetchone()
        if not visit_info or visit_info[1] != req.patient_id:
            conn.close()
            raise HTTPException(status_code=400, detail="当前就诊记录与患者不匹配。")
    conn.close()

    patient_context = (
        f"姓名：{patient[1]}；性别：{patient[2] or '未知'}；"
        f"年龄：{patient[3] if patient[3] is not None else '未知'}；"
        f"过敏史：{patient[5] or '否认'}"
    )
    extra_patient_fields = parse_patient_extra_fields(patient[6])
    if extra_patient_fields:
        patient_context += "；" + "；".join(
            f"{item['label']}：{item['value'] or '未填写'}"
            for item in extra_patient_fields
        )
    if visit_info:
        patient_context += (
            f"；就诊日期：{visit_info[2] or '未知'}；"
            f"就诊类型：{visit_info[3] or '未知'}"
        )

    record_data = req.record or load_saved_record_for_chat(req.visit_id)
    record_context = format_chat_record(record_data) or "当前尚无已填写病历内容。"
    conversation_context = format_chat_conversation(req.conversation) or "当前尚无录音转写内容。"

    kb_query = " ".join([
        question,
        record_context[:1200],
        conversation_context[-1000:]
    ])
    kb_context = search_kb(kb_query, top_k=3) or "本地知识库无直接匹配条目。"

    context_message = f"""【患者资料】
{patient_context}

【当前病历草稿】
{record_context}

【录音与医患对话】
{conversation_context}

【本地口腔知识库】
{limit_text(kb_context, 1400)}

【医生当前问题】
{question}
"""

    messages: List[Dict[str, str]] = [
        {"role": "system", "content": CASE_CHAT_SYSTEM_PROMPT}
    ]

    # 仅携带最近对话，避免本地模型上下文溢出。
    for item in req.history[-8:]:
        role = item.get("role")
        content = limit_text(item.get("content", ""), 700)
        if role in {"user", "assistant"} and content:
            messages.append({"role": role, "content": content})

    selected_image_ids = list(dict.fromkeys(req.image_ids))[:MAX_IMAGES_PER_ANALYSIS]
    selected_rows: List[tuple] = []

    if selected_image_ids:
        if not VISION_ENABLED:
            raise HTTPException(
                status_code=503,
                detail="本地视觉能力未启用，请使用 v2.1 启动器加载 mmproj。"
            )
        selected_rows = fetch_image_rows(image_ids=selected_image_ids)
        if len(selected_rows) != len(selected_image_ids):
            raise HTTPException(status_code=404, detail="部分所选图片不存在。")
        assert_image_access(selected_rows, req.patient_id, req.visit_id)

        user_content: List[Dict[str, Any]] = [
            {"type": "text", "text": context_message}
        ]
        for index, row in enumerate(selected_rows, start=1):
            user_content.append({
                "type": "text",
                "text": (
                    f"所选图片{index}：image_id={row[0]}，"
                    f"文件名={row[3]}，当前图注={row[9] or '无'}。"
                )
            })
            user_content.append({
                "type": "image_url",
                "image_url": {
                    "url": image_to_data_url(row[5], row[7] or "image/jpeg")
                }
            })
        messages.append({"role": "user", "content": user_content})
    else:
        messages.append({"role": "user", "content": context_message})

    try:
        answer = await call_llm(
            messages,
            temperature=0.2,
            max_tokens=LLM_MAX_TOKENS_CHAT,
            require_json=False,
            extra_payload={"cache_prompt": False} if selected_rows else None
        )
    except HTTPException as exc:
        detail = str(exc.detail)
        if selected_rows and (
            "image input is not supported" in detail.lower()
            or "mmproj" in detail.lower()
        ):
            raise HTTPException(
                status_code=503,
                detail="本地模型尚未加载 mmproj，无法分析所选图片。"
            ) from exc
        raise

    clean_answer = normalize_case_chat_answer(answer)

    return {
        "answer": clean_answer,
        "patient_id": req.patient_id,
        "visit_id": req.visit_id,
        "kb_used": kb_context,
        "local_model": MODEL_NAME,
        "selected_image_ids": [row[0] for row in selected_rows]
    }


# ==================== 病历查询与更新 ====================
@app.get("/api/records/{visit_id}")
async def get_record(visit_id: int):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT section, content, source, is_ai_suggestion, needs_confirm FROM records WHERE visit_id = ?", (visit_id,))
    rows = c.fetchall()
    c.execute("""
        SELECT section, stored_path, caption, tooth_position, image_type, needs_confirm
        FROM case_images WHERE visit_id = ? ORDER BY sort_order, id
    """, (visit_id,))
    image_rows_for_export = c.fetchall()
    conn.close()

    record = {}
    for row in rows:
        record[row[0]] = {
            "content": row[1],
            "source": row[2],
            "is_ai_suggestion": bool(row[3]),
            "needs_confirm": bool(row[4])
        }
    return {"record": record, "visit_id": visit_id}

@app.post("/api/records/{visit_id}/update")
async def update_record(visit_id: int, req: RecordUpdateRequest):
    """医生审核后保存最终病历"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    now = datetime.now().isoformat()

    c.execute("DELETE FROM records WHERE visit_id = ?", (visit_id,))

    for section, data in req.sections.items():
        if isinstance(data, dict):
            content = data.get("content", "")
            source = data.get("source", "manual")
            is_ai = 1 if source in ("ai", "ai_suggestion") else 0
            needs_confirm = 1 if data.get("needs_confirm") else 0
        else:
            content = str(data)
            source = "manual"
            is_ai = 0
            needs_confirm = 0

        c.execute("""
            INSERT INTO records (visit_id, section, content, source, is_ai_suggestion, needs_confirm, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (visit_id, section, content, source, is_ai, needs_confirm, now))

    c.execute("UPDATE visits SET status = ? WHERE id = ?", ("completed", visit_id))
    conn.commit()
    conn.close()
    return {"status": "saved"}

# ==================== Word导出 ====================
@app.get("/api/export/word/{visit_id}")
async def export_word(visit_id: int):
    """导出Word病历，AI内容带颜色标注，含电子签名区"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute("""
        SELECT p.name, p.gender, p.age, p.phone, p.allergy,
               p.extra_fields_json, v.visit_date, v.visit_type
        FROM visits v JOIN patients p ON v.patient_id = p.id WHERE v.id = ?
    """, (visit_id,))
    patient = c.fetchone()

    c.execute("SELECT section, content, source, is_ai_suggestion, needs_confirm FROM records WHERE visit_id = ?", (visit_id,))
    rows = c.fetchall()
    c.execute("""
        SELECT section, stored_path, caption, tooth_position, image_type, needs_confirm
        FROM case_images WHERE visit_id = ? ORDER BY sort_order, id
    """, (visit_id,))
    image_rows_for_export = c.fetchall()
    conn.close()

    if not patient:
        return {"error": "记录不存在"}

    doc = Document()

    # 标题
    title = doc.add_heading('口腔门诊病历', level=0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER

    # AI标识
    ai_note = doc.add_paragraph()
    ai_note.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = ai_note.add_run('【AI辅助生成，请医生审核确认】')
    run.bold = True
    run.font.color.rgb = RGBColor(255, 0, 0)
    run.font.size = Pt(12)

    doc.add_paragraph()

    # 基本信息表格
    info_table = doc.add_table(rows=2, cols=4)
    info_table.style = 'Table Grid'
    headers = ["姓名", "性别", "年龄", "电话"]
    values = [patient[0], patient[1] or "", str(patient[2]) if patient[2] else "", patient[3] or ""]
    for i, (h, v) in enumerate(zip(headers, values)):
        info_table.rows[0].cells[i].text = h
        info_table.rows[1].cells[i].text = v
        info_table.rows[0].cells[i].paragraphs[0].runs[0].font.bold = True

    doc.add_paragraph()

    # 过敏史
    p = doc.add_paragraph()
    p.add_run("药物过敏史：").bold = True
    p.add_run(patient[4] or "否认")

    # 患者补充信息
    export_extra_fields = parse_patient_extra_fields(patient[5])
    for item in export_extra_fields:
        p = doc.add_paragraph()
        p.add_run(f"{item['label']}：").bold = True
        p.add_run(item["value"] or "未填写")

    # 就诊信息
    p = doc.add_paragraph()
    p.add_run(
        f"就诊日期：{patient[6]}    就诊类型：{patient[7]}"
    ).bold = True

    doc.add_paragraph()

    # 病历内容
    section_order = ["主诉", "现病史", "既往史", "口腔专科检查", "辅助检查", "诊断", "治疗计划", "处置", "医嘱"]
    record_dict = {row[0]: row for row in rows}

    for section in section_order:
        if section not in record_dict:
            continue

        _, content, source, is_ai, needs_confirm = record_dict[section]

        p = doc.add_paragraph()
        p.add_run(f"{section}：").bold = True

        run = p.add_run(content)
        if needs_confirm:
            run.font.color.rgb = RGBColor(255, 0, 0)
            run.bold = True
            run.font.size = Pt(11)
        elif is_ai or source == "ai_suggestion":
            run.font.color.rgb = RGBColor(0, 102, 204)
            run.font.size = Pt(11)
        elif source == "manual":
            run.font.color.rgb = RGBColor(0, 128, 0)
            run.font.size = Pt(11)

        # 添加来源标注
        if source == "ai_suggestion":
            tag = p.add_run(" 【AI建议】")
            tag.font.color.rgb = RGBColor(255, 128, 0)
            tag.font.size = Pt(9)
        elif needs_confirm:
            tag = p.add_run(" 【需确认】")
            tag.font.color.rgb = RGBColor(255, 0, 0)
            tag.font.size = Pt(9)

        related_images = [
            image_row for image_row in image_rows_for_export
            if (image_row[0] or "待归类") == section
        ]
        for _, image_path, caption, tooth_position, image_type, image_confirm in related_images:
            path = Path(image_path)
            if not path.exists():
                continue
            try:
                doc.add_picture(str(path), width=Pt(220))
                image_paragraph = doc.paragraphs[-1]
                image_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
                caption_text = caption or image_type or "病例图片"
                if tooth_position:
                    caption_text += f"（牙位：{tooth_position}）"
                if image_confirm:
                    caption_text += "【图像观察需医生确认】"
                caption_paragraph = doc.add_paragraph(caption_text)
                caption_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
                caption_paragraph.runs[0].font.size = Pt(9)
                caption_paragraph.runs[0].font.color.rgb = RGBColor(96, 96, 96)
            except Exception:
                pass

    unassigned_images = [
        image_row for image_row in image_rows_for_export
        if (image_row[0] or "待归类") == "待归类"
    ]
    if unassigned_images:
        doc.add_heading("待归类病例图片", level=2)
        for _, image_path, caption, tooth_position, image_type, image_confirm in unassigned_images:
            path = Path(image_path)
            if not path.exists():
                continue
            try:
                doc.add_picture(str(path), width=Pt(220))
                text = caption or image_type or "病例图片"
                if tooth_position:
                    text += f"（牙位：{tooth_position}）"
                paragraph = doc.add_paragraph(text + "【需医生归类】")
                paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            except Exception:
                pass

    # 签名区
    doc.add_paragraph()
    sig_p = doc.add_paragraph()
    sig_p.add_run("医师签名：________________    日期：________________")
    sig_p.alignment = WD_ALIGN_PARAGRAPH.RIGHT

    # 页脚免责声明
    doc.add_paragraph()
    footer = doc.add_paragraph()
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    f_run = footer.add_run("本病历由AI辅助生成，内容经医生审核确认后具有法律效力。未经审核的AI建议仅供参考。")
    f_run.font.size = Pt(8)
    f_run.font.color.rgb = RGBColor(128, 128, 128)

    filename = EXPORT_DIR / f"病历_{patient[0]}_{patient[5]}_{visit_id}.docx"
    doc.save(filename)

    return FileResponse(
        path=filename,
        filename=filename.name,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )

# ==================== 启动 ====================
if __name__ == "__main__":
    print("=" * 60)
    print("  Dental AI Scribe - 口腔AI病历助手（多模态病例版 v2.1）")
    print("=" * 60)
    print(f"[*] LLM后端: {LLAMA_CPP_URL}")
    print(f"[*] 模型名称: {MODEL_NAME}")
    print(f"[*] Whisper: {WHISPER_MODEL} ({WHISPER_DEVICE}, {WHISPER_COMPUTE_TYPE})")
    print(f"[*] 数据库: {DB_PATH}")
    print("=" * 60)
    print("[*] 启动前请确保 llama.cpp server 已运行：")
    print(f"    ./server -m your-model.gguf -c 8192 --port 8080")
    print(f"[*] 浏览器访问: http://127.0.0.1:{APP_PORT}")
    print("=" * 60)
    for warning in CONFIG_WARNINGS:
        print(f"[!] 配置提醒: {warning}")
    uvicorn.run(app, host=APP_HOST, port=APP_PORT)
