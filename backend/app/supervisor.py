from __future__ import annotations

import os
import socket
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import httpx


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class WorkerProcess:
    def __init__(self, engine_id: str, engine: dict, project_root: str, log_dir: str):
        self.engine_id = engine_id
        self.engine = engine
        self.project_root = project_root
        self.log_dir = Path(log_dir)
        self.port = free_port()
        self.token = uuid.uuid4().hex
        self.process: subprocess.Popen | None = None
        self.load_seconds: float | None = None
        self._log_handle = None
        self.client = httpx.Client(trust_env=False)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _env(self) -> dict[str, str]:
        env = os.environ.copy()
        env.update(
            {
                "PYTHONUNBUFFERED": "1",
                "HF_HOME": self.engine.get("_hf_home", ""),
                "HF_ENDPOINT": "https://hf-mirror.com",
                "HF_HUB_DISABLE_XET": "1",
                "TOKENIZERS_PARALLELISM": "false",
            }
        )
        if self.engine_id == "mps":
            env["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
        return env

    def start(self, timeout: float = 240.0) -> None:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        log_path = self.log_dir / f"worker-{self.engine_id}.log"
        self._log_handle = log_path.open("a", encoding="utf-8")
        self._log_handle.write(f"\n=== start {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
        self._log_handle.flush()

        cmd = [
            self.engine["_python"],
            self.engine["_worker"],
            "--port",
            str(self.port),
            "--token",
            self.token,
            "--model-dir",
            self.engine["_model_dir"],
            "--hf-home",
            self.engine.get("_hf_home", ""),
        ]
        self.process = subprocess.Popen(
            cmd,
            cwd=self.project_root,
            env=self._env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        threading.Thread(target=self._pump_logs, daemon=True).start()
        self._wait_health(timeout)

    def _pump_logs(self) -> None:
        if not self.process or not self.process.stdout:
            return
        for line in self.process.stdout:
            if self._log_handle:
                self._log_handle.write(line)
                self._log_handle.flush()
        if self._log_handle:
            self._log_handle.flush()

    def _wait_health(self, timeout: float) -> None:
        deadline = time.time() + timeout
        last_error = ""
        while time.time() < deadline:
            if self.process and self.process.poll() is not None:
                raise RuntimeError(f"{self.engine_id} worker exited: {self.tail_log()}")
            try:
                response = self.client.get(
                    f"{self.base_url}/health",
                    headers={"X-Worker-Token": self.token},
                    timeout=2.0,
                )
                if response.status_code == 200:
                    payload = response.json()
                    self.load_seconds = payload.get("load_seconds")
                    return
                last_error = response.text
            except Exception as exc:
                last_error = str(exc)
            time.sleep(0.5)
        raise RuntimeError(f"{self.engine_id} worker not ready: {last_error}\n{self.tail_log()}")

    def synthesize(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.process or self.process.poll() is not None:
            raise RuntimeError(f"{self.engine_id} worker is not running")
        response = self.client.post(
            f"{self.base_url}/synthesize",
            json=payload,
            headers={"X-Worker-Token": self.token},
            timeout=900.0,
        )
        if response.status_code != 200:
            try:
                detail = response.json().get("error") or response.text
            except Exception:
                detail = response.text
            raise RuntimeError(detail)
        return response.json()

    def stop(self) -> None:
        if not self.process:
            return
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        self.process = None
        if self._log_handle:
            self._log_handle.flush()
            self._log_handle.close()
            self._log_handle = None

    def tail_log(self, lines: int = 30) -> str:
        path = self.log_dir / f"worker-{self.engine_id}.log"
        if not path.exists():
            return ""
        try:
            content = path.read_text(encoding="utf-8", errors="ignore").splitlines()
            return "\n".join(content[-lines:])
        except Exception:
            return ""


class EngineSupervisor:
    def __init__(self, config: dict):
        self.config = config
        self.engines: dict[str, dict] = config["engines"]
        self.project_root = config["_project_root"]
        self.log_dir = str(Path(config["_data_dir"]) / "logs")
        self.lock = threading.RLock()
        self.worker: WorkerProcess | None = None
        self.active: str | None = None
        self.status = "idle"
        self.error: str | None = None

    def capabilities(self) -> dict:
        items = []
        for engine_id, engine in self.engines.items():
            items.append(
                {
                    "id": engine_id,
                    "label": engine.get("label", engine_id),
                    "description": engine.get("description", ""),
                    "languages": engine.get("languages", []),
                    "emotionModes": engine.get("emotionModes", ["reference"]),
                    "supportsPronunciation": bool(engine.get("supportsPronunciation")),
                    "supportsDurationFactor": bool(engine.get("supportsDurationFactor", True)),
                    "speedHint": engine.get("speedHint", ""),
                    "active": engine_id == self.active,
                }
            )
        return {
            "active": self.active,
            "status": self.status,
            "error": self.error,
            "loadSeconds": self.worker.load_seconds if self.worker else None,
            "engines": items,
        }

    def activate(self, engine_id: str, timeout: float = 240.0) -> dict:
        if engine_id not in self.engines:
            raise ValueError(f"unknown engine: {engine_id}")
        with self.lock:
            previous = self.active
            self.status = "loading"
            self.error = None
            if self.worker:
                self.worker.stop()
                self.worker = None
            try:
                worker = WorkerProcess(
                    engine_id,
                    self.engines[engine_id],
                    self.project_root,
                    self.log_dir,
                )
                worker.start(timeout=timeout)
                self.worker = worker
                self.active = engine_id
                self.status = "ready"
                return self.capabilities()
            except Exception as exc:
                self.error = str(exc)
                self.status = "failed"
                self.active = None
                if previous and previous != engine_id:
                    try:
                        fallback = WorkerProcess(
                            previous,
                            self.engines[previous],
                            self.project_root,
                            self.log_dir,
                        )
                        fallback.start(timeout=timeout)
                        self.worker = fallback
                        self.active = previous
                        self.status = "ready"
                        self.error = f"{engine_id} 启动失败，已回退到 {previous}: {exc}"
                        return self.capabilities()
                    except Exception as fallback_exc:
                        self.error = f"{exc}\n回退失败: {fallback_exc}"
                raise

    def synthesize(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            if not self.worker or self.status != "ready":
                raise RuntimeError("engine is not ready")
            return self.worker.synthesize(payload)

    def shutdown(self) -> None:
        with self.lock:
            if self.worker:
                self.worker.stop()
                self.worker = None
            self.active = None
            self.status = "stopped"