# 使用官方 Python 基础镜像
FROM python:3.9-slim

# 安装系统级依赖库（解决 libGL.so 报错）
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /app

# 复制依赖文件并安装
COPY requirements.txt .
# 建议将 requirements.txt 中的 opencv-python 替换为 opencv-python-headless 以减小镜像体积
RUN pip install --no-cache-dir -r requirements.txt

# 复制所有项目文件
COPY . .

# 暴露 Flask 端口
EXPOSE 5001

# 启动命令
CMD ["gunicorn", "--bind", "0.0.0.0:5001", "app:app"]
