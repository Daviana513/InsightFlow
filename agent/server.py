#!/usr/bin/env python3
"""InsightFlow Local Agent: a dependency-free local project and run service."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import mimetypes
import sqlite3
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


HOST = "127.0.0.1"
PORT = 8765
PUBLIC_SITE_ORIGIN = "https://insightflow-research.wuyixuan003.chatgpt.site"
ROOT = Path(__file__).resolve().parents[1]
OPENCLIP_PYTHON = ROOT / ".venv" / "bin" / "python"
MODELS_DIR = ROOT / ".models"
DEFAULT_MODEL_VERSION = "en_infographic_v3_balanced"
ACTIVE_MODEL_FILE = MODELS_DIR / "active.json"
MIN_TRAINING_PER_CLASS = 20
MIN_TRAINING_POSTS_PER_CLASS = 5
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff", ".bmp"}
FIELD_ALIASES = {
    "record_id": ("record_id", "id", "post_id", "shortcode"),
    "image_path": ("image_path", "file_path", "filename", "image", "media_path"),
    "caption": ("caption", "text", "post_text", "description"),
    "language": ("language", "lang"),
    "account": ("account_name", "account", "username", "author"),
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_bytes(payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def trusted_origin(origin: str | None) -> str | None:
    if not origin:
        return None
    host = urlparse(origin).hostname
    return origin if origin == PUBLIC_SITE_ORIGIN or host in {"localhost", "127.0.0.1", "::1"} else None


def active_model() -> tuple[str, Path, Path]:
    version = DEFAULT_MODEL_VERSION
    if ACTIVE_MODEL_FILE.is_file():
        try:
            version = json.loads(ACTIVE_MODEL_FILE.read_text(encoding="utf-8")).get("model_version", version)
        except (OSError, json.JSONDecodeError):
            pass
    if not isinstance(version, str) or not version.replace("_", "").replace("-", "").isalnum():
        version = DEFAULT_MODEL_VERSION
    model = MODELS_DIR / version / "infographic_classifier.pkl"
    if not model.is_file():
        version = DEFAULT_MODEL_VERSION
        model = MODELS_DIR / version / "infographic_classifier.pkl"
    return version, model, model.with_name("metrics.json")


def training_readiness(counts: dict[str, int], posts: dict[str, int]) -> dict:
    missing_images = {label: max(0, MIN_TRAINING_PER_CLASS - counts.get(label, 0)) for label in ("infographic", "not_infographic")}
    missing_posts = {label: max(0, MIN_TRAINING_POSTS_PER_CLASS - posts.get(label, 0)) for label in ("infographic", "not_infographic")}
    return {
        "ready": not any(missing_images.values()) and not any(missing_posts.values()),
        "minimum_per_class": MIN_TRAINING_PER_CLASS,
        "recommended_per_class": 100,
        "minimum_posts_per_class": MIN_TRAINING_POSTS_PER_CLASS,
        "missing_images": missing_images,
        "missing_posts": missing_posts,
    }


def resolve_file(images_dir: Path, value: str) -> Path:
    candidate = Path(value).expanduser()
    return candidate.resolve() if candidate.is_absolute() else (images_dir / candidate).resolve()


def inspect_project(images_value: str, metadata_value: str) -> dict:
    images_dir = Path(images_value).expanduser().resolve()
    metadata_csv = Path(metadata_value).expanduser().resolve()
    if not images_dir.is_dir():
        raise ValueError("图片目录不存在或无法读取")
    if not metadata_csv.is_file() or metadata_csv.suffix.lower() != ".csv":
        raise ValueError("帖文主表必须是可读取的 CSV 文件")

    image_count = sum(1 for path in images_dir.rglob("*") if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS)
    with metadata_csv.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = reader.fieldnames or []
        lowered = {header.strip().lower(): header for header in headers}
        mapping = {
            key: next((lowered[alias] for alias in aliases if alias in lowered), None)
            for key, aliases in FIELD_ALIASES.items()
        }
        if not mapping["record_id"] and "post_shortcode" in lowered and "image_index" in lowered:
            mapping["record_id"] = f"{lowered['post_shortcode']} + {lowered['image_index']}"
        record_count = 0
        missing_images = 0
        image_field = mapping["image_path"]
        for row in reader:
            record_count += 1
            if image_field and row.get(image_field):
                value = row[image_field].strip()
                path = resolve_file(images_dir, value)
                alternate = resolve_file(metadata_csv.parent, value)
                if not path.is_file() and not alternate.is_file():
                    missing_images += 1

    return {
        "name": metadata_csv.stem,
        "images_dir": str(images_dir),
        "metadata_csv": str(metadata_csv),
        "image_count": image_count,
        "record_count": record_count,
        "missing_images": missing_images,
        "headers": headers,
        "mapping": mapping,
        "ready": bool(mapping["record_id"] and mapping["image_path"]),
        "warnings": [
            message
            for condition, message in (
                (not mapping["record_id"], "未找到稳定记录 ID 字段"),
                (not mapping["image_path"], "未找到图片路径字段"),
                (missing_images > 0, f"有 {missing_images} 条记录找不到对应图片"),
            )
            if condition
        ],
    }


SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  images_dir TEXT NOT NULL,
  metadata_csv TEXT NOT NULL,
  image_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  missing_images INTEGER NOT NULL,
  mapping_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready', 'running', 'paused', 'complete')),
  stage TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  threshold REAL NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS reviews (
  run_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('keep', 'remove', 'uncertain')),
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, record_id, stage),
  FOREIGN KEY(run_id) REFERENCES runs(id)
);
CREATE TABLE IF NOT EXISTS records (
  run_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  image_path TEXT NOT NULL,
  post_shortcode TEXT NOT NULL DEFAULT '',
  image_index TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  preprocess_status TEXT NOT NULL CHECK(preprocess_status IN ('passed', 'image_missing')),
  preprocess_reason TEXT NOT NULL DEFAULT '',
  clip_probability REAL,
  clip_status TEXT NOT NULL DEFAULT 'pending',
  clip_error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(run_id, record_id),
  FOREIGN KEY(run_id) REFERENCES runs(id)
);
CREATE TABLE IF NOT EXISTS training_labels (
  project_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK(label IN ('infographic', 'not_infographic', 'uncertain')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, record_id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS training_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'complete', 'failed')),
  processed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  model_version TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
"""


def migrate(db: sqlite3.Connection) -> None:
    additions = {
        "runs": (("candidate_count", "INTEGER NOT NULL DEFAULT 0"), ("message", "TEXT NOT NULL DEFAULT ''")),
        "records": (
            ("clip_probability", "REAL"),
            ("clip_status", "TEXT NOT NULL DEFAULT 'pending'"),
            ("clip_error", "TEXT NOT NULL DEFAULT ''"),
        ),
    }
    for table, columns in additions.items():
        existing = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
        for name, declaration in columns:
            if name not in existing:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
    db.execute("PRAGMA optimize")


class State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.project: dict | None = None
        self.db_path: Path | None = None
        self.active_runs: set[str] = set()
        self.active_training_jobs: set[str] = set()

    def open_project(self, images_dir: str, metadata_csv: str) -> dict:
        project = inspect_project(images_dir, metadata_csv)
        project_id = hashlib.sha256(f"{project['images_dir']}\0{project['metadata_csv']}".encode()).hexdigest()[:16]
        project["id"] = project_id
        db_dir = Path(project["metadata_csv"]).parent / ".insightflow"
        db_dir.mkdir(exist_ok=True)
        db_path = db_dir / "insightflow.db"
        with self.lock, sqlite3.connect(db_path) as db:
            db.executescript(SCHEMA)
            migrate(db)
            db.execute(
                """INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET image_count=excluded.image_count,
                record_count=excluded.record_count, missing_images=excluded.missing_images,
                mapping_json=excluded.mapping_json, updated_at=excluded.updated_at""",
                (
                    project_id, project["name"], project["images_dir"], project["metadata_csv"],
                    project["image_count"], project["record_count"], project["missing_images"],
                    json.dumps(project["mapping"], ensure_ascii=False), now(),
                ),
            )
        self.project, self.db_path = project, db_path
        return project

    def connect(self) -> sqlite3.Connection:
        if not self.db_path:
            raise ValueError("请先打开一个本地项目")
        db = sqlite3.connect(self.db_path)
        db.row_factory = sqlite3.Row
        return db

    def create_run(self, threshold: float) -> dict:
        if not self.project or not self.project["ready"]:
            raise ValueError("项目字段未通过校验，暂时不能创建任务")
        run_id = f"run_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:4]}"
        timestamp = now()
        config = {"workflow_version": "local-first-v0.4", "openclip_threshold": threshold}
        with self.lock, self.connect() as db:
            db.execute(
                """INSERT INTO runs
                (id, project_id, status, stage, processed, total, threshold, candidate_count, message,
                 config_json, created_at, updated_at)
                VALUES (?, ?, 'ready', 'preprocess', 0, ?, ?, 0, '', ?, ?, ?)""",
                (run_id, self.project["id"], self.project["record_count"], threshold,
                 json.dumps(config), timestamp, timestamp),
            )
        return self.get_run(run_id)

    def get_run(self, run_id: str | None = None) -> dict | None:
        with self.lock, self.connect() as db:
            if run_id:
                row = db.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            else:
                row = db.execute("SELECT * FROM runs ORDER BY created_at DESC LIMIT 1").fetchone()
        return dict(row) if row else None

    def update_run(self, run_id: str, status: str) -> dict:
        if status not in {"ready", "running", "paused", "complete"}:
            raise ValueError("不支持的任务状态")
        with self.lock, self.connect() as db:
            changed = db.execute(
                "UPDATE runs SET status = ?, updated_at = ? WHERE id = ?", (status, now(), run_id)
            ).rowcount
        if not changed:
            raise ValueError("找不到该任务")
        return self.get_run(run_id)

    def preprocess_run(self, run_id: str) -> dict:
        if not self.project:
            raise ValueError("请先打开一个本地项目")
        run = self.get_run(run_id)
        if not run:
            raise ValueError("找不到该任务")
        if run["stage"] != "preprocess":
            return {"run": run, "summary": {"already_complete": True}}

        metadata_csv = Path(self.project["metadata_csv"])
        images_dir = Path(self.project["images_dir"])
        mapping = self.project["mapping"]
        records = []
        seen = set()
        with metadata_csv.open("r", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                id_mapping = mapping["record_id"]
                if " + " in id_mapping:
                    fields = id_mapping.split(" + ")
                    record_id = "#".join((row.get(field) or "").strip() for field in fields)
                else:
                    record_id = (row.get(id_mapping) or "").strip()
                if not record_id or record_id in seen:
                    raise ValueError("稳定记录 ID 为空或重复，请检查 post_shortcode 与 image_index")
                seen.add(record_id)

                image_value = (row.get(mapping["image_path"]) or "").strip()
                image_path = resolve_file(images_dir, image_value)
                if not image_path.is_file():
                    image_path = resolve_file(metadata_csv.parent, image_value)
                readable = image_path.is_file()
                records.append((
                    run_id, record_id, str(image_path), (row.get("post_shortcode") or "").strip(),
                    (row.get("image_index") or "").strip(),
                    (row.get(mapping.get("caption") or "") or "").strip(),
                    (row.get(mapping.get("account") or "") or "").strip(),
                    (row.get(mapping.get("language") or "") or "").strip(),
                    "passed" if readable else "image_missing",
                    "基础字段与图片已验证" if readable else "找不到对应图片",
                ))

        passed = sum(record[8] == "passed" for record in records)
        timestamp = now()
        with self.lock, self.connect() as db:
            db.execute("DELETE FROM records WHERE run_id = ?", (run_id,))
            db.executemany(
                """INSERT INTO records
                (run_id, record_id, image_path, post_shortcode, image_index, caption, account_name,
                 language, preprocess_status, preprocess_reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", records
            )
            db.execute(
                """UPDATE runs SET status = 'paused', stage = 'openclip', processed = ?, total = ?,
                message = '预处理完成，可以运行 OpenCLIP', updated_at = ? WHERE id = ?""",
                (len(records), len(records), timestamp, run_id),
            )
        return {
            "run": self.get_run(run_id),
            "summary": {"total": len(records), "passed": passed, "image_missing": len(records) - passed},
        }

    def openclip_runtime(self) -> dict:
        version, model_path, metrics_path = active_model()
        metrics = {}
        if metrics_path.is_file():
            try:
                metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                pass
        return {
            "ready": OPENCLIP_PYTHON.is_file() and model_path.is_file(),
            "python_ready": OPENCLIP_PYTHON.is_file(),
            "model_ready": model_path.is_file(),
            "model_version": version,
            "model_path": str(model_path),
            "metrics": metrics,
        }

    def openclip_summary(self, run_id: str) -> dict:
        run = self.get_run(run_id)
        if not run:
            raise ValueError("找不到该任务")
        with self.lock, self.connect() as db:
            row = db.execute(
                """SELECT SUM(CASE WHEN clip_status = 'scored' THEN 1 ELSE 0 END) AS scored,
                SUM(CASE WHEN clip_probability >= ? THEN 1 ELSE 0 END) AS candidates,
                SUM(CASE WHEN clip_probability < ? THEN 1 ELSE 0 END) AS below_threshold,
                SUM(CASE WHEN clip_status = 'error' THEN 1 ELSE 0 END) AS errors
                FROM records WHERE run_id = ?""",
                (run["threshold"], run["threshold"], run_id),
            ).fetchone()
        return {"run": run, "summary": {key: int(row[key] or 0) for key in row.keys()}}

    def start_openclip(self, run_id: str) -> dict:
        run = self.get_run(run_id)
        if not run:
            raise ValueError("找不到该任务")
        if run["stage"] != "openclip":
            return self.openclip_summary(run_id)
        runtime = self.openclip_runtime()
        if not runtime["ready"]:
            raise ValueError("OpenCLIP 独立环境或分类器尚未准备好")
        with self.lock:
            already_running = run_id in self.active_runs
            if not already_running:
                self.active_runs.add(run_id)
        if already_running:
            return self.openclip_summary(run_id)

        run_dir = Path(self.project["metadata_csv"]).parent / ".insightflow" / "runs" / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        manifest = run_dir / "openclip_input.csv"
        with self.lock, self.connect() as db, manifest.open("w", encoding="utf-8-sig", newline="") as handle:
            rows = db.execute(
                "SELECT record_id, image_path FROM records WHERE run_id = ? AND preprocess_status = 'passed' ORDER BY record_id",
                (run_id,),
            ).fetchall()
            writer = csv.DictWriter(handle, fieldnames=("record_id", "image_path"))
            writer.writeheader()
            writer.writerows(dict(row) for row in rows)
            config = json.loads(run["config_json"])
            config["openclip_model"] = runtime["model_version"]
            db.execute(
                """UPDATE records SET clip_probability = NULL, clip_status = 'pending', clip_error = ''
                WHERE run_id = ?""", (run_id,),
            )
            db.execute(
                """UPDATE runs SET status = 'running', processed = 0, candidate_count = 0,
                message = '正在启动 OpenCLIP', config_json = ?, updated_at = ? WHERE id = ?""",
                (json.dumps(config, ensure_ascii=False), now(), run_id),
            )
        threading.Thread(
            target=self._run_openclip,
            args=(run_id, manifest, Path(runtime["model_path"])),
            daemon=True,
        ).start()
        return self.openclip_summary(run_id)

    def _run_openclip(self, run_id: str, manifest: Path, model_path: Path) -> None:
        command = [
            str(OPENCLIP_PYTHON), str(ROOT / "agent" / "openclip_runner.py"),
            "--input", str(manifest), "--classifier", str(model_path), "--device", "auto",
        ]
        try:
            process = subprocess.Popen(
                command, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            assert process.stdout
            for line in process.stdout:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "status":
                    with self.lock, self.connect() as db:
                        db.execute(
                            "UPDATE runs SET message = ?, updated_at = ? WHERE id = ?",
                            (event.get("message", "OpenCLIP 运行中"), now(), run_id),
                        )
                elif event.get("type") == "batch":
                    updates = []
                    for item in event.get("items", []):
                        error = item.get("error", "")
                        updates.append((item.get("probability"), "error" if error else "scored", error,
                                        run_id, item.get("record_id", "")))
                    with self.lock, self.connect() as db:
                        db.executemany(
                            """UPDATE records SET clip_probability = ?, clip_status = ?, clip_error = ?
                            WHERE run_id = ? AND record_id = ?""",
                            updates,
                        )
                        db.execute(
                            "UPDATE runs SET processed = ?, message = '正在计算图片概率', updated_at = ? WHERE id = ?",
                            (int(event.get("processed", 0)), now(), run_id),
                        )
            return_code = process.wait()
            if return_code:
                raise RuntimeError(f"OpenCLIP 运行失败（退出码 {return_code}）")
            run = self.get_run(run_id)
            with self.lock, self.connect() as db:
                candidates = db.execute(
                    "SELECT COUNT(*) FROM records WHERE run_id = ? AND clip_probability >= ?",
                    (run_id, run["threshold"]),
                ).fetchone()[0]
                errors = db.execute(
                    "SELECT COUNT(*) FROM records WHERE run_id = ? AND clip_status = 'error'", (run_id,)
                ).fetchone()[0]
                db.execute(
                    """UPDATE runs SET status = 'paused', stage = 'gpt', candidate_count = ?,
                    message = ?, updated_at = ? WHERE id = ?""",
                    (candidates, f"OpenCLIP 完成：{candidates} 条进入候选，{errors} 条读取失败", now(), run_id),
                )
        except Exception as error:
            with self.lock, self.connect() as db:
                db.execute(
                    "UPDATE runs SET status = 'paused', message = ?, updated_at = ? WHERE id = ?",
                    (f"OpenCLIP 失败：{error}", now(), run_id),
                )
        finally:
            with self.lock:
                self.active_runs.discard(run_id)

    def list_training_candidates(self, run_id: str, offset: int = 0, limit: int = 12) -> dict:
        if not self.project:
            raise ValueError("请先打开一个本地项目")
        limit = min(max(limit, 1), 60)
        offset = max(offset, 0)
        with self.lock, self.connect() as db:
            rows = db.execute(
                """SELECT r.record_id, r.image_path, r.caption, r.account_name, r.post_shortcode,
                r.image_index, t.label FROM records r
                LEFT JOIN training_labels t ON t.project_id = ? AND t.record_id = r.record_id
                WHERE r.run_id = ? AND r.preprocess_status = 'passed'
                ORDER BY r.record_id LIMIT ? OFFSET ?""",
                (self.project["id"], run_id, limit, offset),
            ).fetchall()
            total = db.execute(
                "SELECT COUNT(*) FROM records WHERE run_id = ? AND preprocess_status = 'passed'", (run_id,)
            ).fetchone()[0]
            counts, posts = self._training_stats(db, run_id)
        return {
            "items": [dict(row) for row in rows],
            "total": total,
            "offset": offset,
            "limit": limit,
            "counts": counts,
            "posts": posts,
            "readiness": training_readiness(counts, posts),
        }

    def _training_stats(self, db: sqlite3.Connection, run_id: str) -> tuple[dict[str, int], dict[str, int]]:
        rows = db.execute(
            """SELECT t.label, COUNT(*) AS image_count,
            COUNT(DISTINCT CASE WHEN r.post_shortcode != '' THEN r.post_shortcode ELSE r.record_id END) AS post_count
            FROM records r JOIN training_labels t
            ON t.project_id = ? AND t.record_id = r.record_id
            WHERE r.run_id = ? AND r.preprocess_status = 'passed'
            GROUP BY t.label""",
            (self.project["id"], run_id),
        ).fetchall()
        counts = {row["label"]: int(row["image_count"]) for row in rows}
        posts = {row["label"]: int(row["post_count"]) for row in rows}
        return counts, posts

    def save_training_label(self, payload: dict) -> dict:
        if not self.project:
            raise ValueError("请先打开一个本地项目")
        if payload.get("label") not in {"infographic", "not_infographic", "uncertain"}:
            raise ValueError("不支持的训练标签")
        if not payload.get("record_id"):
            raise ValueError("训练标签缺少记录 ID")
        with self.lock, self.connect() as db:
            exists = db.execute(
                """SELECT 1 FROM records r JOIN runs u ON u.id = r.run_id
                WHERE u.project_id = ? AND r.record_id = ? LIMIT 1""",
                (self.project["id"], payload["record_id"]),
            ).fetchone()
            if not exists:
                raise ValueError("训练图片不属于当前项目")
            db.execute(
                """INSERT INTO training_labels VALUES (?, ?, ?, ?)
                ON CONFLICT(project_id, record_id) DO UPDATE SET
                label = excluded.label, updated_at = excluded.updated_at""",
                (self.project["id"], payload["record_id"], payload["label"], now()),
            )
        return {"saved": True}

    def get_training_job(self) -> dict | None:
        if not self.project:
            raise ValueError("请先打开一个本地项目")
        with self.lock, self.connect() as db:
            row = db.execute(
                "SELECT * FROM training_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
                (self.project["id"],),
            ).fetchone()
        if not row:
            return None
        job = dict(row)
        job["metrics"] = json.loads(job.pop("metrics_json") or "{}")
        return job

    def start_training(self, run_id: str) -> dict:
        if not self.project:
            raise ValueError("请先打开一个本地项目")
        if not OPENCLIP_PYTHON.is_file():
            raise ValueError("OpenCLIP 独立运行环境尚未准备好")
        if not self.get_run(run_id):
            raise ValueError("找不到该任务")

        timestamp = now()
        job_id = f"train_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:4]}"
        model_version = f"en_infographic_custom_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{job_id[-4:]}"
        output_dir = MODELS_DIR / model_version
        training_dir = Path(self.project["metadata_csv"]).parent / ".insightflow" / "training" / job_id
        training_dir.mkdir(parents=True, exist_ok=True)
        manifest = training_dir / "training_manifest.csv"

        with self.lock, self.connect() as db:
            running = db.execute(
                "SELECT id FROM training_jobs WHERE project_id = ? AND status = 'running' LIMIT 1",
                (self.project["id"],),
            ).fetchone()
            if running:
                raise ValueError("已有模型训练正在进行，请等待完成")
            counts, posts = self._training_stats(db, run_id)
            readiness = training_readiness(counts, posts)
            if not readiness["ready"]:
                raise ValueError("训练样本还未达到最低要求，请继续标注两类图片")
            rows = db.execute(
                """SELECT r.record_id, r.image_path,
                CASE WHEN r.post_shortcode != '' THEN r.post_shortcode ELSE r.record_id END AS post_shortcode,
                t.label FROM records r JOIN training_labels t
                ON t.project_id = ? AND t.record_id = r.record_id
                WHERE r.run_id = ? AND r.preprocess_status = 'passed'
                AND t.label IN ('infographic', 'not_infographic') ORDER BY r.record_id""",
                (self.project["id"], run_id),
            ).fetchall()
            db.execute(
                """INSERT INTO training_jobs
                (id, project_id, status, processed, total, model_version, message, metrics_json, created_at, updated_at)
                VALUES (?, ?, 'running', 0, ?, ?, '正在准备训练数据', '{}', ?, ?)""",
                (job_id, self.project["id"], len(rows), model_version, timestamp, timestamp),
            )

        try:
            with manifest.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=("record_id", "image_path", "post_shortcode", "label"))
                writer.writeheader()
                writer.writerows(dict(row) for row in rows)
        except OSError as error:
            with self.lock, self.connect() as db:
                db.execute(
                    "UPDATE training_jobs SET status = 'failed', message = ?, updated_at = ? WHERE id = ?",
                    (f"无法保存训练清单：{error}", now(), job_id),
                )
            raise ValueError(f"无法保存训练清单：{error}") from error

        with self.lock:
            self.active_training_jobs.add(job_id)
        threading.Thread(
            target=self._run_training,
            args=(job_id, manifest, output_dir, model_version),
            daemon=True,
        ).start()
        return self.get_training_job()

    def _run_training(self, job_id: str, manifest: Path, output_dir: Path, model_version: str) -> None:
        command = [
            str(OPENCLIP_PYTHON), str(ROOT / "agent" / "train_classifier.py"),
            "--input", str(manifest), "--output-dir", str(output_dir),
            "--version", model_version, "--device", "auto",
        ]
        last_output = ""
        try:
            process = subprocess.Popen(
                command, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            assert process.stdout
            for line in process.stdout:
                last_output = line.strip()
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") in {"status", "progress"}:
                    with self.lock, self.connect() as db:
                        db.execute(
                            "UPDATE training_jobs SET processed = ?, message = ?, updated_at = ? WHERE id = ?",
                            (int(event.get("processed", 0)), event.get("message", "正在训练模型"), now(), job_id),
                        )
                elif event.get("type") == "complete":
                    metrics = event.get("metrics", {})
                    with self.lock, self.connect() as db:
                        db.execute(
                            """UPDATE training_jobs SET status = 'complete', processed = total,
                            message = '训练完成，新模型将在下一次筛选中使用', metrics_json = ?, updated_at = ?
                            WHERE id = ?""",
                            (json.dumps(metrics, ensure_ascii=False), now(), job_id),
                        )
            return_code = process.wait()
            if return_code:
                raise RuntimeError(last_output or f"训练进程退出码 {return_code}")
            if not (output_dir / "infographic_classifier.pkl").is_file():
                raise RuntimeError("训练完成但没有生成模型文件")
            MODELS_DIR.mkdir(exist_ok=True)
            ACTIVE_MODEL_FILE.write_text(
                json.dumps({"model_version": model_version, "activated_at": now()}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as error:
            with self.lock, self.connect() as db:
                db.execute(
                    "UPDATE training_jobs SET status = 'failed', message = ?, updated_at = ? WHERE id = ?",
                    (f"训练失败：{error}", now(), job_id),
                )
        finally:
            with self.lock:
                self.active_training_jobs.discard(job_id)

    def save_review(self, payload: dict) -> dict:
        required = ("run_id", "record_id", "stage", "decision")
        if any(not payload.get(key) for key in required):
            raise ValueError("审核记录缺少必要字段")
        if payload["decision"] not in {"keep", "remove", "uncertain"}:
            raise ValueError("不支持的人工决定")
        with self.lock, self.connect() as db:
            db.execute(
                """INSERT INTO reviews VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id, record_id, stage) DO UPDATE SET
                decision=excluded.decision, note=excluded.note, updated_at=excluded.updated_at""",
                (payload["run_id"], payload["record_id"], payload["stage"], payload["decision"],
                 payload.get("note", ""), now()),
            )
        return {"saved": True}


STATE = State()


class Handler(BaseHTTPRequestHandler):
    server_version = "InsightFlowLocal/0.1"

    def log_message(self, format: str, *args: object) -> None:
        print(f"[Local Agent] {format % args}")

    def allowed_origin(self) -> str | None:
        return trusted_origin(self.headers.get("Origin"))

    def reject_remote_origin(self) -> bool:
        if self.headers.get("Origin") and not self.allowed_origin():
            self.send_json(403, {"error": "Local Agent 只接受 InsightFlow 正式站点或本机页面的请求"})
            return True
        return False

    def send_json(self, status: int, payload: object) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        origin = self.allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1_000_000:
            raise ValueError("请求内容过大")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_OPTIONS(self) -> None:
        if self.reject_remote_origin():
            return
        self.send_response(204)
        origin = self.allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        if self.reject_remote_origin():
            return
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/health":
                self.send_json(200, {"ok": True, "version": "0.1", "project": STATE.project})
            elif parsed.path == "/runs/current":
                self.send_json(200, {"run": STATE.get_run() if STATE.project else None})
            elif parsed.path == "/models/openclip":
                self.send_json(200, STATE.openclip_runtime())
            elif parsed.path.startswith("/runs/") and parsed.path.endswith("/openclip"):
                run_id = parsed.path.strip("/").split("/")[1]
                self.send_json(200, STATE.openclip_summary(run_id))
            elif parsed.path == "/training/candidates":
                query = parse_qs(parsed.query)
                self.send_json(200, STATE.list_training_candidates(
                    query.get("run_id", [""])[0],
                    int(query.get("offset", ["0"])[0]),
                    int(query.get("limit", ["12"])[0]),
                ))
            elif parsed.path == "/training/status":
                self.send_json(200, {"job": STATE.get_training_job()})
            elif parsed.path == "/image":
                self.send_image(parse_qs(parsed.query).get("path", [""])[0])
            else:
                self.send_json(404, {"error": "接口不存在"})
        except (ValueError, OSError, sqlite3.Error) as error:
            self.send_json(400, {"error": str(error)})

    def do_POST(self) -> None:
        if self.reject_remote_origin():
            return
        try:
            payload = self.read_json()
            if self.path == "/projects/open":
                self.send_json(200, {"project": STATE.open_project(payload.get("images_dir", ""), payload.get("metadata_csv", ""))})
            elif self.path == "/runs":
                self.send_json(201, {"run": STATE.create_run(float(payload.get("threshold", 0.1)))})
            elif self.path.startswith("/runs/") and self.path.endswith("/preprocess"):
                run_id = self.path.strip("/").split("/")[1]
                self.send_json(200, STATE.preprocess_run(run_id))
            elif self.path.startswith("/runs/") and self.path.endswith("/openclip"):
                run_id = self.path.strip("/").split("/")[1]
                self.send_json(202, STATE.start_openclip(run_id))
            elif self.path == "/training/labels":
                self.send_json(200, STATE.save_training_label(payload))
            elif self.path == "/training/train":
                self.send_json(202, {"job": STATE.start_training(payload.get("run_id", ""))})
            elif self.path == "/reviews":
                self.send_json(200, STATE.save_review(payload))
            else:
                self.send_json(404, {"error": "接口不存在"})
        except (ValueError, OSError, sqlite3.Error, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})

    def do_PATCH(self) -> None:
        if self.reject_remote_origin():
            return
        try:
            payload = self.read_json()
            parts = self.path.strip("/").split("/")
            if len(parts) == 3 and parts[0] == "runs" and parts[2] == "status":
                self.send_json(200, {"run": STATE.update_run(parts[1], payload.get("status", ""))})
            else:
                self.send_json(404, {"error": "接口不存在"})
        except (ValueError, OSError, sqlite3.Error, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})

    def send_image(self, value: str) -> None:
        if not STATE.project:
            raise ValueError("请先打开项目")
        root = Path(STATE.project["images_dir"]).resolve()
        path = resolve_file(root, value)
        if root not in path.parents or not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS:
            raise ValueError("图片不在当前项目目录中")
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        origin = self.allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description="InsightFlow Local Agent")
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    server = ThreadingHTTPServer((HOST, args.port), Handler)
    print(f"InsightFlow Local Agent 已启动：http://{HOST}:{args.port}")
    print("它只接受本机连接；关闭此窗口即可停止。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
