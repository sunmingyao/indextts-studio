from __future__ import annotations

import audioop
import json
import math
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid
import wave
from pathlib import Path
from typing import Any

from .store import now_iso

ALIGN_LANGUAGES = {
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

CJK_LANGUAGES = {"chinese", "japanese", "cantonese"}
INTERJECTIONS = {
    "啊", "哦", "嗯", "唉", "喂", "呀", "哈", "嘿", "哇", "诶",
    "oh", "ah", "uh", "hey", "hi", "hmm", "yeah",
}
NOISE_TEXTS = {
    "music", "applause", "laughter", "silence", "音乐", "掌声", "笑声", "静音",
}


def normalize_language(value: object, fallback: str | None = None) -> str:
    if isinstance(value, list):
        value = value[0] if value else None
    return str(value or fallback or "unknown")


def normalize_source(text: str) -> str:
    return re.sub(r"[\s\W_]+", "", text.lower(), flags=re.UNICODE)


def collapse_repetition(text: str) -> str:
    collapsed = re.sub(r"(.{2,24})\1+", r"\1", text.strip())
    collapsed = re.sub(r"\b(\w+)(?:\s+\1\b)+", r"\1", collapsed, flags=re.IGNORECASE)
    collapsed = re.sub(
        r"\b([A-Za-z]+(?:\s+[A-Za-z]+){0,4})(?:\s+\1\b){2,}",
        r"\1",
        collapsed,
        flags=re.IGNORECASE,
    )
    return collapsed.strip()


def is_meaningful(text: str) -> bool:
    normalized = normalize_source(text)
    if not normalized:
        return False
    if normalized in INTERJECTIONS:
        return True
    if normalized in NOISE_TEXTS:
        return False
    if len(normalized) < 2:
        return False
    if len(set(normalized)) == 1:
        return False
    return True


def is_duplicate_cue(source: str, cues: list[dict], start: float) -> bool:
    normalized = normalize_source(source)
    if not normalized:
        return True
    for previous in reversed(cues[-4:]):
        previous_normalized = normalize_source(previous["source"])
        gap = start - float(previous["end"])
        if normalized == previous_normalized and gap <= 1.5:
            return True
        if (
            gap <= 1.0
            and len(normalized) <= 8
            and (
                normalized in previous_normalized
                or previous_normalized in normalized
            )
        ):
            return True
    return False


def srt_time(seconds: float) -> str:
    milliseconds = int(round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def vtt_time(seconds: float) -> str:
    return srt_time(seconds).replace(",", ".")


def split_cues(
    items: list[dict],
    *,
    joiner: str,
    max_duration: float = 7.0,
    max_chars: int = 90,
    min_duration: float = 0.8,
    merge_gap: float = 0.7,
) -> list[dict]:
    cues: list[dict] = []
    current: list[dict] = []

    def flush() -> None:
        if not current:
            return
        cues.append(
            {
                "start": round(float(current[0]["start"]), 3),
                "end": round(float(current[-1]["end"]), 3),
                "source": joiner.join(str(item["text"]) for item in current),
            }
        )
        current.clear()

    for item in items:
        candidate = current + [item]
        candidate_text = joiner.join(str(x["text"]) for x in candidate)
        candidate_duration = float(candidate[-1]["end"]) - float(candidate[0]["start"])
        if current and (
            candidate_duration > max_duration or len(candidate_text) > max_chars
        ):
            flush()
        current.append(item)
    flush()

    merged: list[dict] = []
    for cue in cues:
        short = (cue["end"] - cue["start"]) < min_duration or len(cue["source"]) <= 3
        if merged and short and cue["start"] - merged[-1]["end"] <= merge_gap:
            merged[-1]["end"] = cue["end"]
            merged[-1]["source"] = (
                merged[-1]["source"] + joiner + cue["source"]
            ).strip()
        else:
            merged.append(cue)
    return merged


def write_srt(path: Path, cues: list[dict]) -> None:
    blocks = []
    for index, cue in enumerate(cues, 1):
        blocks.append(
            f"{index}\n"
            f"{srt_time(cue['start'])} --> {srt_time(cue['end'])}\n"
            f"{wrap_subtitle(cue['translation'])}\n"
        )
    path.write_text("\n".join(blocks), encoding="utf-8")


def write_vtt(path: Path, cues: list[dict]) -> None:
    blocks = ["WEBVTT\n"]
    for cue in cues:
        blocks.append(
            f"{vtt_time(cue['start'])} --> {vtt_time(cue['end'])}\n"
            f"{wrap_subtitle(cue['translation'])}\n"
        )
    path.write_text("\n".join(blocks), encoding="utf-8")


CJK_CHAR = re.compile(
    r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]"
)
CLAUSE_BREAK = re.compile(r"[，。！？；：、,.!?;:]")
WRAP_BREAK = re.compile(r"[，。！？；：、,.!?;:]\s*|\s")


def visible_length(text: str) -> int:
    return len(re.sub(r"\s", "", text or ""))


def cps_limit(language: str) -> int:
    return 13 if language.lower() in CJK_LANGUAGES else 24


def wrap_subtitle(text: str) -> str:
    text = (text or "").strip()
    if not text:
        return text
    cjk_ratio = len(CJK_CHAR.findall(text)) / max(1, len(text))
    limit = 16 if cjk_ratio >= 0.3 else 42
    if len(text) <= limit:
        return text
    target = min(limit, (len(text) + 1) // 2)
    breaks = [match.end() for match in WRAP_BREAK.finditer(text[:limit])]
    minimum = max(1, len(text) - limit)
    candidates = [pos for pos in breaks if minimum <= pos <= limit]
    if candidates:
        split_at = min(candidates, key=lambda pos: abs(pos - target))
    else:
        split_at = target
    if split_at <= 0 or split_at >= len(text):
        split_at = target
    first, rest = text[:split_at].strip(), text[split_at:].strip()
    if not first or not rest:
        return text
    return f"{first}\n{rest}"


def _split_translation(text: str) -> tuple[str, str] | None:
    text = (text or "").strip()
    if not text:
        return None
    middle = len(text) / 2
    cuts = [
        match.end()
        for match in CLAUSE_BREAK.finditer(text[:-1])
    ]
    if not cuts:
        return None
    split_at = min(cuts, key=lambda pos: abs(pos - middle))
    left, right = text[:split_at].strip(), text[split_at:].strip()
    if visible_length(left) < 2 or visible_length(right) < 2:
        return None
    return left, right


def split_overlong_cue(cue: dict, language: str) -> list[dict]:
    duration = float(cue["end"]) - float(cue["start"])
    text = str(cue.get("translation") or "")
    if duration < 1.2 or not text:
        return [cue]
    is_cjk = language.lower() in CJK_LANGUAGES
    capacity = 32 if is_cjk else 84
    if (
        visible_length(text) <= capacity
        and visible_length(text) / duration <= cps_limit(language)
    ):
        return [cue]
    parts = _split_translation(text)
    if not parts:
        return [cue]
    left, right = parts
    share = visible_length(left) / max(1, visible_length(left) + visible_length(right))
    cut = float(cue["start"]) + duration * share
    cut = min(max(cut, float(cue["start"]) + 0.5), float(cue["end"]) - 0.5)
    first = dict(cue)
    second = dict(cue)
    first["end"] = round(cut, 3)
    first["translation"] = left
    second["start"] = round(cut, 3)
    second["translation"] = right
    return [first, second]


def adjust_timing(cues: list[dict], lead_in: float = 0.12, lag: float = 0.2) -> None:
    for index, cue in enumerate(cues):
        start = float(cue["start"])
        end = float(cue["end"])
        lower = 0.0 if index == 0 else float(cues[index - 1]["end"]) + 0.04
        start = max(lower, start - lead_in)
        end = end + lag
        if index + 1 < len(cues):
            upper = float(cues[index + 1]["start"]) - 0.04
            end = min(end, max(start + 0.5, upper))
        end = max(end, start + 0.5)
        cue["start"] = round(start, 3)
        cue["end"] = round(end, 3)


def polish_cues(cues: list[dict], language: str) -> list[dict]:
    polished: list[dict] = []
    for cue in cues:
        polished.extend(split_overlong_cue(dict(cue), language))
    adjust_timing(polished)
    return polished


FRAME_SECONDS = 0.02


def frame_levels(audio: Path) -> list[float]:
    levels: list[float] = []
    with wave.open(str(audio), "rb") as handle:
        rate = handle.getframerate()
        width = handle.getsampwidth()
        if rate != 16000:
            raise RuntimeError(f"断句需要 16kHz 单声道音频，实际为 {rate}Hz")
        frame_samples = max(1, int(rate * FRAME_SECONDS))
        while True:
            data = handle.readframes(frame_samples)
            if not data:
                break
            rms = audioop.rms(data, width)
            levels.append(20 * math.log10(max(rms, 1) / 32768.0))
    return levels


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return -90.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(len(ordered) * quantile)))
    return ordered[index]


def speech_regions(
    levels: list[float],
    threshold: float,
    min_silence: float,
) -> list[tuple[float, float]]:
    frames = len(levels)
    min_gap = max(1, int(round(min_silence / FRAME_SECONDS)))
    speech = [level >= threshold for level in levels]

    index = 0
    while index < frames:
        if speech[index]:
            index += 1
            continue
        end = index
        while end < frames and not speech[end]:
            end += 1
        if index > 0 and end < frames and end - index < min_gap:
            for fill in range(index, end):
                speech[fill] = True
        index = end

    regions: list[tuple[float, float]] = []
    index = 0
    while index < frames:
        if not speech[index]:
            index += 1
            continue
        end = index
        while end < frames and speech[end]:
            end += 1
        start_time = max(0.0, index * FRAME_SECONDS - 0.08)
        end_time = min(frames * FRAME_SECONDS, end * FRAME_SECONDS + 0.08)
        if end_time - start_time >= 0.35:
            regions.append((start_time, end_time))
        index = end
    return regions


def split_long_region(
    start: float,
    end: float,
    levels: list[float],
    max_chunk: float,
) -> list[tuple[float, float]]:
    chunks: list[tuple[float, float]] = []
    while end - start > max_chunk:
        target = start + max_chunk
        low = max(start + 2.0, target - 3.0)
        low_index = max(0, int(low / FRAME_SECONDS))
        high_index = min(len(levels), int(target / FRAME_SECONDS))
        cut: float | None = None
        if high_index - low_index >= 1:
            quietest = min(range(low_index, high_index), key=lambda i: levels[i])
            cut = (quietest + 1) * FRAME_SECONDS
        if cut is None or cut - start < 2.0:
            cut = target
        chunks.append((start, cut))
        start = cut
    if end - start >= 0.35:
        chunks.append((start, end))
    return chunks


class SubtitleManager:
    def __init__(
        self,
        translator: Any,
        data_dir: str,
        ffmpeg: str,
        ffprobe: str,
        max_upload_mb: int = 4096,
    ):
        self.translator = translator
        self.root = Path(data_dir) / "subtitles"
        self.root.mkdir(parents=True, exist_ok=True)
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.max_upload_bytes = max_upload_mb * 1024 * 1024
        self.jobs: dict[str, dict[str, Any]] = {}
        self.lock = threading.RLock()
        self.queue: queue.Queue[str] = queue.Queue()
        self.thread = threading.Thread(target=self._worker_loop, daemon=True)
        self.thread.start()

    def _public(self, job: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in job.items() if not key.startswith("_")}

    def create_job(
        self,
        *,
        filename: str,
        source: str,
        target: str,
        silence: float,
        batch_size: int,
    ) -> tuple[dict[str, Any], Path]:
        job_id = uuid.uuid4().hex
        job_dir = self.root / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        suffix = Path(filename).suffix.lower() or ".mp4"
        destination = job_dir / f"source{suffix}"
        job = {
            "id": job_id,
            "status": "uploading",
            "stage": "uploading",
            "step": 1,
            "progress": 0,
            "message": "正在上传视频",
            "video_name": Path(filename).name,
            "source": source,
            "target": target,
            "silence": silence,
            "batch_size": batch_size,
            "duration": None,
            "elapsed": None,
            "rtf": None,
            "cue_count": 0,
            "cues": [],
            "timings": {},
            "filtered": 0,
            "error": None,
            "created_at": now_iso(),
            "finished_at": None,
            "cancel_requested": False,
            "_dir": str(job_dir),
            "_source_path": str(destination),
        }
        with self.lock:
            self.jobs[job_id] = job
        return self._public(job), destination

    def enqueue(self, job_id: str) -> None:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return
            job.update(
                status="queued",
                stage="queued",
                step=1,
                progress=2,
                message="等待处理",
            )
        self.queue.put(job_id)

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self.lock:
            job = self.jobs.get(job_id)
            return self._public(job) if job else None

    def cancel(self, job_id: str) -> dict[str, Any] | None:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return None
            if job["status"] in {"queued", "uploading"}:
                job.update(
                    status="canceled",
                    stage="canceled",
                    message="已取消",
                    finished_at=now_iso(),
                )
            elif job["status"] == "running":
                job["cancel_requested"] = True
                job["message"] = "正在取消"
            return self._public(job)

    def has_active(self) -> bool:
        with self.lock:
            return any(
                job["status"] in {"uploading", "queued", "running"}
                for job in self.jobs.values()
            )

    def download_path(self, job_id: str, fmt: str) -> Path | None:
        with self.lock:
            job = self.jobs.get(job_id)
        if not job:
            return None
        suffix = "srt" if fmt == "srt" else "vtt"
        path = Path(job["_dir"]) / f"subtitle.{suffix}"
        return path if path.is_file() else None

    def _update(self, job_id: str, **fields: Any) -> None:
        with self.lock:
            job = self.jobs.get(job_id)
            if job:
                job.update(fields)

    def _canceled(self, job_id: str) -> bool:
        with self.lock:
            job = self.jobs.get(job_id)
            return bool(job and job.get("cancel_requested"))

    def _run_cmd(self, cmd: list[str], *, capture_stderr: bool = False) -> str:
        result = subprocess.run(
            cmd,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE if capture_stderr else subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return result.stderr if capture_stderr else result.stdout

    def _probe_duration(self, path: Path) -> float:
        output = self._run_cmd(
            [
                self.ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                str(path),
            ]
        )
        return float(output.strip())

    def _extract_audio(self, video: Path, audio: Path) -> None:
        self._run_cmd(
            [
                self.ffmpeg,
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(video),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                str(audio),
            ]
        )

    def _detect_intervals(
        self,
        audio: Path,
        min_silence: float,
        max_chunk: float = 20.0,
    ) -> list[tuple[float, float]]:
        levels = frame_levels(audio)
        if not levels:
            return []
        min_silence = max(0.15, min(float(min_silence), 5.0))
        # 旧片常有配乐铺底，阈值跟随底噪而不是固定 -35dB；
        # 用“比中位数低 12dB”封顶，避免密集对白被当成峰值切成碎片。
        bed = min(percentile(levels, 0.15), percentile(levels, 0.5) - 12.0)
        threshold = min(max(bed + 8.0, -70.0), -15.0)
        regions = speech_regions(levels, threshold, min_silence)

        chunks: list[tuple[float, float]] = []
        for start, end in regions:
            chunks.extend(split_long_region(start, end, levels, max_chunk))
        return chunks

    def _extract_chunk(self, audio: Path, start: float, end: float, output: Path) -> None:
        self._run_cmd(
            [
                self.ffmpeg,
                "-y",
                "-loglevel",
                "error",
                "-ss",
                f"{start:.3f}",
                "-to",
                f"{end:.3f}",
                "-i",
                str(audio),
                "-c:a",
                "pcm_s16le",
                str(output),
            ]
        )

    def _translate_cues(
        self,
        job_id: str,
        cues: list[dict],
        target: str,
        batch_size: int,
        progress_start: float,
        progress_span: float,
        timings: dict[str, float] | None = None,
    ) -> str:
        if not cues:
            return "unknown"
        source_language = str(cues[0].get("_language") or "English")
        for index, cue in enumerate(cues):
            cue.pop("_language", None)
        for batch_start in range(0, len(cues), batch_size):
            if self._canceled(job_id):
                raise RuntimeError("用户已取消")
            batch = cues[batch_start : batch_start + batch_size]
            context = [
                cue["source"] for cue in cues[max(0, batch_start - 2) : batch_start]
            ]
            result = self.translator.translate(
                [cue["source"] for cue in batch],
                source_language,
                target,
                context,
            )
            if timings is not None:
                timings["translate"] = timings.get("translate", 0.0) + float(
                    result.get("elapsed") or 0.0
                )
            translations = result.get("translations") or []
            refusals = result.get("refusals") or []
            for offset, cue in enumerate(batch):
                cue["translation"] = (
                    translations[offset] if offset < len(translations) else ""
                )
                cue["refusal"] = bool(
                    refusals[offset] if offset < len(refusals) else False
                )
                cue["translation_mode"] = result.get("mode", "unknown")
            done = min(batch_start + len(batch), len(cues))
            self._update(
                job_id,
                progress=round(progress_start + progress_span * done / len(cues), 1),
                message=f"正在翻译 {done}/{len(cues)} 条字幕",
                cues=cues,
                cue_count=len(cues),
            )
        return source_language

    def _run(self, job_id: str) -> None:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job or job["status"] == "canceled":
                return
            job.update(
                status="running",
                stage="extracting",
                step=2,
                progress=5,
                message="正在提取音频",
            )
            job_dir = Path(job["_dir"])
            source_path = Path(job["_source_path"])
            silence = float(job["silence"])
            target = job["target"]
            batch_size = int(job["batch_size"])

        started = time.perf_counter()
        timings = {
            "extract": 0.0,
            "asr": 0.0,
            "align": 0.0,
            "translate": 0.0,
            "export": 0.0,
        }
        filtered_count = 0
        audio = job_dir / "audio.wav"
        try:
            extract_started = time.perf_counter()
            self._extract_audio(source_path, audio)
            timings["extract"] = round(time.perf_counter() - extract_started, 3)
            duration = self._probe_duration(audio)
            intervals = self._detect_intervals(audio, silence)
            self._update(
                job_id,
                duration=round(duration, 3),
                stage="transcribing",
                step=3,
                progress=10,
                message=f"识别到 {len(intervals)} 个语音段",
            )

            cues: list[dict] = []
            last_text = ""
            for index, (start, end) in enumerate(intervals):
                if self._canceled(job_id):
                    raise RuntimeError("用户已取消")
                chunk = job_dir / f"chunk-{index:04d}.wav"
                self._extract_chunk(audio, start, end, chunk)
                context = (
                    "Previous subtitles for continuity only; do not repeat them: "
                    f"{last_text[-160:]}"
                    if last_text
                    else None
                )
                asr = self.translator.transcribe(chunk.as_posix(), None, context)
                timings["asr"] = timings.get("asr", 0.0) + float(
                    asr.get("elapsed") or 0.0
                )
                text = collapse_repetition(str(asr.get("text") or "").strip())
                if not text or not is_meaningful(text):
                    filtered_count += 1
                    chunk.unlink(missing_ok=True)
                    continue
                language = normalize_language(asr.get("language"), "English")
                joiner = "" if language.lower() in CJK_LANGUAGES else " "
                last_text = text
                words: list[dict] = []
                timestamps = "vad"
                if language.lower() in ALIGN_LANGUAGES:
                    aligned = self.translator.align(chunk.as_posix(), text, language)
                    timings["align"] = timings.get("align", 0.0) + float(
                        aligned.get("elapsed") or 0.0
                    )
                    for item in aligned.get("items") or []:
                        words.append(
                            {
                                "text": item["text"],
                                "start": float(item["start"]) + start,
                                "end": float(item["end"]) + start,
                            }
                        )
                    timestamps = "aligner"
                if words:
                    chunk_cues = split_cues(
                        words,
                        joiner=joiner,
                        max_chars=32 if language.lower() in CJK_LANGUAGES else 84,
                    )
                else:
                    chunk_cues = [{"start": start, "end": end, "source": text}]
                for cue in chunk_cues:
                    if not is_meaningful(cue["source"]) or is_duplicate_cue(
                        cue["source"], cues, float(cue["start"])
                    ):
                        filtered_count += 1
                        continue
                    cue["_language"] = language
                    cue["timestamps"] = timestamps
                    cues.append(cue)
                chunk.unlink(missing_ok=True)
                self._update(
                    job_id,
                    progress=round(10 + 50 * (index + 1) / max(len(intervals), 1), 1),
                    message=f"识别与对齐 {index + 1}/{len(intervals)} 段",
                    cues=cues,
                    cue_count=len(cues),
                    filtered=filtered_count,
                )

            if self._canceled(job_id):
                raise RuntimeError("用户已取消")
            self._update(
                job_id,
                stage="translating",
                step=4,
                progress=65,
                message=f"正在翻译 {len(cues)} 条字幕",
            )
            source_language = self._translate_cues(
                job_id, cues, target, batch_size, 65.0, 25.0, timings
            )
            cues = polish_cues(cues, source_language)
            self._update(job_id, cues=cues, cue_count=len(cues))

            if self._canceled(job_id):
                raise RuntimeError("用户已取消")
            self._update(
                job_id,
                stage="exporting",
                step=5,
                progress=95,
                message="正在生成字幕文件",
            )
            export_started = time.perf_counter()
            write_srt(job_dir / "subtitle.srt", cues)
            write_vtt(job_dir / "subtitle.vtt", cues)
            timings["export"] = round(time.perf_counter() - export_started, 3)
            elapsed = round(time.perf_counter() - started, 3)
            timings["total"] = elapsed
            timings["overhead"] = round(
                max(
                    0.0,
                    elapsed
                    - timings["extract"]
                    - timings["asr"]
                    - timings["align"]
                    - timings["translate"]
                    - timings["export"],
                ),
                3,
            )
            rtf = round(elapsed / duration, 4) if duration else None
            payload = {
                "video": str(source_path),
                "duration": duration,
                "intervals": intervals,
                "cues": cues,
                "elapsed": elapsed,
                "rtf": rtf,
                "timings": timings,
                "filtered": filtered_count,
            }
            (job_dir / "segments.json").write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            audio.unlink(missing_ok=True)
            try:
                source_path.unlink(missing_ok=True)
            except OSError:
                pass
            self._update(
                job_id,
                status="succeeded",
                stage="succeeded",
                step=5,
                progress=100,
                message="字幕生成完成",
                elapsed=elapsed,
                rtf=rtf,
                cues=cues,
                cue_count=len(cues),
                timings=timings,
                filtered=filtered_count,
                finished_at=now_iso(),
            )
        except Exception as exc:
            canceled = self._canceled(job_id)
            self._update(
                job_id,
                status="canceled" if canceled else "failed",
                stage="canceled" if canceled else "failed",
                message="已取消" if canceled else "字幕生成失败",
                error=None if canceled else str(exc),
                finished_at=now_iso(),
            )
            audio.unlink(missing_ok=True)
            for chunk in job_dir.glob("chunk-*.wav"):
                chunk.unlink(missing_ok=True)

    def _worker_loop(self) -> None:
        while True:
            job_id = self.queue.get()
            try:
                self._run(job_id)
            finally:
                self.queue.task_done()

    def interpret(self, audio_path: Path, target: str) -> dict[str, Any]:
        started = time.perf_counter()
        asr = self.translator.transcribe(audio_path.as_posix(), None)
        source = str(asr.get("text") or "").strip()
        language = normalize_language(asr.get("language"), "English")
        translation = ""
        if source:
            result = self.translator.translate([source], language, target, [])
            translations = result.get("translations") or []
            translation = translations[0] if translations else ""
        return {
            "source": source,
            "translation": translation,
            "language": language,
            "elapsed": round(time.perf_counter() - started, 3),
        }