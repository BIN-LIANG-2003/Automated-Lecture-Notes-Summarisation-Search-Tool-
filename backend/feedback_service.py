import html
import re
from urllib.parse import quote

from flask import jsonify, request

from .config import APP_BASE_URL, FEEDBACK_ADMIN_USERNAMES, SUPPORT_EMAIL
from .db import get_db_connection
from .email_service import send_resend_email
from .security import get_authenticated_username
from .utils import normalize_email, parse_int, row_to_dict, utcnow_iso
from .workspace_domain import is_valid_email


FEEDBACK_TYPES = {
    'bug_report': 'Bug report',
    'feature_request': 'Feature request',
    'login_account': 'Login & account',
    'upload_ocr': 'Upload & OCR',
    'sharing_email': 'Sharing & email',
    'performance': 'Performance',
    'ui_usability': 'UI & usability',
    'other': 'Other',
}
FEEDBACK_PRIORITIES = {'low', 'medium', 'high'}
FEEDBACK_STATUSES = {
    'new',
    'acknowledged',
    'in_review',
    'planned',
    'in_progress',
    'resolved',
    'closed',
}
OPEN_FEEDBACK_STATUSES = FEEDBACK_STATUSES - {'resolved', 'closed'}
PUBLIC_EVENT_TYPES = {'submitted', 'status_changed', 'public_reply', 'user_follow_up'}
INTERNAL_EVENT_TYPES = {'internal_note', 'email_sent', 'email_failed'}


def _clean_text(value, max_length=1000):
    text = re.sub(r'\s+', ' ', str(value or '').strip())
    if max_length and len(text) > max_length:
        return text[:max_length].strip()
    return text


def _clean_multiline(value, max_length=5000):
    text = str(value or '').replace('\r\n', '\n').replace('\r', '\n').strip()
    text = re.sub(r'\n{4,}', '\n\n\n', text)
    if max_length and len(text) > max_length:
        return text[:max_length].strip()
    return text


def _normalize_feedback_type(value):
    raw = _clean_text(value, 80).lower()
    key = re.sub(r'[^a-z0-9]+', '_', raw).strip('_')
    if key in FEEDBACK_TYPES:
        return key
    for candidate, label in FEEDBACK_TYPES.items():
        if raw == label.lower():
            return candidate
    return 'other'


def _normalize_priority(value):
    priority = _clean_text(value, 30).lower()
    return priority if priority in FEEDBACK_PRIORITIES else 'medium'


def _normalize_status(value, default='new'):
    status = _clean_text(value, 40).lower()
    return status if status in FEEDBACK_STATUSES else default


def _admin_usernames():
    return {
        item.strip().lower()
        for item in str(FEEDBACK_ADMIN_USERNAMES or '').split(',')
        if item.strip()
    }


def is_feedback_admin(username):
    safe_username = str(username or '').strip().lower()
    return bool(safe_username and safe_username in _admin_usernames())


def _require_authenticated_username():
    username = get_authenticated_username()
    if not username:
        return '', (jsonify({'error': 'Authentication required'}), 401)
    return username, None


def _require_feedback_admin():
    username, error = _require_authenticated_username()
    if error:
        return '', error
    if not is_feedback_admin(username):
        return '', (jsonify({'error': 'Feedback admin access required'}), 403)
    return username, None


def _load_user_profile(conn, username):
    user = row_to_dict(
        conn.execute(
            'SELECT username, email FROM users WHERE username = ? LIMIT 1',
            (username,),
        ).fetchone()
    ) or {}
    return {
        'username': str(user.get('username') or username or '').strip(),
        'email': normalize_email(user.get('email')),
    }


def _feedback_admin_link(feedback_id=''):
    safe_id = quote(str(feedback_id or '').strip())
    suffix = f'?feedback={safe_id}' if safe_id else ''
    return f'{APP_BASE_URL}/#/admin/feedback{suffix}'


def _insert_feedback_item(conn, params):
    now_iso = utcnow_iso()
    values = (
        params['username'],
        params['user_email_snapshot'],
        params['type'],
        params['title'],
        params['description'],
        params['priority'],
        'new',
        params['page_path'],
        params['workspace_id'],
        params['document_id'],
        params['user_agent'],
        '',
        now_iso,
        now_iso,
        None,
    )
    if conn.db_type == 'postgres':
        cursor = conn.execute(
            '''
            INSERT INTO feedback_items (
                username,
                user_email_snapshot,
                type,
                title,
                description,
                priority,
                status,
                page_path,
                workspace_id,
                document_id,
                user_agent,
                assigned_to,
                created_at,
                updated_at,
                resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            ''',
            values,
        )
        row = row_to_dict(cursor.fetchone()) or {}
        return parse_int(row.get('id'), 0, 0)

    cursor = conn.execute(
        '''
        INSERT INTO feedback_items (
            username,
            user_email_snapshot,
            type,
            title,
            description,
            priority,
            status,
            page_path,
            workspace_id,
            document_id,
            user_agent,
            assigned_to,
            created_at,
            updated_at,
            resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''',
        values,
    )
    return parse_int(getattr(cursor, 'lastrowid', 0), 0, 0)


def _record_feedback_event(
    conn,
    feedback_id,
    *,
    actor_username='',
    actor_role='system',
    event_type='internal_note',
    old_status='',
    new_status='',
    message='',
    visibility='internal',
):
    now_iso = utcnow_iso()
    conn.execute(
        '''
        INSERT INTO feedback_events (
            feedback_id,
            actor_username,
            actor_role,
            event_type,
            old_status,
            new_status,
            message,
            visibility,
            created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''',
        (
            parse_int(feedback_id, 0, 1),
            _clean_text(actor_username, 120),
            _clean_text(actor_role, 40) or 'system',
            _clean_text(event_type, 60),
            _clean_text(old_status, 40),
            _clean_text(new_status, 40),
            _clean_multiline(message, 3000),
            'public' if visibility == 'public' else 'internal',
            now_iso,
        ),
    )


def _load_feedback_item(conn, feedback_id):
    return row_to_dict(
        conn.execute(
            'SELECT * FROM feedback_items WHERE id = ? LIMIT 1',
            (parse_int(feedback_id, 0, 1),),
        ).fetchone()
    )


def _load_feedback_events(conn, feedback_id, *, include_internal=False):
    sql = '''
        SELECT *
        FROM feedback_events
        WHERE feedback_id = ?
    '''
    params = [parse_int(feedback_id, 0, 1)]
    if not include_internal:
        sql += " AND visibility = 'public'"
    sql += ' ORDER BY created_at ASC, id ASC'
    return [row_to_dict(row) for row in conn.execute(sql, tuple(params)).fetchall()]


def _latest_public_update(conn, feedback_id):
    row = row_to_dict(
        conn.execute(
            '''
            SELECT message, event_type, new_status, created_at
            FROM feedback_events
            WHERE feedback_id = ?
              AND visibility = 'public'
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            ''',
            (parse_int(feedback_id, 0, 1),),
        ).fetchone()
    ) or {}
    message = _clean_text(row.get('message'), 220)
    if message:
        return message
    event_type = str(row.get('event_type') or '').strip()
    if event_type == 'status_changed':
        status = str(row.get('new_status') or '').strip().replace('_', ' ')
        return f'Status updated to {status}.'
    if event_type == 'submitted':
        return 'Feedback submitted.'
    return ''


def _serialize_event(row, *, include_internal=False):
    event = row_to_dict(row) or {}
    if event.get('visibility') == 'internal' and not include_internal:
        return None
    payload = {
        'id': parse_int(event.get('id'), 0, 0),
        'feedback_id': parse_int(event.get('feedback_id'), 0, 0),
        'actor_username': str(event.get('actor_username') or '').strip(),
        'actor_role': str(event.get('actor_role') or '').strip(),
        'event_type': str(event.get('event_type') or '').strip(),
        'old_status': str(event.get('old_status') or '').strip(),
        'new_status': str(event.get('new_status') or '').strip(),
        'message': str(event.get('message') or '').strip(),
        'visibility': str(event.get('visibility') or '').strip(),
        'created_at': str(event.get('created_at') or '').strip(),
    }
    if not include_internal and payload['visibility'] == 'internal':
        return None
    return payload


def _serialize_feedback_item(conn, row, *, include_private=False, include_events=False):
    item = row_to_dict(row) or {}
    feedback_id = parse_int(item.get('id'), 0, 0)
    payload = {
        'id': feedback_id,
        'type': str(item.get('type') or 'other').strip(),
        'type_label': FEEDBACK_TYPES.get(str(item.get('type') or '').strip(), 'Other'),
        'title': str(item.get('title') or '').strip(),
        'description': str(item.get('description') or '').strip(),
        'priority': str(item.get('priority') or 'medium').strip(),
        'status': str(item.get('status') or 'new').strip(),
        'page_path': str(item.get('page_path') or '').strip(),
        'workspace_id': str(item.get('workspace_id') or '').strip(),
        'document_id': parse_int(item.get('document_id'), 0, 0) or None,
        'created_at': str(item.get('created_at') or '').strip(),
        'updated_at': str(item.get('updated_at') or '').strip(),
        'resolved_at': str(item.get('resolved_at') or '').strip(),
        'latest_public_update': _latest_public_update(conn, feedback_id),
    }
    if include_private:
        payload.update({
            'username': str(item.get('username') or '').strip(),
            'user_email_snapshot': normalize_email(item.get('user_email_snapshot')),
            'user_agent': str(item.get('user_agent') or '').strip(),
            'assigned_to': str(item.get('assigned_to') or '').strip(),
        })
    if include_events:
        events = _load_feedback_events(conn, feedback_id, include_internal=include_private)
        payload['events'] = [
            event
            for event in (_serialize_event(row, include_internal=include_private) for row in events)
            if event
        ]
    return payload


def _serialize_similar_feedback(row, current_username):
    item = row_to_dict(row) or {}
    is_own = str(item.get('username') or '').strip() == str(current_username or '').strip()
    description = _clean_text(item.get('description'), 180) if is_own else ''
    if len(description) > 140:
        description = f'{description[:137].rstrip()}...'
    return {
        'id': parse_int(item.get('id'), 0, 0),
        'title': str(item.get('title') or '').strip(),
        'type': str(item.get('type') or 'other').strip(),
        'type_label': FEEDBACK_TYPES.get(str(item.get('type') or '').strip(), 'Other'),
        'status': str(item.get('status') or 'new').strip(),
        'preview': description,
        'is_own': is_own,
    }


def _record_email_event(feedback_id, *, ok, target_email, context, actor_username='system'):
    conn = get_db_connection()
    if not conn:
        return
    try:
        _record_feedback_event(
            conn,
            feedback_id,
            actor_username=actor_username,
            actor_role='system',
            event_type='email_sent' if ok else 'email_failed',
            message=f'{context}: {target_email}' if ok else f'{context} failed for {target_email}',
            visibility='internal',
        )
        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        print(f'Feedback email event record failed: {e}')
    finally:
        conn.close()


def _send_admin_feedback_notification(item):
    recipient = normalize_email(SUPPORT_EMAIL)
    if not recipient or not is_valid_email(recipient):
        return False, 'SUPPORT_EMAIL is not a valid email address'

    admin_url = _feedback_admin_link(item.get('id'))
    user_email = normalize_email(item.get('user_email_snapshot'))
    subject = f"StudyHub feedback: {item.get('title') or 'Untitled'}"
    body_html = f'''
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 640px; margin: 0 auto;">
          <h2>New StudyHub feedback</h2>
          <p><strong>{html.escape(item.get('title') or 'Untitled')}</strong></p>
          <p><strong>Type:</strong> {html.escape(FEEDBACK_TYPES.get(item.get('type'), item.get('type') or 'other'))}</p>
          <p><strong>Priority:</strong> {html.escape(item.get('priority') or 'medium')}</p>
          <p><strong>User:</strong> {html.escape(item.get('username') or '')} {html.escape(user_email)}</p>
          <p><strong>Page:</strong> {html.escape(item.get('page_path') or '-')}</p>
          <p><strong>Workspace:</strong> {html.escape(item.get('workspace_id') or '-')} · <strong>Document:</strong> {html.escape(str(item.get('document_id') or '-'))}</p>
          <div style="margin: 14px 0; padding: 12px 14px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px;">
            {html.escape(item.get('description') or '').replace(chr(10), '<br />')}
          </div>
          <p><a href="{html.escape(admin_url)}" style="display: inline-block; padding: 10px 14px; border-radius: 8px; background: #2563eb; color: #fff; text-decoration: none;">Open admin inbox</a></p>
        </div>
    '''
    body_text = (
        f"New StudyHub feedback\n\n"
        f"Title: {item.get('title') or 'Untitled'}\n"
        f"Type: {FEEDBACK_TYPES.get(item.get('type'), item.get('type') or 'other')}\n"
        f"Priority: {item.get('priority') or 'medium'}\n"
        f"User: {item.get('username') or ''} {user_email}\n"
        f"Page: {item.get('page_path') or '-'}\n"
        f"Workspace: {item.get('workspace_id') or '-'}\n"
        f"Document: {item.get('document_id') or '-'}\n\n"
        f"{item.get('description') or ''}\n\n"
        f"Admin inbox: {admin_url}\n"
    )
    return send_resend_email(recipient, subject, body_html, body_text, reply_to=user_email)


def _send_admin_feedback_follow_up_notification(item, message):
    recipient = normalize_email(SUPPORT_EMAIL)
    if not recipient or not is_valid_email(recipient):
        return False, 'SUPPORT_EMAIL is not a valid email address'

    admin_url = _feedback_admin_link(item.get('id'))
    user_email = normalize_email(item.get('user_email_snapshot'))
    safe_title = item.get('title') or 'Untitled feedback'
    body_html = f'''
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 640px; margin: 0 auto;">
          <h2>New follow-up on StudyHub feedback</h2>
          <p><strong>{html.escape(safe_title)}</strong></p>
          <p><strong>User:</strong> {html.escape(item.get('username') or '')} {html.escape(user_email)}</p>
          <div style="margin: 14px 0; padding: 12px 14px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px;">
            {html.escape(message or '').replace(chr(10), '<br />')}
          </div>
          <p><a href="{html.escape(admin_url)}" style="display: inline-block; padding: 10px 14px; border-radius: 8px; background: #2563eb; color: #fff; text-decoration: none;">Open feedback thread</a></p>
        </div>
    '''
    body_text = (
        f'New follow-up on StudyHub feedback\n\n'
        f'Title: {safe_title}\n'
        f"User: {item.get('username') or ''} {user_email}\n\n"
        f'{message or ""}\n\n'
        f'Feedback thread: {admin_url}\n'
    )
    return send_resend_email(
        recipient,
        f'StudyHub feedback follow-up: {safe_title}',
        body_html,
        body_text,
        reply_to=user_email,
    )


def _send_user_feedback_email(item, subject_prefix, message):
    recipient = normalize_email(item.get('user_email_snapshot'))
    if not recipient or not is_valid_email(recipient):
        return False, 'Feedback submitter has no valid email address'

    safe_title = item.get('title') or 'your feedback'
    body_html = f'''
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: 0 auto;">
          <h2>{html.escape(subject_prefix)}</h2>
          <p>{html.escape(message)}</p>
          <p><strong>Feedback:</strong> {html.escape(safe_title)}</p>
          <p><strong>Status:</strong> {html.escape(str(item.get('status') or 'new').replace('_', ' '))}</p>
          <p style="font-size: 12px; color: #6b7280;">This is a private StudyHub feedback update. Internal admin notes are never included.</p>
        </div>
    '''
    body_text = (
        f'{subject_prefix}\n\n'
        f'{message}\n\n'
        f'Feedback: {safe_title}\n'
        f"Status: {str(item.get('status') or 'new').replace('_', ' ')}\n"
    )
    return send_resend_email(recipient, f'StudyHub feedback update: {safe_title}', body_html, body_text)


def get_feedback_config():
    username, error = _require_authenticated_username()
    if error:
        return error
    return jsonify({
        'support_email': SUPPORT_EMAIL,
        'is_admin': is_feedback_admin(username),
        'types': [{'value': key, 'label': label} for key, label in FEEDBACK_TYPES.items()],
        'priorities': sorted(FEEDBACK_PRIORITIES),
        'statuses': list(FEEDBACK_STATUSES),
    }), 200


def submit_feedback():
    username, error = _require_authenticated_username()
    if error:
        return error

    data = request.get_json(silent=True) or {}
    title = _clean_text(data.get('title'), 160)
    description = _clean_multiline(data.get('description'), 5000)
    if not title:
        return jsonify({'error': 'Feedback title is required'}), 400
    if not description:
        return jsonify({'error': 'Feedback description is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500

    try:
        profile = _load_user_profile(conn, username)
        params = {
            'username': username,
            'user_email_snapshot': profile['email'],
            'type': _normalize_feedback_type(data.get('type')),
            'title': title,
            'description': description,
            'priority': _normalize_priority(data.get('priority')),
            'page_path': _clean_text(data.get('page_path'), 500),
            'workspace_id': _clean_text(data.get('workspace_id'), 120),
            'document_id': parse_int(data.get('document_id'), 0, 0) or None,
            'user_agent': _clean_text(request.headers.get('User-Agent'), 500),
        }
        feedback_id = _insert_feedback_item(conn, params)
        if not feedback_id:
            raise RuntimeError('Feedback insert did not return an id')
        _record_feedback_event(
            conn,
            feedback_id,
            actor_username=username,
            actor_role='user',
            event_type='submitted',
            message='Feedback submitted.',
            visibility='public',
        )
        conn.commit()
        item = _load_feedback_item(conn, feedback_id)
        payload = _serialize_feedback_item(conn, item, include_private=False, include_events=True)
        private_item = _serialize_feedback_item(conn, item, include_private=True, include_events=False)
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({'error': f'Failed to submit feedback: {e}'}), 500
    finally:
        conn.close()

    admin_ok, admin_error = _send_admin_feedback_notification(private_item)
    _record_email_event(
        feedback_id,
        ok=admin_ok,
        target_email=normalize_email(SUPPORT_EMAIL),
        context='Admin notification',
    )
    if not admin_ok:
        print(f'Feedback admin notification failed for #{feedback_id}: {admin_error}')

    ack_ok, ack_error = _send_user_feedback_email(
        private_item,
        'Feedback received',
        'Thanks for sending feedback. We have received your report and will review the details. You will get an update when there is a reply or status change.',
    )
    _record_email_event(
        feedback_id,
        ok=ack_ok,
        target_email=private_item.get('user_email_snapshot') or '',
        context='User acknowledgement',
    )
    if not ack_ok:
        print(f'Feedback acknowledgement failed for #{feedback_id}: {ack_error}')

    return jsonify({
        'item': payload,
        'support_email': SUPPORT_EMAIL,
        'admin_notified': bool(admin_ok),
        'acknowledgment_sent': bool(ack_ok),
    }), 201


def list_my_feedback():
    username, error = _require_authenticated_username()
    if error:
        return error
    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        rows = conn.execute(
            '''
            SELECT *
            FROM feedback_items
            WHERE username = ?
            ORDER BY updated_at DESC, id DESC
            ''',
            (username,),
        ).fetchall()
        items = [_serialize_feedback_item(conn, row, include_private=False, include_events=False) for row in rows]
        return jsonify({
            'items': items,
            'total': len(items),
            'is_admin': is_feedback_admin(username),
            'support_email': SUPPORT_EMAIL,
        }), 200
    finally:
        conn.close()


def get_my_feedback(feedback_id):
    username, error = _require_authenticated_username()
    if error:
        return error
    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        item = _load_feedback_item(conn, feedback_id)
        if not item or str(item.get('username') or '').strip() != username:
            return jsonify({'error': 'Feedback item not found'}), 404
        return jsonify({
            'item': _serialize_feedback_item(conn, item, include_private=False, include_events=True),
            'support_email': SUPPORT_EMAIL,
        }), 200
    finally:
        conn.close()


def add_feedback_follow_up(feedback_id):
    username, error = _require_authenticated_username()
    if error:
        return error
    data = request.get_json(silent=True) or {}
    message = _clean_multiline(data.get('message'), 3000)
    if not message:
        return jsonify({'error': 'Follow-up message is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500

    email_item = None
    try:
        item = _load_feedback_item(conn, feedback_id)
        if not item or str(item.get('username') or '').strip() != username:
            return jsonify({'error': 'Feedback item not found'}), 404
        if str(item.get('status') or 'new').strip() == 'closed':
            return jsonify({'error': 'This feedback is closed. Start a new feedback item if you need more help.'}), 409

        now_iso = utcnow_iso()
        conn.execute(
            'UPDATE feedback_items SET updated_at = ? WHERE id = ?',
            (now_iso, parse_int(feedback_id, 0, 1)),
        )
        _record_feedback_event(
            conn,
            feedback_id,
            actor_username=username,
            actor_role='user',
            event_type='user_follow_up',
            message=message,
            visibility='public',
        )
        conn.commit()
        email_item = _load_feedback_item(conn, feedback_id)
        payload = _serialize_feedback_item(conn, email_item, include_private=False, include_events=True)
        private_item = _serialize_feedback_item(conn, email_item, include_private=True, include_events=False)
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({'error': f'Failed to add follow-up: {e}'}), 500
    finally:
        conn.close()

    admin_ok, admin_error = _send_admin_feedback_follow_up_notification(private_item, message)
    _record_email_event(
        feedback_id,
        ok=admin_ok,
        target_email=normalize_email(SUPPORT_EMAIL),
        context='User follow-up notification',
        actor_username=username,
    )
    if not admin_ok:
        print(f'Feedback follow-up admin notification failed for #{feedback_id}: {admin_error}')

    return jsonify({'item': payload, 'admin_notified': bool(admin_ok)}), 200


def close_my_feedback(feedback_id):
    username, error = _require_authenticated_username()
    if error:
        return error

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500

    try:
        item = _load_feedback_item(conn, feedback_id)
        if not item or str(item.get('username') or '').strip() != username:
            return jsonify({'error': 'Feedback item not found'}), 404

        old_status = str(item.get('status') or 'new').strip()
        if old_status != 'closed':
            now_iso = utcnow_iso()
            conn.execute(
                '''
                UPDATE feedback_items
                SET status = ?,
                    updated_at = ?,
                    resolved_at = ?
                WHERE id = ?
                ''',
                ('closed', now_iso, now_iso, parse_int(feedback_id, 0, 1)),
            )
            _record_feedback_event(
                conn,
                feedback_id,
                actor_username=username,
                actor_role='user',
                event_type='status_changed',
                old_status=old_status,
                new_status='closed',
                message='Feedback closed by the submitter.',
                visibility='public',
            )
            conn.commit()

        item = _load_feedback_item(conn, feedback_id)
        return jsonify({'item': _serialize_feedback_item(conn, item, include_private=False, include_events=True)}), 200
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({'error': f'Failed to close feedback: {e}'}), 500
    finally:
        conn.close()


def similar_feedback():
    username, error = _require_authenticated_username()
    if error:
        return error
    query = _clean_text(request.args.get('q'), 160)
    if len(query) < 4:
        return jsonify({'items': []}), 200
    like = f'%{query.lower()}%'
    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        rows = conn.execute(
            '''
            SELECT *
            FROM feedback_items
            WHERE status NOT IN ('resolved', 'closed')
              AND (LOWER(title) LIKE ? OR LOWER(description) LIKE ?)
            ORDER BY
              CASE WHEN LOWER(title) LIKE ? THEN 0 ELSE 1 END,
              updated_at DESC,
              id DESC
            LIMIT 5
            ''',
            (like, like, like),
        ).fetchall()
        return jsonify({
            'items': [
                _serialize_similar_feedback(row, username)
                for row in rows
            ]
        }), 200
    finally:
        conn.close()


def list_admin_feedback():
    admin_username, error = _require_feedback_admin()
    if error:
        return error

    query = _clean_text(request.args.get('q'), 160)
    status = _clean_text(request.args.get('status'), 40).lower()
    feedback_type = _normalize_feedback_type(request.args.get('type')) if request.args.get('type') else ''
    priority = _normalize_priority(request.args.get('priority')) if request.args.get('priority') else ''
    limit = parse_int(request.args.get('limit'), 50, 1, 100)
    offset = parse_int(request.args.get('offset'), 0, 0, 10000)

    conditions = []
    params = []
    if query:
        conditions.append('(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(username) LIKE ?)')
        like = f'%{query.lower()}%'
        params.extend([like, like, like])
    if status in FEEDBACK_STATUSES:
        conditions.append('status = ?')
        params.append(status)
    if feedback_type in FEEDBACK_TYPES:
        conditions.append('type = ?')
        params.append(feedback_type)
    if priority in FEEDBACK_PRIORITIES:
        conditions.append('priority = ?')
        params.append(priority)

    where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ''
    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        total_row = row_to_dict(
            conn.execute(
                f'SELECT COUNT(*) AS count FROM feedback_items {where_sql}',
                tuple(params),
            ).fetchone()
        ) or {}
        rows = conn.execute(
            f'''
            SELECT *
            FROM feedback_items
            {where_sql}
            ORDER BY updated_at DESC, id DESC
            LIMIT ? OFFSET ?
            ''',
            tuple(params + [limit, offset]),
        ).fetchall()
        return jsonify({
            'items': [_serialize_feedback_item(conn, row, include_private=True, include_events=False) for row in rows],
            'total': parse_int(total_row.get('count'), 0, 0),
            'limit': limit,
            'offset': offset,
            'is_admin': True,
            'admin_username': admin_username,
            'support_email': SUPPORT_EMAIL,
        }), 200
    finally:
        conn.close()


def get_admin_feedback(feedback_id):
    _, error = _require_feedback_admin()
    if error:
        return error
    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        item = _load_feedback_item(conn, feedback_id)
        if not item:
            return jsonify({'error': 'Feedback item not found'}), 404
        return jsonify({
            'item': _serialize_feedback_item(conn, item, include_private=True, include_events=True),
            'support_email': SUPPORT_EMAIL,
        }), 200
    finally:
        conn.close()


def update_admin_feedback(feedback_id):
    admin_username, error = _require_feedback_admin()
    if error:
        return error
    data = request.get_json(silent=True) or {}
    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500

    email_item = None
    status_changed = False
    try:
        item = _load_feedback_item(conn, feedback_id)
        if not item:
            return jsonify({'error': 'Feedback item not found'}), 404

        old_status = str(item.get('status') or 'new').strip()
        next_status = _normalize_status(data.get('status'), old_status) if 'status' in data else old_status
        if 'status' in data and next_status == 'closed':
            return jsonify({'error': 'Only the feedback submitter can close feedback.'}), 400
        assigned_to = _clean_text(data.get('assigned_to'), 120) if 'assigned_to' in data else str(item.get('assigned_to') or '')
        priority = _normalize_priority(data.get('priority')) if 'priority' in data else str(item.get('priority') or 'medium')
        now_iso = utcnow_iso()
        status_changed = next_status != old_status
        if next_status in {'resolved', 'closed'}:
            resolved_at = now_iso if status_changed else (item.get('resolved_at') or now_iso)
        else:
            resolved_at = None

        conn.execute(
            '''
            UPDATE feedback_items
            SET status = ?,
                priority = ?,
                assigned_to = ?,
                updated_at = ?,
                resolved_at = ?
            WHERE id = ?
            ''',
            (
                next_status,
                priority,
                assigned_to,
                now_iso,
                resolved_at,
                parse_int(feedback_id, 0, 1),
            ),
        )
        if status_changed:
            _record_feedback_event(
                conn,
                feedback_id,
                actor_username=admin_username,
                actor_role='admin',
                event_type='status_changed',
                old_status=old_status,
                new_status=next_status,
                message=f'Status changed from {old_status.replace("_", " ")} to {next_status.replace("_", " ")}.',
                visibility='public',
            )
        conn.commit()
        email_item = _load_feedback_item(conn, feedback_id)
        payload = _serialize_feedback_item(conn, email_item, include_private=True, include_events=True)
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({'error': f'Failed to update feedback: {e}'}), 500
    finally:
        conn.close()

    if status_changed and email_item:
        private_item = row_to_dict(email_item) or {}
        ok, email_error = _send_user_feedback_email(
            private_item,
            'Feedback status updated',
            f'Your feedback status is now {private_item.get("status", "new").replace("_", " ")}.',
        )
        _record_email_event(
            feedback_id,
            ok=ok,
            target_email=private_item.get('user_email_snapshot') or '',
            context='Status update notification',
            actor_username=admin_username,
        )
        if not ok:
            print(f'Feedback status email failed for #{feedback_id}: {email_error}')

    return jsonify({'item': payload}), 200


def add_public_reply(feedback_id):
    admin_username, error = _require_feedback_admin()
    if error:
        return error
    data = request.get_json(silent=True) or {}
    message = _clean_multiline(data.get('message'), 3000)
    if not message:
        return jsonify({'error': 'Reply message is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    email_item = None
    try:
        item = _load_feedback_item(conn, feedback_id)
        if not item:
            return jsonify({'error': 'Feedback item not found'}), 404
        conn.execute(
            'UPDATE feedback_items SET updated_at = ? WHERE id = ?',
            (utcnow_iso(), parse_int(feedback_id, 0, 1)),
        )
        _record_feedback_event(
            conn,
            feedback_id,
            actor_username=admin_username,
            actor_role='admin',
            event_type='public_reply',
            message=message,
            visibility='public',
        )
        conn.commit()
        email_item = _load_feedback_item(conn, feedback_id)
        payload = _serialize_feedback_item(conn, email_item, include_private=True, include_events=True)
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({'error': f'Failed to add public reply: {e}'}), 500
    finally:
        conn.close()

    private_item = row_to_dict(email_item) or {}
    ok, email_error = _send_user_feedback_email(
        private_item,
        'New reply to your feedback',
        message,
    )
    _record_email_event(
        feedback_id,
        ok=ok,
        target_email=private_item.get('user_email_snapshot') or '',
        context='Public reply notification',
        actor_username=admin_username,
    )
    if not ok:
        print(f'Feedback public reply email failed for #{feedback_id}: {email_error}')

    return jsonify({'item': payload}), 200


def add_internal_note(feedback_id):
    admin_username, error = _require_feedback_admin()
    if error:
        return error
    data = request.get_json(silent=True) or {}
    message = _clean_multiline(data.get('message'), 3000)
    if not message:
        return jsonify({'error': 'Internal note message is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        item = _load_feedback_item(conn, feedback_id)
        if not item:
            return jsonify({'error': 'Feedback item not found'}), 404
        conn.execute(
            'UPDATE feedback_items SET updated_at = ? WHERE id = ?',
            (utcnow_iso(), parse_int(feedback_id, 0, 1)),
        )
        _record_feedback_event(
            conn,
            feedback_id,
            actor_username=admin_username,
            actor_role='admin',
            event_type='internal_note',
            message=message,
            visibility='internal',
        )
        conn.commit()
        item = _load_feedback_item(conn, feedback_id)
        return jsonify({'item': _serialize_feedback_item(conn, item, include_private=True, include_events=True)}), 200
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({'error': f'Failed to add internal note: {e}'}), 500
    finally:
        conn.close()
