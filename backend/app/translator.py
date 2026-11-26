from __future__ import annotations

import os
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

from .supervisor import free_port


class TranslatorProcess:
    def __init__(self, config: dict, project_root: str, log_dir: str):
        self.config = config
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
                "HF_HOME": self.config.get("_hf_home", ""),
                "HF_ENDPOINT": "https://hf-mirror.com",
                "HF_HUB_DISABLE_XET": "1",
                "TOKENIZERS_PARALLELISM": "false",
            }
        )
        return env

    def start(self, timeout: float = 240.0) -> None:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        log_path = self.log_dir / "worker-translate.log"
        self._log_handle = log_path.open("a", encoding="utf-8")
        self._log_handle.write(f"\n=== start {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
        self._log_handle.flush()

        cmd = [
            self.config["_python"],
            self.config["_worker"],
            "--port",
            str(self.port),
            "--token",
            self.token,
            "--asr-model",
            self.config["_asr_model"],
            "--aligner-model",
            self.config["_aligner_model"],
            "--llm-model",
            self.config["_llm_model"],
            "--hf-home",
            self.config.get("_hf_home", ""),
        ]
        self.process = subprocess.Popen(
            cmd,
            cwd=self.project_root,
            env=self._env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
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

    def _wait_health(self, timeout: float) -> None:
        deadline = time.time() + timeout
        last_error = ""
        while time.time() < deadline:
            if self.process and self.process.poll() is not None:
                raise RuntimeError(f"translate worker exited: {self.tail_log()}")
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
        raise RuntimeError(
            f"translate worker not ready: {last_error}\n{self.tail_log()}"
        )

    def request(
        self,
        path: str,
        payload: dict[str, Any],
        timeout: float = 900.0,
    ) -> dict[str, Any]:
        if not self.process or self.process.poll() is not None:
            raise RuntimeError("translate worker is not running")
        response = self.client.post(
            f"{self.base_url}{path}",
            json=payload,
            headers={"X-Worker-Token": self.token},
            timeout=timeout,
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
        path = self.log_dir / "worker-translate.log"
        if not path.exists():
            return ""
        try:
            content = path.read_text(encoding="utf-8", errors="ignore").splitlines()
            return "\n".join(content[-lines:])
        except Exception:
            return ""


class TranslatorSupervisor:
    def __init__(self, config: dict):
        self.config = config.get("translator", {})
        self.project_root = config["_project_root"]
        self.log_dir = str(Path(config["_data_dir"]) / "logs")
        self.lock = threading.RLock()
        self.process: TranslatorProcess | None = None
        self.status = "idle"
        self.error: str | None = None
        self.load_seconds: float | None = None

    def missing(self) -> list[str]:
        required = [
            self.config.get("_python"),
            self.config.get("_worker"),
            self.config.get("_asr_model"),
            self.config.get("_aligner_model"),
            self.config.get("_llm_model"),
        ]
        return [path for path in required if not path or not Path(path).exists()]

    def capabilities(self) -> dict:
        missing = self.missing()
        return {
            "status": self.status,
            "ready": self.status == "ready" and not missing,
            "error": self.error,
            "loadSeconds": self.load_seconds,
            "missing": missing,
            "models": {
                "asr": self.config.get("_asr_model"),
                "aligner": self.config.get("_aligner_model"),
                "llm": self.config.get("_llm_model"),
            },
        }

    def activate(self, timeout: float = 240.0) -> dict:
        with self.lock:
            missing = self.missing()
            if missing:
                self.status = "failed"
                self.error = f"翻译模型缺失: {', '.join(missing)}"
                raise RuntimeError(self.error)
            self.status = "loading"
            self.error = None
            if self.process:
                self.process.stop()
                self.process = None
            try:
                process = TranslatorProcess(
                    self.config,
                    self.project_root,
                    self.log_dir,
                )
                process.start(timeout=timeout)
                self.process = process
                self.load_seconds = process.load_seconds
                self.status = "ready"
                return self.capabilities()
            except Exception as exc:
                self.status = "failed"
                self.error = str(exc)
                if self.process:
                    self.process.stop()
                    self.process = None
                raise

    def stop(self) -> None:
        with self.lock:
            if self.process:
                self.process.stop()
                self.process = None
            self.status = "stopped"
            self.load_seconds = None

    def request(
        self,
        path: str,
        payload: dict[str, Any],
        timeout: float = 900.0,
    ) -> dict[str, Any]:
        with self.lock:
            if not self.process or self.status != "ready":
                raise RuntimeError("翻译服务尚未就绪")
            return self.process.request(path, payload, timeout=timeout)

    def transcribe(
        self,
        audio_path: str,
        language: str | None,
        context: str | None = None,
    ) -> dict[str, Any]:
        payload = {"audio_path": audio_path, "language": language}
        if context:
            payload["context"] = context
        return self.request(
            "/transcribe",
            payload,
            timeout=300.0,
        )

    def align(self, audio_path: str, text: str, language: str) -> dict[str, Any]:
        return self.request(
            "/align",
            {"audio_path": audio_path, "text": text, "language": language},
            timeout=300.0,
        )

    def translate(
        self,
        texts: list[str],
        source_language: str,
        target_language: str,
        context_before: list[str] | None = None,
    ) -> dict[str, Any]:
        return self.request(
            "/translate",
            {
                "texts": texts,
                "source_language": source_language,
                "target_language": target_language,
                "context_before": context_before or [],
            },
            timeout=600.0,
        )

    def shutdown(self) -> None:
        self.stop()