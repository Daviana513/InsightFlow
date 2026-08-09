#!/usr/bin/env python3
"""InsightFlow Local Agent: a dependency-free local project and run service."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import mimetypes
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


HOST = "127.0.0.1"
PORT = 8765
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
  PRIMARY KEY(run_id, record_id),
  FOREIGN KEY(run_id) REFERENCES runs(id)
);
"""


class State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.project: dict | None = None
        self.db_path: Path | None = None

    def open_project(self, images_dir: str, metadata_csv: str) -> dict:
        project = inspect_project(images_dir, metadata_csv)
        project_id = hashlib.sha256(f"{project['images_dir']}\0{project['metadata_csv']}".encode()).hexdigest()[:16]
        project["id"] = project_id
        db_dir = Path(project["metadata_csv"]).parent / ".insightflow"
        db_dir.mkdir(exist_ok=True)
        db_path = db_dir / "insightflow.db"
        with self.lock, sqlite3.connect(db_path) as db:
            db.executescript(SCHEMA)
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
                "INSERT INTO runs VALUES (?, ?, 'ready', 'preprocess', 0, ?, ?, ?, ?, ?)",
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
                "INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", records
            )
            db.execute(
                "UPDATE runs SET status = 'paused', stage = 'openclip', processed = ?, total = ?, updated_at = ? WHERE id = ?",
                (len(records), len(records), timestamp, run_id),
            )
        return {
            "run": self.get_run(run_id),
            "summary": {"total": len(records), "passed": passed, "image_missing": len(records) - passed},
        }

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
        origin = self.headers.get("Origin")
        if not origin:
            return None
        host = urlparse(origin).hostname
        return origin if host in {"localhost", "127.0.0.1", "::1"} else None

    def reject_remote_origin(self) -> bool:
        if self.headers.get("Origin") and not self.allowed_origin():
            self.send_json(403, {"error": "Local Agent 只接受本机页面的请求"})
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
