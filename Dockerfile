# 使用较新的 Bookworm 版本，源更稳定
FROM python:3.9-bookworm

# 必须使用 root 用户安装系统包
USER root

# Bookworm 不需要复杂的 sed 换源，直接安装即可
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1-mesa-glx \
    libglib2.0-0 \
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
