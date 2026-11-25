from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path


def find_binary(path: str | None, fallback: str) -> str | None:
    if path and Path(path).exists():
        return path
    found = shutil.which(fallback)
    if found:
        return found
    if fallback == "ffmpeg":
        try:
            import imageio_ffmpeg

            return imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            pass
    return None


def require_binary(path: str | None, fallback: str) -> str:
    found = find_binary(path, fallback)
    if not found:
        raise RuntimeError(f"Required binary not found: {fallback}")
    return found


def normalize_voice(src: Path, dst: Path, ffmpeg: str, max_seconds: int = 15) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(src),
        "-ac",
        "1",
        "-ar",
        "22050",
        "-t",
        str(max_seconds),
        "-vn",
        str(dst),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr[-1200:]}")


def probe_audio(path: Path, ffprobe: str | None) -> dict:
    if not ffprobe:
        import soundfile as sf

        info = sf.info(str(path))
        return {
            "duration": round(info.frames / info.samplerate, 3),
            "sample_rate": int(info.samplerate),
            "channels": int(info.channels),
            "codec": info.subtype,
        }
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "stream=sample_rate,channels,codec_name",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {proc.stderr[-800:]}")
    payload = json.loads(proc.stdout or "{}")
    stream = (payload.get("streams") or [{}])[0]
    duration = float(payload.get("format", {}).get("duration") or 0)
    return {
        "duration": round(duration, 3),
        "sample_rate": int(stream.get("sample_rate") or 0),
        "channels": int(stream.get("channels") or 0),
        "codec": stream.get("codec_name"),
    }