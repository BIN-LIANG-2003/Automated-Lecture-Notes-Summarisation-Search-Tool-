import modal


APP_NAME = "studyhub-summary-service"
MODEL_VOLUME_NAME = "studyhub-summary-models"
MODEL_MOUNT_PATH = "/models"
SECRET_NAME = "studyhub-summary-service"

app = modal.App(APP_NAME)
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install_from_requirements("summary_service/requirements.txt")
    .add_local_python_source("summary_service")
)


@app.function(
    image=image,
    gpu="T4",
    timeout=900,
    volumes={MODEL_MOUNT_PATH: model_volume},
    secrets=[modal.Secret.from_name(SECRET_NAME)],
)
@modal.asgi_app(label="summary")
def summary():
    import os

    os.environ.setdefault("SUMMARY_ADAPTER_DIR", "/models/flan_t5_large_lora_adapter_stable_final")
    os.environ.setdefault("HF_CACHE_DIR", "/models/hf-cache")
    os.environ.setdefault("SUMMARY_BASE_MODEL_ID", "google/flan-t5-large")

    from summary_service.app import create_app

    return create_app()
