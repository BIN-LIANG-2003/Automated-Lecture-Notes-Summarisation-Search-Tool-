import os
import re
import threading
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool


PROMPT = (
    "Summarise these lecture notes for student revision. Focus on key concepts, "
    "definitions, causes, effects, and exam-relevant points:\n\n"
)
SERVICE_NAME = "studyhub-summary-service"
SUMMARY_SOURCE = "custom_flan_t5_large"
SUMMARY_MODEL_LABEL = "google/flan-t5-large+lora"

LENGTH_PRESETS = {
    "short": {"max_new_tokens": 90, "min_new_tokens": 35},
    "medium": {"max_new_tokens": 140, "min_new_tokens": 50},
    "long": {"max_new_tokens": 220, "min_new_tokens": 80},
}

_model_lock = threading.Lock()
_model_state: dict[str, Any] = {
    "tokenizer": None,
    "model": None,
    "device": "cpu",
    "loaded": False,
}


class SummaryRequest(BaseModel):
    text: str
    summary_length: str | None = None


def _env(name: str, default: str = "") -> str:
    return str(os.environ.get(name) or default).strip()


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(_env(name, str(default))))
    except Exception:
        return default


def _env_flag(name: str, default: bool = False) -> bool:
    raw_value = _env(name, "1" if default else "0").lower()
    return raw_value in {"1", "true", "yes", "on"}


def _is_explicit_development() -> bool:
    return any(
        _env(name).lower() == "development"
        for name in ("APP_ENV", "FLASK_ENV", "ENV")
    )


def _clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _summary_length(value: str | None) -> str:
    requested = str(value or _env("SUMMARY_DEFAULT_LENGTH", "medium")).strip().lower()
    return requested if requested in LENGTH_PRESETS else "medium"


def _split_chunks_with_metadata(text: str) -> tuple[list[str], dict[str, Any]]:
    words = _clean_text(text).split()
    if not words:
        return [], {
            "input_word_count": 0,
            "processed_word_count": 0,
            "truncated": False,
            "chunk_count": 0,
        }

    chunk_words = _env_int("SUMMARY_CHUNK_WORDS", 350, minimum=80)
    overlap = min(_env_int("SUMMARY_CHUNK_OVERLAP", 50, minimum=0), max(0, chunk_words - 1))
    max_chunks = _env_int("SUMMARY_MAX_CHUNKS", 8, minimum=1)
    step = max(1, chunk_words - overlap)

    chunks = []
    start = 0
    processed_word_count = 0
    while start < len(words) and len(chunks) < max_chunks:
        end = min(start + chunk_words, len(words))
        chunk = " ".join(words[start:end]).strip()
        if chunk:
            chunks.append(chunk)
            processed_word_count = max(processed_word_count, end)
        if end >= len(words):
            break
        start += step
    metadata = {
        "input_word_count": len(words),
        "processed_word_count": processed_word_count,
        "truncated": processed_word_count < len(words),
        "chunk_count": len(chunks),
    }
    return chunks, metadata


def _split_chunks(text: str) -> list[str]:
    return _split_chunks_with_metadata(text)[0]


def _auth_dependency(authorization: str | None = Header(default=None)):
    token = _env("SUMMARY_SERVICE_AUTH_TOKEN")
    if not token:
        if _is_explicit_development() and _env_flag("ALLOW_UNAUTHENTICATED_SUMMARY_SERVICE", False):
            return
        raise HTTPException(
            status_code=503,
            detail="SUMMARY_SERVICE_AUTH_TOKEN is required for /summarize",
        )
    if token.lower() == "replace-me":
        raise HTTPException(
            status_code=503,
            detail="SUMMARY_SERVICE_AUTH_TOKEN must be set to a non-placeholder value",
        )
    auth_header = str(authorization or "").strip()
    scheme, _, credential = auth_header.partition(" ")
    if scheme.lower() != "bearer" or credential.strip() != token:
        raise HTTPException(
            status_code=401,
            detail="Unauthorized",
            headers={"WWW-Authenticate": "Bearer"},
        )


def _load_model_once():
    with _model_lock:
        if _model_state.get("loaded"):
            return

        import torch
        from peft import PeftModel
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

        base_model_id = _env("SUMMARY_BASE_MODEL_ID", "google/flan-t5-large")
        adapter_dir = _env("SUMMARY_ADAPTER_DIR", "/models/flan_t5_large_lora_adapter_stable_final")
        hf_token = _env("HF_TOKEN")
        cache_dir = _env("HF_CACHE_DIR")
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)

        model_kwargs: dict[str, Any] = {}
        if hf_token:
            model_kwargs["token"] = hf_token
        if cache_dir:
            model_kwargs["cache_dir"] = cache_dir

        cuda_available = torch.cuda.is_available()
        dtype = torch.float16 if cuda_available else torch.float32
        device = "cuda" if cuda_available else "cpu"

        tokenizer = AutoTokenizer.from_pretrained(base_model_id, **model_kwargs)
        base_model = AutoModelForSeq2SeqLM.from_pretrained(
            base_model_id,
            torch_dtype=dtype,
            **model_kwargs,
        )
        model = PeftModel.from_pretrained(base_model, adapter_dir, is_trainable=False)
        model.to(device)
        model.eval()

        _model_state.update(
            {
                "tokenizer": tokenizer,
                "model": model,
                "device": device,
                "loaded": True,
            }
        )


def _generate_one(text: str, summary_length: str) -> str:
    _load_model_once()

    import torch

    tokenizer = _model_state["tokenizer"]
    model = _model_state["model"]
    device = _model_state["device"]
    preset = LENGTH_PRESETS[summary_length]
    max_input_tokens = _env_int("SUMMARY_MAX_INPUT_TOKENS", 512, minimum=64)

    inputs = tokenizer(
        PROMPT + text,
        return_tensors="pt",
        truncation=True,
        max_length=max_input_tokens,
    )
    inputs = {key: value.to(device) for key, value in inputs.items()}

    with torch.inference_mode():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=preset["max_new_tokens"],
            min_new_tokens=preset["min_new_tokens"],
            num_beams=4,
            length_penalty=1.0,
            no_repeat_ngram_size=3,
            early_stopping=True,
        )
    return tokenizer.decode(output_ids[0], skip_special_tokens=True).strip()


def _summarize_sync(text: str, summary_length: str) -> dict[str, Any]:
    cleaned = _clean_text(text)
    if not cleaned:
        raise HTTPException(status_code=400, detail="Text is required")

    chunks, chunk_metadata = _split_chunks_with_metadata(cleaned)
    if not chunks:
        raise HTTPException(status_code=400, detail="Text is required")

    partial_summaries = [_generate_one(chunk, summary_length) for chunk in chunks]
    partial_summaries = [summary for summary in partial_summaries if summary]
    if not partial_summaries:
        raise HTTPException(status_code=502, detail="Summary model returned empty output")

    if len(partial_summaries) > 1:
        final_summary = _generate_one("\n\n".join(partial_summaries), summary_length)
    else:
        final_summary = partial_summaries[0]

    if not final_summary:
        raise HTTPException(status_code=502, detail="Summary model returned empty output")

    return {
        "summary": final_summary,
        "summary_source": SUMMARY_SOURCE,
        "summary_model": SUMMARY_MODEL_LABEL,
        "summary_length": summary_length,
        "chunk_count": chunk_metadata["chunk_count"],
        "input_word_count": chunk_metadata["input_word_count"],
        "processed_word_count": chunk_metadata["processed_word_count"],
        "truncated": chunk_metadata["truncated"],
    }


def create_app() -> FastAPI:
    app = FastAPI(title=SERVICE_NAME)

    @app.on_event("startup")
    async def startup_load_model():
        await run_in_threadpool(_load_model_once)

    @app.get("/health")
    async def health():
        try:
            import torch

            cuda_available = torch.cuda.is_available()
        except Exception:
            cuda_available = False
        return {
            "ok": bool(_model_state.get("loaded")),
            "service": SERVICE_NAME,
            "base_model": _env("SUMMARY_BASE_MODEL_ID", "google/flan-t5-large"),
            "adapter_dir": _env("SUMMARY_ADAPTER_DIR", "/models/flan_t5_large_lora_adapter_stable_final"),
            "cuda_available": cuda_available,
            "model_loaded": bool(_model_state.get("loaded")),
        }

    @app.post("/summarize", dependencies=[Depends(_auth_dependency)])
    async def summarize(payload: SummaryRequest):
        summary_length = _summary_length(payload.summary_length)
        return await run_in_threadpool(_summarize_sync, payload.text, summary_length)

    return app


app = create_app()
