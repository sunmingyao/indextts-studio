from __future__ import annotations

import queue
import threading
import uuid
from pathlib import Path
from typing import Any

from .store import Store, now_iso
from .supervisor import EngineSupervisor


class JobManager:
    def __init__(self, supervisor: EngineSupervisor, store: Store, data_dir: str):
        self.supervisor = supervisor
        self.store = store
        self.data_dir = Path(data_dir)
        self.outputs_dir = self.data_dir / "outputs"
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        self.queue: queue.Queue[str] = queue.Queue()
        self.lock = threading.RLock()
        self.thread = threading.Thread(target=self._worker, daemon=True)
        self.thread.start()

    def submit(
        self,
        *,
        text: str,
        voice_id: str,
        lang: str,
        duration_factor: float,
        emotion: dict[str, Any] | None,
        advanced: dict[str, Any] | None,
    ) -> dict:
        if self.supervisor.status != "ready" or not self.supervisor.active:
            raise RuntimeError("引擎尚未就绪，请稍后再试")
        voice = self.store.get_voice(voice_id)
        if not voice:
            raise ValueError("音色不存在，请先上传参考音频")
        engine_id = self.supervisor.active
        capability = self.supervisor.engines[engine_id]
        if lang not in capability.get("languages", []):
            raise ValueError(f"当前引擎不支持语言: {lang}")

        job_id = uuid.uuid4().hex
        record = {
            "id": job_id,
            "status": "queued",
            "engine": engine_id,
            "text": text,
            "voice_id": voice_id,
            "voice_name": voice.get("name", ""),
            "lang": lang,
            "duration_factor": duration_factor,
            "emotion": emotion or {"mode": "reference", "alpha": 1.0},
            "advanced": advanced or {},
            "output_path": str(self.outputs_dir / f"{job_id}.wav"),
            "audio_url": None,
            "duration": None,
            "elapsed": None,
            "rtf": None,
            "error": None,
            "cancel_requested": False,
            "created_at": now_iso(),
            "started_at": None,
            "finished_at": None,
        }
        self.store.create_job(record)
        self.queue.put(job_id)
        return record

    def cancel(self, job_id: str) -> dict | None:
        job = self.store.get_job(job_id)
        if not job:
            return None
        if job["status"] == "queued":
            return self.store.update_job(
                job_id,
                status="canceled",
                error="用户已取消",
                finished_at=now_iso(),
                cancel_requested=True,
            )
        if job["status"] == "running":
            return self.store.update_job(job_id, cancel_requested=True)
        return job

    def _worker(self) -> None:
        while True:
            job_id = self.queue.get()
            try:
                self._run(job_id)
            finally:
                self.queue.task_done()

    def _run(self, job_id: str) -> None:
        job = self.store.get_job(job_id)
        if not job or job["status"] == "canceled":
            return
        if self.supervisor.active != job["engine"]:
            self.store.update_job(
                job_id,
                status="failed",
                error="引擎已切换，请重新提交任务",
                finished_at=now_iso(),
            )
            return
        if not self.supervisor.worker or self.supervisor.status != "ready":
            self.store.update_job(
                job_id,
                status="failed",
                error="引擎未就绪",
                finished_at=now_iso(),
            )
            return

        job = self.store.update_job(job_id, status="running", started_at=now_iso())
        try:
            voice = self.store.get_voice(job["voice_id"])
            if not voice:
                raise ValueError("音色文件不存在")

            emotion = dict(job.get("emotion") or {})
            audio_voice_id = emotion.pop("audioVoiceId", None)
            audio_path = None
            if audio_voice_id:
                audio_voice = self.store.get_voice(audio_voice_id)
                if not audio_voice:
                    raise ValueError("情感参考音频不存在")
                audio_path = audio_voice["path"]

            payload = {
                "text": job["text"],
                "lang": job["lang"],
                "voice_path": voice["path"],
                "output_path": job["output_path"],
                "duration_factor": job["duration_factor"],
                "emotion": {
                    "mode": emotion.get("mode", "reference"),
                    "alpha": emotion.get("alpha", 1.0),
                    "vector": emotion.get("vector"),
                    "text": emotion.get("text"),
                    "audio_path": audio_path,
                },
                "advanced": job.get("advanced") or {},
            }
            result = self.supervisor.synthesize(payload)

            if job.get("cancel_requested"):
                self.store.update_job(
                    job_id,
                    status="canceled",
                    error="用户已取消（任务已完成）",
                    output_path=result.get("audio_path"),
                    duration=result.get("duration"),
                    elapsed=result.get("elapsed"),
                    rtf=result.get("rtf"),
                    finished_at=now_iso(),
                )
                return

            output_path = result.get("audio_path") or job["output_path"]
            self.store.update_job(
                job_id,
                status="succeeded",
                output_path=output_path,
                audio_url=f"/api/audio/{Path(output_path).name}",
                duration=result.get("duration"),
                elapsed=result.get("elapsed"),
                rtf=result.get("rtf"),
                finished_at=now_iso(),
            )
        except Exception as exc:
            self.store.update_job(
                job_id,
                status="failed",
                error=str(exc),
                finished_at=now_iso(),
            )