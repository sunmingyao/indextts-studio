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
    "do_sample",
    "top_p",
    "top_k",
    "temperature",
    "length_penalty",
    "num_beams",
    "repetition_penalty",
    "max_mel_tokens",
    "max_text_tokens_per_segment",
    "use_random",
}


def json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "IndexTTSMPSWorker/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[mps-worker] {fmt % args}", flush=True)

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
                "engine": "mps",
                "languages": ["zh", "en", "ja", "es", "ar"],
                "emotion_modes": ["reference", "audio", "vector", "text"],
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
    def __init__(self, address: tuple[str, int], token: str, tts: Any, torch: Any, load_seconds: float):
        super().__init__(address, Handler)
        self.token = token
        self.tts = tts
        self.torch = torch
        self.load_seconds = round(load_seconds, 2)
        self.lock = threading.Lock()

    def synthesize(self, payload: dict[str, Any]) -> dict[str, Any]:
        text = (payload.get("text") or "").strip()
        voice_path = payload.get("voice_path") or ""
        output_path = payload.get("output_path") or ""
        lang = str(payload.get("lang") or "zh").upper()
        if not text or not voice_path or not output_path:
            raise ValueError("text, voice_path and output_path are required")
        if not Path(voice_path).is_file():
            raise FileNotFoundError(f"voice not found: {voice_path}")
        if lang not in {"ZH", "EN", "JA", "ES", "AR"}:
            raise ValueError(f"unsupported language for MPS engine: {lang}")

        emotion = payload.get("emotion") or {}
        mode = emotion.get("mode") or "reference"
        alpha = float(emotion.get("alpha", emotion.get("emo_alpha", 1.0)) or 1.0)
        advanced = payload.get("advanced") or {}
        kwargs = {key: value for key, value in advanced.items() if key in ALLOWED_GEN and value is not None}
        for key in ("temperature", "top_p", "length_penalty", "repetition_penalty"):
            if key in kwargs:
                kwargs[key] = float(kwargs[key])
        for key in ("top_k", "num_beams", "max_mel_tokens", "max_text_tokens_per_segment"):
            if key in kwargs:
                kwargs[key] = int(kwargs[key])
        for key in ("do_sample", "use_random"):
            if key in kwargs:
                kwargs[key] = bool(kwargs[key])
        kwargs.update(
            spk_audio_prompt=voice_path,
            text=text,
            lang=lang,
            output_path=output_path,
            duration_factor=float(payload.get("duration_factor", 1.0) or 1.0),
            verbose=False,
        )

        if mode == "audio":
            audio_path = emotion.get("audio_path") or ""
            if not audio_path or not Path(audio_path).is_file():
                raise ValueError("emotion audio_path is required for audio mode")
            kwargs.update(emo_audio_prompt=audio_path, emo_alpha=alpha)
        elif mode == "vector":
            vector = emotion.get("vector") or []
            if len(vector) != 8:
                raise ValueError("emotion vector must contain 8 numbers")
            kwargs.update(emo_vector=[float(v) for v in vector], emo_alpha=alpha)
        elif mode == "text":
            kwargs.update(
                use_emo_text=True,
                emo_text=emotion.get("text") or None,
                emo_alpha=alpha,
            )
        elif mode != "reference":
            raise ValueError(f"unsupported emotion mode: {mode}")

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        started = time.perf_counter()
        with self.lock:
            self.tts.infer(**kwargs)
        elapsed = time.perf_counter() - started

        import soundfile as sf

        duration = float(sf.info(output_path).duration)
        allocated = None
        try:
            allocated = round(self.torch.mps.current_allocated_memory() / 1024**3, 2)
        except Exception:
            pass
        try:
            self.torch.mps.empty_cache()
        except Exception:
            pass

        return {
            "engine": "mps",
            "audio_path": output_path,
            "duration": round(duration, 3),
            "elapsed": round(elapsed, 3),
            "rtf": round(elapsed / duration, 3) if duration else None,
            "mps_allocated_gb": allocated,
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
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    import torch
    from indextts.infer_v2_5 import IndexTTS2

    started = time.perf_counter()
    tts = IndexTTS2(
        cfg_path=str(Path(args.model_dir) / "config.yaml"),
        model_dir=args.model_dir,
        device="mps",
        use_bf16=False,
        use_cuda_kernel=False,
        use_qwen_emo=True,
    )
    load_seconds = time.perf_counter() - started
    server = WorkerServer((args.host, args.port), args.token, tts, torch, load_seconds)
    print(f"[mps-worker] ready on http://{args.host}:{args.port} load={load_seconds:.2f}s", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()