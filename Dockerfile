# ---------- Stage 1: build frontend ----------
FROM node:20-bookworm AS frontend-builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY public ./public
COPY index.html ./
COPY vite.config.js ./

RUN npm run build


# ---------- Stage 2: backend runtime ----------
FROM python:3.11-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ocrmypdf \
    tesseract-ocr \
    tesseract-ocr-eng \
    ghostscript \
    qpdf \
    pngquant \
    unpaper \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
COPY --from=frontend-builder /app/dist ./dist

EXPOSE 5001

CMD ["gunicorn", "--bind", "0.0.0.0:5001", "app:app"]
