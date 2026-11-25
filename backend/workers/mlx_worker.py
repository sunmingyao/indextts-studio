from __future__ import annotations

import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

ALLOWED_GEN = {
    "greedy",
    "seed",
    "top_k",
    "top_p",
    "temperature",
    "repetition_penalty",
    "max_mel_tokens",
    "max_text_tokens_per_segment",
    "interval_silence",
    "n_timesteps",
    "cfg_rate",
    "duration_factor",
}


def json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "IndexTTSMLXWorker/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[mlx-worker] {fmt % args}", flush=True)

    def _authorized(self) -> bool:
        token = self.server.token  # type: ignore[attr-defined]
        return not token or self.headers.get("X-Worker-Token") == token

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send(404, {"ok": False, "error": "not found"})
            return
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        self._send(
            200,
            {
                "ok": True,
                "ready": True,
                "engine": "mlx",
                "languages": ["zh", "en", "ja", "yue"],
                "emotion_modes": ["reference"],
                "load_seconds": self.server.load_seconds,  # type: ignore[attr-defined]
            },
        )

    def do_POST(self) -> None:
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        if self.path == "/shutdown":
            self._send(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if self.path != "/synthesize":
            self._send(404, {"ok": False, "error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            result = self.server.synthesize(payload)  # type: ignore[attr-defined]
            self._send(200, {"ok": True, **result})
        except Exception as exc:
            self._send(500, {"ok": False, "error": str(exc)})


class WorkerServer(HTTPServer):
    def __init__(self, address: tuple[str, int], token: str, tts: Any, model_dir: str, load_seconds: float):
        super().__init__(address, Handler)
        self.token = token
        self.tts = tts
        self.model_dir = model_dir
        self.load_seconds = round(load_seconds, 2)
        self.speakers: dict[str, Any] = {}
        self.lock = threading.Lock()

    def synthesize(self, payload: dict[str, Any]) -> dict[str, Any]:
        text = (payload.get("text") or "").strip()
        voice_path = payload.get("voice_path") or ""
        output_path = payload.get("output_path") or ""
        lang = payload.get("lang") or "zh"
        if not text or not voice_path or not output_path:
            raise ValueError("text, voice_path and output_path are required")
        if not Path(voice_path).is_file():
            raise FileNotFoundError(f"voice not found: {voice_path}")

        emotion = payload.get("emotion") or {}
        if (emotion.get("mode") or "reference") != "reference":
            raise ValueError("MLX engine only supports emotion mode 'reference'")

        advanced = payload.get("advanced") or {}
        gen = {key: value for key, value in advanced.items() if key in ALLOWED_GEN and value is not None}
        for key in ("temperature", "top_p", "repetition_penalty", "cfg_rate", "duration_factor"):
            if key in gen:
                gen[key] = float(gen[key])
        for key in ("top_k", "max_mel_tokens", "max_text_tokens_per_segment", "interval_silence", "n_timesteps", "seed"):
            if key in gen:
                gen[key] = int(gen[key])
        if "greedy" in gen:
            gen["greedy"] = bool(gen["greedy"])
        if payload.get("duration_factor") is not None:
            gen["duration_factor"] = float(payload["duration_factor"])
        if str(lang).lower() not in {"zh", "en", "ja", "yue"}:
            raise ValueError(f"unsupported language for MLX engine: {lang}")

        started = time.perf_counter()
        with self.lock:
            spk = self.speakers.get(voice_path)
            clone_seconds = 0.0
            if spk is None:
                clone_started = time.perf_counter()
                spk = self.tts.build_speaker(voice_path)
                clone_seconds = time.perf_counter() - clone_started
                self.speakers[voice_path] = spk
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            pcm = self.tts.synthesize(str(text), lang=str(lang).lower(), spk=spk, **gen)
            import soundfile as sf

            sf.write(output_path, pcm, 22050, subtype="PCM_16")

        elapsed = time.perf_counter() - started
        import soundfile as sf

        duration = float(sf.info(output_path).duration)
        return {
            "engine": "mlx",
            "audio_path": output_path,
            "duration": round(duration, 3),
            "elapsed": round(elapsed, 3),
            "clone_seconds": round(clone_seconds, 3),
            "rtf": round(elapsed / duration, 3) if duration else None,
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--token", default="")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--hf-home", default="")
    args = parser.parse_args()

    if args.hf_home:
        os.environ.setdefault("HF_HOME", args.hf_home)
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

    from index_tts_2_5_mlx import IndexTTS

    started = time.perf_counter()
    tts = IndexTTS(model_dir=args.model_dir)
    load_seconds = time.perf_counter() - started
    server = WorkerServer((args.host, args.port), args.token, tts, args.model_dir, load_seconds)
    print(f"[mlx-worker] ready on http://{args.host}:{args.port} load={load_seconds:.2f}s", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()