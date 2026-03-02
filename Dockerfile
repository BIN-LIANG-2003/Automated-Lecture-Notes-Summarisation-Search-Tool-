# 使用 Python 3.9 基础镜像
FROM python:3.9-slim

# 必须使用 root 用户安装系统包
USER root

# 安装 OpenCV 和 RapidOCR 所需的底层库
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    ffmpeg \
    libsm6 \
    libxext6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 安装依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制所有代码
COPY . .

# 暴露 Flask 运行端口
EXPOSE 5001

# 使用 gunicorn 启动服务
CMD ["gunicorn", "--bind", "0.0.0.0:5001", "app:app"]
