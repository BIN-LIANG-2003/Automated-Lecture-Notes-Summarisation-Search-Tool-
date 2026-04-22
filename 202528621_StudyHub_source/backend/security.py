import re
import threading
import time

from flask import g, jsonify, request
from itsdangerous import URLSafeTimedSerializer, BadSignature, BadTimeSignature, SignatureExpired

from .config import (
    AUTH_BYPASS_ENDPOINTS,
    AUTH_COOKIE_NAME,
    AUTH_TOKEN_SALT,
    AUTH_TOKEN_SECRET,
    AUTH_TOKEN_TTL_SECONDS,
    RATE_LIMIT_ENABLED,
    RATE_LIMIT_WINDOW_SECONDS,
)
from .utils import utcnow_iso


_auth_token_serializer = URLSafeTimedSerializer(AUTH_TOKEN_SECRET)
_FILE_AUTH_TOKEN_PATH_RE = re.compile(r'^/api/documents/\d+/file$')
_RATE_LIMIT_LOCK = threading.Lock()
_RATE_LIMIT_BUCKETS = {}
RATE_LIMIT_RULES = {
    'login': (20, RATE_LIMIT_WINDOW_SECONDS),
    'register': (10, RATE_LIMIT_WINDOW_SECONDS),
    'resend_verification': (10, RATE_LIMIT_WINDOW_SECONDS),
    'upload_file': (60, RATE_LIMIT_WINDOW_SECONDS),
    'extract_text_from_image': (30, RATE_LIMIT_WINDOW_SECONDS),
    'analyze_text': (30, RATE_LIMIT_WINDOW_SECONDS),
    'summarize_document': (30, RATE_LIMIT_WINDOW_SECONDS),
}


def create_auth_token(username):
    safe_username = str(username or '').strip()
    if not safe_username:
        return ''
    payload = {
        'username': safe_username,
        'issued_at': utcnow_iso(),
    }
    return _auth_token_serializer.dumps(payload, salt=AUTH_TOKEN_SALT)


def decode_auth_token(token):
    safe_token = str(token or '').strip()
    if not safe_token:
        return False, '', 'Missing auth token'
    try:
        payload = _auth_token_serializer.loads(
            safe_token,
            salt=AUTH_TOKEN_SALT,
            max_age=AUTH_TOKEN_TTL_SECONDS,
        )
    except SignatureExpired:
        return False, '', 'Auth token expired, please sign in again'
    except (BadSignature, BadTimeSignature):
        return False, '', 'Invalid auth token'
    except Exception:
        return False, '', 'Invalid auth token'

    if not isinstance(payload, dict):
        return False, '', 'Invalid auth token payload'
    username = str(payload.get('username') or '').strip()
    if not username:
        return False, '', 'Invalid auth token payload'
    return True, username, ''


def get_bearer_token():
    auth_header = str(request.headers.get('Authorization') or '').strip()
    if not auth_header:
        return ''
    if not auth_header.lower().startswith('bearer '):
        return ''
    return auth_header[7:].strip()


def get_request_auth_token():
    bearer_token = get_bearer_token()
    if bearer_token:
        return bearer_token

    cookie_token = str(request.cookies.get(AUTH_COOKIE_NAME) or '').strip()
    if cookie_token:
        return cookie_token

    if _FILE_AUTH_TOKEN_PATH_RE.fullmatch(str(request.path or '').strip()):
        query_token = (request.args.get('auth_token') or '').strip()
        if query_token:
            return query_token
    return ''


def extract_request_username():
    endpoint_leaf = str(request.endpoint or '').rsplit('.', 1)[-1]
    if endpoint_leaf in {'create_friend_request'}:
        return ''

    query_username = (request.args.get('username') or '').strip()
    if query_username:
        return query_username

    form_username = (request.form.get('username') or '').strip()
    if form_username:
        return form_username

    if request.is_json:
        data = request.get_json(silent=True) or {}
        if isinstance(data, dict):
            json_username = (data.get('username') or '').strip()
            if json_username:
                return json_username

    value_username = (request.values.get('username') or '').strip()
    if value_username:
        return value_username
    return ''


def get_request_share_token():
    query_token = (request.args.get('share_token') or '').strip()
    if query_token:
        return query_token

    form_token = (request.form.get('share_token') or '').strip()
    if form_token:
        return form_token

    if request.is_json:
        data = request.get_json(silent=True) or {}
        if isinstance(data, dict):
            json_token = (data.get('share_token') or '').strip()
            if json_token:
                return json_token
    return ''


def _request_doc_id():
    view_args = request.view_args if isinstance(request.view_args, dict) else {}
    raw_doc_id = view_args.get('doc_id')
    if raw_doc_id not in (None, ''):
        try:
            return max(0, int(raw_doc_id))
        except Exception:
            return 0

    if request.is_json:
        data = request.get_json(silent=True) or {}
        if isinstance(data, dict):
            raw_doc_id = data.get('doc_id')
            if raw_doc_id not in (None, ''):
                try:
                    return max(0, int(raw_doc_id))
                except Exception:
                    return 0
    return 0


def _request_allows_anonymous_access(endpoint_leaf):
    if endpoint_leaf in AUTH_BYPASS_ENDPOINTS:
        return True

    share_token = get_request_share_token()
    if not share_token:
        return False

    if endpoint_leaf in {'get_document', 'get_document_file'}:
        return True
    return False


def get_authenticated_username():
    return str(getattr(g, 'authenticated_username', '') or '').strip()


def clear_rate_limit_state():
    with _RATE_LIMIT_LOCK:
        _RATE_LIMIT_BUCKETS.clear()


def _rate_limit_identity():
    forwarded_for = str(request.headers.get('X-Forwarded-For') or '').split(',', 1)[0].strip()
    remote_addr = str(request.remote_addr or '').strip()
    return forwarded_for or remote_addr or 'unknown'


def rate_limit_middleware():
    if not RATE_LIMIT_ENABLED:
        return None
    if request.method == 'OPTIONS':
        return None
    endpoint_leaf = str(request.endpoint or '').rsplit('.', 1)[-1]
    rule = RATE_LIMIT_RULES.get(endpoint_leaf)
    if not rule:
        return None

    limit, window_seconds = rule
    try:
        safe_limit = max(1, int(limit))
        safe_window = max(1, int(window_seconds))
    except Exception:
        return None

    now = time.monotonic()
    key = (endpoint_leaf, _rate_limit_identity())
    with _RATE_LIMIT_LOCK:
        timestamps = [
            ts for ts in _RATE_LIMIT_BUCKETS.get(key, [])
            if now - ts < safe_window
        ]
        if len(timestamps) >= safe_limit:
            retry_after = max(1, int(safe_window - (now - timestamps[0])))
            response = jsonify({
                'error': 'Too many requests. Please wait and try again.',
                'retry_after_seconds': retry_after,
            })
            response.status_code = 429
            response.headers['Retry-After'] = str(retry_after)
            return response
        timestamps.append(now)
        _RATE_LIMIT_BUCKETS[key] = timestamps
    return None


def enforce_auth_token_middleware():
    path = str(request.path or '')
    if not path.startswith('/api/'):
        return None
    if request.method == 'OPTIONS':
        return None

    endpoint = str(request.endpoint or '')
    if not endpoint:
        return None
    endpoint_leaf = endpoint.rsplit('.', 1)[-1]
    g.authenticated_username = ''
    g.auth_token_error = ''

    auth_token = get_request_auth_token()
    token_ok = False
    token_username = ''
    token_error = ''
    if auth_token:
        token_ok, token_username, token_error = decode_auth_token(auth_token)
        if token_ok:
            g.authenticated_username = token_username
        else:
            g.auth_token_error = token_error or 'Invalid auth token'

    username = extract_request_username()
    if token_ok and username and token_username != username:
        return jsonify({'error': 'Auth token does not match username'}), 403

    if _request_allows_anonymous_access(endpoint_leaf) or endpoint in AUTH_BYPASS_ENDPOINTS:
        return None

    if not auth_token:
        return jsonify({'error': 'Auth token is required'}), 401
    if not token_ok:
        return jsonify({'error': token_error or 'Invalid auth token'}), 401
    return None
