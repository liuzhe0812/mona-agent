from __future__ import annotations

import asyncio
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from funasr import AutoModel

TEMPORARY_ROOT = Path("/data/temporary")
MAX_UPLOAD_BYTES = int(os.getenv("ASR_MAX_UPLOAD_BYTES", str(100 * 1024 * 1024)))
IDLE_SECONDS = int(os.getenv("ASR_IDLE_SECONDS", "600"))
DEVICE = os.getenv("ASR_DEVICE", "cuda:0")


class AsrRuntime:
    def __init__(self) -> None:
        self.model: Any | None = None
        self.lock = asyncio.Lock()
        self.last_used_at = 0.0

    def load(self) -> Any:
        if self.model is None:
            self.model = AutoModel(
                model="iic/SenseVoiceSmall",
                vad_model="fsmn-vad",
                punc_model="ct-punc",
                spk_model="cam++",
                device=DEVICE,
            )
        return self.model

    def unload_if_idle(self) -> None:
        if self.model is None or time.monotonic() - self.last_used_at < IDLE_SECONDS:
            return
        self.model = None
        if DEVICE.startswith("cuda"):
            torch.cuda.empty_cache()


runtime = AsrRuntime()


async def _release_idle_model() -> None:
    while True:
        await asyncio.sleep(60)
        runtime.unload_if_idle()


@asynccontextmanager
async def lifespan(_: FastAPI):
    TEMPORARY_ROOT.mkdir(parents=True, exist_ok=True)
    idle_task = asyncio.create_task(_release_idle_model())
    try:
        yield
    finally:
        idle_task.cancel()
        await asyncio.gather(idle_task, return_exceptions=True)
        runtime.model = None
        if DEVICE.startswith("cuda"):
            torch.cuda.empty_cache()


app = FastAPI(title="Mona ASR", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/ready")
async def ready() -> dict[str, bool | str]:
    if DEVICE.startswith("cuda") and not torch.cuda.is_available():
        return {"ready": False, "reason": "cuda_unavailable"}
    return {"ready": True}


async def _save_upload(upload: UploadFile) -> Path:
    suffix = Path(upload.filename or "audio").suffix.lower()
    target = TEMPORARY_ROOT / f"{uuid.uuid4().hex}{suffix}"
    written = 0
    try:
        with target.open("xb") as output:
            while chunk := await upload.read(1024 * 1024):
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="audio_too_large")
                output.write(chunk)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return target


def _extract_result(raw: Any, mode: str) -> dict[str, Any]:
    item = raw[0] if isinstance(raw, list) and raw else {}
    sentences = item.get("sentence_info") if isinstance(item, dict) else None
    segments: list[dict[str, Any]] = []
    for sentence in sentences or []:
        speaker = sentence.get("spk")
        segment: dict[str, Any] = {
            "start_ms": sentence.get("start"),
            "end_ms": sentence.get("end"),
            "text": sentence.get("text", ""),
        }
        if mode == "meeting_diarize" and speaker is not None:
            segment["speaker"] = f"speaker_{int(speaker) + 1}"
        segments.append(segment)
    return {
        "text": item.get("text", "") if isinstance(item, dict) else "",
        "segments": segments,
    }


@app.post("/v1/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    mode: str = Form("quick_asr"),
    language: str = Form("auto"),
) -> dict[str, Any]:
    if mode not in {"quick_asr", "meeting_diarize"}:
        raise HTTPException(status_code=422, detail="invalid_mode")
    source = await _save_upload(file)
    try:
        async with runtime.lock:
            model = await asyncio.to_thread(runtime.load)
            raw = await asyncio.to_thread(
                model.generate,
                input=str(source),
                cache={},
                language=language,
                use_itn=True,
                batch_size_s=300,
            )
            runtime.last_used_at = time.monotonic()
        return {"mode": mode, "language": language, **_extract_result(raw, mode)}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail="transcription_failed") from exc
    finally:
        source.unlink(missing_ok=True)
        await file.close()

