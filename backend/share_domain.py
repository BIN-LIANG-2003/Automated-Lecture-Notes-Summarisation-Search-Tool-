import uuid

from .config import DEFAULT_WORKSPACE_SETTINGS, INVITE_BASE_URL
from .utils import invitation_is_expired, parse_bool, parse_int, row_to_dict, utcnow_iso
from .workspace_domain import get_workspace_record, get_workspace_settings, normalize_workspace_settings, workspace_belongs_to_user


def is_document_soft_deleted(doc_row):
    doc = row_to_dict(doc_row) or {}
    return bool(str(doc.get('deleted_at') or '').strip())


def create_document_share_token():
    return f'{uuid.uuid4().hex}{uuid.uuid4().hex}'


def build_document_share_url(token):
    safe_token = str(token or '').strip()
    if not safe_token:
        return ''
    return f'{INVITE_BASE_URL}/#/shared/{safe_token}'


def expire_document_share_links(conn, document_id=0):
    now_iso = utcnow_iso()
    safe_doc_id = parse_int(document_id, 0, 0)
    if safe_doc_id > 0:
        conn.execute(
            '''
            UPDATE document_share_links
            SET status = 'expired'
            WHERE document_id = ?
              AND status = 'active'
              AND expires_at < ?
            ''',
            (safe_doc_id, now_iso),
        )
    else:
        conn.execute(
            '''
            UPDATE document_share_links
            SET status = 'expired'
            WHERE status = 'active'
              AND expires_at < ?
            ''',
            (now_iso,),
        )


def serialize_document_share_link_row(row):
    data = row_to_dict(row) or {}
    return {
        'id': data.get('id'),
        'document_id': data.get('document_id'),
        'workspace_id': data.get('workspace_id', ''),
        'token': data.get('token', ''),
        'status': data.get('status', ''),
        'expires_at': data.get('expires_at', ''),
        'created_at': data.get('created_at', ''),
        'created_by': data.get('created_by', ''),
        'last_access_at': data.get('last_access_at', ''),
        'share_url': build_document_share_url(data.get('token', '')),
    }


def to_document_share_link_payload(row):
    payload = serialize_document_share_link_row(row)
    status = str(payload.get('status') or '').strip().lower()
    expired = status == 'expired' or invitation_is_expired(payload.get('expires_at'))
    payload['is_expired'] = bool(expired)
    payload['is_accessible'] = status == 'active' and not expired
    return payload


def list_document_share_link_payloads(conn, document_id, limit=20):
    safe_doc_id = parse_int(document_id, 0, 0)
    safe_limit = parse_int(limit, 20, 1, 100)
    if safe_doc_id <= 0:
        return []

    expire_document_share_links(conn, safe_doc_id)
    conn.commit()
    cursor = conn.execute(
        '''
        SELECT *
        FROM document_share_links
        WHERE document_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
        ''',
        (safe_doc_id, safe_limit),
    )
    return [to_document_share_link_payload(item) for item in cursor.fetchall()]


def validate_document_share_token(conn, document_id, token, mark_access=False):
    safe_token = str(token or '').strip()
    doc_id = parse_int(document_id, 0, 0)
    if not safe_token or doc_id <= 0:
        return False, None, 'Invalid share token'

    expire_document_share_links(conn, doc_id)
    conn.commit()

    cursor = conn.execute(
        '''
        SELECT *
        FROM document_share_links
        WHERE token = ? AND document_id = ?
        ORDER BY id DESC
        LIMIT 1
        ''',
        (safe_token, doc_id),
    )
    share_row = row_to_dict(cursor.fetchone())
    if not share_row:
        return False, None, 'Invalid share link'

    status = str(share_row.get('status') or '').strip().lower()
    if status == 'expired':
        return False, share_row, 'Share link has expired'
    if status and status != 'active':
        return False, share_row, 'Share link is no longer active'

    expires_at = share_row.get('expires_at')
    if invitation_is_expired(expires_at):
        conn.execute(
            "UPDATE document_share_links SET status = 'expired' WHERE id = ?",
            (share_row.get('id'),),
        )
        conn.commit()
        share_row['status'] = 'expired'
        return False, share_row, 'Share link has expired'

    if mark_access:
        now_iso = utcnow_iso()
        conn.execute(
            'UPDATE document_share_links SET last_access_at = ? WHERE id = ?',
            (now_iso, share_row.get('id')),
        )
        conn.commit()
        share_row['last_access_at'] = now_iso

    return True, share_row, ''


def get_document_link_sharing_mode(conn, doc_row):
    doc = row_to_dict(doc_row) or {}
    workspace_id = str(doc.get('workspace_id') or '').strip()
    if not workspace_id:
        return DEFAULT_WORKSPACE_SETTINGS['link_sharing_mode']
    workspace_row = get_workspace_record(conn, workspace_id)
    settings = normalize_workspace_settings((workspace_row or {}).get('settings_json'))
    return settings.get('link_sharing_mode', DEFAULT_WORKSPACE_SETTINGS['link_sharing_mode'])


def can_user_manage_workspace_share_links(conn, workspace_id, username=''):
    safe_workspace_id = str(workspace_id or '').strip()
    actor = str(username or '').strip()
    if not safe_workspace_id or not actor:
        return False

    workspace_row = get_workspace_record(conn, safe_workspace_id)
    if not workspace_row:
        return False

    owner_username = str((workspace_row or {}).get('owner_username') or '').strip()
    if owner_username and owner_username == actor:
        return True
    if not workspace_belongs_to_user(conn, safe_workspace_id, actor):
        return False

    workspace_settings = normalize_workspace_settings((workspace_row or {}).get('settings_json'))
    return parse_bool(workspace_settings.get('allow_member_share_management'), False)


def user_can_manage_document_share_links(conn, doc_row, username=''):
    doc = row_to_dict(doc_row) or {}
    actor = str(username or '').strip()
    if not actor:
        return False

    workspace_id = str(doc.get('workspace_id') or '').strip()
    owner_username = str(doc.get('username') or '').strip()
    if workspace_id:
        return can_user_manage_workspace_share_links(conn, workspace_id, actor)
    if owner_username:
        return owner_username == actor
    return False


def count_active_document_share_links(conn, document_id):
    safe_doc_id = parse_int(document_id, 0, 0)
    if safe_doc_id <= 0:
        return 0

    expire_document_share_links(conn, safe_doc_id)
    conn.commit()
    cursor = conn.execute(
        '''
        SELECT COUNT(1) AS total
        FROM document_share_links
        WHERE document_id = ? AND status = 'active'
        ''',
        (safe_doc_id,),
    )
    row = row_to_dict(cursor.fetchone()) or {}
    return parse_int(row.get('total', 0), 0, 0)


def check_document_access(conn, doc_row, username='', share_token=''):
    doc = row_to_dict(doc_row) or {}
    if is_document_soft_deleted(doc):
        return False, 'Document is in Trash'
    viewer = str(username or '').strip()
    safe_share_token = str(share_token or '').strip()
    doc_id = parse_int(doc.get('id', 0), 0, 0)
    workspace_id = str(doc.get('workspace_id') or '').strip()
    owner_username = str(doc.get('username') or '').strip()

    if not workspace_id:
        if owner_username and viewer == owner_username:
            return True, ''
        if safe_share_token:
            token_ok, _, token_reason = validate_document_share_token(
                conn,
                doc_id,
                safe_share_token,
                mark_access=True,
            )
            if token_ok:
                return True, ''
            if token_reason:
                return False, token_reason
        if owner_username and viewer and viewer != owner_username:
            return False, 'You do not have access to this document'
        return True, ''

    link_mode = get_document_link_sharing_mode(conn, doc)

    if viewer and workspace_belongs_to_user(conn, workspace_id, viewer):
        return True, ''

    if safe_share_token and link_mode != 'restricted':
        token_ok, _, token_reason = validate_document_share_token(
            conn,
            doc_id,
            safe_share_token,
            mark_access=True,
        )
        if token_ok:
            return True, ''
        if token_reason and link_mode == 'workspace':
            return False, token_reason

    if link_mode == 'public':
        return True, ''
    if link_mode == 'workspace':
        return False, 'This link is only available to workspace members'
    return False, 'Link sharing is restricted by workspace settings'
