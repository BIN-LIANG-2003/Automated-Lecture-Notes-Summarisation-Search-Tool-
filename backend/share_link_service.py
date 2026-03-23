from flask import jsonify, request

from .config import DEFAULT_WORKSPACE_SETTINGS
from .db import get_db_connection
from .document_domain import plaintext_to_html
from .utils import parse_bool, parse_int, row_to_dict, utcnow_iso
from .share_domain import (
    check_document_access,
    count_active_document_share_links,
    create_document_share_token,
    get_document_link_sharing_mode,
    list_document_share_link_payloads,
    serialize_document_share_link_row,
    to_document_share_link_payload,
    user_can_manage_document_share_links,
    validate_document_share_token,
)
from .workspace_domain import expires_at_for_days, get_workspace_settings


def create_document_share_link(doc_id):
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
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

        doc_data = row_to_dict(doc) or {}
        workspace_id = str(doc_data.get('workspace_id') or '').strip()

        if workspace_id:
            workspace_settings = get_workspace_settings(conn, workspace_id)
        else:
            workspace_settings = dict(DEFAULT_WORKSPACE_SETTINGS)

        if not user_can_manage_document_share_links(conn, doc, username):
            return jsonify({'error': 'Only owner (or allowed members) can create share links'}), 403

        link_mode = workspace_settings.get('link_sharing_mode', DEFAULT_WORKSPACE_SETTINGS['link_sharing_mode'])
        if link_mode == 'restricted':
            return jsonify({'error': 'Link sharing is restricted in this workspace settings'}), 403

        requested_expiry = data.get('expiry_days', None)
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
            conn.commit()
            active_count = 0

        if active_count >= max_active_share_links:
            return jsonify({
                'error': (
                    f'Active share links reached limit ({max_active_share_links}). '
                    'Revoke existing links or enable auto-revoke in workspace settings.'
                ),
                'active_count': active_count,
                'max_active_share_links_per_document': max_active_share_links,
            }), 409

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
            return jsonify({'error': 'Failed to generate share token'}), 500

        conn.commit()
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
        return jsonify(payload), 201
    finally:
        conn.close()


def list_document_share_links(doc_id):
    username = (request.args.get('username') or '').strip()
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
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or request.args.get('username') or '').strip()
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
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or request.args.get('username') or '').strip()
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


def get_document_by_share_token(token):
    safe_token = str(token or '').strip()
    username = (request.args.get('username') or '').strip()
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
        doc_data['share'] = serialize_document_share_link_row(refreshed_share_row)
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
