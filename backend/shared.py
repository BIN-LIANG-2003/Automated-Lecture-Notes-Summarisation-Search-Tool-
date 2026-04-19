import os
import io
import sys
import json
import html
import re
import secrets
import shutil
import subprocess
import uuid
import requests
from datetime import datetime, timedelta
from urllib.parse import quote, urlparse

from flask import make_response, request, jsonify, send_from_directory, redirect
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from sklearn.feature_extraction.text import TfidfVectorizer

# --- Google 登录库 ---
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

from .config import (
    APP_BASE_URL,
    DEFAULT_WORKSPACE_SETTINGS,
    EMAIL_VERIFICATION_TTL_HOURS,
    ENABLE_PDF_OCR_FALLBACK,
    EXTERNAL_OCR_AUTH_TOKEN,
    EXTERNAL_OCR_SERVICE_URL,
    EXTERNAL_OCR_TIMEOUT_SECONDS,
    AUTH_COOKIE_NAME,
    AUTH_COOKIE_SAMESITE,
    AUTH_COOKIE_SECURE,
    AUTH_TOKEN_TTL_SECONDS,
    GOOGLE_CLIENT_ID,
    HF_MODEL_BASE_URL,
    INVITE_BASE_URL,
    HF_TOKEN,
    OCR_MODEL_ID,
    OCRMYPDF_BINARY,
    OCRMYPDF_LANGUAGE,
    OCRMYPDF_TIMEOUT_SECONDS,
    S3_BUCKET,
    SUMMARIZER_MODEL_ID,
    WORKSPACE_SUMMARY_LENGTH_LEVELS,
    s3_client,
)
from .db import ensure_user_friend_code, generate_unique_friend_code, get_db_connection
from .document_domain import (
    PDF_NEEDS_OCR_ERROR,
    PDF_NEEDS_OCR_STATUS,
    PDF_TEXT_PENDING_ERROR,
    PDF_TEXT_PENDING_STATUS,
    extract_document_content,
    normalize_newlines,
    is_pdf_text_available,
    plaintext_to_html,
    normalize_pdf_text,
    score_pdf_text_quality,
    user_can_edit_document,
)
from .security import (
    create_auth_token,
    decode_auth_token,
    get_authenticated_username,
    get_bearer_token,
    get_request_auth_token,
)
from .share_domain import (
    check_document_access,
    is_document_soft_deleted,
)
from .storage import (
    detect_mimetype,
    storage_file_as_local_path,
)
from .summary_service import (
    build_summary_bundle,
    build_summary_cache_key,
    build_summary_input_hash,
    call_hf_summarizer,
    clean_summary_input,
    clear_document_summary_cache,
    external_summary_service_configured,
    extract_key_sentences,
    finish_summary_generation,
    generate_abstractive_summary,
    generate_extractive_summary,
    get_summary_length_targets,
    split_summary_chunks,
    try_begin_summary_generation,
)
from .utils import (
    normalize_email,
    parse_bool,
    parse_float,
    parse_int,
    parse_iso_datetime,
    row_to_dict,
    utcnow_iso,
)
from .workspace_domain import (
    get_workspace_settings,
    is_valid_email,
    normalize_workspace_settings,
    workspace_belongs_to_user,
)
from .email_service import send_resend_email
from .user_preferences import normalize_user_preferences


# ================= 配置部分 =================
app = None


# ================= 辅助函数 =================


def _auth_response(payload, auth_token='', remember=False, status_code=200):
    response = make_response(jsonify(payload), status_code)
    safe_token = str(auth_token or '').strip()
    if safe_token:
        response.set_cookie(
            AUTH_COOKIE_NAME,
            safe_token,
            max_age=AUTH_TOKEN_TTL_SECONDS if remember else None,
            httponly=True,
            secure=AUTH_COOKIE_SECURE,
            samesite=AUTH_COOKIE_SAMESITE,
            path='/',
        )
    return response


def _clear_auth_cookie_response(payload, status_code=200):
    response = make_response(jsonify(payload), status_code)
    response.set_cookie(
        AUTH_COOKIE_NAME,
        '',
        expires=0,
        max_age=0,
        httponly=True,
        secure=AUTH_COOKIE_SECURE,
        samesite=AUTH_COOKIE_SAMESITE,
        path='/',
    )
    return response


def _resolve_authenticated_username_from_request():
    username = get_authenticated_username()
    if username:
        return True, username, ''
    auth_token = get_request_auth_token()
    token_ok, token_username, token_error = decode_auth_token(auth_token)
    return token_ok, token_username, token_error


def build_summary_cache_text_hash(text):
    return build_summary_input_hash(text)


def build_document_summary_cache_key(text, summary_length='medium', keyword_limit=5):
    return build_summary_cache_key(
        text,
        summary_length=summary_length,
        keyword_limit=keyword_limit,
    )


def mask_email_for_log(email):
    safe_email = normalize_email(email)
    if not safe_email or '@' not in safe_email:
        return 'unknown'
    local_part, domain_part = safe_email.split('@', 1)
    if len(local_part) <= 1:
        masked_local = '*'
    elif len(local_part) == 2:
        masked_local = f'{local_part[0]}*'
    else:
        masked_local = f"{local_part[0]}{'*' * (len(local_part) - 2)}{local_part[-1]}"
    return f'{masked_local}@{domain_part}'


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


def load_document_summary_fields_from_row(doc_data, expected_summary_cache_key, expected_input_hash=''):
    doc = row_to_dict(doc_data)
    if not isinstance(doc, dict):
        return None
    summary_text = str(doc.get('summary_text') or '').strip()
    if not summary_text:
        return None
    cached_key = str(doc.get('summary_cache_key') or '').strip()
    expected_key = str(expected_summary_cache_key or '').strip()
    if not cached_key or (expected_key and cached_key != expected_key):
        return None
    cached_input_hash = str(doc.get('summary_input_hash') or '').strip()
    expected_hash = str(expected_input_hash or '').strip()
    if expected_hash and cached_input_hash != expected_hash:
        return None
    try:
        key_sentences = json.loads(doc.get('key_sentences_json') or '[]')
    except Exception:
        key_sentences = []
    if not isinstance(key_sentences, list):
        key_sentences = []
    summary_source = str(doc.get('summary_source') or '').strip().lower()
    return {
        'summary': summary_text,
        'summary_text': summary_text,
        'keywords': [],
        'key_sentences': [str(item).strip() for item in key_sentences if str(item).strip()],
        'summary_source': summary_source,
        'summary_model': str(doc.get('summary_model') or SUMMARIZER_MODEL_ID).strip() or SUMMARIZER_MODEL_ID,
        'ai_summary': str(doc.get('ai_summary') or '').strip(),
        'extractive_summary': str(doc.get('extractive_summary') or '').strip(),
        'used_fallback': summary_source == 'textrank_fallback',
        'summary_error': str(doc.get('summary_error') or '').strip(),
        'summary_input_hash': cached_input_hash,
        'summary_cache_key': cached_key,
        'summary_note': '',
        'options_used': {},
        'cached_at': doc.get('summary_generated_at') or '',
    }


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
        'summary': str(payload.get('summary') or payload.get('summary_text') or '').strip(),
        'summary_text': str(payload.get('summary_text') or payload.get('summary') or '').strip(),
        'keywords': payload.get('keywords') if isinstance(payload.get('keywords'), list) else [],
        'key_sentences': payload.get('key_sentences') if isinstance(payload.get('key_sentences'), list) else [],
        'summary_source': str(payload.get('summary_source') or '').strip().lower() or 'fallback',
        'summary_model': str(payload.get('summary_model') or SUMMARIZER_MODEL_ID).strip() or SUMMARIZER_MODEL_ID,
        'ai_summary': str(payload.get('ai_summary') or '').strip(),
        'extractive_summary': str(payload.get('extractive_summary') or '').strip(),
        'used_fallback': bool(payload.get('used_fallback')),
        'summary_error': str(payload.get('summary_error') or payload.get('error') or '').strip(),
        'summary_input_hash': str(payload.get('summary_input_hash') or content_hash or '').strip(),
        'summary_cache_key': str(payload.get('summary_cache_key') or content_hash or '').strip(),
        'summary_note': str(payload.get('summary_note') or '').strip(),
        'options_used': payload.get('options_used') if isinstance(payload.get('options_used'), dict) else {},
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


def save_document_summary_fields(conn, document_id, payload, input_hash='', summary_cache_key=''):
    safe_doc_id = parse_int(document_id, 0, 0)
    if safe_doc_id <= 0 or not isinstance(payload, dict):
        return False
    key_sentences = payload.get('key_sentences') if isinstance(payload.get('key_sentences'), list) else []
    safe_input_hash = str(input_hash or payload.get('summary_input_hash') or '').strip()
    safe_cache_key = str(summary_cache_key or payload.get('summary_cache_key') or '').strip()
    now_iso = utcnow_iso()
    try:
        conn.execute(
            '''
            UPDATE documents
            SET summary_text = ?,
                summary_source = ?,
                summary_model = ?,
                extractive_summary = ?,
                ai_summary = ?,
                key_sentences_json = ?,
                summary_generated_at = ?,
                summary_error = ?,
                summary_input_hash = ?,
                summary_cache_key = ?
            WHERE id = ?
            ''',
            (
                str(payload.get('summary_text') or payload.get('summary') or '').strip(),
                str(payload.get('summary_source') or '').strip(),
                str(payload.get('summary_model') or SUMMARIZER_MODEL_ID).strip() or SUMMARIZER_MODEL_ID,
                str(payload.get('extractive_summary') or '').strip(),
                str(payload.get('ai_summary') or '').strip(),
                json.dumps(key_sentences, ensure_ascii=False),
                now_iso,
                str(payload.get('summary_error') or payload.get('error') or '').strip(),
                safe_input_hash,
                safe_cache_key,
                safe_doc_id,
            ),
        )
        conn.commit()
        return True
    except Exception as e:
        print(f"⚠️ Document summary field write failed: {e}")
        return False


def create_email_verification_token():
    return secrets.token_urlsafe(32)


def email_verification_expires_at():
    return (datetime.utcnow() + timedelta(hours=EMAIL_VERIFICATION_TTL_HOURS)).isoformat()


def build_email_verification_url(token):
    safe_token = str(token or '').strip()
    if not safe_token:
        return ''
    return f'{INVITE_BASE_URL}/api/auth/verify-email?token={quote(safe_token)}'


def _render_auth_message_page(title, message, *, status_code=200, success=False):
    safe_title = html.escape(str(title or '').strip() or 'StudyHub')
    safe_message = html.escape(str(message or '').strip() or 'No details available.')
    login_url = f'{APP_BASE_URL}/#/login'
    button_label = 'Open StudyHub'
    accent = '#166534' if success else '#b91c1c'
    page_html = f'''
        <!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>{safe_title}</title>
            <style>
              body {{
                margin: 0;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                background: #f5f7fb;
                color: #111827;
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                padding: 24px;
              }}
              .card {{
                width: min(100%, 520px);
                background: #ffffff;
                border-radius: 16px;
                box-shadow: 0 18px 44px rgba(15, 23, 42, 0.12);
                padding: 28px 24px;
                border-top: 5px solid {accent};
              }}
              h1 {{
                margin: 0 0 12px;
                font-size: 24px;
              }}
              p {{
                margin: 0 0 18px;
                line-height: 1.6;
              }}
              a {{
                display: inline-block;
                padding: 10px 14px;
                border-radius: 10px;
                background: #2563eb;
                color: #ffffff;
                text-decoration: none;
                font-weight: 600;
              }}
              .meta {{
                margin-top: 14px;
                font-size: 13px;
                color: #6b7280;
              }}
            </style>
          </head>
          <body>
            <main class="card">
              <h1>{safe_title}</h1>
              <p>{safe_message}</p>
              <a href="{html.escape(login_url)}">{button_label}</a>
              <div class="meta">You can close this tab after reading this message.</div>
            </main>
          </body>
        </html>
    '''
    return page_html, status_code, {'Content-Type': 'text/html; charset=utf-8'}


def send_registration_verification_email(to_email, username, verification_url, expires_at):
    recipient = normalize_email(to_email)
    masked_recipient = mask_email_for_log(recipient)
    safe_username = str(username or '').strip()
    safe_verification_url = str(verification_url or '').strip()
    safe_expiry_label = str(expires_at or '').strip() or 'Unknown'
    if not recipient:
        print('Registration verification email send skipped: missing recipient email')
        return False, 'Missing recipient email'
    if not safe_verification_url:
        print(
            f'Registration verification email send failed for {masked_recipient}: '
            'verification URL could not be generated'
        )
        return False, 'Verification URL could not be generated'

    subject = 'Verify your StudyHub account'
    body_html = f'''
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 560px; margin: 0 auto;">
          <h2 style="margin-bottom: 12px;">Verify your StudyHub email</h2>
          <p>Hello <strong>{html.escape(safe_username or recipient)}</strong>,</p>
          <p>Thanks for creating a StudyHub account. Please verify your email address before signing in.</p>
          <p style="margin: 18px 0;">
            <a href="{html.escape(safe_verification_url)}" style="display: inline-block; padding: 10px 14px; border-radius: 8px; text-decoration: none; background: #2563eb; color: #ffffff;">
              Verify email
            </a>
          </p>
          <p style="margin-bottom: 8px;"><strong>Expires:</strong> {html.escape(safe_expiry_label)}</p>
          <p style="margin-bottom: 8px;"><strong>Direct link:</strong></p>
          <p style="margin-top: 0; word-break: break-word;">
            <a href="{html.escape(safe_verification_url)}" style="color: #2563eb;">{html.escape(safe_verification_url)}</a>
          </p>
          <p style="font-size: 12px; color: #6b7280;">If you did not create this account, you can ignore this email.</p>
        </div>
    '''
    body_text = (
        f'Hello {safe_username or recipient},\n\n'
        'Thanks for creating a StudyHub account. Please verify your email address before signing in.\n\n'
        f'Verification link: {safe_verification_url}\n'
        f'Expires: {safe_expiry_label}\n'
    )
    sent, error_message = send_resend_email(recipient, subject, body_html, body_text)
    if not sent:
        print(
            f'Registration verification email send failed for {masked_recipient}: '
            f'{error_message}'
        )
        return False, error_message
    return True, ''


def _persist_email_verification(conn, user_row):
    user = row_to_dict(user_row) or {}
    username = str(user.get('username') or '').strip()
    email = normalize_email(user.get('email'))
    if not username or not email:
        return False, '', '', 'Account is missing username or email'

    verification_token = create_email_verification_token()
    expires_at = email_verification_expires_at()
    conn.execute(
        '''
        UPDATE users
        SET email_verified = ?,
            email_verification_token = ?,
            email_verification_expires_at = ?,
            verified_at = NULL
        WHERE username = ?
        ''',
        (
            False if conn.db_type == 'postgres' else 0,
            verification_token,
            expires_at,
            username,
        ),
    )
    return True, verification_token, expires_at, ''


def _find_user_for_verification_request(conn, identifier='', email=''):
    safe_identifier = str(identifier or '').strip()
    safe_email = normalize_email(email)
    if safe_email:
        cursor = conn.execute('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1', (safe_email,))
        row = cursor.fetchone()
        if row:
            return row_to_dict(row)
    if safe_identifier:
        cursor = conn.execute(
            'SELECT * FROM users WHERE username = ? OR LOWER(email) = ? LIMIT 1',
            (safe_identifier, normalize_email(safe_identifier)),
        )
        return row_to_dict(cursor.fetchone())
    return None


# ================= API 路由接口 =================

def register():
    data = request.get_json(silent=True) or {}
    username = str(data.get('username') or '').strip()
    email = normalize_email(data.get('email'))
    password = data.get('password')

    if not username or not email or not password:
        return jsonify({'error': 'Missing fields'}), 400
    if not is_valid_email(email):
        return jsonify({'error': 'Please enter a valid email address'}), 400

    hashed_pw = generate_password_hash(password, method='pbkdf2:sha256')
    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        existing = row_to_dict(
            conn.execute(
                'SELECT username, email FROM users WHERE username = ? OR LOWER(email) = ? LIMIT 1',
                (username, email),
            ).fetchone()
        )
        if existing:
            if str(existing.get('username') or '').strip() == username:
                return jsonify({'error': 'Username already exists'}), 409
            return jsonify({'error': 'Email is already registered'}), 409

        verification_token = create_email_verification_token()
        expires_at = email_verification_expires_at()
        verification_url = build_email_verification_url(verification_token)
        friend_code = generate_unique_friend_code(conn)
        conn.execute(
            '''
            INSERT INTO users (
                username,
                email,
                friend_code,
                password_hash,
                email_verified,
                email_verification_token,
                email_verification_expires_at,
                verified_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            (
                username,
                email,
                friend_code,
                hashed_pw,
                False if conn.db_type == 'postgres' else 0,
                verification_token,
                expires_at,
                None,
            ),
        )
        sent, send_error = send_registration_verification_email(email, username, verification_url, expires_at)
        if not sent:
            conn.rollback()
            return jsonify({'error': send_error or 'Failed to send verification email'}), 503
        conn.commit()
        return jsonify({
            'message': 'Account created. Please check your email to verify your account before signing in.',
            'username': username,
            'email': email,
            'verification_required': True,
            'verification_expires_at': expires_at,
        }), 201
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({'error': f'Registration failed (User may exist): {str(e)}'}), 409
    finally:
        conn.close()

def login():
    data = request.get_json(silent=True) or {}
    username_or_email = str(data.get('username') or '').strip()
    password = data.get('password')
    remember_session = parse_bool(data.get('remember'), False)
    normalized_identifier = normalize_email(username_or_email)
    if not username_or_email or not password:
        return jsonify({'error': 'Username/email and password are required'}), 400

    conn = get_db_connection()
    cursor = conn.execute(
        'SELECT * FROM users WHERE username = ? OR LOWER(email) = ?',
        (username_or_email, normalized_identifier),
    )
    user = row_to_dict(cursor.fetchone())
    conn.close()

    if user and check_password_hash(user['password_hash'], password):
        if not parse_bool(user.get('email_verified'), False):
            return jsonify({
                'error': 'Please verify your email address before signing in.',
                'code': 'email_not_verified',
                'email': normalize_email(user.get('email')),
                'username': str(user.get('username') or '').strip(),
            }), 403
        user_email = user.get('email') if hasattr(user, 'get') else user['email']
        auth_token = create_auth_token(user['username'])
        return _auth_response({
            'message': 'Login successful',
            'username': user['username'],
            'email': user_email,
            'auth_token': auth_token,
            'preferences': normalize_user_preferences(user),
        }, auth_token, remember_session, 200)
    else:
        return jsonify({'error': 'Invalid credentials'}), 401


def verify_email():
    token = str(request.args.get('token') or '').strip()
    if not token:
        return _render_auth_message_page(
            'Missing verification token',
            'This verification link is incomplete. Please request a new verification email from the sign-in page.',
            status_code=400,
        )

    conn = get_db_connection()
    if not conn:
        return _render_auth_message_page(
            'Verification unavailable',
            'StudyHub could not connect to the database. Please try again shortly.',
            status_code=500,
        )
    try:
        user = row_to_dict(
            conn.execute(
                '''
                SELECT username, email, email_verified, email_verification_token, email_verification_expires_at
                FROM users
                WHERE email_verification_token = ?
                LIMIT 1
                ''',
                (token,),
            ).fetchone()
        )
        if not user:
            return _render_auth_message_page(
                'Verification link invalid',
                'This verification link is invalid or has already been replaced. Request a new verification email and try again.',
                status_code=400,
            )

        if parse_bool(user.get('email_verified'), False):
            return _render_auth_message_page(
                'Email already verified',
                'This account has already been verified. You can return to StudyHub and sign in now.',
                success=True,
            )

        expires_at = parse_iso_datetime(user.get('email_verification_expires_at'))
        if expires_at is None or expires_at < datetime.utcnow():
            return _render_auth_message_page(
                'Verification link expired',
                'This verification link has expired. Return to the sign-in page and request a new verification email.',
                status_code=400,
            )

        now_iso = utcnow_iso()
        conn.execute(
            '''
            UPDATE users
            SET email_verified = ?,
                verified_at = ?,
                email_verification_token = NULL,
                email_verification_expires_at = NULL
            WHERE username = ?
            ''',
            (
                True if conn.db_type == 'postgres' else 1,
                now_iso,
                user.get('username'),
            ),
        )
        conn.commit()
        return _render_auth_message_page(
            'Email verified',
            'Your email address has been verified. You can return to StudyHub and sign in now.',
            success=True,
        )
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        print(f'Email verification failed: {e}')
        return _render_auth_message_page(
            'Verification failed',
            'StudyHub could not verify this email link right now. Please try again later.',
            status_code=500,
        )
    finally:
        conn.close()


def resend_verification():
    data = request.get_json(silent=True) or {}
    identifier = str(data.get('identifier') or data.get('username') or '').strip()
    email = normalize_email(data.get('email'))
    if not identifier and not email:
        return jsonify({'error': 'Username or email is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        user = _find_user_for_verification_request(conn, identifier=identifier, email=email)
        if not user:
            return jsonify({
                'message': 'If an unverified account exists for that username or email, a new verification email has been sent.',
            }), 200

        if parse_bool(user.get('email_verified'), False):
            return jsonify({'message': 'This account is already verified. You can sign in now.'}), 200

        ok, verification_token, expires_at, persist_error = _persist_email_verification(conn, user)
        if not ok:
            conn.rollback()
            return jsonify({'error': persist_error or 'Could not prepare verification email'}), 400

        verification_url = build_email_verification_url(verification_token)
        sent, send_error = send_registration_verification_email(
            user.get('email'),
            user.get('username'),
            verification_url,
            expires_at,
        )
        if not sent:
            conn.rollback()
            return jsonify({'error': send_error or 'Failed to send verification email'}), 503

        conn.commit()
        return jsonify({
            'message': 'A fresh verification email has been sent if the account is still awaiting verification.',
            'email': normalize_email(user.get('email')),
            'verification_required': True,
            'verification_expires_at': expires_at,
        }), 200
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        print(f'Resend verification failed: {e}')
        return jsonify({'error': 'Failed to resend verification email'}), 500
    finally:
        conn.close()


def me():
    token_ok, token_username, token_error = _resolve_authenticated_username_from_request()
    if not token_ok:
        return jsonify({'error': token_error or 'Invalid auth token'}), 401

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        cursor = conn.execute(
            '''
            SELECT username, email, friend_code, email_notifications_enabled
            FROM users
            WHERE username = ?
            ''',
            (token_username,),
        )
        user = cursor.fetchone()
        if not user:
            return jsonify({'error': 'User account not found for this session'}), 404
        friend_code = ensure_user_friend_code(conn, token_username)
        conn.commit()
        return jsonify({
            'username': user['username'],
            'email': user.get('email') if hasattr(user, 'get') else user['email'],
            'friend_code': friend_code or (user.get('friend_code') if hasattr(user, 'get') else user['friend_code']),
            'auth_token': create_auth_token(token_username),
            'preferences': normalize_user_preferences(user),
            'authenticated': True,
        }), 200
    finally:
        conn.close()


def update_preferences():
    token_ok, token_username, token_error = _resolve_authenticated_username_from_request()
    if not token_ok:
        return jsonify({'error': token_error or 'Invalid auth token'}), 401

    data = request.get_json(silent=True) or {}
    next_email_notifications = parse_bool(
        data.get('email_notifications_enabled'),
        True,
    )

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        db_email_notifications_value = (
            next_email_notifications if conn.db_type == 'postgres' else (1 if next_email_notifications else 0)
        )
        conn.execute(
            '''
            UPDATE users
            SET email_notifications_enabled = ?
            WHERE username = ?
            ''',
            (db_email_notifications_value, token_username),
        )
        conn.commit()
        cursor = conn.execute(
            '''
            SELECT username, email, friend_code, email_notifications_enabled
            FROM users
            WHERE username = ?
            ''',
            (token_username,),
        )
        user = row_to_dict(cursor.fetchone())
        if not user:
            return jsonify({'error': 'User account not found for this session'}), 404
        return jsonify({
            'username': user.get('username') or token_username,
            'email': normalize_email(user.get('email')),
            'preferences': normalize_user_preferences(user),
        }), 200
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({'error': f'Failed to save preferences: {e}'}), 500
    finally:
        conn.close()


def logout():
    token_ok, token_username, token_error = _resolve_authenticated_username_from_request()
    if not token_ok:
        return _clear_auth_cookie_response({'error': token_error or 'Invalid auth token'}, 401)
    return _clear_auth_cookie_response({
        'message': 'Signed out successfully',
        'username': token_username,
        'stateless': True,
    }, 200)


def google_login():
    try:
        data = request.get_json(silent=True) or {}
        token = data.get('token')
        remember_session = parse_bool(data.get('remember'), False)
        
        id_info = id_token.verify_oauth2_token(token, google_requests.Request(), GOOGLE_CLIENT_ID)
        email = normalize_email(id_info['email'])
        name = id_info.get('name', email.split('@')[0])
        now_iso = utcnow_iso()
        
        conn = get_db_connection()
        cursor = conn.execute('SELECT * FROM users WHERE LOWER(email) = ?', (email,))
        user = row_to_dict(cursor.fetchone())
        
        if user is None:
            username = f"{name.split()[0]}_{uuid.uuid4().hex[:4]}"
            random_password = uuid.uuid4().hex
            hashed_password = generate_password_hash(random_password, method='pbkdf2:sha256')
            friend_code = generate_unique_friend_code(conn)
            try:
                conn.execute(
                    '''
                    INSERT INTO users (
                        username,
                        email,
                        friend_code,
                        password_hash,
                        email_verified,
                        email_verification_token,
                        email_verification_expires_at,
                        verified_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ''',
                    (
                        username,
                        email,
                        friend_code,
                        hashed_password,
                        True if conn.db_type == 'postgres' else 1,
                        None,
                        None,
                        now_iso,
                    ),
                )
                conn.commit()
                cursor = conn.execute('SELECT * FROM users WHERE LOWER(email) = ?', (email,))
                user = row_to_dict(cursor.fetchone())
            except Exception as e:
                conn.close()
                return jsonify({'error': f'Register failed: {str(e)}'}), 500
        elif not parse_bool(user.get('email_verified'), False):
            conn.execute(
                '''
                UPDATE users
                SET email_verified = ?,
                    verified_at = ?,
                    email_verification_token = NULL,
                    email_verification_expires_at = NULL
                WHERE username = ?
                ''',
                (
                    True if conn.db_type == 'postgres' else 1,
                    now_iso,
                    user.get('username'),
                ),
            )
            conn.commit()
            cursor = conn.execute('SELECT * FROM users WHERE LOWER(email) = ?', (email,))
            user = row_to_dict(cursor.fetchone())
        conn.close()
        user_email = user.get('email') if hasattr(user, 'get') else user['email']
        auth_token = create_auth_token(user['username'])
        return _auth_response({
            'message': 'Login successful',
            'username': user['username'],
            'email': user_email,
            'auth_token': auth_token,
            'preferences': normalize_user_preferences(user),
        }, auth_token, remember_session, 200)
    except ValueError:
        return jsonify({'error': 'Invalid Google token'}), 401
    except Exception as e:
        print(f"Google login error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

def get_hf_headers(content_type=None):
    if not HF_TOKEN:
        return None
    result = {"Authorization": f"Bearer {HF_TOKEN}"}
    if content_type:
        result["Content-Type"] = content_type
    return result


def get_external_ocr_auth_headers():
    if not EXTERNAL_OCR_AUTH_TOKEN:
        return {}
    return {"Authorization": f"Bearer {EXTERNAL_OCR_AUTH_TOKEN}"}


def hf_model_url(model_id):
    return f"{HF_MODEL_BASE_URL}/{model_id}"


def is_t5_family_summarizer_model(model_id=None):
    safe_model_id = str(model_id or SUMMARIZER_MODEL_ID or '').strip().lower()
    if not safe_model_id:
        return False
    return bool(
        re.search(r'(^|[/-])(flan-?t5|t5|mt5|byt5)([-/]|$)', safe_model_id)
    )


def build_hf_summarizer_input(text_content, model_id=None):
    safe_text = str(text_content or '').strip()
    if not safe_text:
        return ''
    if not is_t5_family_summarizer_model(model_id):
        return safe_text
    if safe_text.lower().startswith('summarize:'):
        return safe_text
    return f'summarize: {safe_text}'


def looks_like_html_error(text):
    value = str(text or '').strip().lower()
    if not value:
        return False
    return value.startswith('<!doctype html') or value.startswith('<html') or '<html' in value[:240]


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
    raw_text = (response.text or '').strip()
    if looks_like_html_error(raw_text):
        status_code = getattr(response, 'status_code', 0) or 0
        if status_code == 410:
            return (
                'Hugging Face OCR endpoint returned 410 Gone. '
                'The configured OCR model or inference endpoint is no longer available.'
            )
        return 'Hugging Face OCR endpoint returned an HTML error page instead of JSON.'
    return raw_text[:240] or 'Unknown error'


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


def summarize_text_with_chunk_merge(text_content, length_options):
    safe_text = clean_summary_input(text_content)
    options = length_options if isinstance(length_options, dict) else {}
    targets = get_summary_length_targets(options.get('summary_length') or 'medium')
    target_max_words = parse_int(options.get('target_max_words'), targets['target_max_words'], 40, 320)
    textrank_sentence_count = parse_int(
        options.get('textrank_sentence_count') or options.get('sentence_limit'),
        targets['textrank_sentence_count'],
        1,
        20,
    )
    if not safe_text:
        return {
            'summary': '',
            'summary_source': 'textrank_only',
            'summary_note': 'No text provided.',
            'meta': {'chunk_count': 0, 'merge_rounds': 0},
            'bundle': build_summary_bundle(
                '',
                summary_length=targets['summary_length'],
                target_max_words=target_max_words,
                textrank_sentence_count=textrank_sentence_count,
            ),
        }

    bundle = build_summary_bundle(
        safe_text,
        summary_length=targets['summary_length'],
        target_max_words=target_max_words,
        textrank_sentence_count=textrank_sentence_count,
    )
    summary_note = ''
    if bundle.get('used_fallback'):
        summary_note = 'Hugging Face summarizer was unavailable; TextRank fallback was used.'
    elif bundle.get('summary_source') == 'textrank_only':
        summary_note = 'TextRank summary used because the text was too short for BART or Hugging Face was not configured.'
    if bundle.get('error'):
        summary_note = f"{summary_note} {bundle.get('error')}".strip()

    return {
        'summary': str(bundle.get('summary_text') or '').strip(),
        'summary_source': str(bundle.get('summary_source') or '').strip() or 'textrank_only',
        'summary_note': summary_note,
        'meta': {
            'chunk_count': parse_int(bundle.get('chunk_count'), 1, 1),
            'merge_rounds': parse_int(bundle.get('merge_rounds'), 0, 0),
            'hf_success_count': 1 if bundle.get('ai_summary') else 0,
            'fallback_count': 1 if bundle.get('used_fallback') else 0,
        },
        'bundle': bundle,
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


SUSPICIOUS_OCR_LATEX_PATTERNS = (
    ('begin_align', re.compile(r'\\begin\{align\*?\}', re.IGNORECASE)),
    ('end_align', re.compile(r'\\end\{align\*?\}', re.IGNORECASE)),
    ('frac', re.compile(r'\\frac\b', re.IGNORECASE)),
    ('mathfrak', re.compile(r'\\mathfrak\b', re.IGNORECASE)),
    ('stackrel', re.compile(r'\\stackrel\b', re.IGNORECASE)),
    ('underset', re.compile(r'\\underset\b', re.IGNORECASE)),
    ('infty', re.compile(r'\\infty\b', re.IGNORECASE)),
)


def assess_ocr_text_quality(text):
    normalized = re.sub(r'\s+', ' ', str(text or '').strip())
    if not normalized:
        return {
            'ok': False,
            'reason': 'OCR text is empty after normalization',
            'metrics': {'char_count': 0},
        }

    lowered = normalized.lower()
    word_tokens = re.findall(r'[a-z]{3,}', lowered)
    unique_word_ratio = (
        len(set(word_tokens)) / float(len(word_tokens))
        if word_tokens else 1.0
    )

    structural_counts = {}
    structural_total = 0
    structural_max = 0
    structural_top_label = ''
    for label, pattern in SUSPICIOUS_OCR_LATEX_PATTERNS:
        count = len(pattern.findall(lowered))
        if count <= 0:
            continue
        structural_counts[label] = count
        structural_total += count
        if count > structural_max:
            structural_max = count
            structural_top_label = label

    token_parts = re.findall(r'\\[a-z]+(?:\*?)?|[a-z]{2,}|\d+', lowered)
    token_counts = {}
    for token in token_parts[:4000]:
        token_counts[token] = token_counts.get(token, 0) + 1
    most_common_token = ''
    most_common_count = 0
    for token, count in token_counts.items():
        if count > most_common_count:
            most_common_token = token
            most_common_count = count
    repeated_token_ratio = (
        most_common_count / float(len(token_parts))
        if token_parts else 0.0
    )

    latex_command_tokens = re.findall(r'\\[a-z]+(?:\*?)?', lowered)
    unique_latex_ratio = (
        len(set(latex_command_tokens)) / float(len(latex_command_tokens))
        if latex_command_tokens else 1.0
    )

    reasons = []
    if len(normalized) >= 220 and structural_total >= 10 and structural_max >= 4:
        reasons.append(
            f"repeated LaTeX-style control sequences detected ({structural_top_label}:{structural_max}, total:{structural_total})"
        )
    if (
        len(normalized) >= 400
        and structural_total >= 6
        and unique_word_ratio < 0.20
        and repeated_token_ratio >= 0.18
    ):
        reasons.append(
            f"very long OCR output has low language diversity (unique_word_ratio:{unique_word_ratio:.2f}, repeated_token_ratio:{repeated_token_ratio:.2f})"
        )
    if (
        len(normalized) >= 500
        and len(latex_command_tokens) >= 18
        and unique_latex_ratio <= 0.45
        and structural_total >= 6
    ):
        reasons.append(
            f"runaway repeated LaTeX command pattern detected (latex_commands:{len(latex_command_tokens)}, unique_latex_ratio:{unique_latex_ratio:.2f})"
        )

    metrics = {
        'char_count': len(normalized),
        'word_count': len(word_tokens),
        'unique_word_ratio': round(unique_word_ratio, 4),
        'structural_token_total': structural_total,
        'structural_token_max': structural_max,
        'structural_token_top': structural_top_label,
        'structural_counts': structural_counts,
        'latex_command_count': len(latex_command_tokens),
        'unique_latex_ratio': round(unique_latex_ratio, 4),
        'most_common_token': most_common_token,
        'most_common_token_count': most_common_count,
        'repeated_token_ratio': round(repeated_token_ratio, 4),
    }
    return {
        'ok': not reasons,
        'reason': '; '.join(reasons),
        'metrics': metrics,
    }


def external_ocr_health_url(endpoint):
    safe_endpoint = str(endpoint or '').strip()
    if not safe_endpoint:
        return ''
    try:
        parsed = urlparse(safe_endpoint)
        path = parsed.path or '/'
        normalized_path = path.rstrip('/')
        if normalized_path.endswith('/ocr'):
            health_path = f'{normalized_path[:-len("/ocr")]}/health'
        elif normalized_path.endswith('/health'):
            health_path = normalized_path
        else:
            health_path = f'{normalized_path}/health' if normalized_path else '/health'
        return parsed._replace(path=health_path, params='', query='', fragment='').geturl()
    except Exception:
        return safe_endpoint


def _probe_external_ocr_service():
    endpoint = str(EXTERNAL_OCR_SERVICE_URL or '').strip()
    if not endpoint:
        return {
            'checked': False,
            'ok': False,
            'error': 'External OCR service is not configured',
        }
    health_endpoint = external_ocr_health_url(endpoint)
    timeout_seconds = min(15, max(2, EXTERNAL_OCR_TIMEOUT_SECONDS))
    probe_meta = {
        'method': 'GET',
        'path': urlparse(health_endpoint).path or '/',
        'timeout_seconds': timeout_seconds,
    }
    try:
        response = requests.request(
            'GET',
            health_endpoint,
            headers=get_external_ocr_auth_headers(),
            timeout=timeout_seconds,
            allow_redirects=True,
        )
    except requests.exceptions.Timeout:
        return {
            'checked': True,
            'ok': False,
            **probe_meta,
            'error': f'External OCR health check timed out after {timeout_seconds}s',
        }
    except Exception as exc:
        return {
            'checked': True,
            'ok': False,
            **probe_meta,
            'error': f'External OCR health check failed: {redact_external_ocr_diagnostic(exc)}',
        }

    status_code = getattr(response, 'status_code', 0) or 0
    return {
        'checked': True,
        'ok': bool(status_code < 400 or status_code == 405),
        **probe_meta,
        'status_code': status_code,
        'error': '' if status_code < 400 or status_code == 405 else f'External OCR health check returned HTTP {status_code}',
    }


def get_ocr_runtime_status(probe_external=False):
    ocrmypdf_path = shutil.which(OCRMYPDF_BINARY)
    status = {
        'external_ocr_configured': bool(EXTERNAL_OCR_SERVICE_URL),
        'external_ocr_timeout_seconds': EXTERNAL_OCR_TIMEOUT_SECONDS,
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

    if probe_external and status['external_ocr_configured']:
        status['external_ocr_probe'] = _probe_external_ocr_service()
    if not status['external_ocr_configured'] and not status['hf_token_configured']:
        status['hints'].append('Set HF_API_TOKEN in environment variables to enable Hugging Face OCR.')
    if status['external_ocr_configured']:
        status['hints'].append('External OCR service is configured and will be tried before Hugging Face.')
        probe = status.get('external_ocr_probe') or {}
        if probe.get('checked') and not probe.get('ok'):
            status['hints'].append('External OCR service is not currently reachable; Hugging Face will be used if configured.')
    if ENABLE_PDF_OCR_FALLBACK and not status['ocrmypdf_available']:
        status['hints'].append('Install ocrmypdf binary to enable automatic PDF OCR fallback for low-quality text extraction.')

    return status


def redact_external_ocr_diagnostic(value):
    message = str(value or '').strip()
    if not message:
        return ''

    endpoint = str(EXTERNAL_OCR_SERVICE_URL or '').strip()
    endpoint_host = ''
    if endpoint:
        try:
            endpoint_host = str(urlparse(endpoint).netloc or '').strip()
        except Exception:
            endpoint_host = ''
        message = message.replace(endpoint, '[external OCR endpoint]')
    if endpoint_host:
        message = message.replace(endpoint_host, '[external OCR host]')

    message = re.sub(r'https?://[^\s)>\]\'"]+', '[url]', message)
    message = re.sub(r"host='[^']+'", "host='[external OCR host]'", message)
    message = re.sub(r'host="[^"]+"', 'host="[external OCR host]"', message)
    return message


def ocr_health():
    status = get_ocr_runtime_status(probe_external=True)
    external_probe = status.get('external_ocr_probe') or {}
    external_ready = bool(status.get('external_ocr_configured') and external_probe.get('ok'))
    ok = bool(external_ready or status.get('hf_token_configured'))
    checked_at = utcnow_iso()
    status['ok'] = ok
    status['checked_at'] = checked_at
    if not ok:
        status['hints'].append('No OCR provider is ready. Configure EXTERNAL_OCR_SERVICE_URL or HF_API_TOKEN.')

    if not get_authenticated_username():
        return jsonify({
            'ok': ok,
            'checked_at': checked_at,
            'details': 'Sign in to view OCR provider diagnostics.',
        }), (200 if ok else 503)

    return jsonify(status), (200 if ok else 503)


def extract_document_text_from_storage(filename, file_type):
    safe_filename = str(filename or '').strip()
    safe_file_type = str(file_type or '').strip().lower().lstrip('.')
    if not safe_filename or not safe_file_type:
        return '', {}

    if safe_file_type == 'pdf':
        with storage_file_as_local_path(safe_filename, suffix='.pdf') as source_path:
            extracted_text, _ = extract_document_content(source_path, 'pdf', allow_pdf_ocr=False)
        normalized_text = normalize_pdf_text(extracted_text)
        if not is_pdf_text_available(normalized_text):
            return '', {
                'extractor': 'path-no-ocr',
                'ocr_attempted': False,
                'ocr_used': False,
                'note': PDF_NEEDS_OCR_ERROR,
            }
        score, metrics = score_pdf_text_quality(normalized_text)
        return normalized_text, {
            'extractor': 'path-no-ocr',
            'ocr_attempted': False,
            'ocr_used': False,
            'quality_score_before': score,
            'quality_score_after': score,
            'quality_metrics_before': metrics,
            'quality_metrics_after': metrics,
            'note': '',
        }

    if safe_file_type in ('docx', 'txt'):
        with storage_file_as_local_path(safe_filename, suffix=f'.{safe_file_type}') as source_path:
            extracted_text, _ = extract_document_content(source_path, safe_file_type)
        return str(extracted_text or '').strip(), {}

    return '', {}


def call_external_ocr_service(img_bytes, mimetype='application/octet-stream', source_filename='image.jpg'):
    endpoint = str(EXTERNAL_OCR_SERVICE_URL or '').strip()
    if not endpoint:
        return False, '', 'External OCR service is not configured'
    if not img_bytes:
        return False, '', 'Empty image payload'

    safe_filename = str(source_filename or 'image.jpg').strip() or 'image.jpg'
    safe_mimetype = str(mimetype or 'application/octet-stream').strip() or 'application/octet-stream'
    auth_headers = get_external_ocr_auth_headers()
    attempts = [
        (
            'raw-bytes',
            {
                'headers': {
                    **auth_headers,
                    'Content-Type': safe_mimetype,
                    'Accept': 'application/json, text/plain;q=0.9, */*;q=0.8',
                    'X-Source-Filename': safe_filename,
                },
                'data': img_bytes,
            },
        ),
        (
            'multipart:file',
            {
                'headers': auth_headers,
                'files': {
                    'file': (safe_filename, img_bytes, safe_mimetype),
                },
            },
        ),
        (
            'multipart:image',
            {
                'headers': auth_headers,
                'files': {
                    'image': (safe_filename, img_bytes, safe_mimetype),
                },
            },
        ),
    ]

    attempt_errors = []
    for attempt_name, request_kwargs in attempts:
        try:
            response = requests.post(
                endpoint,
                timeout=EXTERNAL_OCR_TIMEOUT_SECONDS,
                **request_kwargs,
            )
        except requests.exceptions.Timeout:
            return False, '', f'External OCR timeout after {EXTERNAL_OCR_TIMEOUT_SECONDS}s'
        except Exception as e:
            return False, '', f'External OCR request failed: {redact_external_ocr_diagnostic(e)}'

        if response.status_code >= 400:
            error_message = redact_external_ocr_diagnostic(hf_error_message(response))
            attempt_errors.append(f'{attempt_name}: HTTP {response.status_code} - {error_message}')
            if response.status_code == 422 and attempt_name != attempts[-1][0]:
                continue
            if response.status_code == 422:
                return False, '', (
                    'External OCR returned 422 Unprocessable Entity. '
                    'The Colab /ocr endpoint likely expects a different request schema '
                    f'({"; ".join(attempt_errors)})'
                )
            return False, '', f'External OCR failed ({response.status_code}): {error_message}'

        content_type = str(response.headers.get('content-type') or '').strip().lower()
        if 'application/json' in content_type:
            try:
                payload = response.json()
            except Exception:
                payload = None
        else:
            payload = None

        extracted_text = normalize_ocr_text(payload)
        if not extracted_text and payload is None:
            extracted_text = str(response.text or '').strip()
        if extracted_text:
            quality = assess_ocr_text_quality(extracted_text)
            if quality.get('ok'):
                return True, extracted_text, ''
            print(
                "OCR provider suspicious output:",
                json.dumps(
                    {
                        'provider': 'external',
                        'endpoint_configured': True,
                        'attempt': attempt_name,
                        'filename': safe_filename,
                        'reason': quality.get('reason') or 'Suspicious OCR output',
                        'metrics': quality.get('metrics') or {},
                        'sample': extracted_text[:180],
                    },
                    ensure_ascii=False,
                ),
            )
            attempt_errors.append(
                f'{attempt_name}: suspicious OCR output - {quality.get("reason") or "unusable text"}'
            )
            continue
        attempt_errors.append(f'{attempt_name}: empty response')

    return False, '', (
        'External OCR did not return usable text'
        + (f' ({"; ".join(attempt_errors)})' if attempt_errors else '')
    )


def call_huggingface_ocr_service(img_bytes, mimetype='application/octet-stream'):
    if not img_bytes:
        return False, '', 'Empty image payload'

    hf_headers = get_hf_headers(mimetype or 'application/octet-stream')
    if not hf_headers:
        return False, '', 'HF_API_TOKEN is not configured on server'

    try:
        target_url = hf_model_url(OCR_MODEL_ID)
        print(f"☁️ [OCR route] Using Hugging Face OCR endpoint: {target_url}")
        response = requests.post(target_url, headers=hf_headers, data=img_bytes, timeout=90)
        if response.status_code >= 400:
            return False, '', f'HF OCR failed ({response.status_code}): {hf_error_message(response)}'
        try:
            ocr_result = response.json()
        except Exception:
            return False, '', f'HF OCR returned non-JSON response: {hf_error_message(response)}'
        extracted_text = normalize_ocr_text(ocr_result)
        if extracted_text:
            return True, extracted_text, ''
        return False, '', 'HF OCR returned empty text'
    except Exception as exc:
        return False, '', f'HF OCR error: {exc}'


# ==========================================
# 专家 1 号：视觉专家 (负责看图识字)
# 对应前端的【按钮 1】
# ==========================================
def extract_text_from_image(doc_id=None):
    username = get_authenticated_username()
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

    external_error = ''
    if str(EXTERNAL_OCR_SERVICE_URL or '').strip():
        external_ok, extracted_text, external_error = call_external_ocr_service(
            img_bytes,
            mimetype=mimetype,
            source_filename=source_filename,
        )
        if external_ok and extracted_text:
            return jsonify({"text": extracted_text, "source": "external"})

    hf_ok, extracted_text, hf_error = call_huggingface_ocr_service(
        img_bytes,
        mimetype=mimetype,
    )
    if hf_ok and extracted_text:
        return jsonify({"text": extracted_text, "source": "huggingface"})

    return jsonify({
        "error": "OCR failed",
        "details": {
            "external": external_error,
            "huggingface": hf_error,
            "runtime": get_ocr_runtime_status(),
            "hint": "Configure EXTERNAL_OCR_SERVICE_URL or HF_API_TOKEN."
        }
    }), 502


# ==========================================
# 专家 2 号：语言专家 (负责摘要和提取关键词)
# 对应前端的【按钮 2】
# ==========================================
def analyze_text(document_id_override=0):
    data = request.get_json(silent=True) or {}
    username = get_authenticated_username()
    share_token = str(data.get('share_token') or '').strip()
    requested_workspace_id = str(data.get('workspace_id') or '').strip()
    requested_doc_id = parse_int(document_id_override or data.get('doc_id', 0), 0, 0)
    force_refresh = parse_bool(data.get('force_refresh'), False)
    workspace_settings = dict(DEFAULT_WORKSPACE_SETTINGS)
    workspace_id = requested_workspace_id
    doc_text_content = ''
    document_owner_username = ''
    text_source = 'request_text'
    refreshed_from_file = False
    pdf_refresh_meta = {}
    doc_file_type = ''
    doc_filename = ''
    attempted_doc_text_extraction = False
    doc_text_extraction_error = ''
    doc_processing_status = ''
    doc_processing_error = ''
    doc_row_data = {}

    if requested_doc_id > 0:
        conn = get_db_connection()
        if not conn:
            return jsonify({'error': 'Database connection failed'}), 500
        try:
            cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (requested_doc_id,))
            doc = cursor.fetchone()
            if not doc:
                return jsonify({'error': 'Document not found'}), 404
            doc_row_data = row_to_dict(doc) or {}

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
            doc_file_type = str(
                (doc.get('file_type') if hasattr(doc, 'get') else doc['file_type']) or ''
            ).strip().lower()
            doc_filename = str(
                (doc.get('filename') if hasattr(doc, 'get') else doc['filename']) or ''
            ).strip()
            doc_processing_status = str(
                (doc.get('processing_status') if hasattr(doc, 'get') else doc['processing_status']) or ''
            ).strip().lower()
            doc_processing_error = str(
                (doc.get('processing_error') if hasattr(doc, 'get') else doc['processing_error']) or ''
            ).strip()
            can_persist_doc_text = bool(
                username
                and user_can_edit_document(conn, doc, username)
                and workspace_settings.get('allow_note_editing', True)
            )

            if doc_file_type == 'pdf' and not doc_text_content:
                if doc_processing_status in (
                    PDF_NEEDS_OCR_STATUS,
                    PDF_TEXT_PENDING_STATUS,
                    'no_text_available',
                    'action_required',
                ):
                    status_error = (
                        PDF_TEXT_PENDING_ERROR
                        if doc_processing_status == PDF_TEXT_PENDING_STATUS
                        else PDF_NEEDS_OCR_ERROR
                    )
                    return jsonify({
                        'error': doc_processing_error or status_error,
                        'processing_status': doc_processing_status or PDF_NEEDS_OCR_STATUS,
                        'processing_error': doc_processing_error or status_error,
                        'details': {
                            'doc_id': requested_doc_id,
                            'file_type': doc_file_type,
                            'text_source': 'empty',
                            'attempted_file_extraction': False,
                            'processing_status': doc_processing_status or PDF_NEEDS_OCR_STATUS,
                            'processing_error': doc_processing_error or status_error,
                        },
                    }), 409
                if doc_processing_status == 'queued':
                    return jsonify({
                        'error': 'PDF text is not ready. Run the optional document worker, or re-upload with a text-selectable PDF.',
                        'processing_status': doc_processing_status,
                    }), 409
                if doc_processing_status == 'processing':
                    return jsonify({
                        'error': 'PDF text extraction is currently running in the document worker.',
                        'processing_status': doc_processing_status,
                    }), 409
                if doc_processing_status == 'failed':
                    return jsonify({
                        'error': doc_processing_error or 'PDF text extraction failed. Upload a text-selectable PDF or run OCR.',
                        'processing_status': doc_processing_status,
                        'processing_error': doc_processing_error,
                    }), 409

            # On explicit rebuild, refresh file text from source file so summary
            # uses latest/full extraction quality instead of stale db content.
            if force_refresh and doc_file_type in ('pdf', 'docx', 'txt') and doc_filename:
                try:
                    refreshed_text, refresh_meta = extract_document_text_from_storage(doc_filename, doc_file_type)
                    pdf_refresh_meta = refresh_meta if isinstance(refresh_meta, dict) else {}
                    refreshed_text = str(refreshed_text or '').strip()
                    if refreshed_text:
                        if refreshed_text != doc_text_content and can_persist_doc_text:
                            next_content_html = ''
                            if doc_file_type in ('docx', 'txt'):
                                next_content_html = plaintext_to_html(refreshed_text)
                            conn.execute(
                                '''
                                UPDATE documents
                                SET content = ?,
                                    content_html = ?,
                                    processing_status = ?,
                                    processing_error = ?,
                                    processed_at = ?
                                WHERE id = ?
                                ''',
                                (refreshed_text, next_content_html, 'processed', '', utcnow_iso(), requested_doc_id)
                            )
                            clear_document_summary_cache(conn, requested_doc_id)
                            conn.commit()
                        doc_text_content = refreshed_text
                        refreshed_from_file = True
                    elif doc_file_type == 'pdf' and not doc_text_content and can_persist_doc_text:
                        conn.execute(
                            '''
                            UPDATE documents
                            SET processing_status = ?,
                                processing_error = ?,
                                processed_at = ?
                            WHERE id = ?
                            ''',
                            (PDF_NEEDS_OCR_STATUS, PDF_NEEDS_OCR_ERROR, utcnow_iso(), requested_doc_id)
                        )
                        conn.commit()
                        doc_processing_status = PDF_NEEDS_OCR_STATUS
                        doc_processing_error = PDF_NEEDS_OCR_ERROR
                except Exception as e:
                    print(f"Document re-extraction on summary refresh failed: {e}")

            if not doc_text_content and doc_file_type in ('pdf', 'docx', 'txt') and doc_filename:
                attempted_doc_text_extraction = True
                try:
                    extracted_text, refresh_meta = extract_document_text_from_storage(doc_filename, doc_file_type)
                    extracted_text = str(extracted_text or '').strip()
                    if doc_file_type == 'pdf':
                        pdf_refresh_meta = refresh_meta if isinstance(refresh_meta, dict) else {}
                    if extracted_text:
                        if can_persist_doc_text:
                            next_content_html = ''
                            if doc_file_type in ('docx', 'txt'):
                                next_content_html = plaintext_to_html(extracted_text)
                            conn.execute(
                                '''
                                UPDATE documents
                                SET content = ?,
                                    content_html = ?,
                                    processing_status = ?,
                                    processing_error = ?,
                                    processed_at = ?
                                WHERE id = ?
                                ''',
                                (extracted_text, next_content_html, 'processed', '', utcnow_iso(), requested_doc_id)
                            )
                            clear_document_summary_cache(conn, requested_doc_id)
                            conn.commit()
                        doc_text_content = extracted_text
                        refreshed_from_file = True
                    elif doc_file_type == 'pdf' and can_persist_doc_text:
                        conn.execute(
                            '''
                            UPDATE documents
                            SET processing_status = ?,
                                processing_error = ?,
                                processed_at = ?
                            WHERE id = ?
                            ''',
                            (PDF_NEEDS_OCR_STATUS, PDF_NEEDS_OCR_ERROR, utcnow_iso(), requested_doc_id)
                        )
                        conn.commit()
                        doc_processing_status = PDF_NEEDS_OCR_STATUS
                        doc_processing_error = PDF_NEEDS_OCR_ERROR
                except Exception as e:
                    doc_text_extraction_error = str(e)
                    print(f"Document text extraction on summarize failed: {e}")
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
        text_source = 'document_file' if refreshed_from_file else 'document_content'
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

    length_targets = get_summary_length_targets(summary_length)
    length_options = {
        **length_targets,
        'summary_length': summary_length,
    }

    if not text_content:
        if requested_doc_id > 0:
            error_message = "No text is available for this document yet."
            if doc_file_type in ('png', 'jpg', 'jpeg', 'webp', 'gif'):
                error_message = "No text is available for this image yet. Run OCR first, then summarize the extracted text."
            elif doc_file_type == 'pdf':
                if doc_processing_status in (
                    PDF_NEEDS_OCR_STATUS,
                    PDF_TEXT_PENDING_STATUS,
                    'no_text_available',
                    'action_required',
                ):
                    error_message = doc_processing_error or (
                        PDF_TEXT_PENDING_ERROR
                        if doc_processing_status == PDF_TEXT_PENDING_STATUS
                        else PDF_NEEDS_OCR_ERROR
                    )
                else:
                    error_message = "No selectable text is available for this PDF. OCR or a text-selectable PDF is required before summarizing."
            elif doc_file_type in ('docx', 'txt'):
                error_message = "No text could be extracted from this file. Open the note and add or edit content first."
            return jsonify({
                "error": error_message,
                "processing_status": doc_processing_status,
                "processing_error": doc_processing_error,
                "details": {
                    "doc_id": requested_doc_id,
                    "file_type": doc_file_type,
                    "text_source": text_source,
                    "attempted_file_extraction": attempted_doc_text_extraction,
                    "file_extraction_error": doc_text_extraction_error,
                    "processing_status": doc_processing_status,
                    "processing_error": doc_processing_error,
                }
            }), 400
        return jsonify({"error": "No text provided"}), 400

    use_document_cache = requested_doc_id > 0 and text_source == 'document_content'
    text_hash = build_summary_cache_text_hash(text_content)
    summary_cache_key = build_document_summary_cache_key(text_content, summary_length, keyword_limit)
    text_char_count = len(text_content)
    text_word_count = len(re.findall(r'\S+', text_content))
    base_options_used = {
        "summary_length": summary_length,
        "keyword_limit": keyword_limit,
        "sentence_limit": length_options['sentence_limit'],
        "target_max_words": length_options['target_max_words'],
        "textrank_sentence_count": length_options['textrank_sentence_count'],
        "max_new_tokens": length_options['max_new_tokens'],
        "min_new_tokens": length_options['min_new_tokens'],
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

    def load_matching_cached_summary():
        if not (use_document_cache and text_hash and not force_refresh):
            return None
        cached_payload = None
        conn = get_db_connection()
        if conn:
            try:
                cached_payload = load_document_summary_cache(
                    conn,
                    requested_doc_id,
                    summary_cache_key,
                    summary_length,
                    keyword_limit
                )
            finally:
                conn.close()
        if not cached_payload:
            cached_payload = load_document_summary_fields_from_row(
                doc_row_data,
                summary_cache_key,
                text_hash,
            )
        return cached_payload

    def build_cached_summary_response(cached_payload):
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
            options_used["target_max_words"] = parse_int(
                cached_options.get("target_max_words"),
                length_options['target_max_words'],
                40,
                320
            )
            options_used["textrank_sentence_count"] = parse_int(
                cached_options.get("textrank_sentence_count"),
                length_options['textrank_sentence_count'],
                1,
                20
            )
            options_used["max_new_tokens"] = parse_int(
                cached_options.get("max_new_tokens"),
                length_options['max_new_tokens'],
                1
            )
            options_used["min_new_tokens"] = parse_int(
                cached_options.get("min_new_tokens"),
                length_options['min_new_tokens'],
                1
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
            "summary_text": str(cached_payload.get("summary_text") or cached_payload.get("summary") or '').strip(),
            "keywords": cached_payload.get("keywords") if isinstance(cached_payload.get("keywords"), list) else [],
            "key_sentences": (
                cached_payload.get("key_sentences")
                if isinstance(cached_payload.get("key_sentences"), list)
                else []
            ),
            "summary_source": str(
                cached_payload.get("summary_source") or "cache"
            ).strip().lower() or "cache",
            "ai_summary": str(cached_payload.get("ai_summary") or '').strip(),
            "extractive_summary": str(cached_payload.get("extractive_summary") or '').strip(),
            "summary_model": str(cached_payload.get("summary_model") or SUMMARIZER_MODEL_ID).strip() or SUMMARIZER_MODEL_ID,
            "used_fallback": parse_bool(cached_payload.get("used_fallback"), False),
            "summary_error": str(cached_payload.get("summary_error") or '').strip(),
            "summary_note": str(cached_payload.get("summary_note") or '').strip(),
            "text_source": text_source,
            "document_id": requested_doc_id,
            "summary_input_hash": text_hash,
            "summary_cache_key": summary_cache_key,
            "cache_hit": True,
            "cached_at": cached_payload.get("cached_at"),
            "options_used": options_used,
        })

    cached_payload = load_matching_cached_summary()
    if cached_payload:
        return build_cached_summary_response(cached_payload)

    summary_generation_started = False
    summary_generation_lock_token = ''
    if requested_doc_id > 0 and summary_cache_key:
        lock_conn = get_db_connection()
        try:
            lock_result = try_begin_summary_generation(
                lock_conn,
                requested_doc_id,
                summary_cache_key,
            )
        finally:
            if lock_conn:
                lock_conn.close()
        if lock_result is None:
            return jsonify({
                "error": "Summary generation lock is unavailable. Please retry.",
                "summary_input_hash": text_hash,
                "summary_cache_key": summary_cache_key,
                "document_id": requested_doc_id,
                "cache_hit": False,
            }), 503
        if not lock_result:
            return jsonify({
                "status": "in_progress",
                "in_progress": True,
                "summary_input_hash": text_hash,
                "summary_cache_key": summary_cache_key,
                "document_id": requested_doc_id,
                "cache_hit": False,
                "message": "Summary generation is already in progress for this document.",
            }), 202
        summary_generation_started = True
        summary_generation_lock_token = str(lock_result or '').strip()

    try:
        cached_payload = load_matching_cached_summary()
        if cached_payload:
            return build_cached_summary_response(cached_payload)

        summary_result = summarize_text_with_chunk_merge(text_content, length_options)
        summary = str(summary_result.get('summary') or '').strip()
        summary_source = str(summary_result.get('summary_source') or 'fallback').strip().lower() or 'fallback'
        summary_note = str(summary_result.get('summary_note') or '').strip()
        summary_meta = summary_result.get('meta') if isinstance(summary_result.get('meta'), dict) else {}
        summary_bundle = (
            summary_result.get('bundle')
            if isinstance(summary_result.get('bundle'), dict)
            else build_summary_bundle(
                text_content,
                summary_length=summary_length,
                target_max_words=length_options['target_max_words'],
                textrank_sentence_count=length_options['textrank_sentence_count'],
            )
        )
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

        key_sentences = (
            summary_bundle.get('key_sentences')
            if isinstance(summary_bundle.get('key_sentences'), list)
            else extract_key_sentences(text_content, keywords, limit=length_options['sentence_limit'])
        )

        response_payload = {
            "summary": summary,
            "summary_text": str(summary_bundle.get('summary_text') or summary).strip(),
            "keywords": keywords,
            "key_sentences": key_sentences,
            "summary_source": summary_source,
            "ai_summary": str(summary_bundle.get('ai_summary') or '').strip(),
            "extractive_summary": str(summary_bundle.get('extractive_summary') or '').strip(),
            "summary_model": str(summary_bundle.get('summary_model') or SUMMARIZER_MODEL_ID).strip() or SUMMARIZER_MODEL_ID,
            "used_fallback": bool(summary_bundle.get('used_fallback')),
            "summary_error": str(summary_bundle.get('error') or '').strip(),
            "summary_note": summary_note,
            "text_source": text_source,
            "document_id": requested_doc_id if requested_doc_id > 0 else None,
            "summary_input_hash": text_hash,
            "summary_cache_key": summary_cache_key,
            "cache_hit": False,
            "options_used": {
                **base_options_used,
                "summarizer_model": str(summary_bundle.get('summary_model') or SUMMARIZER_MODEL_ID).strip() or SUMMARIZER_MODEL_ID,
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

        should_cache_generated_summary = (
            use_document_cache
            and text_hash
            and not response_payload.get("used_fallback")
            and str(response_payload.get("summary_source") or '').strip().lower() not in ('textrank_fallback', 'fallback')
        )
        if (
            should_cache_generated_summary
            and external_summary_service_configured()
            and summary_source != 'custom_flan_t5_large'
        ):
            should_cache_generated_summary = False
        if should_cache_generated_summary:
            cache_conn = get_db_connection()
            if cache_conn:
                try:
                    save_document_summary_cache(
                        cache_conn,
                        requested_doc_id,
                        workspace_id,
                        username or document_owner_username,
                        summary_cache_key,
                        summary_length,
                        keyword_limit,
                        {
                            "summary": summary,
                            "summary_text": response_payload.get("summary_text") or summary,
                            "keywords": keywords,
                            "key_sentences": key_sentences,
                            "summary_source": summary_source,
                            "summary_model": response_payload.get("summary_model") or SUMMARIZER_MODEL_ID,
                            "ai_summary": response_payload.get("ai_summary") or '',
                            "extractive_summary": response_payload.get("extractive_summary") or '',
                            "used_fallback": response_payload.get("used_fallback"),
                            "summary_error": response_payload.get("summary_error") or '',
                            "summary_input_hash": text_hash,
                            "summary_cache_key": summary_cache_key,
                            "summary_note": summary_note,
                            "options_used": response_payload.get("options_used") if isinstance(response_payload.get("options_used"), dict) else {},
                        }
                    )
                    save_document_summary_fields(
                        cache_conn,
                        requested_doc_id,
                        response_payload,
                        text_hash,
                        summary_cache_key,
                    )
                finally:
                    cache_conn.close()

        return jsonify(response_payload)
    finally:
        if summary_generation_started:
            release_conn = get_db_connection()
            try:
                finish_summary_generation(
                    release_conn,
                    requested_doc_id,
                    summary_cache_key,
                    summary_generation_lock_token,
                )
            finally:
                if release_conn:
                    release_conn.close()

# ================= 修改后的下载/访问接口 (支持 S3) =================
def uploaded_file(filename):
    safe_filename = secure_filename(str(filename or '').strip())
    if not safe_filename or safe_filename != str(filename or '').strip():
        return jsonify({'error': 'File not found'}), 404

    bearer_token = get_request_auth_token() or (request.args.get('auth_token') or '').strip()
    token_ok, token_username, _ = decode_auth_token(bearer_token)
    username = token_username if token_ok else ''
    share_token = (request.args.get('share_token') or '').strip()
    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500

    try:
        cursor = conn.execute(
            'SELECT * FROM documents WHERE filename = ? ORDER BY id DESC LIMIT 1',
            (safe_filename,)
        )
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'File not found'}), 404
        if not username and not share_token:
            return jsonify({'error': 'Auth token or share token is required'}), 401
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
                Params={'Bucket': S3_BUCKET, 'Key': safe_filename},
                ExpiresIn=3600
            )
            # 让浏览器直接跳转到 AWS S3 下载
            return redirect(presigned_url, code=302)
        except Exception as e:
            print(f"S3 Link Generation Error: {e}")
            return jsonify({'error': 'Could not generate file link'}), 500
    else:
        # 如果没配 S3 (比如本地测试)，还是从本地文件夹读
        upload_dir = app.config['UPLOAD_FOLDER']
        if not os.path.isabs(upload_dir):
            upload_dir = os.path.abspath(upload_dir)
        return send_from_directory(upload_dir, safe_filename)

# ================= 前端路由 =================
def serve_index():
    return send_from_directory(app.static_folder, 'index.html')

def catch_all(path):
    if path.startswith('api/') or path.startswith('uploads/'):
        return jsonify({'error': 'Not found'}), 404
    
    if os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory(app.static_folder, path)
    
    return send_from_directory(app.static_folder, 'index.html')
