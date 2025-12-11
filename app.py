import os
import sqlite3
import uuid
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash

# --- Google 登录库 ---
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

# --- 文本提取库 (您的核心功能) ---
import docx  # 处理 .docx
import PyPDF2  # 处理 .pdf

app = Flask(__name__)
CORS(app)  # 允许跨域

# =================配置部分=================
# 上传文件保存的文件夹
UPLOAD_FOLDER = 'uploads'
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024  # 限制最大上传 20MB

# 允许的文件后缀
ALLOWED_EXTENSIONS = {'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'docx', 'webp'}

# 您的 Google Client ID (必须与前端 main.jsx 一致)
GOOGLE_CLIENT_ID = "1076922320508-6jdkr9v6g7rku2dipd6kr3n3thojdvn4.apps.googleusercontent.com"

# =================数据库工具函数=================
def get_db_connection():
    conn = sqlite3.connect('database.db')
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db_connection()
    # 1. 创建用户表
    conn.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE,
            password_hash TEXT NOT NULL
        )
    ''')
    # 2. 创建文档表 (包含 content 字段用于存提取的文字)
    conn.execute('''
        CREATE TABLE IF NOT EXISTS documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            title TEXT,
            uploaded_at TEXT,
            file_type TEXT,
            content TEXT, 
            tags TEXT,
            username TEXT,
            last_access_at TEXT
        )
    ''')
    conn.commit()
    conn.close()

# 初始化数据库 (每次启动时检查)
init_db()

# =================辅助函数=================
def allowed_file(filename):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def extract_text(filepath, ext):
    """从文件中提取文字的核心逻辑"""
    text = ""
    try:
        if ext == 'docx':
            doc = docx.Document(filepath)
            text = "\n".join([para.text for para in doc.paragraphs])
        elif ext == 'pdf':
            with open(filepath, 'rb') as f:
                reader = PyPDF2.PdfReader(f)
                for page in reader.pages:
                    text += page.extract_text() + "\n"
        elif ext == 'txt':
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                text = f.read()
        # 图片暂不处理OCR，留空
    except Exception as e:
        print(f"Error extracting text: {e}")
        text = "Text extraction failed or not supported."
    return text

# =================API 路由接口=================

# 1. 普通注册
@app.route('/api/auth/register', methods=['POST'])
def register():
    data = request.get_json()
    username = data.get('username')
    email = data.get('email')
    password = data.get('password')

    if not username or not password:
        return jsonify({'error': 'Missing fields'}), 400

    hashed_pw = generate_password_hash(password, method='pbkdf2:sha256')

    conn = get_db_connection()
    try:
        conn.execute('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
                     (username, email, hashed_pw))
        conn.commit()
        return jsonify({'message': 'User created successfully'}), 201
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Username or email already exists'}), 409
    finally:
        conn.close()

# 2. 普通登录
@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.get_json()
    username_or_email = data.get('username')
    password = data.get('password')

    conn = get_db_connection()
    # 支持用用户名或邮箱登录
    user = conn.execute('SELECT * FROM users WHERE username = ? OR email = ?', 
                        (username_or_email, username_or_email)).fetchone()
    conn.close()

    if user and check_password_hash(user['password_hash'], password):
        return jsonify({'message': 'Login successful', 'username': user['username']}), 200
    else:
        return jsonify({'error': 'Invalid credentials'}), 401

# 3. Google 登录 (新增功能)
@app.route('/api/auth/google', methods=['POST'])
def google_login():
    try:
        data = request.get_json()
        token = data.get('token')
        
        # A. 验证 Google Token
        id_info = id_token.verify_oauth2_token(
            token, 
            google_requests.Request(), 
            GOOGLE_CLIENT_ID
        )

        # B. 获取用户信息
        email = id_info['email']
        name = id_info.get('name', email.split('@')[0])
        
        # C. 数据库查找用户
        conn = get_db_connection()
        user = conn.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
        
        if user is None:
            # 自动注册逻辑
            username = f"{name.split()[0]}_{uuid.uuid4().hex[:4]}" # 生成唯一用户名
            random_password = uuid.uuid4().hex # 生成随机密码
            hashed_password = generate_password_hash(random_password, method='pbkdf2:sha256')
            
            try:
                conn.execute('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
                             (username, email, hashed_password))
                conn.commit()
                user = conn.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
            except Exception as e:
                conn.close()
                return jsonify({'error': f'Register failed: {str(e)}'}), 500

        conn.close()

        # D. 返回成功
        return jsonify({
            'message': 'Login successful',
            'username': user['username']
        }), 200

    except ValueError:
        return jsonify({'error': 'Invalid Google token'}), 401
    except Exception as e:
        print(f"Google login error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

# 4. 获取文档列表
@app.route('/api/documents', methods=['GET'])
def get_documents():
    username = request.args.get('username')
    conn = get_db_connection()
    
    if username:
        # 只看自己的
        docs = conn.execute('SELECT * FROM documents WHERE username = ? ORDER BY uploaded_at DESC', (username,)).fetchall()
    else:
        # 看所有的 (访客模式)
        docs = conn.execute('SELECT * FROM documents ORDER BY uploaded_at DESC').fetchall()
    
    conn.close()
    return jsonify([dict(doc) for doc in docs])

# 5. 上传文档 (包含文本提取逻辑)
@app.route('/api/documents/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    
    file = request.files['file']
    username = request.form.get('username', 'Anonymous')
    
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        # 防止重名覆盖，加个时间戳
        unique_filename = f"{uuid.uuid4().hex[:8]}_{filename}"
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], unique_filename)
        file.save(filepath)

        # 获取文件后缀
        ext = filename.rsplit('.', 1)[1].lower()
        
        # --- 核心：提取文本 ---
        extracted_text = extract_text(filepath, ext)
        # -------------------

        # 存入数据库
        conn = get_db_connection()
        conn.execute(
            'INSERT INTO documents (filename, title, uploaded_at, file_type, content, username, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (unique_filename, filename, datetime.utcnow().isoformat(), ext, extracted_text, username, '')
        )
        conn.commit()
        conn.close()

        return jsonify({'message': 'File uploaded and processed successfully'}), 201
    
    return jsonify({'error': 'File type not allowed'}), 400

# 6. 获取单个文档详情
@app.route('/api/documents/<int:doc_id>', methods=['GET'])
def get_document(doc_id):
    conn = get_db_connection()
    doc = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,)).fetchone()
    
    if doc:
        # 更新最后访问时间
        conn.execute('UPDATE documents SET last_access_at = ? WHERE id = ?', 
                     (datetime.utcnow().isoformat(), doc_id))
        conn.commit()
        conn.close()
        return jsonify(dict(doc))
    else:
        conn.close()
        return jsonify({'error': 'Document not found'}), 404

# 7. 下载/预览文件
@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# =================启动服务器=================
if __name__ == '__main__':
    # host='0.0.0.0' 允许局域网访问 (手机端)
    # port=5001 您的指定端口
    app.run(debug=True, port=5001, host='0.0.0.0')