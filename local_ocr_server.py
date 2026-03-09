# local_ocr_server.py
import os
import cv2
import numpy as np
import torch
from PIL import Image

# Skip PaddleX online source probing to reduce startup noise/latency.
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

from paddleocr import PaddleOCR
from transformers import TrOCRProcessor, VisionEncoderDecoderModel
from fastapi import FastAPI, UploadFile
import uvicorn
import logging

logging.disable(logging.DEBUG)

# 🚀 极其关键：激活 Apple M4 芯片的 Metal 硬件加速！
if torch.backends.mps.is_available():
    device = torch.device("mps")
    print("🔥 已成功激活 Apple M4 MPS 硬件加速！")
else:
    device = torch.device("cpu")
    print("⚠️ 未检测到 MPS，使用 CPU 运行。")

# --- 1. 加载 PaddleOCR ---
print("正在加载版面检测引擎...")
# --- 1. 加载 PaddleOCR (终极兼容版本) ---
# 只保留核心语言参数，其他参数全部移除，确保不会再报 Unknown argument
ocr_det = PaddleOCR(lang="en")
# --- 2. 加载你的专属大模型 ---
print("正在从 Hugging Face 拉取你的专属 AI 大脑...")
YOUR_MODEL_REPO = "lbin2021/my-lecture-ocr"
processor = TrOCRProcessor.from_pretrained(YOUR_MODEL_REPO)
model = VisionEncoderDecoderModel.from_pretrained(YOUR_MODEL_REPO).to(device)
print("✅ 所有模型加载完毕，随时可以开始接单！")

# ==================== 核心算法区 (保持不变) ====================
def detect_boxes(bgr_img):
    res = ocr_det.ocr(bgr_img, det=True, rec=False, cls=False)
    boxes = []
    if res and len(res) > 0 and res[0] is not None:
        for item in res[0]:
            boxes.append(np.array(item, dtype=np.float32))
    return boxes

def box_stats(box):
    xs, ys = box[:,0], box[:,1]
    return {"x0": float(xs.min()), "x1": float(xs.max()), "y0": float(ys.min()), "y1": float(ys.max()), "xc": float(xs.mean()), "yc": float(ys.mean()), "h": float(ys.max() - ys.min())}

def group_into_lines(stats, img_w):
    if not stats: return []
    hs = sorted([s["h"] for s in stats if s["h"] > 1])
    median_h = hs[len(hs)//2] if hs else 20.0
    thr = 0.7 * median_h  
    stats_sorted = sorted(stats, key=lambda s: s["yc"])
    lines = []
    for s in stats_sorted:
        placed = False
        for line in lines:
            if abs(s["yc"] - line["yc_mean"]) <= thr:
                line["items"].append(s)
                line["yc_mean"] = sum(i["yc"] for i in line["items"]) / len(line["items"])
                placed = True
                break
        if not placed:
            lines.append({"yc_mean": s["yc"], "items":[s]})

    left = [s for s in stats if s["xc"] < 0.5*img_w]
    right = [s for s in stats if s["xc"] >= 0.5*img_w]
    two_cols = (len(left) > 0.2*len(stats) and len(right) > 0.2*len(stats))
    for l in lines: l["items"].sort(key=lambda s: s["x0"])
    if not two_cols:
        lines.sort(key=lambda l: l["yc_mean"])
        return lines
    left_lines, right_lines = [], []
    for l in lines:
        xc_mean = sum(i["xc"] for i in l["items"]) / len(l["items"])
        (left_lines if xc_mean < 0.5*img_w else right_lines).append(l)
    left_lines.sort(key=lambda l: l["yc_mean"])
    right_lines.sort(key=lambda l: l["yc_mean"])
    return left_lines + right_lines

def crop_line(img, items, pad=6):
    x0 = int(max(min(i["x0"] for i in items) - pad, 0))
    y0 = int(max(min(i["y0"] for i in items) - pad, 0))
    x1 = int(min(max(i["x1"] for i in items) + pad, img.shape[1]-1))
    y1 = int(min(max(i["y1"] for i in items) + pad, img.shape[0]-1))
    return img[y0:y1, x0:x1]

def slice_long_line(bgr, max_ratio=10.0, overlap=0.25):
    h, w = bgr.shape[:2]
    if h < 5 or (w / max(h, 1)) <= max_ratio: return [bgr]
    target_w = int(max_ratio * h)
    step = int(target_w * (1 - overlap))
    slices, x = [], 0
    while x < w:
        slices.append(bgr[:, x:min(x + target_w, w)])
        if x + target_w >= w: break
        x += step
    return slices

def trocr_decode(bgr):
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)
    pixel_values = processor(images=pil, return_tensors="pt").pixel_values.to(device)
    with torch.no_grad():
        out_ids = model.generate(pixel_values, max_length=128)
    return processor.batch_decode(out_ids, skip_special_tokens=True)[0].strip()

def recognize_line(bgr_line):
    parts = slice_long_line(bgr_line)
    texts = [trocr_decode(p) for p in parts]
    return " ".join([t for t in texts if t]).strip()

def process_full_image(bgr_img):
    boxes = detect_boxes(bgr_img)
    stats = [box_stats(b) for b in boxes]
    lines = group_into_lines(stats, bgr_img.shape[1])
    out_lines = []
    for line in lines:
        crop = crop_line(bgr_img, line["items"])
        text = recognize_line(crop)
        if text: out_lines.append(text)
    return {"text": "\n".join(out_lines)}

# ==================== FastAPI ====================
app = FastAPI()

@app.post("/ocr")
async def ocr_api(file: UploadFile):
    data = await file.read()
    img_np = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    result = process_full_image(img_np)
    return result

if __name__ == "__main__":
    print("\n" + "="*60)
    print("🚀 你的 Mac M4 本地算力中心已上线！")
    print("🌍 内部 API 地址是: http://127.0.0.1:8000/ocr")
    print("="*60 + "\n")
    uvicorn.run(app, host="0.0.0.0", port=8000)
