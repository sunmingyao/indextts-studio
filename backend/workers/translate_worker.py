from __future__ import annotations

import argparse
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import mlx.core as mx
from mlx_audio.stt import load as load_stt
from mlx_lm import generate as llm_generate
from mlx_lm import load as load_llm

TARGET_NAMES = {
    "en": "English",
    "zh": "Simplified Chinese",
    "ja": "Japanese",
    "ko": "Korean",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "pt": "Portuguese",
    "ru": "Russian",
    "it": "Italian",
    "yue": "Cantonese",
}

SUPPORTED_ALIGN_LANGUAGES = {
    "chinese",
    "english",
    "japanese",
    "korean",
    "french",
    "german",
    "italian",
    "portuguese",
    "russian",
    "spanish",
    "cantonese",
}

REFUSAL_PATTERNS = [
    r"^(?:抱歉|对不起).{0,20}(?:无法|不能|不能协助|无法协助)",
    r"^(?:我|作为).{0,20}(?:无法|不能|不能协助)",
    r"^(?:I(?:'m| am)? sorry|Sorry).{0,40}(?:can(?:not|'t)|unable)",
    r"^(?:I can(?:not|'t)|I am unable|As an AI)",
]


def json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def normalize_language(value: object, fallback: str | None = None) -> str:
    if isinstance(value, list):
        value = value[0] if value else None
    return str(value or fallback or "unknown")


def is_refusal(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return True
    return any(re.search(pattern, stripped, re.IGNORECASE) for pattern in REFUSAL_PATTERNS)


class TranslationEngine:
    def __init__(self, asr_model: str, aligner_model: str, llm_model: str):
        started = time.perf_counter()
        self.asr = load_stt(asr_model)
        self.aligner = load_stt(aligner_model)
        self.llm, self.tokenizer = load_llm(llm_model)
        self.load_seconds = round(time.perf_counter() - started, 2)
        self.lock = threading.Lock()
        self.models = {
            "asr": asr_model,
            "aligner": aligner_model,
            "llm": llm_model,
        }

    def transcribe(
        self,
        audio_path: str,
        language: str | None,
        context: str | None = None,
    ) -> dict[str, Any]:
        if not Path(audio_path).is_file():
            raise FileNotFoundError(audio_path)
        started = time.perf_counter()
        with self.lock:
            result = self.asr.generate(
                audio_path,
                language=language,
                system_prompt=context,
            )
            text = str(result.text).strip()
            detected = normalize_language(result.language, language)
            mx.clear_cache()
        return {
            "text": text,
            "language": detected,
            "elapsed": round(time.perf_counter() - started, 3),
        }

    def align(self, audio_path: str, text: str, language: str) -> dict[str, Any]:
        if not Path(audio_path).is_file():
            raise FileNotFoundError(audio_path)
        if language.lower() not in SUPPORTED_ALIGN_LANGUAGES:
            return {"items": [], "supported": False}
        started = time.perf_counter()
        with self.lock:
            alignment = self.aligner.generate(
                audio=audio_path,
                text=text,
                language=language,
            )
            items = [
                {
                    "text": str(item.text),
                    "start": round(float(item.start_time), 3),
                    "end": round(float(item.end_time), 3),
                }
                for item in alignment
            ]
            mx.clear_cache()
        return {
            "items": items,
            "supported": True,
            "elapsed": round(time.perf_counter() - started, 3),
        }

    def translate_one(
        self,
        text: str,
        source_language: str,
        target_language: str,
    ) -> str:
        target_name = TARGET_NAMES.get(target_language, target_language)
        prompt = self.tokenizer.apply_chat_template(
            [
                {
                    "role": "system",
                    "content": (
                        "You are a professional film subtitle translator. Translate the "
                        f"original {source_language} line into natural {target_name}. "
                        "Preserve the original meaning, profanity level, and tone. Prefer "
                        "concise phrasing that can be read in the line's screen time; "
                        "never drop meaning. Do not soften, explain, warn, or omit. "
                        "Output only the translation."
                    ),
                },
                {"role": "user", "content": text},
            ],
            tokenize=False,
            add_generation_prompt=True,
        )
        output = llm_generate(
            self.llm,
            self.tokenizer,
            prompt=prompt,
            max_tokens=256,
            verbose=False,
        )
        return str(output).strip()

    def translate(
        self,
        texts: list[str],
        source_language: str,
        target_language: str,
        context_before: list[str] | None = None,
    ) -> dict[str, Any]:
        if not texts:
            return {"translations": [], "mode": "batch", "refusals": []}
        started = time.perf_counter()
        with self.lock:
            if len(texts) == 1 and not context_before:
                translations = [
                    self.translate_one(texts[0], source_language, target_language)
                ]
                mode = "single"
            else:
                target_name = TARGET_NAMES.get(target_language, target_language)
                context = "\n".join(context_before or []) or "(none)"
                lines = "\n".join(
                    f"{index}. {text}" for index, text in enumerate(texts, 1)
                )
                prompt = self.tokenizer.apply_chat_template(
                    [
                        {
                            "role": "system",
                            "content": (
                                "You are a professional film subtitle translator. "
                                f"Translate ONLY the numbered {source_language} subtitle "
                                f"lines into natural {target_name}. Context is for "
                                "understanding only: never translate, repeat, continue, or "
                                "paraphrase context lines. Preserve names, pronouns, "
                                "terminology, meaning, profanity level, and tone. Keep each line concise "
                                "enough to read in its screen time without dropping meaning. "
                                "Do not soften, explain, warn, merge, or omit lines. Output "
                                "exactly the same number of numbered lines, in the same order, "
                                "with no extra text."
                            ),
                        },
                        {
                            "role": "user",
                            "content": (
                                f"Context before (do not translate):\n{context}\n\n"
                                f"Lines to translate:\n{lines}"
                            ),
                        },
                    ],
                    tokenize=False,
                    add_generation_prompt=True,
                )
                output = str(
                    llm_generate(
                        self.llm,
                        self.tokenizer,
                        prompt=prompt,
                        max_tokens=max(256, len(texts) * 160),
                        verbose=False,
                    )
                ).strip()
                parsed: dict[int, str] = {}
                for line in output.splitlines():
                    match = re.match(r"^\s*(\d+)\s*[\.\)、:：]\s*(.+?)\s*$", line)
                    if match:
                        parsed[int(match.group(1))] = match.group(2)
                if len(parsed) == len(texts) and all(
                    index in parsed for index in range(1, len(texts) + 1)
                ):
                    translations = [parsed[index] for index in range(1, len(texts) + 1)]
                    mode = "batch"
                else:
                    translations = [
                        self.translate_one(text, source_language, target_language)
                        for text in texts
                    ]
                    mode = "fallback"
            mx.clear_cache()
        return {
            "translations": translations,
            "mode": mode,
            "refusals": [is_refusal(text) for text in translations],
            "elapsed": round(time.perf_counter() - started, 3),
        }


class WorkerServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], token: str, engine: TranslationEngine):
        super().__init__(address, Handler)
        self.token = token
        self.engine = engine


class Handler(BaseHTTPRequestHandler):
    server_version = "IndexTTSTranslateWorker/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[translate-worker] {fmt % args}", flush=True)

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
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        if self.path == "/health":
            engine = self.server.engine  # type: ignore[attr-defined]
            self._send(
                200,
                {
                    "ok": True,
                    "ready": True,
                    "load_seconds": engine.load_seconds,
                    "models": engine.models,
                },
            )
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        if self.path == "/shutdown":
            self._send(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            engine = self.server.engine  # type: ignore[attr-defined]
            if self.path == "/transcribe":
                result = engine.transcribe(
                    payload["audio_path"],
                    payload.get("language"),
                    payload.get("context"),
                )
            elif self.path == "/align":
                result = engine.align(
                    payload["audio_path"],
                    payload["text"],
                    payload["language"],
                )
            elif self.path == "/translate":
                result = engine.translate(
                    payload.get("texts") or [],
                    payload.get("source_language") or "unknown",
                    payload.get("target_language") or "zh",
                    payload.get("context_before") or [],
                )
            else:
                self._send(404, {"ok": False, "error": "not found"})
                return
            self._send(200, {"ok": True, **result})
        except Exception as exc:
            self._send(500, {"ok": False, "error": str(exc)})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", default="")
    parser.add_argument("--asr-model", required=True)
    parser.add_argument("--aligner-model", required=True)
    parser.add_argument("--llm-model", required=True)
    parser.add_argument("--hf-home", default="")
    args = parser.parse_args()

    print("[translate-worker] loading models", flush=True)
    engine = TranslationEngine(args.asr_model, args.aligner_model, args.llm_model)
    server = WorkerServer(("127.0.0.1", args.port), args.token, engine)
    print(
        f"[translate-worker] ready on 127.0.0.1:{args.port} "
        f"load={engine.load_seconds}s",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()