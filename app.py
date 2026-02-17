import os
import sqlite3
import uuid
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory, redirect
from flask_cors import CORS
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash

# --- Google 登录库 ---
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

# --- 文本提取库 ---
import docx
import PyPDF2

# --- PostgreSQL 驱动 ---
import psycopg2
from psycopg2.extras import RealDictCursor

# --- AWS S3 库 (新增) ---
import boto3
from botocore.exceptions import NoCredentialsError

# ================= 配置部分 =================
app = Flask(__name__, static_folder='dist', static_url_path='')
CORS(app)

UPLOAD_FOLDER = 'uploads'
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024  # 20MB
ALLOWED_EXTENSIONS = {'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'docx', 'webp'}
GOOGLE_CLIENT_ID = "1076922320508-6jdkr9v6g7rku2dipd6kr3n3thojdvn4.apps.googleusercontent.com"

# ================= AWS S3 配置 (新增) =================
# 从环境变量获取密钥
S3_BUCKET = os.environ.get('S3_BUCKET_NAME')
S3_KEY = os.environ.get('AWS_ACCESS_KEY_ID')
S3_SECRET = os.environ.get('AWS_SECRET_ACCESS_KEY')
S3_REGION = os.environ.get('AWS_REGION', 'us-west-2')

# 创建 S3 客户端
try:
    s3_client = boto3.client(
        's3',
        aws_access_key_id=S3_KEY,
        aws_secret_access_key=S3_SECRET,
        region_name=S3_REGION
    )
    print("✅ AWS S3 Client initialized.")
except Exception as e:
    print(f"⚠️ AWS S3 Client failed to initialize: {e}")
    s3_client = None

# ================= 数据库智能兼容层 (DBWrapper) =================
class DBWrapper:
    """
    这个类用于屏蔽 SQLite 和 PostgreSQL 的语法差异。
    Render 使用 PostgreSQL (%s 占位符)，本地开发使用 SQLite (? 占位符)。
    """
    def __init__(self, conn, db_type):
        self.conn = conn
        self.db_type = db_type

    def execute(self, query, params=()):
        # 1. 自动转换占位符：如果是 Postgres，把 SQL 里的 '?' 替换为 '%s'
        if self.db_type == 'postgres':
            query = query.replace('?', '%s')
        
        # 2. 执行查询
        try:
            if self.db_type == 'postgres':
                cursor = self.conn.cursor()
                cursor.execute(query, params)
                return cursor
            else:
                # SQLite
                return self.conn.execute(query, params)
        except Exception as e:
            print(f"Database Execution Error: {e}")
            raise e

    def commit(self):
        self.conn.commit()

    def close(self):
        self.conn.close()

# ================= 数据库连接函数 =================
def get_db_connection():
    # 1. 尝试从 Render 环境变量获取 PostgreSQL 地址
    database_url = os.environ.get('DATABASE_URL')
    
    if database_url:
        # === 生产环境: PostgreSQL ===
        try:
            # 修正 URL 格式 (SQLAlchemy/Psycopg2 需要 postgresql:// 开头)
            if database_url.startswith("postgres://"):
                database_url = database_url.replace("postgres://", "postgresql://", 1)
            
            conn = psycopg2.connect(database_url, cursor_factory=RealDictCursor)
            return DBWrapper(conn, 'postgres')
        except Exception as e:
            print(f"❌ PostgreSQL connection failed: {e}")
            return None
    else:
        # === 本地开发环境: SQLite ===
        conn = sqlite3.connect('database.db')
        conn.row_factory = sqlite3.Row
        return DBWrapper(conn, 'sqlite')

# ================= 初始化数据库表 =================
def init_db():
    conn = get_db_connection()
    if not conn:
        print("⚠️ Warning: Could not connect to database for initialization.")
        return

    print(f"✅ Connected to database type: {conn.db_type}")

    # 根据数据库类型选择不同的建表语法
    if conn.db_type == 'postgres':
        # Postgres 使用 SERIAL 自增
        id_type = "SERIAL PRIMARY KEY"
        timestamp_type = "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
    else:
        # SQLite 使用 INTEGER PRIMARY KEY AUTOINCREMENT
        id_type = "INTEGER PRIMARY KEY AUTOINCREMENT"
        timestamp_type = "TEXT" 

    # 创建用户表
    users_sql = f'''
        CREATE TABLE IF NOT EXISTS users (
            id {id_type},
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE,
            password_hash TEXT NOT NULL
        );
    '''
    
    # 创建文档表
    docs_sql = f'''
        CREATE TABLE IF NOT EXISTS documents (
            id {id_type},
            filename TEXT NOT NULL,
            title TEXT,
            uploaded_at {timestamp_type},
            file_type TEXT,
            content TEXT, 
            tags TEXT,
            username TEXT,
            last_access_at {timestamp_type}
        );
    '''

    try:
        conn.execute(users_sql)
        conn.execute(docs_sql)
        conn.commit()
        print("✅ Database tables initialized successfully.")
    except Exception as e:
        print(f"❌ Error initializing tables: {e}")
    finally:
        conn.close()

# 启动时运行初始化
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

# ================= API 路由接口 =================

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
        # DBWrapper 会自动处理占位符 ?
        conn.execute('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
                     (username, email, hashed_pw))
        conn.commit()
        return jsonify({'message': 'User created successfully'}), 201
    except Exception as e:
        return jsonify({'error': f'Registration failed (User may exist): {str(e)}'}), 409
    finally:
        conn.close()

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.get_json()
    username_or_email = data.get('username')
    password = data.get('password')

    conn = get_db_connection()
    cursor = conn.execute('SELECT * FROM users WHERE username = ? OR email = ?', 
                        (username_or_email, username_or_email))
    user = cursor.fetchone()
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
        cursor = conn.execute('SELECT * FROM users WHERE email = ?', (email,))
        user = cursor.fetchone()
        
        if user is None:
            username = f"{name.split()[0]}_{uuid.uuid4().hex[:4]}"
            random_password = uuid.uuid4().hex
            hashed_password = generate_password_hash(random_password, method='pbkdf2:sha256')
            try:
                conn.execute('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
                             (username, email, hashed_password))
                conn.commit()
                cursor = conn.execute('SELECT * FROM users WHERE email = ?', (email,))
                user = cursor.fetchone()
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
    try:
        if username:
            cursor = conn.execute('SELECT * FROM documents WHERE username = ? ORDER BY uploaded_at DESC', (username,))
            docs = cursor.fetchall()
        else:
            cursor = conn.execute('SELECT * FROM documents ORDER BY uploaded_at DESC')
            docs = cursor.fetchall()
        
        return jsonify([dict(doc) for doc in docs])
    finally:
        conn.close()

# ================= 修改后的上传接口 (支持 S3) =================
@app.route('/api/documents/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    
    file = request.files['file']
    username = request.form.get('username', 'Anonymous')
    
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    if file and allowed_file(file.filename):
        original_filename = file.filename
        try:
            ext = original_filename.rsplit('.', 1)[1].lower()
        except IndexError:
            return jsonify({'error': 'Filename must have an extension'}), 400
        
        unique_filename = f"{uuid.uuid4().hex}.{ext}"
        # 1. 先保存到本地临时文件夹 (为了提取文字)
        local_filepath = os.path.join(app.config['UPLOAD_FOLDER'], unique_filename)
        file.save(local_filepath)

        # 2. 提取文字 (这一步需要本地文件)
        extracted_text = extract_text(local_filepath, ext)

        # 3. 【关键步骤】上传到 AWS S3
        try:
            if S3_BUCKET and s3_client: # 只有配置了 S3 且客户端初始化成功才上传
                print(f"🚀 Uploading to S3: {S3_BUCKET}")
                s3_client.upload_file(
                    local_filepath, 
                    S3_BUCKET, 
                    unique_filename,
                    ExtraArgs={'ContentType': file.content_type} # 设置文件类型
                )
                print("✅ Upload to S3 successful")
                
                # 4. 上传成功后，删除本地文件 (节省 Render 空间)
                os.remove(local_filepath)
                print("🗑️ Local file removed")
            else:
                print("⚠️ S3_BUCKET not set or client failed, keeping local file")

        except Exception as e:
            print(f"❌ S3 Upload Error: {e}")
            # 注意：即使 S3 上传失败，我们可能还是想保留数据库记录（或者报错，取决于你的需求）
            return jsonify({'error': f'Failed to upload to S3: {str(e)}'}), 500

        # 5. 存入数据库
        conn = get_db_connection()
        try:
            conn.execute(
                'INSERT INTO documents (filename, title, uploaded_at, file_type, content, username, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
                (unique_filename, original_filename, datetime.utcnow().isoformat(), ext, extracted_text, username, '')
            )
            conn.commit()
            return jsonify({'message': 'File uploaded successfully'}), 201
        except Exception as e:
            print(f"Database Error: {e}")
            return jsonify({'error': 'Database save failed'}), 500
        finally:
            conn.close()
    
    return jsonify({'error': 'File type not allowed'}), 400

@app.route('/api/documents/<int:doc_id>', methods=['GET'])
def get_document(doc_id):
    conn = get_db_connection()
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        
        if doc:
            conn.execute('UPDATE documents SET last_access_at = ? WHERE id = ?', 
                         (datetime.utcnow().isoformat(), doc_id))
            conn.commit()
            return jsonify(dict(doc))
        else:
            return jsonify({'error': 'Document not found'}), 404
    finally:
        conn.close()

# ================= 修改后的下载/访问接口 (支持 S3) =================
@app.route('/uploads/<filename>')
def uploaded_file(filename):
    # 如果配置了 S3，直接生成一个 S3 的链接跳转过去
    if S3_BUCKET and s3_client:
        try:
            # 生成一个“预签名 URL”，有效期 1 小时 (3600秒)
            presigned_url = s3_client.generate_presigned_url(
                'get_object',
                Params={'Bucket': S3_BUCKET, 'Key': filename},
                ExpiresIn=3600
            )
            # 让浏览器直接跳转到 AWS S3 下载
            return redirect(presigned_url, code=302)
        except Exception as e:
            print(f"S3 Link Generation Error: {e}")
            return jsonify({'error': 'Could not generate file link'}), 500
    else:
        # 如果没配 S3 (比如本地测试)，还是从本地文件夹读
        return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# ================= 前端路由 =================
@app.route('/')
def serve_index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:path>')
def catch_all(path):
    if path.startswith('api/') or path.startswith('uploads/'):
        return jsonify({'error': 'Not found'}), 404
    
    if os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory(app.static_folder, path)
    
    return send_from_directory(app.static_folder, 'index.html')

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(debug=True, port=port, host='0.0.0.0')