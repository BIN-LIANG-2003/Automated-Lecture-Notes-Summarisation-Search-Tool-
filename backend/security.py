import re

from flask import g, jsonify, request
from itsdangerous import URLSafeTimedSerializer, BadSignature, BadTimeSignature, SignatureExpired

from .config import AUTH_BYPASS_ENDPOINTS, AUTH_TOKEN_SALT, AUTH_TOKEN_SECRET, AUTH_TOKEN_TTL_SECONDS
from .utils import utcnow_iso


_auth_token_serializer = URLSafeTimedSerializer(AUTH_TOKEN_SECRET)
_FILE_AUTH_TOKEN_PATH_RE = re.compile(r'^/api/documents/\d+/file$')


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
    if endpoint_leaf == 'extract_text_from_image' and _request_doc_id() > 0:
        return True
    if endpoint_leaf == 'analyze_text' and _request_doc_id() > 0:
        return True
    return False


def get_authenticated_username():
    return str(getattr(g, 'authenticated_username', '') or '').strip()


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
