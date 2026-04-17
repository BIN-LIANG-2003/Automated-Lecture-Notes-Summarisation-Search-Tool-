import io
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool


OCR_SOURCE = "custom_ppocrv5"
DEFAULT_DET_MODEL_NAME = "PP-OCRv5_mobile_det"
DEFAULT_REC_MODEL_NAME = "PP-OCRv5_mobile_rec"

app = FastAPI(title="StudyHub OCR Service")

_ocr_instance = None
_ocr_lock = threading.Lock()


def _env(name: str, default: str = "") -> str:
    return str(os.environ.get(name) or default).strip()


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except Exception:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except Exception:
        return default


def _safe_filename(value: Optional[str], fallback: str = "image") -> str:
    cleaned = str(value or fallback).replace("\x00", "").replace("\\", "/").strip()
    return Path(cleaned).name or fallback


@app.middleware("http")
async def require_bearer_token(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)

    token = _env("OCR_SERVICE_AUTH_TOKEN")
    if not token:
        return await call_next(request)

    auth_header = str(request.headers.get("authorization") or "").strip()
    scheme, _, credential = auth_header.partition(" ")
    if scheme.lower() != "bearer" or credential.strip() != token:
        return JSONResponse(
            {"detail": "Unauthorized"},
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )

    return await call_next(request)


@app.get("/health")
async def health():
    rec_model_dir = _env("OCR_REC_MODEL_DIR")
    rec_model_path = Path(rec_model_dir) if rec_model_dir else None
    rec_model_ready = bool(rec_model_path and rec_model_path.exists())
    return JSONResponse({"ok": rec_model_ready}, status_code=200 if rec_model_ready else 503)


@app.post("/ocr")
async def ocr(request: Request):
    image_bytes, filename = await _read_ocr_payload(request)
    text = await run_in_threadpool(_run_ocr, image_bytes, filename)
    return {
        "text": text,
        "source": OCR_SOURCE,
        "filename": filename,
    }


async def _read_ocr_payload(request: Request) -> tuple[bytes, str]:
    content_type = str(request.headers.get("content-type") or "").lower()
    if "multipart/form-data" in content_type:
        form = await request.form()
        for field_name in ("file", "image"):
            item = form.get(field_name)
            if item is None:
                continue
            read = getattr(item, "read", None)
            if not callable(read):
                continue
            payload = await read()
            filename = _safe_filename(getattr(item, "filename", None), fallback=f"{field_name}.png")
            if not payload:
                raise HTTPException(status_code=400, detail="Empty image payload")
            return payload, filename
        raise HTTPException(status_code=400, detail="Expected multipart field 'file' or 'image'")

    payload = await request.body()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty image payload")
    filename = _safe_filename(request.headers.get("x-source-filename"), fallback="image")
    return payload, filename


def _build_ocr():
    from paddleocr import PaddleOCR

    rec_model_dir = _env("OCR_REC_MODEL_DIR")
    if not rec_model_dir:
        raise RuntimeError("OCR_REC_MODEL_DIR must point to the exported recognition model directory")
    if not Path(rec_model_dir).exists():
        raise RuntimeError(f"OCR_REC_MODEL_DIR does not exist: {rec_model_dir}")

    kwargs: dict[str, Any] = {
        "text_detection_model_name": _env("OCR_DET_MODEL_NAME", DEFAULT_DET_MODEL_NAME),
        "text_recognition_model_name": _env("OCR_REC_MODEL_NAME", DEFAULT_REC_MODEL_NAME),
        "text_recognition_model_dir": rec_model_dir,
        "text_recognition_batch_size": _env_int("OCR_RECOGNITION_BATCH_SIZE", 1),
        "text_rec_score_thresh": _env_float("OCR_TEXT_SCORE_THRESH", 0.0),
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": True,
    }

    det_model_dir = _env("OCR_DET_MODEL_DIR")
    if det_model_dir:
        kwargs["text_detection_model_dir"] = det_model_dir

    device = _env("OCR_DEVICE")
    if device:
        kwargs["device"] = device

    return PaddleOCR(**kwargs)


def _get_ocr():
    global _ocr_instance
    with _ocr_lock:
        if _ocr_instance is None:
            _ocr_instance = _build_ocr()
        return _ocr_instance


def _run_ocr(image_bytes: bytes, filename: str) -> str:
    image_path = _prepare_image_file(image_bytes, filename)
    try:
        ocr_engine = _get_ocr()
        with _ocr_lock:
            if hasattr(ocr_engine, "predict"):
                result = ocr_engine.predict(image_path)
            else:
                result = ocr_engine.ocr(image_path)
        return _join_ocr_text(result)
    finally:
        try:
            os.unlink(image_path)
        except OSError:
            pass


def _prepare_image_file(image_bytes: bytes, filename: str) -> str:
    composited_image = None
    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            image.load()
            if (image.format or "").upper() == "PNG" and _has_transparency(image):
                composited_image = _composite_on_white(image)
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=400, detail="Payload is not a readable image") from exc

    if composited_image is not None:
        tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        tmp.close()
        composited_image.save(tmp.name, format="PNG")
        return tmp.name

    suffix = Path(filename).suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}:
        suffix = ".png"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(image_bytes)
        return tmp.name


def _has_transparency(image: Image.Image) -> bool:
    return image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)


def _composite_on_white(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    background.alpha_composite(rgba)
    return background.convert("RGB")


def _join_ocr_text(result: Any) -> str:
    lines = []
    for text in _extract_texts(result):
        normalized = " ".join(str(text or "").split())
        if normalized:
            lines.append(normalized)
    return "\n".join(lines).strip()


def _extract_texts(value: Any) -> list[str]:
    if value is None:
        return []

    if isinstance(value, str):
        return [value]

    if isinstance(value, dict):
        texts: list[str] = []
        if "res" in value:
            texts.extend(_extract_texts(value.get("res")))
        for key in ("rec_texts", "rec_text", "text", "ocr_text", "transcription"):
            if key in value:
                texts.extend(_extract_texts(value.get(key)))
        if texts:
            return texts
        for key, child in value.items():
            if key not in {"input_path", "page_index", "model_settings", "rec_scores"}:
                texts.extend(_extract_texts(child))
        return texts

    if isinstance(value, (list, tuple)):
        if len(value) >= 2 and isinstance(value[1], (list, tuple)) and value[1] and isinstance(value[1][0], str):
            return [value[1][0]]
        texts: list[str] = []
        for child in value:
            texts.extend(_extract_texts(child))
        return texts

    for attr_name in ("json", "res"):
        attr_value = getattr(value, attr_name, None)
        if callable(attr_value):
            try:
                attr_value = attr_value()
            except Exception:
                attr_value = None
        if attr_value is not None and attr_value is not value:
            extracted = _extract_texts(attr_value)
            if extracted:
                return extracted

    for method_name in ("to_dict", "dict"):
        method = getattr(value, method_name, None)
        if callable(method):
            try:
                extracted = _extract_texts(method())
            except Exception:
                extracted = []
            if extracted:
                return extracted

    return []


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("ocr_service.app:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
