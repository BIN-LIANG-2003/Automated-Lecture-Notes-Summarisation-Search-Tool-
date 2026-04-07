import html

import requests
from flask import jsonify, request

from .config import DEFAULT_WORKSPACE_SETTINGS, RESEND_API_KEY, RESEND_FROM_EMAIL
from .db import get_db_connection
from .document_domain import plaintext_to_html
from .security import get_authenticated_username
from .utils import normalize_email, parse_bool, parse_int, row_to_dict, utcnow_iso
from .share_domain import (
    build_document_share_url,
    check_document_access,
    count_active_document_share_links,
    create_document_share_token,
    expire_document_share_links,
    get_document_link_sharing_mode,
    list_document_share_link_payloads,
    serialize_document_share_link_row,
    to_document_share_link_payload,
    user_can_manage_document_share_links,
    validate_document_share_token,
)
from .workspace_domain import expires_at_for_days, get_workspace_settings, is_valid_email


def _load_share_creation_context(conn, doc_id, username):
    cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
    doc = cursor.fetchone()
    if not doc:
        return None, {'error': 'Document not found'}, 404

    doc_data = row_to_dict(doc) or {}
    workspace_id = str(doc_data.get('workspace_id') or '').strip()
    workspace_settings = (
        get_workspace_settings(conn, workspace_id)
        if workspace_id
        else dict(DEFAULT_WORKSPACE_SETTINGS)
    )

    if not user_can_manage_document_share_links(conn, doc, username):
        return None, {'error': 'Only owner (or allowed members) can create share links'}, 403

    link_mode = workspace_settings.get('link_sharing_mode', DEFAULT_WORKSPACE_SETTINGS['link_sharing_mode'])
    if link_mode == 'restricted':
        return None, {'error': 'Link sharing is restricted in this workspace settings'}, 403

    return {
        'doc': doc,
        'doc_data': doc_data,
        'workspace_id': workspace_id,
        'workspace_settings': workspace_settings,
        'link_mode': link_mode,
    }, None, 200


def _find_reusable_document_share_link_payload(conn, doc_id):
    expire_document_share_links(conn, doc_id)
    cursor = conn.execute(
        '''
        SELECT *
        FROM document_share_links
        WHERE document_id = ?
          AND status = 'active'
        ORDER BY created_at DESC, id DESC
        ''',
        (doc_id,),
    )
    for row in cursor.fetchall():
        payload = to_document_share_link_payload(row)
        if payload.get('is_accessible'):
            return payload
    return None


def _prepare_document_share_link_payload(
    conn,
    doc_id,
    username,
    requested_expiry=None,
    *,
    allow_reuse_when_limit=False,
):
    context, error_payload, error_status = _load_share_creation_context(conn, doc_id, username)
    if error_payload:
        return None, error_payload, error_status

    workspace_settings = context['workspace_settings']
    link_mode = context['link_mode']
    workspace_id = context['workspace_id']

    if requested_expiry is None or str(requested_expiry).strip() == '':
        expiry_days = workspace_settings.get('default_share_expiry_days', 7)
    else:
        expiry_days = requested_expiry
    expiry_days = parse_int(expiry_days, 7, 1, 30)
    expires_at = expires_at_for_days(expiry_days)

    max_active_share_links = parse_int(
        workspace_settings.get('max_active_share_links_per_document', 5),
        5,
        1,
        20,
    )
    auto_revoke_previous = parse_bool(
        workspace_settings.get('auto_revoke_previous_share_links', False),
        False,
    )

    active_count = count_active_document_share_links(conn, doc_id)
    revoked_before_create = 0
    if auto_revoke_previous and active_count > 0:
        revoked_before_create = active_count
        conn.execute(
            '''
            UPDATE document_share_links
            SET status = 'revoked'
            WHERE document_id = ? AND status = 'active'
            ''',
            (doc_id,),
        )
        active_count = 0

    if active_count >= max_active_share_links:
        if allow_reuse_when_limit:
            reused_payload = _find_reusable_document_share_link_payload(conn, doc_id)
            if reused_payload:
                reused_payload['expiry_days'] = expiry_days
                reused_payload['link_sharing_mode'] = link_mode
                reused_payload['max_active_share_links_per_document'] = max_active_share_links
                reused_payload['auto_revoke_previous_share_links'] = auto_revoke_previous
                reused_payload['revoked_before_create'] = 0
                reused_payload['reused_existing'] = True
                return {'payload': reused_payload, 'context': context}, None, 200
        return None, {
            'error': (
                f'Active share links reached limit ({max_active_share_links}). '
                'Revoke existing links or enable auto-revoke in workspace settings.'
            ),
            'active_count': active_count,
            'max_active_share_links_per_document': max_active_share_links,
        }, 409

    token = create_document_share_token()
    try:
        conn.execute(
            '''
            INSERT INTO document_share_links (
                document_id, workspace_id, token, created_by, status, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ''',
            (
                doc_id,
                workspace_id,
                token,
                username,
                'active',
                expires_at,
                utcnow_iso(),
            ),
        )
    except Exception:
        return None, {'error': 'Failed to generate share token'}, 500

    share_cursor = conn.execute(
        'SELECT * FROM document_share_links WHERE token = ? LIMIT 1',
        (token,),
    )
    share_row = row_to_dict(share_cursor.fetchone())
    payload = serialize_document_share_link_row(share_row)
    payload['expiry_days'] = expiry_days
    payload['link_sharing_mode'] = link_mode
    payload['max_active_share_links_per_document'] = max_active_share_links
    payload['auto_revoke_previous_share_links'] = auto_revoke_previous
    payload['revoked_before_create'] = revoked_before_create
    payload['reused_existing'] = False
    return {'payload': payload, 'context': context}, None, 201


def send_document_share_email(
    to_email,
    document_title,
    sender_username,
    share_url,
    expires_at,
    link_mode='workspace',
    personal_message='',
):
    recipient = normalize_email(to_email)
    safe_title = str(document_title or '').strip() or 'Untitled Note'
    safe_sender = str(sender_username or '').strip() or 'A StudyHub classmate'
    safe_share_url = str(share_url or '').strip()
    safe_expires_at = str(expires_at or '').strip() or 'Unknown'
    safe_message = str(personal_message or '').strip()
    safe_link_mode = str(link_mode or '').strip().lower() or 'workspace'
    if not recipient:
        return False, 'Missing recipient email'
    if not RESEND_API_KEY:
        return False, 'RESEND_API_KEY is not configured'
    if not safe_share_url:
        return False, 'Share URL is unavailable'

    access_note = (
        'Anyone with this link can open the shared note.'
        if safe_link_mode == 'public'
        else 'This shared note follows workspace member access rules and may require StudyHub sign-in.'
    )
    escaped_message = html.escape(safe_message).replace('\n', '<br />') if safe_message else ''
    message_block = (
        f'''
          <div style="margin: 12px 0 18px; padding: 12px 14px; border-radius: 10px; background: #f8fafc; border: 1px solid #e2e8f0;">
            <strong style="display:block; margin-bottom: 6px;">Personal message</strong>
            <div>{escaped_message}</div>
          </div>
        '''
        if escaped_message
        else ''
    )
    subject = f'StudyHub note from {safe_sender}: {safe_title}'
    body_html = f'''
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 560px; margin: 0 auto;">
          <h2 style="margin-bottom: 12px;">A StudyHub note was shared with you</h2>
          <p><strong>{html.escape(safe_sender)}</strong> sent you a note: <strong>{html.escape(safe_title)}</strong>.</p>
          {message_block}
          <p>{html.escape(access_note)}</p>
          <p style="margin: 18px 0;">
            <a href="{html.escape(safe_share_url)}" style="display: inline-block; padding: 10px 14px; border-radius: 8px; text-decoration: none; background: #2563eb; color: #ffffff;">
              Open Shared Note
            </a>
          </p>
          <p style="margin-bottom: 8px;"><strong>Expires:</strong> {html.escape(safe_expires_at)}</p>
          <p style="margin-bottom: 8px;"><strong>Direct link:</strong></p>
          <p style="margin-top: 0; word-break: break-word;">
            <a href="{html.escape(safe_share_url)}" style="color: #2563eb;">{html.escape(safe_share_url)}</a>
          </p>
          <p style="font-size: 12px; color: #6b7280;">If you did not expect this email, you can ignore it.</p>
        </div>
    '''
    body_text = (
        f'{safe_sender} sent you a StudyHub note: "{safe_title}".\n\n'
        f'{safe_message}\n\n' if safe_message else f'{safe_sender} sent you a StudyHub note: "{safe_title}".\n\n'
    ) + (
        f'{access_note}\n\n'
        f'Open shared note: {safe_share_url}\n'
        f'Expires: {safe_expires_at}\n'
    )
    try:
        response = requests.post(
            'https://api.resend.com/emails',
            headers={
                'Authorization': f'Bearer {RESEND_API_KEY}',
                'Content-Type': 'application/json',
            },
            json={
                'from': RESEND_FROM_EMAIL,
                'to': [recipient],
                'subject': subject,
                'html': body_html,
                'text': body_text,
            },
            timeout=15,
        )
        if response.status_code >= 400:
            return False, f'Resend failed ({response.status_code}): {response.text[:220]}'
        return True, ''
    except Exception as e:
        return False, f'Resend request error: {e}'


def create_document_share_link(doc_id):
    data = request.get_json(silent=True) or {}
    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'username is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500

    try:
        result, error_payload, status_code = _prepare_document_share_link_payload(
            conn,
            doc_id,
            username,
            data.get('expiry_days', None),
            allow_reuse_when_limit=False,
        )
        if error_payload:
            return jsonify(error_payload), status_code
        conn.commit()
        return jsonify(result['payload']), 201
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def send_document_share_link_email(doc_id):
    data = request.get_json(silent=True) or {}
    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'username is required'}), 400

    recipient_email = normalize_email(data.get('recipient_email') or data.get('email'))
    if not recipient_email or not is_valid_email(recipient_email):
        return jsonify({'error': 'Please enter a valid recipient email address'}), 400

    personal_message = str(data.get('message') or '').strip()
    if len(personal_message) > 500:
        return jsonify({'error': 'Message must be 500 characters or fewer'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500

    try:
        result, error_payload, status_code = _prepare_document_share_link_payload(
            conn,
            doc_id,
            username,
            data.get('expiry_days', None),
            allow_reuse_when_limit=True,
        )
        if error_payload:
            return jsonify(error_payload), status_code

        payload = result['payload']
        context = result['context']
        share_url = str(payload.get('share_url') or build_document_share_url(payload.get('token'))).strip()
        sent, send_error = send_document_share_email(
            recipient_email,
            context['doc_data'].get('title') or context['doc_data'].get('filename') or 'Untitled Note',
            username,
            share_url,
            payload.get('expires_at'),
            context.get('link_mode'),
            personal_message,
        )
        if not sent:
            conn.rollback()
            return jsonify({'error': send_error or 'Failed to send share email'}), 503

        conn.commit()
        return jsonify({
            'message': f'Shared note email sent to {recipient_email}.',
            'recipient_email': recipient_email,
            'share': payload,
            'reused_existing': bool(payload.get('reused_existing')),
        }), 200
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def list_document_share_links(doc_id):
    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'username is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        if not user_can_manage_document_share_links(conn, doc, username):
            return jsonify({'error': 'Only owner (or allowed members) can manage share links'}), 403

        doc_data = row_to_dict(doc) or {}
        workspace_id = str(doc_data.get('workspace_id') or '').strip()
        link_mode = get_document_link_sharing_mode(conn, doc)
        items = list_document_share_link_payloads(conn, doc_id, limit=30)
        return jsonify({
            'document_id': doc_id,
            'workspace_id': workspace_id,
            'link_sharing_mode': link_mode,
            'items': items,
        }), 200
    finally:
        conn.close()


def revoke_all_document_share_links(doc_id):
    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'username is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        if not user_can_manage_document_share_links(conn, doc, username):
            return jsonify({'error': 'Only owner (or allowed members) can manage share links'}), 403

        count_cursor = conn.execute(
            '''
            SELECT COUNT(1) AS total
            FROM document_share_links
            WHERE document_id = ? AND status != 'revoked'
            ''',
            (doc_id,),
        )
        count_row = row_to_dict(count_cursor.fetchone()) or {}
        revoke_count = parse_int(count_row.get('total', 0), 0, 0)

        conn.execute(
            '''
            UPDATE document_share_links
            SET status = 'revoked'
            WHERE document_id = ? AND status != 'revoked'
            ''',
            (doc_id,),
        )
        conn.commit()

        items = list_document_share_link_payloads(conn, doc_id, limit=30)
        return jsonify({
            'message': 'All share links revoked',
            'document_id': doc_id,
            'revoked_count': revoke_count,
            'items': items,
        }), 200
    finally:
        conn.close()


def revoke_document_share_link(doc_id, share_link_id):
    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'username is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        if not user_can_manage_document_share_links(conn, doc, username):
            return jsonify({'error': 'Only owner (or allowed members) can manage share links'}), 403

        link_cursor = conn.execute(
            'SELECT * FROM document_share_links WHERE id = ? AND document_id = ?',
            (share_link_id, doc_id),
        )
        link_row = row_to_dict(link_cursor.fetchone())
        if not link_row:
            return jsonify({'error': 'Share link not found'}), 404

        current_status = str(link_row.get('status') or '').strip().lower()
        if current_status == 'revoked':
            payload = to_document_share_link_payload(link_row)
            payload['message'] = 'Share link already revoked'
            return jsonify(payload), 200

        conn.execute(
            "UPDATE document_share_links SET status = 'revoked' WHERE id = ?",
            (share_link_id,),
        )
        conn.commit()
        refreshed_cursor = conn.execute(
            'SELECT * FROM document_share_links WHERE id = ? LIMIT 1',
            (share_link_id,),
        )
        refreshed = row_to_dict(refreshed_cursor.fetchone()) or link_row
        payload = to_document_share_link_payload(refreshed)
        payload['message'] = 'Share link revoked'
        return jsonify(payload), 200
    finally:
        conn.close()


def delete_document_share_link(doc_id, share_link_id):
    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'username is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        if not user_can_manage_document_share_links(conn, doc, username):
            return jsonify({'error': 'Only owner (or allowed members) can manage share links'}), 403

        link_cursor = conn.execute(
            'SELECT * FROM document_share_links WHERE id = ? AND document_id = ?',
            (share_link_id, doc_id),
        )
        link_row = row_to_dict(link_cursor.fetchone())
        if not link_row:
            return jsonify({'error': 'Share link not found'}), 404

        payload = to_document_share_link_payload(link_row)
        if payload.get('is_accessible'):
            return jsonify({'error': 'Active share links must be revoked before deletion'}), 409

        conn.execute(
            'DELETE FROM document_share_links WHERE id = ? AND document_id = ?',
            (share_link_id, doc_id),
        )
        conn.commit()
        payload['message'] = 'Share link deleted'
        payload['deleted'] = True
        return jsonify(payload), 200
    finally:
        conn.close()


def delete_inactive_document_share_links(doc_id):
    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'username is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        if not user_can_manage_document_share_links(conn, doc, username):
            return jsonify({'error': 'Only owner (or allowed members) can manage share links'}), 403

        link_cursor = conn.execute(
            '''
            SELECT *
            FROM document_share_links
            WHERE document_id = ?
            ORDER BY created_at DESC, id DESC
            ''',
            (doc_id,),
        )
        rows = [row_to_dict(item) for item in link_cursor.fetchall()]
        delete_ids = []
        for row in rows:
            payload = to_document_share_link_payload(row)
            if not payload.get('is_accessible'):
                link_id = parse_int(payload.get('id'), 0, 0)
                if link_id > 0:
                    delete_ids.append(link_id)

        if not delete_ids:
            return jsonify({
                'message': 'No inactive share links to delete',
                'document_id': doc_id,
                'deleted_count': 0,
                'items': list_document_share_link_payloads(conn, doc_id, limit=30),
            }), 200

        placeholders = ','.join('?' for _ in delete_ids)
        conn.execute(
            f'DELETE FROM document_share_links WHERE document_id = ? AND id IN ({placeholders})',
            (doc_id, *delete_ids),
        )
        conn.commit()
        return jsonify({
            'message': 'Inactive share links deleted',
            'document_id': doc_id,
            'deleted_count': len(delete_ids),
            'items': list_document_share_link_payloads(conn, doc_id, limit=30),
        }), 200
    finally:
        conn.close()


def get_document_by_share_token(token):
    safe_token = str(token or '').strip()
    username = get_authenticated_username()
    if not safe_token:
        return jsonify({'error': 'Missing share token'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500

    try:
        share_cursor = conn.execute(
            '''
            SELECT *
            FROM document_share_links
            WHERE token = ?
            ORDER BY id DESC
            LIMIT 1
            ''',
            (safe_token,),
        )
        share_row = row_to_dict(share_cursor.fetchone())
        if not share_row:
            return jsonify({'error': 'Share link not found'}), 404

        doc_id = parse_int(share_row.get('document_id'), 0, 0)
        if doc_id <= 0:
            return jsonify({'error': 'Share link is invalid'}), 404

        token_ok, validated_share_row, token_reason = validate_document_share_token(
            conn,
            doc_id,
            safe_token,
            mark_access=False,
        )
        if not token_ok:
            return jsonify({'error': token_reason or 'Share link is invalid'}), 403
        if validated_share_row:
            share_row = validated_share_row

        doc_cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = doc_cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        allowed, reason = check_document_access(conn, doc, username, safe_token)
        if not allowed:
            return jsonify({'error': reason}), 403

        refreshed_share_cursor = conn.execute(
            'SELECT * FROM document_share_links WHERE token = ? ORDER BY id DESC LIMIT 1',
            (safe_token,),
        )
        refreshed_share_row = row_to_dict(refreshed_share_cursor.fetchone()) or share_row

        conn.execute(
            'UPDATE documents SET last_access_at = ? WHERE id = ?',
            (utcnow_iso(), doc_id),
        )
        conn.commit()

        doc_data = dict(doc)
        workspace_id = str(doc_data.get('workspace_id') or '').strip()
        workspace_settings = get_workspace_settings(conn, workspace_id)
        doc_data['link_sharing_mode'] = get_document_link_sharing_mode(conn, doc)
        doc_data['can_manage_share_links'] = user_can_manage_document_share_links(conn, doc, username)
        doc_data['share'] = to_document_share_link_payload(refreshed_share_row)
        doc_data['allow_ai_tools'] = parse_bool(workspace_settings.get('allow_ai_tools', True), True)
        doc_data['allow_ocr'] = parse_bool(workspace_settings.get('allow_ocr', True), True)
        doc_data['allow_export'] = parse_bool(workspace_settings.get('allow_export', True), True)
        doc_data['summary_length'] = str(
            workspace_settings.get('summary_length', DEFAULT_WORKSPACE_SETTINGS.get('summary_length', 'medium'))
            or 'medium'
        ).strip().lower()
        doc_data['keyword_limit'] = parse_int(
            workspace_settings.get('keyword_limit', DEFAULT_WORKSPACE_SETTINGS.get('keyword_limit', 5)),
            5,
            3,
            12,
        )
        doc_data['default_share_expiry_days'] = parse_int(
            workspace_settings.get(
                'default_share_expiry_days',
                DEFAULT_WORKSPACE_SETTINGS.get('default_share_expiry_days', 7),
            ),
            7,
            1,
            30,
        )
        ext = str(doc_data.get('file_type') or '').lower().strip('.')
        if ext in ('docx', 'txt') and not (doc_data.get('content_html') or '').strip():
            doc_data['content_html'] = plaintext_to_html(doc_data.get('content') or '')
        return jsonify(doc_data), 200
    finally:
        conn.close()
