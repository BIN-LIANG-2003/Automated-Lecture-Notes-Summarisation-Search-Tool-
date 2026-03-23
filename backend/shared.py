import os
import io
import sys
import json
import hashlib
import re
import shutil
import subprocess
import tempfile
import requests
from datetime import datetime, timedelta
from flask import request, jsonify, send_from_directory, redirect
from werkzeug.security import generate_password_hash, check_password_hash
from sklearn.feature_extraction.text import TfidfVectorizer

# --- Google 登录库 ---
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

from .config import (
    DEFAULT_WORKSPACE_SETTINGS,
    ENABLE_PDF_OCR_FALLBACK,
    GOOGLE_CLIENT_ID,
    HF_MODEL_BASE_URL,
    HF_TOKEN,
    OCR_MODEL_ID,
    OCRMYPDF_BINARY,
    OCRMYPDF_LANGUAGE,
    OCRMYPDF_TIMEOUT_SECONDS,
    S3_BUCKET,
    SUMMARY_CACHE_VERSION,
    SUMMARIZER_MODEL_ID,
    s3_client,
)
from .db import get_db_connection
from .document_domain import extract_text_from_pdf_bytes_with_meta, normalize_newlines
from .security import create_auth_token
from .share_domain import (
    check_document_access,
    is_document_soft_deleted,
)
from .storage import (
    detect_mimetype,
    read_file_bytes_from_storage,
)
from .utils import (
    parse_bool,
    parse_float,
    parse_int,
    row_to_dict,
    utcnow_iso,
)
from .workspace_domain import (
    get_workspace_settings,
    normalize_workspace_settings,
    workspace_belongs_to_user,
)


# ================= 配置部分 =================
app = None


# ================= 辅助函数 =================


def build_summary_cache_text_hash(text):
    normalized = re.sub(r'\s+', ' ', str(text or '').strip())
    if not normalized:
        return ''
    payload = f"{SUMMARY_CACHE_VERSION}:{normalized}"
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def load_document_summary_cache(conn, document_id, content_hash, summary_length, keyword_limit):
    safe_doc_id = parse_int(document_id, 0, 0)
    safe_hash = str(content_hash or '').strip()
    safe_summary_length = str(summary_length or '').strip().lower()
    safe_keyword_limit = parse_int(keyword_limit, 5, 1)
    if safe_doc_id <= 0 or not safe_hash or not safe_summary_length:
        return None
    try:
        cursor = conn.execute(
            '''
            SELECT summary_json, summary_source, summary_note, created_at, updated_at
            FROM document_summary_cache
            WHERE document_id = ?
              AND content_hash = ?
              AND summary_length = ?
              AND keyword_limit = ?
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
            ''',
            (safe_doc_id, safe_hash, safe_summary_length, safe_keyword_limit)
        )
        row = row_to_dict(cursor.fetchone())
        if not row:
            return None
        raw_json = row.get('summary_json')
        try:
            payload = json.loads(raw_json) if isinstance(raw_json, str) else {}
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        payload['summary_source'] = str(
            payload.get('summary_source') or row.get('summary_source') or 'cache'
        ).strip().lower() or 'cache'
        payload['summary_note'] = str(payload.get('summary_note') or row.get('summary_note') or '').strip()
        payload['cached_at'] = row.get('updated_at') or row.get('created_at') or utcnow_iso()
        return payload
    except Exception as e:
        print(f"⚠️ Summary cache read failed: {e}")
        return None


def save_document_summary_cache(
    conn,
    document_id,
    workspace_id,
    username,
    content_hash,
    summary_length,
    keyword_limit,
    payload
):
    safe_doc_id = parse_int(document_id, 0, 0)
    safe_hash = str(content_hash or '').strip()
    safe_summary_length = str(summary_length or '').strip().lower()
    safe_keyword_limit = parse_int(keyword_limit, 5, 1)
    if safe_doc_id <= 0 or not safe_hash or not safe_summary_length:
        return False
    if not isinstance(payload, dict) or not str(payload.get('summary') or '').strip():
        return False

    safe_payload = {
        'summary': str(payload.get('summary') or '').strip(),
        'keywords': payload.get('keywords') if isinstance(payload.get('keywords'), list) else [],
        'key_sentences': payload.get('key_sentences') if isinstance(payload.get('key_sentences'), list) else [],
        'summary_source': str(payload.get('summary_source') or '').strip().lower() or 'fallback',
        'summary_note': str(payload.get('summary_note') or '').strip(),
    }
    summary_json = json.dumps(safe_payload, ensure_ascii=False)
    now_iso = utcnow_iso()
    safe_workspace_id = str(workspace_id or '').strip()
    safe_username = str(username or '').strip()
    try:
        conn.execute(
            '''
            DELETE FROM document_summary_cache
            WHERE document_id = ?
              AND content_hash = ?
              AND summary_length = ?
              AND keyword_limit = ?
            ''',
            (safe_doc_id, safe_hash, safe_summary_length, safe_keyword_limit)
        )
        conn.execute(
            '''
            INSERT INTO document_summary_cache (
                document_id,
                workspace_id,
                username,
                content_hash,
                summary_length,
                keyword_limit,
                summary_json,
                summary_source,
                summary_note,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            (
                safe_doc_id,
                safe_workspace_id,
                safe_username,
                safe_hash,
                safe_summary_length,
                safe_keyword_limit,
                summary_json,
                safe_payload.get('summary_source') or '',
                safe_payload.get('summary_note') or '',
                now_iso,
                now_iso,
            )
        )
        conn.commit()
        return True
    except Exception as e:
        print(f"⚠️ Summary cache write failed: {e}")
        return False


# ================= API 路由接口 =================

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
        auth_token = create_auth_token(username)
        return jsonify({
            'message': 'User created successfully',
            'username': username,
            'email': email,
            'auth_token': auth_token,
        }), 201
    except Exception as e:
        return jsonify({'error': f'Registration failed (User may exist): {str(e)}'}), 409
    finally:
        conn.close()

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
        user_email = user.get('email') if hasattr(user, 'get') else user['email']
        auth_token = create_auth_token(user['username'])
        return jsonify({
            'message': 'Login successful',
            'username': user['username'],
            'email': user_email,
            'auth_token': auth_token,
        }), 200
    else:
        return jsonify({'error': 'Invalid credentials'}), 401

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
        user_email = user.get('email') if hasattr(user, 'get') else user['email']
        auth_token = create_auth_token(user['username'])
        return jsonify({
            'message': 'Login successful',
            'username': user['username'],
            'email': user_email,
            'auth_token': auth_token,
        }), 200
    except ValueError:
        return jsonify({'error': 'Invalid Google token'}), 401
    except Exception as e:
        print(f"Google login error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

def extract_key_sentences(text_content, keywords=None, limit=3):
    normalized = normalize_newlines(text_content or '')
    fragments = [part.strip() for part in re.split(r'(?<=[.!?。！？])\s+', normalized) if part.strip()]
    if not fragments:
        return []

    keyword_list = [
        str(item).strip().lower()
        for item in (keywords or [])
        if str(item).strip()
    ]
    keyword_list = [item for item in keyword_list if item != 'not enough text']

    scored = []
    for idx, sentence in enumerate(fragments[:150]):
        lower_sentence = sentence.lower()
        score = 0
        for keyword in keyword_list:
            score += lower_sentence.count(keyword) * 2
        score += min(len(sentence.split()) / 8.0, 1.5)
        scored.append((score, -idx, sentence))

    scored.sort(reverse=True)
    top = []
    for _, _, sentence in scored:
        if sentence in top:
            continue
        top.append(sentence)
        if len(top) >= max(1, int(limit or 3)):
            break

    if not top:
        top = fragments[:max(1, int(limit or 3))]
    return top

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


def split_text_for_summary(text_content, max_chars=3600, min_chars=1200, overlap_chars=220):
    normalized = normalize_newlines(text_content or '')
    normalized = re.sub(r'[ \t]+', ' ', normalized).strip()
    if not normalized:
        return []
    if len(normalized) <= max_chars:
        return [normalized]

    markers = (
        ('\n\n', 2),
        ('. ', 2),
        ('! ', 2),
        ('? ', 2),
        ('。', 1),
        ('！', 1),
        ('？', 1),
        ('; ', 2),
        ('；', 1),
    )
    chunks = []
    start = 0
    total_len = len(normalized)
    guard = 0

    while start < total_len and guard < 10000:
        guard += 1
        hard_end = min(total_len, start + max_chars)
        end = hard_end

        if hard_end < total_len:
            window = normalized[start:hard_end]
            best_pos = -1
            best_tail = 0
            for marker, tail in markers:
                marker_pos = window.rfind(marker)
                if marker_pos > best_pos:
                    best_pos = marker_pos
                    best_tail = tail
            if best_pos >= min_chars:
                end = start + best_pos + best_tail

        if end <= start:
            end = hard_end

        chunk = normalized[start:end].strip()
        if chunk:
            chunks.append(chunk)

        if end >= total_len:
            break

        next_start = max(0, end - max(0, overlap_chars))
        if next_start <= start:
            next_start = end
        start = next_start

    if not chunks:
        return [normalized[:max_chars]]
    return chunks


def build_fallback_summary(text_content, sentence_limit=3, max_chars=560):
    raw_text = normalize_newlines(text_content or '')
    raw_text = re.sub(r'(?im)^\s*part\s+\d+\s*:\s*', '', raw_text)
    raw_text = re.sub(r'[ \t]+', ' ', raw_text).strip()
    if not raw_text:
        return ''

    safe_limit = max(1, int(sentence_limit or 3))
    fragments = [
        part.strip()
        for part in re.split(r'(?<=[.!?。！？])\s+|\n+', raw_text)
        if part.strip()
    ]

    if len(fragments) < safe_limit:
        compact_lines = [
            part.strip()
            for part in re.split(r'\n+', normalize_newlines(text_content or ''))
            if part.strip()
        ]
        for item in compact_lines:
            candidate = re.sub(r'\s+', ' ', item)
            if candidate and candidate not in fragments:
                fragments.append(candidate)

    if fragments:
        if len(fragments) <= safe_limit:
            picked = fragments
        else:
            picked = []
            key_indexes = [0, len(fragments) // 2, len(fragments) - 1]
            for idx in key_indexes:
                sentence = fragments[idx]
                if sentence not in picked:
                    picked.append(sentence)
                if len(picked) >= safe_limit:
                    break
            if len(picked) < safe_limit:
                for sentence in fragments:
                    if sentence in picked:
                        continue
                    picked.append(sentence)
                    if len(picked) >= safe_limit:
                        break
        summary = ' '.join(picked[:safe_limit]).strip()
    else:
        summary = raw_text

    if len(summary) > max_chars:
        text_len = len(summary)
        slice_len = max(90, max_chars // max(1, safe_limit))
        points = [0, text_len // 2, max(0, text_len - slice_len)]
        excerpts = []
        for point in points:
            start = max(0, min(point, max(0, text_len - slice_len)))
            end = min(text_len, start + slice_len)
            snippet = summary[start:end].strip()
            if snippet and snippet not in excerpts:
                excerpts.append(snippet)
        summary = ' ... '.join(excerpts).strip() or summary[:max_chars]
        if len(summary) > max_chars:
            clipped = summary[:max_chars]
            summary = clipped.rsplit(' ', 1)[0].strip() or clipped

    return summary


def call_hf_summarizer_once(text_content, length_options):
    safe_text = str(text_content or '').strip()
    if not safe_text:
        return {'ok': False, 'summary': '', 'error': 'Empty input text'}

    hf_headers = get_hf_headers('application/json')
    if not hf_headers:
        return {'ok': False, 'summary': '', 'error': 'HF_API_TOKEN is not configured on server.'}

    payload = {
        "inputs": safe_text,
        "parameters": {
            "max_new_tokens": length_options['max_new_tokens'],
            "min_new_tokens": length_options['min_new_tokens'],
            "do_sample": False
        },
        "options": {"wait_for_model": True}
    }

    try:
        response = requests.post(
            hf_model_url(SUMMARIZER_MODEL_ID),
            headers=hf_headers,
            json=payload,
            timeout=90
        )
    except Exception as e:
        return {'ok': False, 'summary': '', 'error': str(e) or 'AI service busy.'}

    if response.status_code >= 400:
        return {
            'ok': False,
            'summary': '',
            'error': f"Summary service failed ({response.status_code}): {hf_error_message(response)}"
        }

    summary = ''
    try:
        summary_res = response.json()
        if isinstance(summary_res, list) and summary_res and isinstance(summary_res[0], dict):
            summary = str(
                summary_res[0].get('summary_text')
                or summary_res[0].get('generated_text')
                or ''
            ).strip()
        elif isinstance(summary_res, dict):
            summary = str(
                summary_res.get('summary_text')
                or summary_res.get('generated_text')
                or ''
            ).strip()
    except Exception:
        summary = ''

    if summary:
        return {'ok': True, 'summary': summary, 'error': ''}

    return {'ok': False, 'summary': '', 'error': 'Summary service returned empty output.'}


def summarize_text_with_chunk_merge(text_content, length_options):
    safe_text = str(text_content or '').strip()
    sentence_limit = max(1, int((length_options or {}).get('sentence_limit', 3) or 3))
    hf_available = bool(get_hf_headers('application/json'))
    chunks = split_text_for_summary(
        safe_text,
        max_chars=3600,
        min_chars=1200,
        overlap_chars=220
    )

    if not chunks:
        return {
            'summary': '',
            'summary_source': 'fallback',
            'summary_note': 'No text provided.',
            'meta': {'chunk_count': 0, 'merge_rounds': 0}
        }

    hf_success_count = 0
    fallback_count = 0
    error_samples = []

    def summarize_unit(unit_text):
        nonlocal hf_success_count, fallback_count, error_samples
        result = call_hf_summarizer_once(unit_text, length_options)
        if result.get('ok'):
            hf_success_count += 1
            return str(result.get('summary') or '').strip()

        fallback_count += 1
        err = str(result.get('error') or '').strip()
        if err and err not in error_samples and len(error_samples) < 2:
            error_samples.append(err)
        return build_fallback_summary(
            unit_text,
            sentence_limit=max(2, sentence_limit),
            max_chars=560
        )

    layer = [summarize_unit(chunk) for chunk in chunks]
    merge_rounds = 0
    if not hf_available and len(layer) > 1:
        merge_rounds = 1
        pick_idx = [0, len(layer) // 2, len(layer) - 1]
        picked = []
        for idx in pick_idx:
            unit = str(layer[idx] or '').strip()
            if unit and unit not in picked:
                picked.append(unit)
        combined = '\n'.join(picked).strip()
        layer = [build_fallback_summary(combined or safe_text, sentence_limit=max(3, sentence_limit), max_chars=780)]
    else:
        while len(layer) > 1 and merge_rounds < 5:
            merge_rounds += 1
            combined_text = '\n\n'.join(
                part
                for part in layer
                if str(part).strip()
            ).strip()
            if not combined_text:
                break
            merge_chunks = split_text_for_summary(
                combined_text,
                max_chars=3400,
                min_chars=900,
                overlap_chars=120
            )
            if not merge_chunks:
                break
            layer = [summarize_unit(chunk) for chunk in merge_chunks]

    summary = str(layer[0] if layer else '').strip()
    if not summary:
        summary = build_fallback_summary(
            safe_text,
            sentence_limit=max(3, sentence_limit),
            max_chars=560
        )
        fallback_count += 1

    summary_source = 'huggingface' if hf_success_count > 0 else 'fallback'
    note_parts = []
    if len(chunks) > 1:
        note_parts.append(f"Chunked summary used {len(chunks)} sections")
    if merge_rounds > 0:
        note_parts.append(f"{merge_rounds} merge round(s)")
    if fallback_count > 0:
        note_parts.append(f"{fallback_count} section(s) used fallback")
    if error_samples:
        note_parts.append("HF note: " + ' | '.join(error_samples))
    summary_note = '; '.join(note_parts)

    return {
        'summary': summary,
        'summary_source': summary_source,
        'summary_note': summary_note,
        'meta': {
            'chunk_count': len(chunks),
            'merge_rounds': merge_rounds,
            'hf_success_count': hf_success_count,
            'fallback_count': fallback_count,
        }
    }


def normalize_ocr_text(payload, depth=0):
    if depth > 5 or payload is None:
        return ''
    if isinstance(payload, str):
        return payload.strip()
    if isinstance(payload, (int, float, bool)):
        return str(payload).strip()
    if isinstance(payload, bytes):
        try:
            return payload.decode('utf-8', errors='ignore').strip()
        except Exception:
            return ''

    if isinstance(payload, list):
        parts = []
        for item in payload:
            text = normalize_ocr_text(item, depth + 1)
            if text:
                parts.append(text)
        return '\n'.join(parts).strip() if parts else ''

    if isinstance(payload, dict):
        preferred_keys = (
            'text',
            'ocr_text',
            'extracted_text',
            'result',
            'content',
            'generated_text',
            'output_text',
            'prediction',
            'predictions',
            'value',
            'data',
            'lines',
            'texts',
        )
        for key in preferred_keys:
            if key not in payload:
                continue
            text = normalize_ocr_text(payload.get(key), depth + 1)
            if text:
                return text

        choices = payload.get('choices')
        if isinstance(choices, list):
            parts = []
            for choice in choices:
                if not isinstance(choice, dict):
                    continue
                message = choice.get('message')
                if isinstance(message, dict):
                    text = normalize_ocr_text(message.get('content'), depth + 1)
                else:
                    text = normalize_ocr_text(choice.get('text'), depth + 1)
                if text:
                    parts.append(text)
            if parts:
                return '\n'.join(parts).strip()

    return ''


def get_ocr_runtime_status():
    ocrmypdf_path = shutil.which(OCRMYPDF_BINARY)
    status = {
        'hf_token_configured': bool(HF_TOKEN),
        'hf_ocr_model': OCR_MODEL_ID,
        'hf_model_base_url': HF_MODEL_BASE_URL,
        'pdf_ocr_fallback_enabled': ENABLE_PDF_OCR_FALLBACK,
        'ocrmypdf_binary': OCRMYPDF_BINARY,
        'ocrmypdf_available': bool(ocrmypdf_path),
        'ocrmypdf_path': ocrmypdf_path or '',
        'ocrmypdf_language': OCRMYPDF_LANGUAGE,
        'hints': [],
    }

    if not status['hf_token_configured']:
        status['hints'].append('Set HF_API_TOKEN in environment variables to enable Hugging Face OCR.')
    if ENABLE_PDF_OCR_FALLBACK and not status['ocrmypdf_available']:
        status['hints'].append('Install ocrmypdf binary to enable automatic PDF OCR fallback for low-quality text extraction.')

    return status


def ocr_health():
    status = get_ocr_runtime_status()
    ok = bool(status.get('hf_token_configured'))
    status['ok'] = ok
    status['checked_at'] = utcnow_iso()
    if not ok:
        status['hints'].append('No OCR provider is ready. Configure HF_API_TOKEN to enable Hugging Face OCR.')
    return jsonify(status), (200 if ok else 503)

# ==========================================
# 专家 1 号：视觉专家 (负责看图识字)
# 对应前端的【按钮 1】
# ==========================================
def extract_text_from_image(doc_id=None):
    username = (request.values.get('username') or '').strip()
    share_token = (request.values.get('share_token') or '').strip()
    requested_workspace_id = (request.values.get('workspace_id') or '').strip()
    img_bytes = b''
    mimetype = 'application/octet-stream'
    source_filename = 'image.jpg'

    if doc_id is not None:
        conn = get_db_connection()
        if not conn:
            return jsonify({'error': 'Database connection failed'}), 500
        doc = None
        workspace_settings = dict(DEFAULT_WORKSPACE_SETTINGS)
        try:
            cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
            doc = cursor.fetchone()
            if doc:
                allowed, reason = check_document_access(conn, doc, username, share_token)
                if not allowed:
                    return jsonify({"error": reason}), 403

                workspace_id = str(
                    (doc.get('workspace_id') if hasattr(doc, 'get') else doc['workspace_id']) or ''
                ).strip()
                workspace_settings = get_workspace_settings(conn, workspace_id)
        finally:
            conn.close()

        if not doc:
            return jsonify({"error": "Document not found"}), 404
        if not workspace_settings.get('allow_ai_tools', True):
            return jsonify({"error": "AI tools are disabled in this workspace settings"}), 403
        if not workspace_settings.get('allow_ocr', True):
            return jsonify({"error": "OCR is disabled in this workspace settings"}), 403

        filename = doc.get('filename') if hasattr(doc, 'get') else doc['filename']
        file_type = doc.get('file_type') if hasattr(doc, 'get') else doc['file_type']
        source_filename = str(filename or source_filename)
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
        if username:
            conn = get_db_connection()
            if not conn:
                return jsonify({'error': 'Database connection failed'}), 500
            try:
                workspace_id = requested_workspace_id
                if not workspace_id:
                    default_cursor = conn.execute(
                        '''
                        SELECT id
                        FROM workspaces
                        WHERE owner_username = ?
                        ORDER BY created_at ASC, id ASC
                        LIMIT 1
                        ''',
                        (username,)
                    )
                    default_row = row_to_dict(default_cursor.fetchone())
                    workspace_id = str(default_row.get('id') or '').strip()
                if workspace_id and not workspace_belongs_to_user(conn, workspace_id, username):
                    return jsonify({'error': 'No access to this workspace'}), 403
                workspace_settings = get_workspace_settings(conn, workspace_id)
            finally:
                conn.close()

            if not workspace_settings.get('allow_ai_tools', True):
                return jsonify({"error": "AI tools are disabled in this workspace settings"}), 403
            if not workspace_settings.get('allow_ocr', True):
                return jsonify({"error": "OCR is disabled in this workspace settings"}), 403

        if 'image' not in request.files:
            return jsonify({"error": "No image provided"}), 400
        file = request.files['image']
        mimetype = file.mimetype or 'application/octet-stream'
        source_filename = str(file.filename or source_filename)
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
                    extracted_text = normalize_ocr_text(ocr_result)

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

    runtime_status = get_ocr_runtime_status()

    if '404' in hf_error:
        hf_error = (
            hf_error
            + ". Hugging Face hf-inference currently has no OCR image endpoint for this model/account."
        )

    error_text = hf_error
    return jsonify({
        "error": f"OCR failed: {error_text}" if error_text else "OCR failed",
        "details": {
            "huggingface": hf_error,
            "runtime": runtime_status,
            "hint": "Configure HF_API_TOKEN and a valid HF OCR model to enable OCR."
        }
    }), 502


# ==========================================
# 专家 2 号：语言专家 (负责摘要和提取关键词)
# 对应前端的【按钮 2】
# ==========================================
def analyze_text():
    data = request.get_json(silent=True) or {}
    username = str(data.get('username') or '').strip()
    share_token = str(data.get('share_token') or '').strip()
    requested_workspace_id = str(data.get('workspace_id') or '').strip()
    requested_doc_id = parse_int(data.get('doc_id', 0), 0, 0)
    force_refresh = parse_bool(data.get('force_refresh'), False)
    workspace_settings = dict(DEFAULT_WORKSPACE_SETTINGS)
    workspace_id = requested_workspace_id
    doc_text_content = ''
    document_owner_username = ''
    text_source = 'request_text'
    refreshed_from_file = False
    pdf_refresh_meta = {}

    if requested_doc_id > 0:
        conn = get_db_connection()
        if not conn:
            return jsonify({'error': 'Database connection failed'}), 500
        try:
            cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (requested_doc_id,))
            doc = cursor.fetchone()
            if not doc:
                return jsonify({'error': 'Document not found'}), 404

            allowed, reason = check_document_access(conn, doc, username, share_token)
            if not allowed:
                return jsonify({'error': reason}), 403

            workspace_id = str(
                (doc.get('workspace_id') if hasattr(doc, 'get') else doc['workspace_id']) or ''
            ).strip()
            workspace_settings = get_workspace_settings(conn, workspace_id)
            doc_text_content = str(
                (doc.get('content') if hasattr(doc, 'get') else doc['content']) or ''
            ).strip()
            document_owner_username = str(
                (doc.get('username') if hasattr(doc, 'get') else doc['username']) or ''
            ).strip()

            # On explicit rebuild, refresh PDF text from source file so summary
            # uses latest/full extraction quality instead of stale db content.
            doc_file_type = str(
                (doc.get('file_type') if hasattr(doc, 'get') else doc['file_type']) or ''
            ).strip().lower()
            doc_filename = str(
                (doc.get('filename') if hasattr(doc, 'get') else doc['filename']) or ''
            ).strip()
            if force_refresh and doc_file_type == 'pdf' and doc_filename:
                try:
                    source_bytes = read_file_bytes_from_storage(doc_filename)
                    refreshed_text, refresh_meta = extract_text_from_pdf_bytes_with_meta(source_bytes)
                    pdf_refresh_meta = refresh_meta if isinstance(refresh_meta, dict) else {}
                    refreshed_text = str(refreshed_text or '').strip()
                    if refreshed_text:
                        if refreshed_text != doc_text_content:
                            conn.execute(
                                'UPDATE documents SET content = ?, content_html = ? WHERE id = ?',
                                (refreshed_text, '', requested_doc_id)
                            )
                            conn.commit()
                        doc_text_content = refreshed_text
                        refreshed_from_file = True
                except Exception as e:
                    print(f"PDF re-extraction on summary refresh failed: {e}")
        finally:
            conn.close()

        if not workspace_settings.get('allow_ai_tools', True):
            return jsonify({"error": "AI tools are disabled in this workspace settings"}), 403
    elif username:
        conn = get_db_connection()
        if not conn:
            return jsonify({'error': 'Database connection failed'}), 500
        try:
            workspace_id = requested_workspace_id
            if not workspace_id:
                default_cursor = conn.execute(
                    '''
                    SELECT id
                    FROM workspaces
                    WHERE owner_username = ?
                    ORDER BY created_at ASC, id ASC
                    LIMIT 1
                    ''',
                    (username,)
                )
                default_row = row_to_dict(default_cursor.fetchone())
                workspace_id = str(default_row.get('id') or '').strip()
            if workspace_id and not workspace_belongs_to_user(conn, workspace_id, username):
                return jsonify({'error': 'No access to this workspace'}), 403
            workspace_settings = get_workspace_settings(conn, workspace_id)
        finally:
            conn.close()

        if not workspace_settings.get('allow_ai_tools', True):
            return jsonify({"error": "AI tools are disabled in this workspace settings"}), 403

    text_content = (data.get('text') or '').strip()
    if not text_content and doc_text_content:
        text_content = doc_text_content
        text_source = 'document_content'
    elif not text_content:
        text_source = 'empty'
    summary_length = str(
        data.get('summary_length')
        or workspace_settings.get('summary_length')
        or DEFAULT_WORKSPACE_SETTINGS['summary_length']
    ).strip().lower()
    if summary_length not in WORKSPACE_SUMMARY_LENGTH_LEVELS:
        summary_length = DEFAULT_WORKSPACE_SETTINGS['summary_length']
    keyword_limit = parse_int(
        data.get('keyword_limit', workspace_settings.get('keyword_limit', DEFAULT_WORKSPACE_SETTINGS['keyword_limit'])),
        5,
        3,
        12
    )

    token_map = {
        'short': {'max_new_tokens': 80, 'min_new_tokens': 18, 'sentence_limit': 2},
        'medium': {'max_new_tokens': 120, 'min_new_tokens': 24, 'sentence_limit': 3},
        'long': {'max_new_tokens': 200, 'min_new_tokens': 48, 'sentence_limit': 5},
    }
    length_options = token_map.get(summary_length, token_map['medium'])

    if not text_content:
        if requested_doc_id > 0:
            return jsonify({
                "error": "No text available in this document. Open the note and add/edit content first.",
                "details": {"doc_id": requested_doc_id}
            }), 400
        return jsonify({"error": "No text provided"}), 400

    use_document_cache = requested_doc_id > 0 and text_source == 'document_content'
    text_hash = build_summary_cache_text_hash(text_content)
    text_char_count = len(text_content)
    text_word_count = len(re.findall(r'\S+', text_content))
    base_options_used = {
        "summary_length": summary_length,
        "keyword_limit": keyword_limit,
        "sentence_limit": length_options['sentence_limit'],
        "chunk_count": 1,
        "merge_rounds": 0,
        "refreshed_from_file": refreshed_from_file,
        "pdf_extractor": str(pdf_refresh_meta.get('extractor') or ''),
        "pdf_ocr_attempted": bool(pdf_refresh_meta.get('ocr_attempted')),
        "pdf_ocr_used": bool(pdf_refresh_meta.get('ocr_used')),
        "pdf_quality_score_before": parse_float(pdf_refresh_meta.get('quality_score_before'), 0.0),
        "pdf_quality_score_after": parse_float(pdf_refresh_meta.get('quality_score_after'), 0.0),
        "text_char_count": text_char_count,
        "text_word_count": text_word_count,
        "summarizer_model": SUMMARIZER_MODEL_ID,
    }
    if use_document_cache and text_hash and not force_refresh:
        conn = get_db_connection()
        if conn:
            try:
                cached_payload = load_document_summary_cache(
                    conn,
                    requested_doc_id,
                    text_hash,
                    summary_length,
                    keyword_limit
                )
            finally:
                conn.close()
            if cached_payload:
                cached_options_raw = cached_payload.get("options_used")
                cached_options = cached_options_raw if isinstance(cached_options_raw, dict) else {}
                options_used = dict(base_options_used)
                if cached_options:
                    options_used["summary_length"] = str(
                        cached_options.get("summary_length") or summary_length
                    ).strip().lower() or summary_length
                    options_used["keyword_limit"] = parse_int(
                        cached_options.get("keyword_limit"),
                        keyword_limit,
                        3,
                        12
                    )
                    options_used["sentence_limit"] = parse_int(
                        cached_options.get("sentence_limit"),
                        length_options['sentence_limit'],
                        1,
                        20
                    )
                    options_used["chunk_count"] = parse_int(
                        cached_options.get("chunk_count"),
                        1,
                        1
                    )
                    options_used["merge_rounds"] = parse_int(
                        cached_options.get("merge_rounds"),
                        0,
                        0
                    )
                    options_used["refreshed_from_file"] = parse_bool(
                        cached_options.get("refreshed_from_file"),
                        refreshed_from_file
                    )
                    options_used["pdf_extractor"] = str(
                        cached_options.get("pdf_extractor") or options_used["pdf_extractor"]
                    ).strip()
                    options_used["pdf_ocr_attempted"] = parse_bool(
                        cached_options.get("pdf_ocr_attempted"),
                        options_used["pdf_ocr_attempted"]
                    )
                    options_used["pdf_ocr_used"] = parse_bool(
                        cached_options.get("pdf_ocr_used"),
                        options_used["pdf_ocr_used"]
                    )
                    options_used["pdf_quality_score_before"] = parse_float(
                        cached_options.get("pdf_quality_score_before"),
                        options_used["pdf_quality_score_before"]
                    )
                    options_used["pdf_quality_score_after"] = parse_float(
                        cached_options.get("pdf_quality_score_after"),
                        options_used["pdf_quality_score_after"]
                    )
                    options_used["text_char_count"] = parse_int(
                        cached_options.get("text_char_count"),
                        text_char_count,
                        0
                    )
                    options_used["text_word_count"] = parse_int(
                        cached_options.get("text_word_count"),
                        text_word_count,
                        0
                    )
                    options_used["summarizer_model"] = str(
                        cached_options.get("summarizer_model") or SUMMARIZER_MODEL_ID
                    ).strip() or SUMMARIZER_MODEL_ID
                return jsonify({
                    "summary": str(cached_payload.get("summary") or '').strip(),
                    "keywords": cached_payload.get("keywords") if isinstance(cached_payload.get("keywords"), list) else [],
                    "key_sentences": (
                        cached_payload.get("key_sentences")
                        if isinstance(cached_payload.get("key_sentences"), list)
                        else []
                    ),
                    "summary_source": str(
                        cached_payload.get("summary_source") or "cache"
                    ).strip().lower() or "cache",
                    "summary_note": str(cached_payload.get("summary_note") or '').strip(),
                    "text_source": text_source,
                    "document_id": requested_doc_id,
                    "cache_hit": True,
                    "cached_at": cached_payload.get("cached_at"),
                    "options_used": options_used,
                })

    summary_result = summarize_text_with_chunk_merge(text_content, length_options)
    summary = str(summary_result.get('summary') or '').strip()
    summary_source = str(summary_result.get('summary_source') or 'fallback').strip().lower() or 'fallback'
    summary_note = str(summary_result.get('summary_note') or '').strip()
    summary_meta = summary_result.get('meta') if isinstance(summary_result.get('meta'), dict) else {}
    pdf_refresh_note = str(pdf_refresh_meta.get('note') or '').strip()

    if pdf_refresh_note and force_refresh and requested_doc_id > 0:
        summary_note = f"{summary_note}; PDF refresh: {pdf_refresh_note}" if summary_note else f"PDF refresh: {pdf_refresh_note}"

    if not summary:
        summary = build_fallback_summary(text_content, sentence_limit=length_options['sentence_limit'], max_chars=560)
        summary_source = 'fallback'
        if not summary_note:
            summary_note = "Summary service returned empty output."

    keywords = []
    try:
        if len(text_content.split()) > 5:
            vectorizer = TfidfVectorizer(stop_words='english', max_features=keyword_limit)
            vectorizer.fit_transform([text_content])
            keywords = vectorizer.get_feature_names_out().tolist()
    except Exception:
        keywords = ["Not enough text"]

    key_sentences = extract_key_sentences(text_content, keywords, limit=length_options['sentence_limit'])

    response_payload = {
        "summary": summary,
        "keywords": keywords,
        "key_sentences": key_sentences,
        "summary_source": summary_source,
        "summary_note": summary_note,
        "text_source": text_source,
        "document_id": requested_doc_id if requested_doc_id > 0 else None,
        "cache_hit": False,
        "options_used": {
            **base_options_used,
            "chunk_count": parse_int(summary_meta.get('chunk_count'), 1, 1),
            "merge_rounds": parse_int(summary_meta.get('merge_rounds'), 0, 0),
            "refreshed_from_file": refreshed_from_file,
            "pdf_extractor": str(pdf_refresh_meta.get('extractor') or base_options_used.get('pdf_extractor') or ''),
            "pdf_ocr_attempted": bool(pdf_refresh_meta.get('ocr_attempted')) or bool(base_options_used.get('pdf_ocr_attempted')),
            "pdf_ocr_used": bool(pdf_refresh_meta.get('ocr_used')),
            "pdf_quality_score_before": parse_float(
                pdf_refresh_meta.get('quality_score_before'),
                parse_float(base_options_used.get('pdf_quality_score_before'), 0.0)
            ),
            "pdf_quality_score_after": parse_float(
                pdf_refresh_meta.get('quality_score_after'),
                parse_float(base_options_used.get('pdf_quality_score_after'), 0.0)
            ),
        },
    }

    if use_document_cache and text_hash:
        cache_conn = get_db_connection()
        if cache_conn:
            try:
                save_document_summary_cache(
                    cache_conn,
                    requested_doc_id,
                    workspace_id,
                    username or document_owner_username,
                    text_hash,
                    summary_length,
                    keyword_limit,
                    {
                        "summary": summary,
                        "keywords": keywords,
                        "key_sentences": key_sentences,
                        "summary_source": summary_source,
                        "summary_note": summary_note,
                        "options_used": response_payload.get("options_used") if isinstance(response_payload.get("options_used"), dict) else {},
                    }
                )
            finally:
                cache_conn.close()

    return jsonify(response_payload)

# ================= 修改后的下载/访问接口 (支持 S3) =================
def uploaded_file(filename):
    username = (request.args.get('username') or '').strip()
    share_token = (request.args.get('share_token') or '').strip()
    conn = get_db_connection()
    if conn:
        try:
            cursor = conn.execute(
                'SELECT * FROM documents WHERE filename = ? ORDER BY id DESC LIMIT 1',
                (filename,)
            )
            doc = cursor.fetchone()
            if doc:
                allowed, reason = check_document_access(conn, doc, username, share_token)
                if not allowed:
                    return jsonify({'error': reason}), 403
        finally:
            conn.close()

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
def serve_index():
    return send_from_directory(app.static_folder, 'index.html')

def catch_all(path):
    if path.startswith('api/') or path.startswith('uploads/'):
        return jsonify({'error': 'Not found'}), 404
    
    if os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory(app.static_folder, path)
    
    return send_from_directory(app.static_folder, 'index.html')
