from __future__ import annotations

import asyncio
import json
import os
import shutil
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import audio
from .config import load_config
from .jobs import JobManager
from .store import Store, now_iso
from .supervisor import EngineSupervisor

CONFIG = load_config()
STORE = Store(CONFIG["_data_dir"])
SUPERVISOR = EngineSupervisor(CONFIG)
JOBS = JobManager(SUPERVISOR, STORE, CONFIG["_data_dir"])
APP_TOKEN = os.environ.get("INDEXTTS_TOKEN", "")
FFMPEG = audio.require_binary(CONFIG.get("ffmpeg"), "ffmpeg")
FFPROBE = audio.find_binary(CONFIG.get("ffprobe"), "ffprobe")
DATA_DIR = Path(CONFIG["_data_dir"])
VOICES_DIR = DATA_DIR / "voices"
OUTPUTS_DIR = DATA_DIR / "outputs"
VOICES_DIR.mkdir(parents=True, exist_ok=True)
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD = int(CONFIG.get("maxUploadMb", 50)) * 1024 * 1024


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    voiceId: str
    lang: str = "zh"
    durationFactor: float = Field(default=1.0, ge=0.5, le=2.0)
    emotion: dict[str, Any] = Field(default_factory=dict)
    advanced: dict[str, Any] = Field(default_factory=dict)


class PresetRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    payload: dict[str, Any]


class VoiceCopyRequest(BaseModel):
    name: str = Field(default="", max_length=80)
    kind: str = Field(pattern="^(voice|emotion)$")


def auth(request: Request) -> None:
    if not APP_TOKEN:
        return
    token = request.headers.get("X-App-Token") or request.query_params.get("token")
    if token != APP_TOKEN:
        raise HTTPException(status_code=401, detail="invalid app token")


def activate_default() -> None:
    try:
        SUPERVISOR.activate(CONFIG.get("defaultEngine", "mlx"))
        print(f"[backend] engine ready: {SUPERVISOR.active}", flush=True)
    except Exception as exc:
        SUPERVISOR.status = "failed"
        SUPERVISOR.error = str(exc)
        print(f"[backend] engine failed: {exc}", flush=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    STORE.mark_interrupted()
    threading.Thread(target=activate_default, daemon=True).start()
    yield
    SUPERVISOR.shutdown()


app = FastAPI(title="IndexTTS Studio", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
async def healthz() -> dict:
    return {
        "ok": True,
        "status": SUPERVISOR.status,
        "active": SUPERVISOR.active,
        "error": SUPERVISOR.error,
    }


@app.get("/api/engines", dependencies=[Depends(auth)])
async def engines() -> dict:
    return SUPERVISOR.capabilities()


@app.post("/api/engines/{engine_id}/activate", dependencies=[Depends(auth)])
async def activate_engine(engine_id: str) -> dict:
    if engine_id not in SUPERVISOR.engines:
        raise HTTPException(status_code=404, detail="unknown engine")
    try:
        return await run_in_threadpool(SUPERVISOR.activate, engine_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/voices", dependencies=[Depends(auth)])
async def list_voices(kind: str | None = Query(default=None)) -> list[dict]:
    if kind and kind not in {"voice", "emotion"}:
        raise HTTPException(status_code=400, detail="kind must be voice or emotion")
    result = []
    for voice in STORE.list_voices(kind):
        item = dict(voice)
        item["audioUrl"] = f"/api/voices/{voice['id']}/audio"
        result.append(item)
    return result


@app.post("/api/voices", dependencies=[Depends(auth)])
async def upload_voice(
    file: UploadFile = File(...),
    name: str = Form("我的音色"),
    consent: bool = Form(True),
    kind: str = Form("voice"),
) -> dict:
    if not consent:
        raise HTTPException(status_code=400, detail="需要确认拥有该声音的使用授权")
    if kind not in {"voice", "emotion"}:
        raise HTTPException(status_code=400, detail="kind must be voice or emotion")
    payload = await file.read()
    if len(payload) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="音频文件过大")
    if not payload:
        raise HTTPException(status_code=400, detail="音频文件为空")

    voice_id = uuid.uuid4().hex
    tmp_path = VOICES_DIR / f"{voice_id}.upload"
    out_path = VOICES_DIR / f"{voice_id}.wav"
    tmp_path.write_bytes(payload)
    try:
        await run_in_threadpool(audio.normalize_voice, tmp_path, out_path, FFMPEG, 15)
        info = await run_in_threadpool(audio.probe_audio, out_path, FFPROBE)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"音频处理失败: {exc}") from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    record = STORE.add_voice(
        {
            "id": voice_id,
            "name": name.strip() or "我的音色",
            "path": str(out_path),
            "duration": info["duration"],
            "sampleRate": info["sample_rate"],
            "channels": info["channels"],
            "consent": True,
            "kind": kind,
            "created_at": now_iso(),
        }
    )
    record["audioUrl"] = f"/api/voices/{voice_id}/audio"
    return record


@app.post("/api/voices/{voice_id}/copy", dependencies=[Depends(auth)])
async def copy_voice(voice_id: str, request: VoiceCopyRequest) -> dict:
    source = STORE.get_voice(voice_id)
    if not source:
        raise HTTPException(status_code=404, detail="voice not found")
    source_path = Path(source["path"])
    if not source_path.is_file():
        raise HTTPException(status_code=404, detail="voice file missing")

    new_id = uuid.uuid4().hex
    out_path = VOICES_DIR / f"{new_id}.wav"
    try:
        shutil.copyfile(source_path, out_path)
        info = await run_in_threadpool(audio.probe_audio, out_path, FFPROBE)
    except Exception as exc:
        out_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"复制音频失败: {exc}") from exc

    name = (request.name or "").strip() or source.get("name") or "参考音频"
    record = STORE.add_voice(
        {
            "id": new_id,
            "name": name,
            "path": str(out_path),
            "duration": info["duration"],
            "sampleRate": info["sample_rate"],
            "channels": info["channels"],
            "consent": True,
            "kind": request.kind,
            "created_at": now_iso(),
        }
    )
    record["audioUrl"] = f"/api/voices/{new_id}/audio"
    return record


@app.get("/api/voices/{voice_id}/audio", dependencies=[Depends(auth)])
async def voice_audio(voice_id: str) -> FileResponse:
    voice = STORE.get_voice(voice_id)
    if not voice:
        raise HTTPException(status_code=404, detail="voice not found")
    path = Path(voice["path"]).resolve()
    if not path.is_file():
        raise HTTPException(status_code=404, detail="voice file missing")
    return FileResponse(path, media_type="audio/wav", filename=f"{voice['name']}.wav")


@app.delete("/api/voices/{voice_id}", dependencies=[Depends(auth)])
async def delete_voice(voice_id: str) -> dict:
    voice = STORE.get_voice(voice_id)
    if voice:
        Path(voice["path"]).unlink(missing_ok=True)
    STORE.delete_voice(voice_id)
    return {"ok": True}


@app.get("/api/presets", dependencies=[Depends(auth)])
async def list_presets() -> list[dict]:
    return STORE.list_presets()


@app.post("/api/presets", dependencies=[Depends(auth)])
async def create_preset(request: PresetRequest) -> dict:
    return STORE.add_preset(
        {
            "id": uuid.uuid4().hex,
            "name": request.name,
            "payload": request.payload,
            "created_at": now_iso(),
        }
    )


@app.delete("/api/presets/{preset_id}", dependencies=[Depends(auth)])
async def delete_preset(preset_id: str) -> dict:
    STORE.delete_preset(preset_id)
    return {"ok": True}


@app.post("/api/tts", dependencies=[Depends(auth)])
async def create_tts(request: TTSRequest) -> dict:
    try:
        return JOBS.submit(
            text=request.text,
            voice_id=request.voiceId,
            lang=request.lang,
            duration_factor=request.durationFactor,
            emotion=request.emotion,
            advanced=request.advanced,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/jobs", dependencies=[Depends(auth)])
async def list_jobs() -> list[dict]:
    return STORE.list_jobs(50)


def remove_job_output(job: dict) -> None:
    output_path = job.get("output_path")
    if not output_path:
        return
    path = (OUTPUTS_DIR / Path(output_path).name).resolve()
    if OUTPUTS_DIR.resolve() in path.parents:
        path.unlink(missing_ok=True)


@app.get("/api/jobs/{job_id}", dependencies=[Depends(auth)])
async def get_job(job_id: str) -> dict:
    job = STORE.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job


@app.delete("/api/jobs/{job_id}", dependencies=[Depends(auth)])
async def delete_job(job_id: str) -> dict:
    job = STORE.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    if job.get("status") in {"queued", "running"}:
        raise HTTPException(status_code=409, detail="任务仍在进行中，暂时不能删除")
    STORE.delete_job(job_id)
    remove_job_output(job)
    return {"ok": True}


@app.delete("/api/jobs", dependencies=[Depends(auth)])
async def clear_jobs() -> dict:
    jobs = STORE.list_jobs(limit=10_000)
    if any(job.get("status") in {"queued", "running"} for job in jobs):
        raise HTTPException(status_code=409, detail="还有任务在进行中，暂时不能清空")
    STORE.clear_jobs()
    for job in jobs:
        remove_job_output(job)
    return {"ok": True, "count": len(jobs)}


@app.post("/api/jobs/{job_id}/cancel", dependencies=[Depends(auth)])
async def cancel_job(job_id: str) -> dict:
    job = JOBS.cancel(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job


@app.get("/api/jobs/{job_id}/events", dependencies=[Depends(auth)])
async def job_events(job_id: str) -> StreamingResponse:
    if not STORE.get_job(job_id):
        raise HTTPException(status_code=404, detail="job not found")

    async def stream():
        last = ""
        while True:
            job = STORE.get_job(job_id)
            if not job:
                yield "event: error\ndata: {\"error\":\"job not found\"}\n\n"
                break
            data = json.dumps(job, ensure_ascii=False)
            if data != last:
                yield f"event: state\ndata: {data}\n\n"
                last = data
            if job["status"] in {"succeeded", "failed", "canceled"}:
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/audio/{filename}", dependencies=[Depends(auth)])
async def output_audio(filename: str) -> FileResponse:
    path = (OUTPUTS_DIR / Path(filename).name).resolve()
    if OUTPUTS_DIR.resolve() not in path.parents:
        raise HTTPException(status_code=400, detail="invalid path")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="audio not found")
    return FileResponse(path, media_type="audio/wav", filename=path.name)


def run() -> None:
    import uvicorn

    uvicorn.run(
        "backend.app.main:app",
        host="127.0.0.1",
        port=int(os.environ.get("INDEXTTS_PORT", "8765")),
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    run()