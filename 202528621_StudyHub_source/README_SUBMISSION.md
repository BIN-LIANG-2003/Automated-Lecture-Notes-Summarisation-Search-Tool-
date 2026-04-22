# StudyHub Source Code Submission

Student Number: 202528621
Project: Automated Lecture Notes Summarisation & Search Tool
Repository commit SHA: b2cc303ba507

## Included

- React/Vite frontend source in `src/`, `public/`, `index.html`, `vite.config.js`, `package.json`, and `package-lock.json`
- Flask backend source in `backend/` and the root `app.py`
- OCR service source in `ocr_service/`
- Summarisation service source in `summary_service/`
- Python and Node dependency manifests
- Backend and end-to-end tests in `tests/`
- Deployment configuration, including `Dockerfile`, `.dockerignore`, and GitHub workflow files
- Environment variable templates such as `.env.example`
- Project documentation in `README.md` and `docs/`

## Intentionally Excluded

The following files are intentionally not included in this source code archive:

- `.git/`
- `node_modules/`
- Python virtual environments such as `venv/` and `.venv/`
- `.env` files and local secrets
- Local SQLite database files such as `database.db` and `studyhub.db`
- User-uploaded documents in `uploads/`
- Generated frontend build output in `dist/`
- Test reports and cache folders
- Python bytecode and `__pycache__/`
- macOS `.DS_Store` files
- Large model checkpoints and raw training artifacts
- Final report PDF and showcase video

## How to Run Locally

Install dependencies:

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
npm ci
```

Create local environment configuration:

```bash
cp .env.example .env
```

Start the Flask backend:

```bash
source venv/bin/activate
python app.py
```

Start the React/Vite frontend:

```bash
npm run dev
```

The frontend dev server runs on `http://127.0.0.1:5173` and proxies API requests to the Flask backend on `http://127.0.0.1:5001`.

## How to Test

Backend tests:

```bash
npm run test:backend
```

End-to-end tests:

```bash
npm run test:e2e
```

## AI Services and Model Artifacts

The source for external OCR and summarisation services is included in `ocr_service/` and `summary_service/`. Runtime endpoints, tokens, and model provider settings are configured through environment variables documented in `.env.example` and `README.md`.

Large raw datasets, training checkpoints, exported model weights, API tokens, and service credentials are not included in this source archive. They should be supplied through the configured deployment environment or external model storage.
