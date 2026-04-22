import modal


MODEL_VOLUME_NAME = "studyhub-ocr-models"
MODEL_MOUNT_PATH = "/models"
OCR_REC_MODEL_VERSION = "ppocrv5_mobile_rec_infer_v2"
REC_MODEL_DIR = f"{MODEL_MOUNT_PATH}/{OCR_REC_MODEL_VERSION}"
SECRET_NAME = "studyhub-ocr-service"

app = modal.App("studyhub-ocr-service")
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install(
        "paddlepaddle-gpu==3.2.0",
        index_url="https://www.paddlepaddle.org.cn/packages/stable/cu126/",
    )
    .pip_install_from_requirements("ocr_service/requirements.txt")
    .add_local_python_source("ocr_service")
)


@app.function(
    image=image,
    gpu="T4",
    timeout=300,
    volumes={MODEL_MOUNT_PATH: model_volume},
    secrets=[modal.Secret.from_name(SECRET_NAME)],
)
@modal.asgi_app(label="ocr")
def ocr():
    import os

    os.environ["OCR_REC_MODEL_DIR"] = REC_MODEL_DIR
    os.environ["OCR_REC_MODEL_VERSION"] = OCR_REC_MODEL_VERSION
    os.environ.setdefault("OCR_REC_MODEL_NAME", "PP-OCRv5_mobile_rec")
    os.environ.setdefault("OCR_DET_MODEL_NAME", "PP-OCRv5_mobile_det")
    os.environ.setdefault("OCR_DEVICE", "gpu:0")

    from ocr_service.app import app as fastapi_app

    return fastapi_app
