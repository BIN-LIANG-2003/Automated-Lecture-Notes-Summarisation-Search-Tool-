import os
import sqlite3
import uuid
import io
import sys
import mimetypes
import re
import requests
from html import escape as html_escape
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory, redirect, send_file
from flask_cors import CORS
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from sklearn.feature_extraction.text import TfidfVectorizer

# --- Google 登录库 ---
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

# --- 文本提取库 ---
import docx
import PyPDF2
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_COLOR_INDEX
from docx.shared import Pt, RGBColor
from lxml import etree, html as lxml_html

try:
    import cv2
    import numpy as np
except Exception:
    cv2 = None
    np = None

try:
    from rapidocr_onnxruntime import RapidOCR
except Exception:
    RapidOCR = None

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

# ================= Hugging Face AI 服务配置 =================
HF_TOKEN = (os.environ.get("HF_API_TOKEN") or "").strip()
HF_MODEL_BASE_URL = (os.environ.get("HF_MODEL_BASE_URL") or "https://router.huggingface.co/hf-inference/models").rstrip("/")
OCR_MODEL_ID = os.environ.get("HF_OCR_MODEL") or "microsoft/trocr-base-printed"
SUMMARIZER_MODEL_ID = os.environ.get("HF_SUMMARIZER_MODEL") or "csebuetnlp/mT5_multilingual_XLSum"

_rapid_ocr_engine = None

MIME_BY_EXT = {
    'pdf': 'application/pdf',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'txt': 'text/plain',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
}

EDITOR_ALLOWED_TAGS = {
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup', 'mark', 'span', 'div',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre',
    'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col', 'img', 'hr'
}
EDITOR_ALLOWED_STYLE_PROPS = {
    'font-weight', 'font-style', 'text-decoration', 'color', 'background-color',
    'text-align', 'font-size', 'font-family', 'vertical-align', 'margin-left',
    'width', 'height', 'border', 'border-collapse'
}
BLOCK_TAGS = {
    'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'
}

NAMED_COLORS = {
    'black': (0, 0, 0),
    'white': (255, 255, 255),
    'red': (255, 0, 0),
    'green': (0, 128, 0),
    'blue': (0, 0, 255),
    'yellow': (255, 255, 0),
    'gray': (128, 128, 128),
    'grey': (128, 128, 128),
    'orange': (255, 165, 0),
    'purple': (128, 0, 128),
    'brown': (165, 42, 42),
}

HIGHLIGHT_RGB_BY_INDEX = {
    WD_COLOR_INDEX.YELLOW: (255, 255, 0),
    WD_COLOR_INDEX.BRIGHT_GREEN: (0, 255, 0),
    WD_COLOR_INDEX.TURQUOISE: (0, 255, 255),
    WD_COLOR_INDEX.PINK: (255, 192, 203),
    WD_COLOR_INDEX.BLUE: (0, 0, 255),
    WD_COLOR_INDEX.RED: (255, 0, 0),
    WD_COLOR_INDEX.DARK_BLUE: (0, 0, 139),
    WD_COLOR_INDEX.TEAL: (0, 128, 128),
    WD_COLOR_INDEX.GREEN: (0, 128, 0),
    WD_COLOR_INDEX.VIOLET: (238, 130, 238),
    WD_COLOR_INDEX.DARK_RED: (139, 0, 0),
    WD_COLOR_INDEX.DARK_YELLOW: (128, 128, 0),
    WD_COLOR_INDEX.GRAY_50: (128, 128, 128),
    WD_COLOR_INDEX.GRAY_25: (192, 192, 192),
    WD_COLOR_INDEX.BLACK: (0, 0, 0),
    WD_COLOR_INDEX.WHITE: (255, 255, 255),
}

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
def ensure_documents_columns(conn):
    column_exists = False
    if conn.db_type == 'sqlite':
        cursor = conn.execute('PRAGMA table_info(documents)')
        rows = cursor.fetchall()
        column_exists = any((row['name'] if hasattr(row, 'keys') else row[1]) == 'content_html' for row in rows)
    else:
        cursor = conn.execute(
            '''
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = ? AND column_name = ?
            ''',
            ('documents', 'content_html')
        )
        column_exists = cursor.fetchone() is not None

    if not column_exists:
        conn.execute('ALTER TABLE documents ADD COLUMN content_html TEXT')


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
            content_html TEXT,
            tags TEXT,
            username TEXT,
            last_access_at {timestamp_type}
        );
    '''

    try:
        conn.execute(users_sql)
        conn.execute(docs_sql)
        ensure_documents_columns(conn)
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


def detect_mimetype(filename, file_ext=''):
    ext = (file_ext or '').lower().strip('.')
    if ext in MIME_BY_EXT:
        return MIME_BY_EXT[ext]
    guessed = mimetypes.guess_type(filename)[0]
    return guessed or 'application/octet-stream'


def normalize_newlines(value):
    text = value if isinstance(value, str) else str(value or '')
    return text.replace('\r\n', '\n').replace('\r', '\n')


def sanitize_style_declarations(style_text):
    style_map = {}
    if not isinstance(style_text, str):
        return style_map

    for declaration in style_text.split(';'):
        if ':' not in declaration:
            continue
        prop, val = declaration.split(':', 1)
        prop = prop.strip().lower()
        val = val.strip()
        if prop not in EDITOR_ALLOWED_STYLE_PROPS or not val:
            continue

        lower_val = val.lower()
        if 'expression(' in lower_val or 'javascript:' in lower_val or 'url(' in lower_val:
            continue

        if prop == 'font-family':
            cleaned_parts = [
                part.strip().strip('"').strip("'")
                for part in val.split(',')
                if part.strip()
            ]
            if not cleaned_parts:
                continue
            val = ', '.join(cleaned_parts[:3])
        elif prop in ('width', 'height', 'margin-left'):
            if not re.fullmatch(r'\d+(?:\.\d+)?(px|pt|em|rem|%)', lower_val):
                continue
        elif prop == 'border-collapse':
            if lower_val not in ('collapse', 'separate'):
                continue
        elif prop == 'border':
            if not re.fullmatch(r'[\w\s.#()-]+', val):
                continue

        style_map[prop] = val

    return style_map


def style_map_to_inline(style_map):
    if not style_map:
        return ''
    return '; '.join(f'{k}: {v}' for k, v in style_map.items())


def parse_css_color(color_value):
    if not isinstance(color_value, str):
        return None
    value = color_value.strip().lower()
    if not value:
        return None

    if value in NAMED_COLORS:
        return NAMED_COLORS[value]

    if re.fullmatch(r'#?[0-9a-f]{6}', value):
        hex_color = value.lstrip('#')
        return tuple(int(hex_color[idx:idx + 2], 16) for idx in (0, 2, 4))

    rgb_match = re.fullmatch(
        r'rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)',
        value
    )
    if rgb_match:
        channels = [max(0, min(255, int(item))) for item in rgb_match.groups()]
        return tuple(channels)

    return None


def sanitize_int_attr(value, min_value=1, max_value=10000):
    raw = str(value or '').strip()
    if not raw or not raw.isdigit():
        return None
    number = int(raw)
    if number < min_value:
        return None
    return min(number, max_value)


def is_safe_link_href(href):
    value = str(href or '').strip()
    if not value:
        return False
    lower = value.lower()
    if lower.startswith(('javascript:', 'data:', 'vbscript:')):
        return False
    return True


def is_safe_image_src(src):
    value = str(src or '').strip()
    if not value:
        return False
    lower = value.lower()
    if lower.startswith(('javascript:', 'vbscript:')):
        return False
    if lower.startswith('data:'):
        return lower.startswith('data:image/')
    return True


def sanitize_colwidth_attr(value):
    raw = str(value or '').strip()
    if not raw:
        return None
    if re.fullmatch(r'\d+(,\d+)*', raw):
        return raw
    return None


def pick_highlight_index_from_css(color_value):
    rgb = parse_css_color(color_value)
    if not rgb:
        return None

    closest_index = None
    closest_distance = None
    for index, target_rgb in HIGHLIGHT_RGB_BY_INDEX.items():
        distance = (
            (rgb[0] - target_rgb[0]) ** 2
            + (rgb[1] - target_rgb[1]) ** 2
            + (rgb[2] - target_rgb[2]) ** 2
        )
        if closest_distance is None or distance < closest_distance:
            closest_distance = distance
            closest_index = index

    return closest_index


def parse_css_font_size_pt(size_value):
    if not isinstance(size_value, str):
        return None
    value = size_value.strip().lower()
    if not value:
        return None
    match = re.fullmatch(r'([0-9]+(?:\.[0-9]+)?)(pt|px|em|rem)?', value)
    if not match:
        return None

    amount = float(match.group(1))
    unit = (match.group(2) or 'pt')
    if unit == 'pt':
        return amount
    if unit == 'px':
        return amount * 0.75
    if unit in ('em', 'rem'):
        return amount * 12.0
    return amount


def css_alignment_from_docx_alignment(alignment):
    if alignment == WD_ALIGN_PARAGRAPH.CENTER:
        return 'center'
    if alignment == WD_ALIGN_PARAGRAPH.RIGHT:
        return 'right'
    if alignment == WD_ALIGN_PARAGRAPH.JUSTIFY:
        return 'justify'
    return ''


def docx_alignment_from_css(style_map):
    alignment = (style_map.get('text-align') or '').strip().lower()
    if alignment == 'center':
        return WD_ALIGN_PARAGRAPH.CENTER
    if alignment == 'right':
        return WD_ALIGN_PARAGRAPH.RIGHT
    if alignment == 'justify':
        return WD_ALIGN_PARAGRAPH.JUSTIFY
    return WD_ALIGN_PARAGRAPH.LEFT


def apply_block_style_to_paragraph(paragraph, style_map):
    paragraph.alignment = docx_alignment_from_css(style_map)
    margin_left = parse_css_font_size_pt(style_map.get('margin-left'))
    if isinstance(margin_left, (int, float)) and margin_left > 0:
        paragraph.paragraph_format.left_indent = Pt(margin_left)


def plaintext_to_html(content):
    text = normalize_newlines(content)
    lines = text.split('\n')
    if not lines:
        return '<p><br></p>'

    blocks = []
    for line in lines:
        if line == '':
            blocks.append('<p><br></p>')
        else:
            blocks.append(f'<p>{html_escape(line)}</p>')
    return ''.join(blocks) or '<p><br></p>'


def html_to_plaintext(content_html):
    if not isinstance(content_html, str) or not content_html.strip():
        return ''

    normalized_html = re.sub(r'(?i)<br\s*/?>', '\n', content_html)
    normalized_html = re.sub(
        r'(?i)</(p|div|li|h[1-6]|blockquote|pre|ul|ol|table|thead|tbody|tr|th|td)>',
        '\n',
        normalized_html
    )
    normalized_html = re.sub(r'(?i)<hr\s*/?>', '\n', normalized_html)

    try:
        root = lxml_html.fragment_fromstring(normalized_html, create_parent='div')
        text = root.text_content()
    except Exception:
        text = re.sub(r'<[^>]+>', '', normalized_html)

    text = text.replace('\xa0', ' ')
    text = normalize_newlines(text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def sanitize_editor_html(raw_html):
    if raw_html is None:
        return '<p><br></p>'

    source_html = str(raw_html).strip()
    if not source_html:
        return '<p><br></p>'

    source_html = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>', '', source_html)
    source_html = re.sub(r'(?is)<!--.*?-->', '', source_html)

    try:
        root = lxml_html.fragment_fromstring(source_html, create_parent='div')
    except Exception:
        return plaintext_to_html(source_html)

    present_tags = {el.tag.lower() for el in root.iter() if isinstance(el.tag, str)}
    strip_tags = [tag for tag in present_tags if tag not in EDITOR_ALLOWED_TAGS]
    if strip_tags:
        etree.strip_tags(root, *strip_tags)

    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        tag = el.tag.lower()
        style_map = sanitize_style_declarations(el.attrib.get('style', ''))

        sanitized_attrs = {}
        if style_map:
            sanitized_attrs['style'] = style_map_to_inline(style_map)

        if tag == 'a':
            href = (el.attrib.get('href') or '').strip()
            if is_safe_link_href(href):
                sanitized_attrs['href'] = href
                sanitized_attrs['target'] = '_blank'
                sanitized_attrs['rel'] = 'noopener noreferrer'
        elif tag == 'img':
            src = (el.attrib.get('src') or '').strip()
            if is_safe_image_src(src):
                sanitized_attrs['src'] = src

            alt = str(el.attrib.get('alt') or '').strip()
            if alt:
                sanitized_attrs['alt'] = alt[:200]

            title = str(el.attrib.get('title') or '').strip()
            if title:
                sanitized_attrs['title'] = title[:200]

            width = sanitize_int_attr(el.attrib.get('width'), 1, 4000)
            if width:
                sanitized_attrs['width'] = str(width)

            height = sanitize_int_attr(el.attrib.get('height'), 1, 4000)
            if height:
                sanitized_attrs['height'] = str(height)
        elif tag in ('th', 'td'):
            colspan = sanitize_int_attr(el.attrib.get('colspan'), 1, 20)
            if colspan and colspan > 1:
                sanitized_attrs['colspan'] = str(colspan)

            rowspan = sanitize_int_attr(el.attrib.get('rowspan'), 1, 100)
            if rowspan and rowspan > 1:
                sanitized_attrs['rowspan'] = str(rowspan)

            colwidth = sanitize_colwidth_attr(el.attrib.get('colwidth'))
            if colwidth:
                sanitized_attrs['colwidth'] = colwidth
        elif tag == 'col':
            span = sanitize_int_attr(el.attrib.get('span'), 1, 20)
            if span and span > 1:
                sanitized_attrs['span'] = str(span)

            width = sanitize_int_attr(el.attrib.get('width'), 1, 4000)
            if width:
                sanitized_attrs['width'] = str(width)

        el.attrib.clear()
        if sanitized_attrs:
            el.attrib.update(sanitized_attrs)

    serialized_parts = []
    if root.text and root.text.strip():
        serialized_parts.append(f'<p>{html_escape(root.text)}</p>')
    for child in root:
        serialized_parts.append(lxml_html.tostring(child, encoding='unicode', method='html'))

    sanitized_html = ''.join(serialized_parts).strip()
    return sanitized_html or '<p><br></p>'


def apply_run_style(run, style_ctx):
    run.bold = bool(style_ctx.get('bold'))
    run.italic = bool(style_ctx.get('italic'))
    run.underline = bool(style_ctx.get('underline'))
    run.font.strike = bool(style_ctx.get('strike'))
    has_subscript = bool(style_ctx.get('subscript'))
    has_superscript = bool(style_ctx.get('superscript'))
    if has_subscript and has_superscript:
        has_subscript = False
    run.font.subscript = has_subscript
    run.font.superscript = has_superscript

    font_size_pt = style_ctx.get('font_size_pt')
    if isinstance(font_size_pt, (int, float)) and font_size_pt > 0:
        run.font.size = Pt(font_size_pt)

    font_name = style_ctx.get('font_name')
    if isinstance(font_name, str) and font_name.strip():
        run.font.name = font_name.strip()

    rgb = style_ctx.get('color_rgb')
    if isinstance(rgb, tuple) and len(rgb) == 3:
        run.font.color.rgb = RGBColor(rgb[0], rgb[1], rgb[2])

    highlight_index = style_ctx.get('highlight_index')
    if highlight_index in HIGHLIGHT_RGB_BY_INDEX:
        run.font.highlight_color = highlight_index


def add_text_to_paragraph(paragraph, text, style_ctx):
    if not text:
        return
    parts = text.split('\n')
    for idx, part in enumerate(parts):
        run = paragraph.add_run(part)
        apply_run_style(run, style_ctx)
        if idx < len(parts) - 1:
            run.add_break()


def merge_inline_style(base_style, node):
    style = dict(base_style or {})
    tag = node.tag.lower() if isinstance(node.tag, str) else ''

    if tag in ('strong', 'b'):
        style['bold'] = True
    elif tag in ('em', 'i'):
        style['italic'] = True
    elif tag == 'u':
        style['underline'] = True
    elif tag in ('s', 'strike', 'del'):
        style['strike'] = True
    elif tag == 'sub':
        style['subscript'] = True
        style['superscript'] = False
    elif tag == 'sup':
        style['superscript'] = True
        style['subscript'] = False
    elif tag == 'mark':
        style['highlight_index'] = WD_COLOR_INDEX.YELLOW
    elif tag == 'code':
        style['font_name'] = 'Courier New'
    elif tag == 'a':
        style['underline'] = True
        style['color_rgb'] = (29, 78, 216)

    style_map = sanitize_style_declarations(node.attrib.get('style', ''))
    font_weight = (style_map.get('font-weight') or '').lower()
    if font_weight == 'bold':
        style['bold'] = True
    elif font_weight.isdigit():
        style['bold'] = int(font_weight) >= 600

    if (style_map.get('font-style') or '').lower() == 'italic':
        style['italic'] = True

    decoration = (style_map.get('text-decoration') or '').lower()
    if 'underline' in decoration:
        style['underline'] = True
    if 'line-through' in decoration:
        style['strike'] = True

    color_rgb = parse_css_color(style_map.get('color'))
    if color_rgb:
        style['color_rgb'] = color_rgb

    highlight_index = pick_highlight_index_from_css(style_map.get('background-color'))
    if highlight_index:
        style['highlight_index'] = highlight_index

    vertical_align = (style_map.get('vertical-align') or '').strip().lower()
    if vertical_align == 'sub':
        style['subscript'] = True
        style['superscript'] = False
    elif vertical_align in ('super', 'sup'):
        style['superscript'] = True
        style['subscript'] = False

    font_size_pt = parse_css_font_size_pt(style_map.get('font-size'))
    if font_size_pt:
        style['font_size_pt'] = font_size_pt

    font_family = style_map.get('font-family')
    if font_family:
        style['font_name'] = font_family.split(',')[0].strip()

    return style


def add_inline_node_to_paragraph(paragraph, node, inherited_style=None):
    current_style = merge_inline_style(inherited_style or {}, node)

    if node.text:
        add_text_to_paragraph(paragraph, node.text, current_style)

    for child in node:
        child_tag = child.tag.lower() if isinstance(child.tag, str) else ''
        if child_tag == 'br':
            paragraph.add_run().add_break()
        elif child_tag == 'img':
            alt = (child.attrib.get('alt') or '').strip()
            src = (child.attrib.get('src') or '').strip()
            placeholder = alt or src or 'Image'
            add_text_to_paragraph(paragraph, f'[Image] {placeholder}', current_style)
        elif child_tag == 'hr':
            add_text_to_paragraph(paragraph, '------------------------------', current_style)
        elif child_tag in BLOCK_TAGS.union({'ul', 'ol'}):
            nested_text = html_to_plaintext(lxml_html.tostring(child, encoding='unicode', method='html'))
            if nested_text:
                paragraph.add_run().add_break()
                add_text_to_paragraph(paragraph, nested_text, current_style)
        else:
            add_inline_node_to_paragraph(paragraph, child, current_style)

        if child.tail:
            add_text_to_paragraph(paragraph, child.tail, current_style)


def append_html_element_to_docx(document, element):
    if not isinstance(element.tag, str):
        return

    tag = element.tag.lower()
    style_map = sanitize_style_declarations(element.attrib.get('style', ''))

    if tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
        level = int(tag[1])
        paragraph = document.add_paragraph(style=f'Heading {min(level, 6)}')
        apply_block_style_to_paragraph(paragraph, style_map)
        add_inline_node_to_paragraph(paragraph, element, {})
        return

    if tag in ('ul', 'ol'):
        list_style = 'List Number' if tag == 'ol' else 'List Bullet'
        items = [child for child in element if isinstance(child.tag, str) and child.tag.lower() == 'li']
        if not items and (element.text or '').strip():
            items = [element]
        for item in items:
            paragraph = document.add_paragraph(style=list_style)
            add_inline_node_to_paragraph(paragraph, item, {})
        return

    if tag == 'blockquote':
        paragraph = document.add_paragraph()
        paragraph.paragraph_format.left_indent = Pt(18)
        paragraph.paragraph_format.space_after = Pt(6)
        apply_block_style_to_paragraph(paragraph, style_map)
        add_inline_node_to_paragraph(paragraph, element, {})
        return

    if tag == 'pre':
        text = normalize_newlines(element.text_content())
        lines = text.split('\n')
        if not lines:
            lines = ['']
        for line in lines:
            paragraph = document.add_paragraph()
            run = paragraph.add_run(line)
            run.font.name = 'Courier New'
        return

    if tag == 'li':
        paragraph = document.add_paragraph(style='List Bullet')
        add_inline_node_to_paragraph(paragraph, element, {})
        return

    if tag == 'table':
        row_elements = []
        for child in element.iter():
            child_tag = child.tag.lower() if isinstance(child.tag, str) else ''
            if child_tag == 'tr':
                row_elements.append(child)

        if not row_elements:
            return

        max_cols = 1
        parsed_rows = []
        for row_el in row_elements:
            cells = [
                cell for cell in row_el
                if isinstance(cell.tag, str) and cell.tag.lower() in ('td', 'th')
            ]
            if not cells:
                continue
            parsed_rows.append(cells)
            max_cols = max(max_cols, len(cells))

        if not parsed_rows:
            return

        table = document.add_table(rows=len(parsed_rows), cols=max_cols)
        try:
            table.style = 'Table Grid'
        except Exception:
            pass

        for row_idx, row_cells in enumerate(parsed_rows):
            for col_idx in range(max_cols):
                target_cell = table.cell(row_idx, col_idx)
                if col_idx >= len(row_cells):
                    target_cell.text = ''
                    continue
                cell_text = normalize_newlines(row_cells[col_idx].text_content()).strip()
                target_cell.text = cell_text
        return

    if tag == 'img':
        alt = (element.attrib.get('alt') or '').strip()
        src = (element.attrib.get('src') or '').strip()
        placeholder = alt or src or 'Image'
        document.add_paragraph(f'[Image] {placeholder}')
        return

    if tag == 'hr':
        document.add_paragraph('------------------------------')
        return

    paragraph = document.add_paragraph()
    apply_block_style_to_paragraph(paragraph, style_map)
    add_inline_node_to_paragraph(paragraph, element, {})


def create_docx_bytes_from_html(content_html, fallback_text=''):
    html_content = sanitize_editor_html(content_html)
    document = docx.Document()

    try:
        root = lxml_html.fragment_fromstring(html_content, create_parent='div')
    except Exception:
        root = None

    if root is None:
        lines = normalize_newlines(fallback_text).split('\n')
        for line in lines or ['']:
            document.add_paragraph(line)
    else:
        if root.text and root.text.strip():
            document.add_paragraph(root.text.strip())

        for child in root:
            append_html_element_to_docx(document, child)
            if child.tail and child.tail.strip():
                document.add_paragraph(child.tail.strip())

        if not document.paragraphs:
            fallback_lines = normalize_newlines(fallback_text).split('\n')
            for line in fallback_lines or ['']:
                document.add_paragraph(line)

    stream = io.BytesIO()
    document.save(stream)
    stream.seek(0)
    return stream.read()


def run_to_html(run):
    raw_text = run.text or ''
    if raw_text == '':
        return ''

    chunk = html_escape(raw_text).replace('\n', '<br/>')
    style_parts = []

    font_size = run.font.size.pt if run.font and run.font.size else None
    if font_size:
        style_parts.append(f'font-size: {round(font_size, 2)}pt')

    font_name = run.font.name if run.font else ''
    if font_name:
        style_parts.append(f'font-family: {html_escape(font_name)}')

    font_color = run.font.color.rgb if run.font and run.font.color else None
    if font_color:
        color_hex = str(font_color)
        if re.fullmatch(r'[0-9A-Fa-f]{6}', color_hex):
            style_parts.append(f'color: #{color_hex}')

    highlight_color = run.font.highlight_color if run.font else None
    if highlight_color in HIGHLIGHT_RGB_BY_INDEX:
        rgb = HIGHLIGHT_RGB_BY_INDEX[highlight_color]
        style_parts.append(f'background-color: #{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}')

    if style_parts:
        chunk = f'<span style="{"; ".join(style_parts)}">{chunk}</span>'

    if run.bold:
        chunk = f'<strong>{chunk}</strong>'
    if run.italic:
        chunk = f'<em>{chunk}</em>'
    if run.underline:
        chunk = f'<u>{chunk}</u>'
    if run.font and run.font.strike:
        chunk = f'<s>{chunk}</s>'
    if run.font and run.font.subscript:
        chunk = f'<sub>{chunk}</sub>'
    if run.font and run.font.superscript:
        chunk = f'<sup>{chunk}</sup>'

    return chunk


def paragraph_to_html_block(paragraph):
    style_name = (paragraph.style.name if paragraph.style else '').strip().lower()
    alignment = css_alignment_from_docx_alignment(paragraph.alignment)
    style_attr = f' style="text-align: {alignment}"' if alignment else ''

    inline_html = ''.join(run_to_html(run) for run in paragraph.runs)
    if not inline_html:
        inline_html = html_escape(paragraph.text or '').replace('\n', '<br/>')
    if not inline_html:
        inline_html = '<br/>'

    if 'list bullet' in style_name:
        return 'ul', f'<li{style_attr}>{inline_html}</li>'
    if 'list number' in style_name:
        return 'ol', f'<li{style_attr}>{inline_html}</li>'

    heading_match = re.search(r'heading\s*([1-6])', style_name)
    if heading_match:
        level = heading_match.group(1)
        return '', f'<h{level}{style_attr}>{inline_html}</h{level}>'

    return '', f'<p{style_attr}>{inline_html}</p>'


def extract_docx_content(filepath):
    document = docx.Document(filepath)
    plain_lines = []
    html_parts = []
    list_type = ''
    list_items = []

    def flush_list():
        nonlocal list_type, list_items
        if list_type and list_items:
            html_parts.append(f'<{list_type}>{"".join(list_items)}</{list_type}>')
        list_type = ''
        list_items = []

    for paragraph in document.paragraphs:
        plain_lines.append(paragraph.text or '')
        block_type, block_html = paragraph_to_html_block(paragraph)
        if block_type in ('ul', 'ol'):
            if list_type and list_type != block_type:
                flush_list()
            list_type = block_type
            list_items.append(block_html)
        else:
            flush_list()
            html_parts.append(block_html)

    flush_list()

    for table in document.tables:
        row_html = []
        for row in table.rows:
            cell_html = []
            cell_text_parts = []
            for cell in row.cells:
                text_value = normalize_newlines(cell.text or '').strip()
                cell_text_parts.append(text_value)
                cell_html.append(f'<td>{html_escape(text_value) if text_value else "<br/>"}</td>')
            plain_lines.append(' | '.join(cell_text_parts).strip())
            row_html.append(f'<tr>{"".join(cell_html)}</tr>')
        if row_html:
            html_parts.append(f'<table><tbody>{"".join(row_html)}</tbody></table>')

    plain_text = '\n'.join(plain_lines)
    html_content = ''.join(html_parts).strip() or plaintext_to_html(plain_text)
    return plain_text, sanitize_editor_html(html_content)


def extract_text_content(filepath):
    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        return f.read()


def extract_document_content(filepath, ext):
    file_ext = (ext or '').lower().strip('.')
    text = ''
    content_html = ''

    try:
        if file_ext == 'docx':
            text, content_html = extract_docx_content(filepath)
        elif file_ext == 'pdf':
            with open(filepath, 'rb') as f:
                reader = PyPDF2.PdfReader(f)
                for page in reader.pages:
                    text += (page.extract_text() or '') + "\n"
        elif file_ext == 'txt':
            text = extract_text_content(filepath)
            content_html = plaintext_to_html(text)
    except Exception as e:
        print(f"Error extracting content: {e}")
        text = "Text extraction failed."
        content_html = plaintext_to_html(text)

    if file_ext in ('docx', 'txt'):
        content_html = sanitize_editor_html(content_html or plaintext_to_html(text))

    return text, content_html


def extract_text(filepath, ext):
    text, _ = extract_document_content(filepath, ext)
    return text


def extract_text_from_pdf_bytes(file_bytes):
    text = ""
    try:
        reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))
        for page in reader.pages:
            page_text = page.extract_text() or ""
            text += page_text + "\n"
    except Exception as e:
        print(f"Error extracting text from PDF bytes: {e}")
        text = "Text extraction failed."
    return text


def create_pdf_bytes_from_text(content):
    try:
        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    except Exception as e:
        raise RuntimeError(
            f'PDF editing requires reportlab in current interpreter: {sys.executable}. '
            f'Install it with "{sys.executable} -m pip install reportlab".'
        ) from e

    text = content if isinstance(content, str) else str(content or '')
    text = text.replace('\r\n', '\n').replace('\r', '\n')

    stream = io.BytesIO()
    pdf_canvas = canvas.Canvas(stream, pagesize=A4)
    page_width, page_height = A4

    font_name = 'Helvetica'
    font_size = 11
    try:
        pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
        font_name = 'STSong-Light'
    except Exception:
        font_name = 'Helvetica'

    pdf_canvas.setFont(font_name, font_size)
    left_margin = 48
    top_margin = 56
    bottom_margin = 56
    line_height = 16
    max_line_width = page_width - (left_margin * 2)

    def wrap_paragraph(paragraph):
        if paragraph == '':
            return ['']

        wrapped = []
        current = ''
        for char in paragraph:
            candidate = current + char
            try:
                text_width = pdfmetrics.stringWidth(candidate, font_name, font_size)
            except Exception:
                text_width = len(candidate) * font_size * 0.6

            if text_width <= max_line_width or not current:
                current = candidate
            else:
                wrapped.append(current)
                current = char

        if current or not wrapped:
            wrapped.append(current)
        return wrapped

    y = page_height - top_margin
    paragraphs = text.split('\n')
    if not paragraphs:
        paragraphs = ['']

    for paragraph in paragraphs:
        for line in wrap_paragraph(paragraph):
            if y < bottom_margin:
                pdf_canvas.showPage()
                pdf_canvas.setFont(font_name, font_size)
                y = page_height - top_margin

            draw_text = line
            if font_name == 'Helvetica':
                draw_text = line.encode('latin-1', 'replace').decode('latin-1')

            pdf_canvas.drawString(left_margin, y, draw_text)
            y -= line_height

    pdf_canvas.save()
    stream.seek(0)
    return stream.read()


def build_editable_file_bytes(file_ext, content, content_html=''):
    ext = (file_ext or '').lower().strip('.')
    text = normalize_newlines(content if isinstance(content, str) else str(content or ''))

    if ext == 'txt':
        return text.encode('utf-8'), 'text/plain'

    if ext == 'docx':
        return create_docx_bytes_from_html(content_html, text), MIME_BY_EXT['docx']

    if ext == 'pdf':
        return create_pdf_bytes_from_text(text), MIME_BY_EXT['pdf']

    raise ValueError('Only txt, docx and pdf support direct source-file update right now.')


def write_file_bytes_to_storage(filename, file_bytes, mimetype='application/octet-stream'):
    if not filename:
        raise ValueError('filename is required')

    if S3_BUCKET and s3_client:
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=filename,
            Body=file_bytes,
            ContentType=mimetype
        )
        return

    local_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    with open(local_path, 'wb') as f:
        f.write(file_bytes)

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
            cursor = conn.execute(
                'SELECT * FROM documents WHERE username = ? ORDER BY uploaded_at DESC, id DESC',
                (username,)
            )
            docs = cursor.fetchall()
        else:
            cursor = conn.execute('SELECT * FROM documents ORDER BY uploaded_at DESC, id DESC')
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

        # 2. 提取内容 (这一步需要本地文件)
        extracted_text, extracted_html = extract_document_content(local_filepath, ext)

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
                '''
                INSERT INTO documents (
                    filename, title, uploaded_at, file_type, content, content_html, username, tags
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    unique_filename,
                    original_filename,
                    datetime.utcnow().isoformat(),
                    ext,
                    extracted_text,
                    extracted_html if ext in ('docx', 'txt') else '',
                    username,
                    ''
                )
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
            doc_data = dict(doc)
            ext = str(doc_data.get('file_type') or '').lower().strip('.')
            if ext in ('docx', 'txt') and not (doc_data.get('content_html') or '').strip():
                doc_data['content_html'] = plaintext_to_html(doc_data.get('content') or '')
            return jsonify(doc_data)
        else:
            return jsonify({'error': 'Document not found'}), 404
    finally:
        conn.close()


@app.route('/api/documents/<int:doc_id>/tags', methods=['PUT'])
def update_document_tags(doc_id):
    data = request.get_json(silent=True) or {}
    raw_tags = data.get('tags', [])

    if isinstance(raw_tags, list):
        tags_list = [str(tag).strip() for tag in raw_tags if str(tag).strip()]
    elif isinstance(raw_tags, str):
        tags_list = [tag.strip() for tag in raw_tags.split(',') if tag.strip()]
    else:
        return jsonify({'error': 'tags must be a list or comma-separated string'}), 400

    tags_value = ','.join(tags_list)

    conn = get_db_connection()
    try:
        conn.execute('UPDATE documents SET tags = ? WHERE id = ?', (tags_value, doc_id))
        conn.commit()

        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        return jsonify(dict(doc)), 200
    finally:
        conn.close()


@app.route('/api/documents/<int:doc_id>/content', methods=['PUT'])
def update_document_content(doc_id):
    data = request.get_json(silent=True) or {}
    content = data.get('content', '')
    content_html = data.get('content_html')

    if content is None:
        content = ''
    if not isinstance(content, str):
        return jsonify({'error': 'content must be a string'}), 400
    if content_html is not None and not isinstance(content_html, str):
        return jsonify({'error': 'content_html must be a string'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        file_type = (doc.get('file_type') if hasattr(doc, 'get') else doc['file_type']) or ''
        file_type = str(file_type).lower().strip('.')
        existing_html = (doc.get('content_html') if hasattr(doc, 'get') else doc['content_html']) or ''

        if file_type in ('docx', 'txt'):
            if content_html is None:
                content_html = plaintext_to_html(content)
            if not content_html.strip() and existing_html.strip():
                content_html = existing_html
            content_html = sanitize_editor_html(content_html)
            content = html_to_plaintext(content_html)
        else:
            content_html = ''

        try:
            file_bytes, mimetype = build_editable_file_bytes(file_type, content, content_html)
            filename = doc.get('filename') if hasattr(doc, 'get') else doc['filename']
            write_file_bytes_to_storage(filename, file_bytes, mimetype)
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        except RuntimeError as e:
            return jsonify({'error': str(e)}), 500
        except Exception as e:
            print(f"File update failed: {e}")
            return jsonify({'error': 'Failed to update source file'}), 500

        conn.execute(
            'UPDATE documents SET content = ?, content_html = ? WHERE id = ?',
            (content, content_html, doc_id)
        )
        conn.commit()

        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        updated_doc = cursor.fetchone()
        return jsonify(dict(updated_doc)), 200
    finally:
        conn.close()


@app.route('/api/documents/<int:doc_id>/pdf', methods=['PUT'])
def update_document_pdf_file(doc_id):
    if request.files and 'file' in request.files:
        file_bytes = request.files['file'].read()
    else:
        file_bytes = request.get_data(cache=False) or b''

    if not file_bytes:
        return jsonify({'error': 'No PDF data provided'}), 400

    if not file_bytes.lstrip().startswith(b'%PDF'):
        return jsonify({'error': 'Invalid PDF payload'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        file_type = (doc.get('file_type') if hasattr(doc, 'get') else doc['file_type']) or ''
        if str(file_type).lower() != 'pdf':
            return jsonify({'error': 'This endpoint only supports PDF documents'}), 400

        filename = doc.get('filename') if hasattr(doc, 'get') else doc['filename']
        try:
            write_file_bytes_to_storage(filename, file_bytes, MIME_BY_EXT['pdf'])
        except Exception as e:
            print(f"PDF file update failed: {e}")
            return jsonify({'error': 'Failed to update source PDF file'}), 500

        extracted_text = extract_text_from_pdf_bytes(file_bytes)
        if not extracted_text.strip():
            extracted_text = (doc.get('content') if hasattr(doc, 'get') else doc['content']) or ''
        conn.execute(
            'UPDATE documents SET content = ?, content_html = ? WHERE id = ?',
            (extracted_text, '', doc_id)
        )
        conn.commit()

        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        updated_doc = cursor.fetchone()
        return jsonify(dict(updated_doc)), 200
    finally:
        conn.close()


@app.route('/api/documents/<int:doc_id>/file', methods=['GET'])
def get_document_file(doc_id):
    conn = get_db_connection()
    try:
        cursor = conn.execute('SELECT filename, title, file_type FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
    finally:
        conn.close()

    if not doc:
        return jsonify({'error': 'Document not found'}), 404

    filename = doc['filename']
    title = doc.get('title') if hasattr(doc, 'get') else doc['title']
    file_ext = doc.get('file_type') if hasattr(doc, 'get') else doc['file_type']
    mimetype = detect_mimetype(filename, file_ext)

    if S3_BUCKET and s3_client:
        try:
            s3_obj = s3_client.get_object(Bucket=S3_BUCKET, Key=filename)
            return send_file(
                io.BytesIO(s3_obj['Body'].read()),
                mimetype=mimetype,
                download_name=title or filename,
                as_attachment=False
            )
        except Exception as e:
            print(f"S3 stream error: {e}")
            return jsonify({'error': 'Could not read file from S3'}), 500

    local_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    if not os.path.exists(local_path):
        return jsonify({'error': 'File not found'}), 404

    return send_file(
        local_path,
        mimetype=mimetype,
        download_name=title or filename,
        as_attachment=False
    )


def get_hf_headers(content_type=None):
    if not HF_TOKEN:
        return None
    result = {"Authorization": f"Bearer {HF_TOKEN}"}
    if content_type:
        result["Content-Type"] = content_type
    return result


def hf_model_url(model_id):
    return f"{HF_MODEL_BASE_URL}/{model_id}"


def hf_error_message(response):
    try:
        body = response.json()
        if isinstance(body, dict):
            if body.get('error'):
                return str(body['error'])
            if body.get('message'):
                return str(body['message'])
    except Exception:
        pass
    return (response.text or '').strip()[:240] or 'Unknown error'


def get_local_ocr_engine():
    global _rapid_ocr_engine
    if RapidOCR is None or cv2 is None or np is None:
        return None
    if _rapid_ocr_engine is None:
        _rapid_ocr_engine = RapidOCR()
    return _rapid_ocr_engine


def run_local_ocr(img_bytes):
    engine = get_local_ocr_engine()
    if engine is None:
        return '', 'RapidOCR dependencies are missing'

    try:
        image_arr = np.frombuffer(img_bytes, dtype=np.uint8)
        image = cv2.imdecode(image_arr, cv2.IMREAD_COLOR)
        if image is None:
            return '', 'Failed to decode image for local OCR'

        result, _ = engine(image)
        if not result:
            return '', 'Local OCR returned empty text'

        lines = []
        for item in result:
            if not isinstance(item, (list, tuple)) or len(item) < 2:
                continue
            line = str(item[1]).strip()
            if line:
                lines.append(line)

        text = '\n'.join(lines).strip()
        if not text:
            return '', 'Local OCR returned empty text'

        return text, ''
    except Exception as e:
        return '', f'Local OCR error: {e}'

# ==========================================
# 专家 1 号：视觉专家 (负责看图识字)
# 对应前端的【按钮 1】
# ==========================================
@app.route('/api/extract-text', methods=['POST'])
@app.route('/api/extract-text/<int:doc_id>', methods=['POST'])
def extract_text_from_image(doc_id=None):
    img_bytes = b''
    mimetype = 'application/octet-stream'

    if doc_id is not None:
        conn = get_db_connection()
        try:
            cursor = conn.execute('SELECT filename, file_type FROM documents WHERE id = ?', (doc_id,))
            doc = cursor.fetchone()
        finally:
            conn.close()

        if not doc:
            return jsonify({"error": "Document not found"}), 404

        filename = doc.get('filename') if hasattr(doc, 'get') else doc['filename']
        file_type = doc.get('file_type') if hasattr(doc, 'get') else doc['file_type']
        if str(file_type or '').lower() not in ('png', 'jpg', 'jpeg', 'webp', 'gif'):
            return jsonify({"error": "This endpoint only supports image documents"}), 400
        mimetype = detect_mimetype(filename, file_type)

        try:
            if S3_BUCKET and s3_client:
                s3_obj = s3_client.get_object(Bucket=S3_BUCKET, Key=filename)
                img_bytes = s3_obj['Body'].read()
            else:
                local_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
                if not os.path.exists(local_path):
                    return jsonify({"error": "Source image not found"}), 404
                with open(local_path, 'rb') as f:
                    img_bytes = f.read()
        except Exception as e:
            return jsonify({"error": f"Failed to read source image: {e}"}), 500
    else:
        if 'image' not in request.files:
            return jsonify({"error": "No image provided"}), 400
        file = request.files['image']
        mimetype = file.mimetype or 'application/octet-stream'
        img_bytes = file.read()

    if not img_bytes:
        return jsonify({"error": "Empty image file"}), 400

    hf_error = ''
    hf_headers = get_hf_headers(mimetype or 'application/octet-stream')
    if hf_headers:
        try:
            response = requests.post(hf_model_url(OCR_MODEL_ID), headers=hf_headers, data=img_bytes, timeout=90)
            if response.status_code < 400:
                try:
                    ocr_result = response.json()
                    extracted_text = ''
                    if isinstance(ocr_result, list) and ocr_result and isinstance(ocr_result[0], dict):
                        extracted_text = str(ocr_result[0].get('generated_text', '')).strip()
                    elif isinstance(ocr_result, dict):
                        extracted_text = str(ocr_result.get('generated_text', '')).strip()

                    if extracted_text:
                        return jsonify({"text": extracted_text, "source": "huggingface"})
                    hf_error = "HF OCR returned empty text"
                except Exception:
                    hf_error = f"HF OCR returned non-JSON response: {hf_error_message(response)}"
            else:
                hf_error = f"HF OCR failed ({response.status_code}): {hf_error_message(response)}"
        except Exception as e:
            hf_error = f"HF OCR error: {e}"
    else:
        hf_error = "HF_API_TOKEN is not configured on server"

    local_text, local_error = run_local_ocr(img_bytes)
    if local_text:
        return jsonify({"text": local_text, "source": "rapidocr", "note": hf_error or None})

    if '404' in hf_error:
        hf_error = (
            hf_error
            + ". Hugging Face hf-inference currently has no OCR image endpoint for this model/account."
        )

    return jsonify({
        "error": "OCR failed",
        "details": {
            "huggingface": hf_error,
            "local": local_error,
            "hint": "Install/enable RapidOCR fallback or configure another OCR provider."
        }
    }), 502


# ==========================================
# 专家 2 号：语言专家 (负责摘要和提取关键词)
# 对应前端的【按钮 2】
# ==========================================
@app.route('/api/analyze-text', methods=['POST'])
def analyze_text():
    data = request.get_json(silent=True) or {}
    text_content = (data.get('text') or '').strip()

    if not text_content:
        return jsonify({"error": "No text provided"}), 400

    summary = ""
    summary_source = "fallback"
    summary_note = ""
    hf_headers = get_hf_headers('application/json')
    if hf_headers:
        try:
            payload = {
                "inputs": text_content[:4000],
                "parameters": {"max_new_tokens": 120, "min_new_tokens": 24, "do_sample": False},
                "options": {"wait_for_model": True}
            }
            response = requests.post(hf_model_url(SUMMARIZER_MODEL_ID), headers=hf_headers, json=payload, timeout=90)
            if response.status_code < 400:
                summary_res = response.json()
                if isinstance(summary_res, list) and summary_res and isinstance(summary_res[0], dict):
                    summary = str(summary_res[0].get('summary_text') or summary_res[0].get('generated_text') or '').strip()
                elif isinstance(summary_res, dict):
                    summary = str(summary_res.get('summary_text') or summary_res.get('generated_text') or '').strip()
                if summary:
                    summary_source = "huggingface"
            else:
                summary_note = f"Summary service failed ({response.status_code})."
        except Exception:
            summary_note = "AI service busy."
    else:
        summary_note = "HF_API_TOKEN is not configured on server."

    if not summary:
        cleaned = re.sub(r'\s+', ' ', text_content)
        summary = cleaned[:220]

    keywords = []
    try:
        if len(text_content.split()) > 5:
            vectorizer = TfidfVectorizer(stop_words='english', max_features=5)
            vectorizer.fit_transform([text_content])
            keywords = vectorizer.get_feature_names_out().tolist()
    except Exception:
        keywords = ["Not enough text"]

    return jsonify({
        "summary": summary,
        "keywords": keywords,
        "summary_source": summary_source,
        "summary_note": summary_note
    })

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
