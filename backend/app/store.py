from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


class Store:
    def __init__(self, data_dir: str):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / "store.json"
        self.lock = threading.RLock()
        self.data: dict[str, Any] = {"voices": {}, "presets": {}, "jobs": {}}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            self._save()
            return
        try:
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            self.data = {"voices": {}, "presets": {}, "jobs": {}}
        for key in ("voices", "presets", "jobs"):
            self.data.setdefault(key, {})
        for voice in self.data["voices"].values():
            voice.setdefault("kind", "voice")

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def list_voices(self, kind: str | None = None) -> list[dict]:
        with self.lock:
            items = self.data["voices"].values()
            if kind:
                items = [item for item in items if item.get("kind", "voice") == kind]
            return sorted(items, key=lambda item: item["created_at"], reverse=True)

    def get_voice(self, voice_id: str) -> dict | None:
        with self.lock:
            return self.data["voices"].get(voice_id)

    def add_voice(self, record: dict) -> dict:
        with self.lock:
            self.data["voices"][record["id"]] = record
            self._save()
            return record

    def delete_voice(self, voice_id: str) -> bool:
        with self.lock:
            record = self.data["voices"].pop(voice_id, None)
            if record:
                self._save()
            return bool(record)

    def list_presets(self) -> list[dict]:
        with self.lock:
            return sorted(self.data["presets"].values(), key=lambda item: item["created_at"], reverse=True)

    def add_preset(self, record: dict) -> dict:
        with self.lock:
            self.data["presets"][record["id"]] = record
            self._save()
            return record

    def delete_preset(self, preset_id: str) -> bool:
        with self.lock:
            record = self.data["presets"].pop(preset_id, None)
            if record:
                self._save()
            return bool(record)

    def create_job(self, record: dict) -> dict:
        with self.lock:
            self.data["jobs"][record["id"]] = record
            self._save()
            return record

    def get_job(self, job_id: str) -> dict | None:
        with self.lock:
            return self.data["jobs"].get(job_id)

    def update_job(self, job_id: str, **fields: Any) -> dict | None:
        with self.lock:
            job = self.data["jobs"].get(job_id)
            if not job:
                return None
            job.update(fields)
            self._save()
            return job

    def list_jobs(self, limit: int = 50) -> list[dict]:
        with self.lock:
            jobs = sorted(
                self.data["jobs"].values(),
                key=lambda item: item.get("created_at", ""),
                reverse=True,
            )
            return jobs[:limit]

    def delete_job(self, job_id: str) -> dict | None:
        with self.lock:
            job = self.data["jobs"].pop(job_id, None)
            if job:
                self._save()
            return job

    def clear_jobs(self) -> list[dict]:
        with self.lock:
            jobs = list(self.data["jobs"].values())
            self.data["jobs"] = {}
            self._save()
            return jobs

    def mark_interrupted(self) -> None:
        with self.lock:
            changed = False
            for job in self.data["jobs"].values():
                if job.get("status") in {"queued", "running"}:
                    job["status"] = "failed"
                    job["error"] = "应用重启，任务已中断"
                    job["finished_at"] = now_iso()
                    changed = True
            if changed:
                self._save()