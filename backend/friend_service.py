import json
import uuid

from flask import jsonify, request

from .db import ensure_user_friend_code, get_db_connection, row_value
from .document_domain import build_editable_file_bytes
from .share_domain import is_document_soft_deleted, user_can_manage_document_share_links
from .security import get_authenticated_username
from .storage import detect_mimetype, read_file_bytes_from_storage, remove_document_file_from_storage, write_file_bytes_to_storage
from .utils import normalize_email, parse_bool, parse_int, row_to_dict, utcnow_iso
from .workspace_domain import (
    get_or_create_default_workspace_id,
    get_workspace_settings,
    workspace_belongs_to_user,
)


MAX_FRIEND_MESSAGE_LENGTH = 1000
MAX_FRIEND_SHARE_NOTE_LENGTH = 500
DIRECT_FILE_SHARE_TYPE = 'friend_file_share'


class FileShareWorkspaceError(ValueError):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


def _last_insert_id(conn, cursor):
    if conn.db_type == 'postgres':
        row = conn.execute('SELECT LASTVAL() AS id').fetchone()
        return parse_int(row_value(row, 'id', 0), 0, 0)
    return parse_int(getattr(cursor, 'lastrowid', 0), 0, 0)


def _friend_pair(username_a, username_b):
    first, second = sorted(
        [str(username_a or '').strip(), str(username_b or '').strip()],
        key=lambda value: value.lower(),
    )
    return first, second


def _safe_metadata_json(metadata):
    if not isinstance(metadata, dict):
        return ''
    try:
        return json.dumps(metadata, ensure_ascii=False)
    except Exception:
        return ''


def _load_metadata_json(value):
    if isinstance(value, dict):
        return dict(value)
    raw_value = str(value or '').strip()
    if not raw_value:
        return {}
    try:
        payload = json.loads(raw_value)
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def are_friends(conn, username_a, username_b):
    safe_a = str(username_a or '').strip()
    safe_b = str(username_b or '').strip()
    if not safe_a or not safe_b or safe_a == safe_b:
        return False
    user_a, user_b = _friend_pair(safe_a, safe_b)
    cursor = conn.execute(
        '''
        SELECT id
        FROM friendships
        WHERE user_a = ? AND user_b = ?
        LIMIT 1
        ''',
        (user_a, user_b),
    )
    return cursor.fetchone() is not None


def create_system_notification(
    conn,
    username,
    title,
    body='',
    *,
    notification_type='system',
    actor_username='',
    link_url='',
    metadata=None,
):
    safe_username = str(username or '').strip()
    safe_title = str(title or '').strip()
    if not safe_username or not safe_title:
        return False
    try:
        conn.execute(
            '''
            INSERT INTO user_notifications (
                username,
                type,
                title,
                body,
                actor_username,
                link_url,
                metadata_json,
                created_at,
                read_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            (
                safe_username,
                str(notification_type or 'system').strip() or 'system',
                safe_title[:160],
                str(body or '').strip()[:1000],
                str(actor_username or '').strip(),
                str(link_url or '').strip(),
                _safe_metadata_json(metadata),
                utcnow_iso(),
                None,
            ),
        )
        return True
    except Exception as exc:
        print(f'⚠️ Failed to create user notification: {exc}')
        return False


def create_friend_message(
    conn,
    sender_username,
    recipient_username,
    body,
    *,
    message_type='text',
    metadata=None,
):
    safe_sender = str(sender_username or '').strip()
    safe_recipient = str(recipient_username or '').strip()
    safe_body = str(body or '').strip()
    if not safe_sender or not safe_recipient or not safe_body:
        return 0
    cursor = conn.execute(
        '''
        INSERT INTO friend_messages (
            sender_username,
            recipient_username,
            body,
            message_type,
            metadata_json,
            created_at,
            read_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ''',
        (
            safe_sender,
            safe_recipient,
            safe_body[:MAX_FRIEND_MESSAGE_LENGTH],
            str(message_type or 'text').strip() or 'text',
            _safe_metadata_json(metadata),
            utcnow_iso(),
            None,
        ),
    )
    return _last_insert_id(conn, cursor)


def _load_document(conn, document_id):
    safe_doc_id = parse_int(document_id, 0, 1)
    if safe_doc_id <= 0:
        return {}
    cursor = conn.execute('SELECT * FROM documents WHERE id = ? LIMIT 1', (safe_doc_id,))
    return row_to_dict(cursor.fetchone()) or {}


def _document_title(doc):
    return (
        str((doc or {}).get('title') or '').strip()
        or str((doc or {}).get('filename') or '').strip()
        or 'Untitled note'
    )


def _document_file_type(doc):
    file_type = str((doc or {}).get('file_type') or '').strip().lower().lstrip('.')
    if file_type:
        return file_type
    filename = str((doc or {}).get('filename') or '').strip()
    if '.' in filename:
        return filename.rsplit('.', 1)[-1].strip().lower()
    return 'txt'


def _insert_copied_document(conn, source_doc, recipient_username, workspace_id, copied_filename):
    now_iso = utcnow_iso()
    file_type = _document_file_type(source_doc)
    columns = [
        'filename',
        'title',
        'uploaded_at',
        'file_type',
        'content',
        'content_html',
        'username',
        'tags',
        'category',
        'workspace_id',
        'last_access_at',
        'deleted_at',
        'processing_status',
        'processing_error',
        'processed_at',
    ]
    values = [
        copied_filename,
        _document_title(source_doc),
        now_iso,
        file_type,
        source_doc.get('content') or '',
        source_doc.get('content_html') or '',
        recipient_username,
        source_doc.get('tags') or '',
        source_doc.get('category') or '',
        workspace_id,
        None,
        None,
        source_doc.get('processing_status') or 'processed',
        source_doc.get('processing_error') or '',
        source_doc.get('processed_at') or now_iso,
    ]
    returning_sql = ' RETURNING id' if getattr(conn, 'db_type', '') == 'postgres' else ''
    cursor = conn.execute(
        f'''
        INSERT INTO documents ({', '.join(columns)})
        VALUES ({', '.join(['?'] * len(columns))})
        {returning_sql}
        ''',
        tuple(values),
    )
    if getattr(conn, 'db_type', '') == 'postgres':
        row = row_to_dict(cursor.fetchone()) or {}
        return parse_int(row.get('id'), 0, 0)
    return parse_int(getattr(cursor, 'lastrowid', 0), 0, 0)


def _resolve_file_share_target_workspace(conn, recipient_username, requested_workspace_id=''):
    safe_username = str(recipient_username or '').strip()
    safe_requested_id = str(requested_workspace_id or '').strip()
    workspace_id = safe_requested_id or get_or_create_default_workspace_id(conn, safe_username)
    if not workspace_id:
        raise FileShareWorkspaceError('Choose a workspace before accepting this file.', 400)
    if not workspace_belongs_to_user(conn, workspace_id, safe_username):
        raise FileShareWorkspaceError('You can only save shared files into a workspace you can access.', 403)
    workspace_settings = get_workspace_settings(conn, workspace_id)
    if not parse_bool(workspace_settings.get('allow_uploads', True), True):
        raise FileShareWorkspaceError('This workspace does not allow file uploads.', 403)
    return workspace_id


def _read_share_source_file_bytes(source_doc, source_filename, file_type):
    try:
        return read_file_bytes_from_storage(source_filename), detect_mimetype(source_filename, file_type), ''
    except Exception as storage_error:
        fallback_text = str((source_doc or {}).get('content') or '').strip()
        fallback_html = str((source_doc or {}).get('content_html') or '')
        if not fallback_text:
            raise RuntimeError(
                'The shared file is unavailable. Ask the sender to re-upload it or share it again.'
            ) from storage_error

        try:
            file_bytes, mimetype = build_editable_file_bytes(file_type, fallback_text, fallback_html)
        except Exception as fallback_error:
            raise RuntimeError(
                'The original file could not be copied, and StudyHub could not rebuild it from saved text.'
            ) from fallback_error

        return (
            file_bytes,
            mimetype,
            'Original file storage was unavailable, so StudyHub rebuilt the copy from saved text.',
        )


def _copy_document_to_user_workspace(conn, source_doc, recipient_username, workspace_id):
    source_filename = str((source_doc or {}).get('filename') or '').strip()
    if not source_filename:
        raise ValueError('Source file is missing a filename')
    file_type = _document_file_type(source_doc)
    copied_filename = f'{uuid.uuid4().hex}.{file_type}'
    if not workspace_id:
        raise ValueError('Could not resolve recipient workspace')

    file_bytes, mimetype, copy_warning = _read_share_source_file_bytes(
        source_doc,
        source_filename,
        file_type,
    )
    storage_written = False
    try:
        write_file_bytes_to_storage(copied_filename, file_bytes, mimetype)
        storage_written = True
        new_document_id = _insert_copied_document(
            conn,
            source_doc,
            recipient_username,
            workspace_id,
            copied_filename,
        )
        if new_document_id <= 0:
            raise RuntimeError('Document copy did not return an id')
        cursor = conn.execute('SELECT * FROM documents WHERE id = ? LIMIT 1', (new_document_id,))
        copied_doc = row_to_dict(cursor.fetchone()) or {}
        return new_document_id, copied_doc, workspace_id, copy_warning
    except Exception:
        if storage_written:
            remove_document_file_from_storage(copied_filename)
        raise


def resolve_file_share_target_workspace(conn, recipient_username, requested_workspace_id=''):
    return _resolve_file_share_target_workspace(conn, recipient_username, requested_workspace_id)


def copy_document_to_user_workspace(conn, source_doc, recipient_username, workspace_id):
    return _copy_document_to_user_workspace(conn, source_doc, recipient_username, workspace_id)


def _load_user_by_username(conn, username):
    cursor = conn.execute(
        '''
        SELECT username, email, friend_code
        FROM users
        WHERE username = ?
        LIMIT 1
        ''',
        (str(username or '').strip(),),
    )
    return row_to_dict(cursor.fetchone())


def _load_user_by_email(conn, email):
    cursor = conn.execute(
        '''
        SELECT username, email, friend_code
        FROM users
        WHERE LOWER(email) = ?
        LIMIT 1
        ''',
        (normalize_email(email),),
    )
    return row_to_dict(cursor.fetchone())


def _load_user_by_username_and_code(conn, username, friend_code):
    safe_code = str(friend_code or '').strip().upper()
    cursor = conn.execute(
        '''
        SELECT username, email, friend_code
        FROM users
        WHERE username = ? AND friend_code = ?
        LIMIT 1
        ''',
        (str(username or '').strip(), safe_code),
    )
    return row_to_dict(cursor.fetchone())


def _serialize_request(row, viewer_username=''):
    item = row_to_dict(row) or {}
    if not item:
        return {}
    requester = str(item.get('requester_username') or '').strip()
    target = str(item.get('target_username') or '').strip()
    viewer = str(viewer_username or '').strip()
    item['direction'] = 'incoming' if viewer and target == viewer else 'outgoing'
    item['peer_username'] = requester if item['direction'] == 'incoming' else target
    item['id'] = parse_int(item.get('id'), 0, 0)
    return item


def _serialize_message(row, viewer_username=''):
    item = row_to_dict(row) or {}
    if not item:
        return {}
    sender = str(item.get('sender_username') or '').strip()
    recipient = str(item.get('recipient_username') or '').strip()
    viewer = str(viewer_username or '').strip()
    direction = 'sent' if sender == viewer else 'received'
    item['id'] = parse_int(item.get('id'), 0, 0)
    item['direction'] = direction
    item['peer_username'] = recipient if direction == 'sent' else sender
    item['is_unread'] = bool(recipient == viewer and not item.get('read_at'))
    item['message_type'] = str(item.get('message_type') or 'text').strip() or 'text'
    raw_metadata = item.get('metadata_json') or ''
    try:
        item['metadata'] = json.loads(raw_metadata) if raw_metadata else {}
    except Exception:
        item['metadata'] = {}
    item.pop('metadata_json', None)
    return item


def _serialize_notification(row):
    item = row_to_dict(row) or {}
    if not item:
        return {}
    item['id'] = parse_int(item.get('id'), 0, 0)
    item['is_unread'] = not bool(item.get('read_at'))
    raw_metadata = item.get('metadata_json') or ''
    try:
        item['metadata'] = json.loads(raw_metadata) if raw_metadata else {}
    except Exception:
        item['metadata'] = {}
    item.pop('metadata_json', None)
    return item


def _friend_last_message(conn, username, friend_username):
    cursor = conn.execute(
        '''
        SELECT *
        FROM friend_messages
        WHERE (sender_username = ? AND recipient_username = ?)
           OR (sender_username = ? AND recipient_username = ?)
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        ''',
        (username, friend_username, friend_username, username),
    )
    return _serialize_message(cursor.fetchone(), username)


def _friend_unread_count(conn, username, friend_username):
    cursor = conn.execute(
        '''
        SELECT COUNT(*) AS unread_count
        FROM friend_messages
        WHERE sender_username = ?
          AND recipient_username = ?
          AND read_at IS NULL
        ''',
        (friend_username, username),
    )
    row = cursor.fetchone()
    return parse_int(row_value(row, 'unread_count', 0), 0, 0)


def _list_friends(conn, username):
    cursor = conn.execute(
        '''
        SELECT *
        FROM friendships
        WHERE user_a = ? OR user_b = ?
        ORDER BY created_at DESC, id DESC
        ''',
        (username, username),
    )
    friends = []
    for row in cursor.fetchall():
        item = row_to_dict(row) or {}
        friend_username = item.get('user_b') if item.get('user_a') == username else item.get('user_a')
        friend_row = _load_user_by_username(conn, friend_username)
        if not friend_row:
            continue
        ensure_user_friend_code(conn, friend_username)
        friend_row = _load_user_by_username(conn, friend_username) or friend_row
        friends.append({
            'username': friend_username,
            'email': friend_row.get('email') or '',
            'friend_code': friend_row.get('friend_code') or '',
            'created_at': item.get('created_at') or '',
            'unread_count': _friend_unread_count(conn, username, friend_username),
            'last_message': _friend_last_message(conn, username, friend_username),
        })
    return friends


def _list_friend_requests(conn, username, *, direction):
    if direction == 'incoming':
        cursor = conn.execute(
            '''
            SELECT fr.*, u.email AS requester_email, u.friend_code AS requester_friend_code
            FROM friend_requests fr
            LEFT JOIN users u ON u.username = fr.requester_username
            WHERE fr.target_username = ? AND fr.status = 'pending'
            ORDER BY fr.created_at DESC, fr.id DESC
            ''',
            (username,),
        )
    else:
        cursor = conn.execute(
            '''
            SELECT fr.*, u.email AS target_email, u.friend_code AS target_friend_code
            FROM friend_requests fr
            LEFT JOIN users u ON u.username = fr.target_username
            WHERE fr.requester_username = ? AND fr.status = 'pending'
            ORDER BY fr.created_at DESC, fr.id DESC
            ''',
            (username,),
        )
    return [_serialize_request(row, username) for row in cursor.fetchall()]


def _list_messages(conn, username):
    cursor = conn.execute(
        '''
        SELECT *
        FROM friend_messages
        WHERE sender_username = ? OR recipient_username = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 120
        ''',
        (username, username),
    )
    messages = [_serialize_message(row, username) for row in cursor.fetchall()]
    messages.reverse()
    return messages


def _list_notifications(conn, username):
    cursor = conn.execute(
        '''
        SELECT *
        FROM user_notifications
        WHERE username = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 80
        ''',
        (username,),
    )
    return [_serialize_notification(row) for row in cursor.fetchall()]


def _build_friend_summary(conn, username):
    friend_code = ensure_user_friend_code(conn, username)
    cursor = conn.execute(
        '''
        SELECT username, email, friend_code
        FROM users
        WHERE username = ?
        LIMIT 1
        ''',
        (username,),
    )
    user = row_to_dict(cursor.fetchone()) or {}
    user['friend_code'] = user.get('friend_code') or friend_code
    friends = _list_friends(conn, username)
    incoming_requests = _list_friend_requests(conn, username, direction='incoming')
    outgoing_requests = _list_friend_requests(conn, username, direction='outgoing')
    messages = _list_messages(conn, username)
    notifications = _list_notifications(conn, username)
    unread_messages = sum(1 for item in messages if item.get('is_unread'))
    unread_notifications = sum(1 for item in notifications if item.get('is_unread'))
    unread_count = unread_messages + unread_notifications + len(incoming_requests)
    return {
        'user': {
            'username': user.get('username') or username,
            'email': user.get('email') or '',
            'friend_code': user.get('friend_code') or '',
        },
        'friends': friends,
        'incoming_requests': incoming_requests,
        'outgoing_requests': outgoing_requests,
        'messages': messages,
        'notifications': notifications,
        'unread_count': unread_count,
    }


def get_friend_summary():
    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'username is required'}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        payload = _build_friend_summary(conn, username)
        conn.commit()
        return jsonify(payload), 200
    finally:
        conn.close()


def _find_pending_request(conn, requester_username, target_username):
    cursor = conn.execute(
        '''
        SELECT *
        FROM friend_requests
        WHERE requester_username = ?
          AND target_username = ?
          AND status = 'pending'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        ''',
        (requester_username, target_username),
    )
    return row_to_dict(cursor.fetchone())


def _accept_friend_request(conn, request_row, accepted_by):
    requester = str(request_row.get('requester_username') or '').strip()
    target = str(request_row.get('target_username') or '').strip()
    user_a, user_b = _friend_pair(requester, target)
    if not are_friends(conn, requester, target):
        conn.execute(
            '''
            INSERT INTO friendships (user_a, user_b, created_at)
            VALUES (?, ?, ?)
            ''',
            (user_a, user_b, utcnow_iso()),
        )
    conn.execute(
        '''
        UPDATE friend_requests
        SET status = 'accepted', responded_at = ?
        WHERE id = ?
        ''',
        (utcnow_iso(), request_row.get('id')),
    )
    create_system_notification(
        conn,
        requester,
        'Friend request accepted',
        f'{accepted_by} accepted your friend request.',
        notification_type='friend',
        actor_username=accepted_by,
    )
    create_system_notification(
        conn,
        target,
        'Friend added',
        f'You and {requester} are now friends.',
        notification_type='friend',
        actor_username=requester,
    )


def create_friend_request():
    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'username is required'}), 400
    data = request.get_json(silent=True) or {}
    mode = str(data.get('mode') or '').strip().lower()
    message = str(data.get('message') or '').strip()[:300]

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        requester = _load_user_by_username(conn, username)
        if not requester:
            return jsonify({'error': 'Current user not found'}), 404
        ensure_user_friend_code(conn, username)

        if mode == 'email' or data.get('email'):
            target = _load_user_by_email(conn, data.get('email'))
            if not target:
                return jsonify({'error': 'No StudyHub account was found for that email'}), 404
        else:
            target_username = str(data.get('username') or '').strip()
            friend_code = str(data.get('friend_code') or data.get('friendCode') or '').strip().upper()
            if not target_username or not friend_code:
                return jsonify({'error': 'Login name and connection code are required'}), 400
            target = _load_user_by_username_and_code(conn, target_username, friend_code)
            if not target:
                return jsonify({'error': 'No user matched that login name and connection code'}), 404

        target_username = str(target.get('username') or '').strip()
        if target_username == username:
            return jsonify({'error': 'You cannot add yourself as a friend'}), 400
        ensure_user_friend_code(conn, target_username)

        if are_friends(conn, username, target_username):
            return jsonify({'error': 'You are already friends'}), 409

        reciprocal = _find_pending_request(conn, target_username, username)
        if reciprocal:
            _accept_friend_request(conn, reciprocal, username)
            payload = _build_friend_summary(conn, username)
            conn.commit()
            return jsonify({'message': 'Friend request accepted.', 'summary': payload}), 200

        existing = _find_pending_request(conn, username, target_username)
        if existing:
            payload = _build_friend_summary(conn, username)
            conn.commit()
            return jsonify({
                'message': 'Friend request is already pending.',
                'request': _serialize_request(existing, username),
                'summary': payload,
            }), 200

        cursor = conn.execute(
            '''
            INSERT INTO friend_requests (
                requester_username,
                target_username,
                status,
                message,
                created_at,
                responded_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ''',
            (username, target_username, 'pending', message, utcnow_iso(), None),
        )
        request_id = _last_insert_id(conn, cursor)
        payload = _build_friend_summary(conn, username)
        conn.commit()
        return jsonify({
            'message': 'Friend request sent.',
            'request_id': request_id,
            'summary': payload,
        }), 201
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def respond_friend_request(request_id):
    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'username is required'}), 400
    safe_request_id = parse_int(request_id, 0, 1)
    if safe_request_id <= 0:
        return jsonify({'error': 'request_id is required'}), 400
    data = request.get_json(silent=True) or {}
    action = str(data.get('action') or '').strip().lower()
    if action not in ('accept', 'reject'):
        return jsonify({'error': 'action must be accept or reject'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        cursor = conn.execute(
            '''
            SELECT *
            FROM friend_requests
            WHERE id = ?
            LIMIT 1
            ''',
            (safe_request_id,),
        )
        request_row = row_to_dict(cursor.fetchone())
        if not request_row:
            return jsonify({'error': 'Friend request not found'}), 404
        if request_row.get('target_username') != username:
            return jsonify({'error': 'Only the invited user can respond to this request'}), 403
        if request_row.get('status') != 'pending':
            return jsonify({'error': f'Friend request is already {request_row.get("status")}'}), 409

        if action == 'accept':
            _accept_friend_request(conn, request_row, username)
            message = 'Friend request accepted.'
        else:
            conn.execute(
                '''
                UPDATE friend_requests
                SET status = 'rejected', responded_at = ?
                WHERE id = ?
                ''',
                (utcnow_iso(), safe_request_id),
            )
            create_system_notification(
                conn,
                request_row.get('requester_username'),
                'Friend request declined',
                f'{username} declined your friend request.',
                notification_type='friend',
                actor_username=username,
            )
            message = 'Friend request rejected.'

        payload = _build_friend_summary(conn, username)
        conn.commit()
        return jsonify({'message': message, 'summary': payload}), 200
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def send_friend_message():
    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'username is required'}), 400
    data = request.get_json(silent=True) or {}
    recipient = str(data.get('recipient_username') or data.get('recipient') or '').strip()
    body = str(data.get('body') or data.get('message') or '').strip()
    if not recipient:
        return jsonify({'error': 'recipient_username is required'}), 400
    if not body:
        return jsonify({'error': 'Message cannot be empty'}), 400
    if len(body) > MAX_FRIEND_MESSAGE_LENGTH:
        return jsonify({'error': f'Message must be {MAX_FRIEND_MESSAGE_LENGTH} characters or fewer'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        target = _load_user_by_username(conn, recipient)
        if not target:
            return jsonify({'error': 'Recipient not found'}), 404
        if not are_friends(conn, username, recipient):
            return jsonify({'error': 'You can only message friends'}), 403
        message_id = create_friend_message(conn, username, recipient, body)
        payload = _build_friend_summary(conn, username)
        conn.commit()
        return jsonify({
            'message': 'Message sent.',
            'message_id': message_id,
            'summary': payload,
        }), 201
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def send_friend_file_share():
    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'username is required'}), 400
    data = request.get_json(silent=True) or {}
    recipient = str(data.get('recipient_username') or data.get('recipient') or '').strip()
    document_id = parse_int(data.get('document_id') or data.get('documentId'), 0, 1)
    note = str(data.get('note') or data.get('message') or '').strip()[:MAX_FRIEND_SHARE_NOTE_LENGTH]
    if not recipient:
        return jsonify({'error': 'recipient_username is required'}), 400
    if document_id <= 0:
        return jsonify({'error': 'document_id is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        target = _load_user_by_username(conn, recipient)
        if not target:
            return jsonify({'error': 'Recipient not found'}), 404
        if not are_friends(conn, username, recipient):
            return jsonify({'error': 'You can only share files with friends'}), 403

        source_doc = _load_document(conn, document_id)
        if not source_doc:
            return jsonify({'error': 'Document not found'}), 404
        if is_document_soft_deleted(source_doc):
            return jsonify({'error': 'Document is in Trash'}), 404
        if not user_can_manage_document_share_links(conn, source_doc, username):
            return jsonify({'error': 'Only the owner or allowed workspace members can share this file'}), 403

        doc_title = _document_title(source_doc)
        metadata = {
            'status': 'pending',
            'sender_username': username,
            'source_document_id': document_id,
            'source_workspace_id': str(source_doc.get('workspace_id') or '').strip(),
            'document_title': doc_title,
            'document_file_type': _document_file_type(source_doc),
            'note': note,
        }
        body = f'{username} shared {doc_title} with you. Accept it to add a copy to your files.'
        if note:
            body = f'{body} Note: {note}'
        chat_body = f'Shared file: {doc_title}'
        if note:
            chat_body = f'{chat_body}\n{note}'
        message_metadata = {
            'status': 'pending',
            'sender_username': username,
            'recipient_username': recipient,
            'source_document_id': document_id,
            'source_workspace_id': str(source_doc.get('workspace_id') or '').strip(),
            'document_title': doc_title,
            'document_file_type': _document_file_type(source_doc),
            'note': note,
        }
        message_id = create_friend_message(
            conn,
            username,
            recipient,
            chat_body,
            message_type=DIRECT_FILE_SHARE_TYPE,
            metadata=message_metadata,
        )
        create_system_notification(
            conn,
            recipient,
            'File shared with you',
            body,
            notification_type=DIRECT_FILE_SHARE_TYPE,
            actor_username=username,
            link_url='',
            metadata=metadata,
        )
        payload = _build_friend_summary(conn, username)
        conn.commit()
        return jsonify({
            'message': f'File share sent to {recipient}.',
            'message_id': message_id,
            'summary': payload,
        }), 201
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def respond_friend_file_share(notification_id):
    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'username is required'}), 400
    safe_notification_id = parse_int(notification_id, 0, 1)
    if safe_notification_id <= 0:
        return jsonify({'error': 'notification_id is required'}), 400
    data = request.get_json(silent=True) or {}
    action = str(data.get('action') or '').strip().lower()
    target_workspace_id = str(
        data.get('target_workspace_id') or
        data.get('targetWorkspaceId') or
        data.get('workspace_id') or
        data.get('workspaceId') or
        ''
    ).strip()
    if action not in ('accept', 'reject'):
        return jsonify({'error': 'action must be accept or reject'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        cursor = conn.execute(
            '''
            SELECT *
            FROM user_notifications
            WHERE id = ? AND username = ?
            LIMIT 1
            ''',
            (safe_notification_id, username),
        )
        notification = row_to_dict(cursor.fetchone()) or {}
        if not notification:
            return jsonify({'error': 'File share request not found'}), 404
        if str(notification.get('type') or '').strip() != DIRECT_FILE_SHARE_TYPE:
            return jsonify({'error': 'This message is not a file share request'}), 400

        metadata = _load_metadata_json(notification.get('metadata_json'))
        current_status = str(metadata.get('status') or 'pending').strip().lower()
        if current_status in ('accepted', 'rejected'):
            payload = _build_friend_summary(conn, username)
            conn.commit()
            return jsonify({
                'message': f'File share already {current_status}.',
                'status': current_status,
                'summary': payload,
            }), 200
        if current_status != 'pending':
            return jsonify({'error': 'File share request is no longer pending'}), 409

        sender = str(metadata.get('sender_username') or notification.get('actor_username') or '').strip()
        if not sender:
            return jsonify({'error': 'File share sender is missing'}), 400
        if not are_friends(conn, username, sender):
            return jsonify({'error': 'You can only receive files from current friends'}), 403

        now_iso = utcnow_iso()
        if action == 'reject':
            metadata.update({
                'status': 'rejected',
                'responded_at': now_iso,
            })
            conn.execute(
                '''
                UPDATE user_notifications
                SET metadata_json = ?, read_at = COALESCE(read_at, ?)
                WHERE id = ? AND username = ?
                ''',
                (_safe_metadata_json(metadata), now_iso, safe_notification_id, username),
            )
            create_system_notification(
                conn,
                sender,
                'File share declined',
                f'{username} declined {str(metadata.get("document_title") or "the shared file").strip()}.',
                notification_type=DIRECT_FILE_SHARE_TYPE,
                actor_username=username,
                metadata={
                    'status': 'rejected',
                    'recipient_username': username,
                    'source_document_id': metadata.get('source_document_id'),
                    'document_title': metadata.get('document_title') or '',
                },
            )
            payload = _build_friend_summary(conn, username)
            conn.commit()
            return jsonify({'message': 'File share declined.', 'status': 'rejected', 'summary': payload}), 200

        source_doc_id = parse_int(metadata.get('source_document_id') or metadata.get('document_id'), 0, 1)
        source_doc = _load_document(conn, source_doc_id)
        if not source_doc:
            return jsonify({'error': 'The shared file is no longer available'}), 404
        if is_document_soft_deleted(source_doc):
            return jsonify({'error': 'The shared file is in Trash'}), 404

        try:
            workspace_id = _resolve_file_share_target_workspace(conn, username, target_workspace_id)
        except FileShareWorkspaceError as exc:
            return jsonify({'error': str(exc)}), exc.status_code

        try:
            new_document_id, copied_doc, workspace_id, copy_warning = _copy_document_to_user_workspace(
                conn,
                source_doc,
                username,
                workspace_id,
            )
        except RuntimeError as exc:
            return jsonify({'error': str(exc)}), 409
        except Exception as exc:
            print(f'Friend file share copy failed: {exc}')
            return jsonify({'error': 'File share could not be copied. Ask the sender to share it again.'}), 500

        metadata.update({
            'status': 'accepted',
            'responded_at': now_iso,
            'accepted_document_id': new_document_id,
            'accepted_workspace_id': workspace_id,
        })
        if copy_warning:
            metadata['accepted_copy_warning'] = copy_warning
        conn.execute(
            '''
            UPDATE user_notifications
            SET metadata_json = ?, read_at = COALESCE(read_at, ?)
            WHERE id = ? AND username = ?
            ''',
            (_safe_metadata_json(metadata), now_iso, safe_notification_id, username),
        )
        create_system_notification(
            conn,
            sender,
            'File share accepted',
            f'{username} accepted {_document_title(source_doc)}.',
            notification_type=DIRECT_FILE_SHARE_TYPE,
            actor_username=username,
            metadata={
                'status': 'accepted',
                'recipient_username': username,
                'source_document_id': source_doc_id,
                'accepted_document_id': new_document_id,
                'accepted_workspace_id': workspace_id,
                'document_title': _document_title(source_doc),
            },
        )
        payload = _build_friend_summary(conn, username)
        conn.commit()
        response_payload = {
            'message': 'File added to your files.',
            'status': 'accepted',
            'document_id': new_document_id,
            'workspace_id': workspace_id,
            'document': copied_doc,
            'summary': payload,
        }
        if copy_warning:
            response_payload['warning'] = copy_warning
        return jsonify(response_payload), 200
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({'error': 'File share response failed'}), 500
    finally:
        conn.close()


def _normalize_id_list(values):
    if not isinstance(values, list):
        return []
    normalized = []
    for value in values:
        next_id = parse_int(value, 0, 1)
        if next_id > 0 and next_id not in normalized:
            normalized.append(next_id)
    return normalized[:100]


def _mark_ids_read(conn, table_name, username_column, username, ids, *, extra_condition=''):
    if not ids:
        return
    placeholders = ', '.join('?' for _ in ids)
    condition = f' AND {extra_condition}' if extra_condition else ''
    conn.execute(
        f'''
        UPDATE {table_name}
        SET read_at = ?
        WHERE {username_column} = ?
          AND id IN ({placeholders})
          AND read_at IS NULL
          {condition}
        ''',
        (utcnow_iso(), username, *ids),
    )


def mark_friend_items_read():
    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'username is required'}), 400
    data = request.get_json(silent=True) or {}
    message_ids = _normalize_id_list(data.get('message_ids') or data.get('messageIds') or [])
    notification_ids = _normalize_id_list(data.get('notification_ids') or data.get('notificationIds') or [])
    peer_username = str(data.get('peer_username') or data.get('peerUsername') or '').strip()

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        if peer_username:
            conn.execute(
                '''
                UPDATE friend_messages
                SET read_at = ?
                WHERE recipient_username = ?
                  AND sender_username = ?
                  AND read_at IS NULL
                ''',
                (utcnow_iso(), username, peer_username),
            )
        _mark_ids_read(conn, 'friend_messages', 'recipient_username', username, message_ids)
        _mark_ids_read(conn, 'user_notifications', 'username', username, notification_ids)
        payload = _build_friend_summary(conn, username)
        conn.commit()
        return jsonify({'message': 'Items marked read.', 'summary': payload}), 200
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()
