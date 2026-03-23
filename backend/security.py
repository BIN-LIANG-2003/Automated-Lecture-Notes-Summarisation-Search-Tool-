from flask import jsonify, request
from itsdangerous import URLSafeTimedSerializer, BadSignature, BadTimeSignature, SignatureExpired

from .config import AUTH_BYPASS_ENDPOINTS, AUTH_TOKEN_SALT, AUTH_TOKEN_SECRET, AUTH_TOKEN_TTL_SECONDS
from .utils import utcnow_iso


_auth_token_serializer = URLSafeTimedSerializer(AUTH_TOKEN_SECRET)


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


def extract_request_username():
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


def enforce_auth_token_middleware():
    path = str(request.path or '')
    if not path.startswith('/api/'):
        return None
    if request.method == 'OPTIONS':
        return None

    endpoint = str(request.endpoint or '')
    endpoint_leaf = endpoint.rsplit('.', 1)[-1]
    if endpoint in AUTH_BYPASS_ENDPOINTS or endpoint_leaf in AUTH_BYPASS_ENDPOINTS:
        return None

    username = extract_request_username()
    if not username:
        return None

    bearer_token = get_bearer_token()
    if not bearer_token:
        return jsonify({'error': 'Auth token is required'}), 401

    token_ok, token_username, token_error = decode_auth_token(bearer_token)
    if not token_ok:
        return jsonify({'error': token_error or 'Invalid auth token'}), 401
    if token_username != username:
        return jsonify({'error': 'Auth token does not match username'}), 403
    return None
