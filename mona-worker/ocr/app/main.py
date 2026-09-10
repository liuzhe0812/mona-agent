from __future__ import annotations

import asyncio
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

os.environ.setdefault("PADDLE_PDX_CACHE_HOME", "/models/paddlex")
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "BOS")

from fastapi import FastAPI, File, HTTPException, UploadFile
from paddleocr import PaddleOCR

TEMPORARY_ROOT = Path("/data/temporary")
MAX_UPLOAD_BYTES = int(os.getenv("OCR_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
IDLE_SECONDS = int(os.getenv("OCR_IDLE_SECONDS", "600"))


class OcrRuntime:
    def __init__(self) -> None:
        self.model: Any | None = None
        self.lock = asyncio.Lock()
        self.last_used_at = 0.0

    def load(self) -> Any:
        if self.model is None:
            self.model = PaddleOCR(
                ocr_version="PP-OCRv5",
                text_detection_model_name="PP-OCRv5_mobile_det",
                text_recognition_model_name="PP-OCRv5_mobile_rec",
                device="cpu",
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                engine="paddle",
                enable_mkldnn=False,
                cpu_threads=4,
            )
        return self.model

    def unload_if_idle(self) -> None:
        if self.model is None or time.monotonic() - self.last_used_at < IDLE_SECONDS:
            return
        self.model = None


runtime = OcrRuntime()


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


app = FastAPI(title="Mona OCR", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/ready")
async def ready() -> dict[str, bool]:
    return {"ready": True}


async def _save_upload(upload: UploadFile) -> Path:
    suffix = Path(upload.filename or "image").suffix.lower()
    target = TEMPORARY_ROOT / f"{uuid.uuid4().hex}{suffix}"
    written = 0
    try:
        with target.open("xb") as output:
            while chunk := await upload.read(1024 * 1024):
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="image_too_large")
                output.write(chunk)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return target


def _extract_result(raw: Any) -> dict[str, Any]:
    payload = raw.json
    result = payload["res"]
    texts = result.get("rec_texts", [])
    scores = result.get("rec_scores", [])
    boxes = result.get("rec_boxes", [])
    lines = [
        {"text": text, "score": float(score), "box": box}
        for text, score, box in zip(texts, scores, boxes, strict=True)
        if text
    ]
    return {"text": "\n".join(line["text"] for line in lines), "lines": lines}

@app.post("/v1/ocr")
async def ocr(file: UploadFile = File(...)) -> dict[str, Any]:
    source = await _save_upload(file)
    try:
        async with runtime.lock:
            model = await asyncio.to_thread(runtime.load)
            raw = (await asyncio.to_thread(lambda: list(model.predict(str(source)))))[0]
            runtime.last_used_at = time.monotonic()
        return _extract_result(raw)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail="ocr_failed") from exc
    finally:
        source.unlink(missing_ok=True)
        await file.close()







