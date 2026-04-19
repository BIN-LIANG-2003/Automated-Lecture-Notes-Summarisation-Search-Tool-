# Modal Summary Service Deployment

This service runs the fine-tuned FLAN-T5-large LoRA summarisation model as a separate Modal FastAPI app. The Render backend calls it through `EXTERNAL_SUMMARY_SERVICE_URL` before falling back to the existing Hugging Face BART and TextRank workflow.

## Modal Resources

Required Modal Volume:

```bash
studyhub-summary-models
```

Expected adapter directory inside the Volume:

```text
/flan_t5_large_lora_adapter_stable_final
```

Runtime path inside the container:

```text
/models/flan_t5_large_lora_adapter_stable_final
```

Required Modal Secret:

```bash
studyhub-summary-service
```

Required secret key:

```bash
SUMMARY_SERVICE_AUTH_TOKEN
```

Optional secret key:

```bash
HF_TOKEN
```

## Local Commands

Install and configure Modal:

```bash
python -m pip install -U modal
python -m modal setup
```

Create the model Volume and upload the LoRA adapter:

```bash
python -m modal volume create studyhub-summary-models
python -m modal volume put studyhub-summary-models /path/to/flan_t5_large_lora_adapter_stable_final /flan_t5_large_lora_adapter_stable_final
```

Create a service token and store it as a Modal Secret:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
python -m modal secret create studyhub-summary-service SUMMARY_SERVICE_AUTH_TOKEN=<token>
```

Serve locally through Modal:

```bash
python -m modal serve summary_service/modal_app.py
```

Deploy:

```bash
python -m modal deploy summary_service/modal_app.py
```

## Render Environment Variables

```bash
EXTERNAL_SUMMARY_SERVICE_URL=https://<modal-url>/summarize
EXTERNAL_SUMMARY_AUTH_TOKEN=<same token>
EXTERNAL_SUMMARY_TIMEOUT_SECONDS=120
SUMMARY_CONFIG_VERSION=flan-t5-large-modal-v1
```

The existing BART/TextRank summarisation remains available as fallback when the Modal service is not configured or fails.
