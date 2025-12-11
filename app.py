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

# --- 文本提取库 ---
import docx
import PyPDF2

# ================= 配置部分 =================
# 修改点 1：初始化 Flask 指向 dist 文件夹
app = Flask(__name__, static_folder='dist', static_url_path='')
CORS(app)

# 上传配置
UPLOAD_FOLDER = 'uploads'
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024  # 20MB

ALLOWED_EXTENSIONS = {'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'docx', 'webp'}
GOOGLE_CLIENT_ID = "1076922320508-6jdkr9v6g7rku2dipd6kr3n3thojdvn4.apps.googleusercontent.com"

# ================= 数据库工具函数 =================
def get_db_connection():
    conn = sqlite3.connect('database.db')
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db_connection()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE,
            password_hash TEXT NOT NULL
        )
    ''')
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

init_db()

# ================= 辅助函数 =================
def allowed_file(filename):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def extract_text(filepath, ext):
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
    except Exception as e:
        print(f"Error extracting text: {e}")
        text = "Text extraction failed."
    return text

# ================= API 路由接口 (业务逻辑) =================

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

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.get_json()
    username_or_email = data.get('username')
    password = data.get('password')

    conn = get_db_connection()
    user = conn.execute('SELECT * FROM users WHERE username = ? OR email = ?', 
                        (username_or_email, username_or_email)).fetchone()
    conn.close()

    if user and check_password_hash(user['password_hash'], password):
        return jsonify({'message': 'Login successful', 'username': user['username']}), 200
    else:
        return jsonify({'error': 'Invalid credentials'}), 401

@app.route('/api/auth/google', methods=['POST'])
def google_login():
    try:
        data = request.get_json()
        token = data.get('token')
        
        id_info = id_token.verify_oauth2_token(token, google_requests.Request(), GOOGLE_CLIENT_ID)
        email = id_info['email']
        name = id_info.get('name', email.split('@')[0])
        
        conn = get_db_connection()
        user = conn.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
        
        if user is None:
            username = f"{name.split()[0]}_{uuid.uuid4().hex[:4]}"
            random_password = uuid.uuid4().hex
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
        return jsonify({'message': 'Login successful', 'username': user['username']}), 200
    except ValueError:
        return jsonify({'error': 'Invalid Google token'}), 401
    except Exception as e:
        print(f"Google login error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/documents', methods=['GET'])
def get_documents():
    username = request.args.get('username')
    conn = get_db_connection()
    if username:
        docs = conn.execute('SELECT * FROM documents WHERE username = ? ORDER BY uploaded_at DESC', (username,)).fetchall()
    else:
        docs = conn.execute('SELECT * FROM documents ORDER BY uploaded_at DESC').fetchall()
    conn.close()
    return jsonify([dict(doc) for doc in docs])

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
        unique_filename = f"{uuid.uuid4().hex[:8]}_{filename}"
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], unique_filename)
        file.save(filepath)

        ext = filename.rsplit('.', 1)[1].lower()
        extracted_text = extract_text(filepath, ext)

        conn = get_db_connection()
        conn.execute(
            'INSERT INTO documents (filename, title, uploaded_at, file_type, content, username, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (unique_filename, filename, datetime.utcnow().isoformat(), ext, extracted_text, username, '')
        )
        conn.commit()
        conn.close()
        return jsonify({'message': 'File uploaded and processed successfully'}), 201
    
    return jsonify({'error': 'File type not allowed'}), 400

@app.route('/api/documents/<int:doc_id>', methods=['GET'])
def get_document(doc_id):
    conn = get_db_connection()
    doc = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,)).fetchone()
    if doc:
        conn.execute('UPDATE documents SET last_access_at = ? WHERE id = ?', 
                     (datetime.utcnow().isoformat(), doc_id))
        conn.commit()
        conn.close()
        return jsonify(dict(doc))
    else:
        conn.close()
        return jsonify({'error': 'Document not found'}), 404

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# ================= 前端托管路由 (新增部分) =================

# 修改点 2：添加根路由，返回 index.html
@app.route('/')
def serve_index():
    return send_from_directory(app.static_folder, 'index.html')

# 修改点 3：添加捕获所有路由，防止 React 刷新 404
@app.route('/<path:path>')
def catch_all(path):
    # 如果是 API 或上传文件请求，不要拦截，直接返回 404 让 Flask 处理
    if path.startswith('api/') or path.startswith('uploads/'):
        return jsonify({'error': 'Not found'}), 404
    
    # 如果请求的是静态资源 (如 js, css, png)，直接返回文件
    if os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory(app.static_folder, path)
    
    # 否则（比如访问 /login），统统返回 index.html 给 React 处理
    return send_from_directory(app.static_folder, 'index.html')

if __name__ == '__main__':
    # 适配 Render 的环境变量 PORT
    port = int(os.environ.get('PORT', 5001))
    app.run(debug=True, port=port, host='0.0.0.0')