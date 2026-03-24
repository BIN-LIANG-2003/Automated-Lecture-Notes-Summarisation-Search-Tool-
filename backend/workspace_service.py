import re
import uuid

from flask import jsonify, request

from .config import DEFAULT_WORKSPACE_SETTINGS, INVITE_EXPIRY_DAYS
from .db import get_db_connection
from .storage import remove_document_file_from_storage
from .utils import invitation_is_expired, normalize_email, parse_int, row_to_dict, utcnow_iso
from .workspace_domain import (
    create_invite_token,
    ensure_owner_membership,
    expire_workspace_invitations,
    expires_at_for_days,
    get_workspace_details,
    get_workspace_record,
    is_valid_email,
    normalize_workspace_name,
    normalize_workspace_settings,
    send_workspace_invite_email,
    serialize_invitation_row,
    workspace_belongs_to_user,
    workspace_settings_to_json,
)


def _user_can_manage_workspace_invites(conn, workspace_row, username, workspace_settings=None):
    actor = (username or '').strip()
    workspace = workspace_row or {}
    if not actor or not workspace:
        return False
    if workspace.get('owner_username') == actor:
        return True
    settings = workspace_settings or normalize_workspace_settings(workspace.get('settings_json'))
    if not settings.get('allow_member_invites'):
        return False
    return workspace_belongs_to_user(conn, workspace.get('id', ''), actor)


def _deliver_workspace_invitation_email(workspace_row, invitation_row, inviter_username):
    invite_payload = serialize_invitation_row(invitation_row)
    ok, send_error = send_workspace_invite_email(
        invite_payload.get('email', ''),
        workspace_row.get('name', ''),
        inviter_username,
        invite_payload.get('invite_url', ''),
        invite_payload.get('expires_at', ''),
    )
    invite_payload['email_sent'] = bool(ok)
    if not ok:
        invite_payload['email_error'] = send_error
    return invite_payload, ok, send_error


def get_workspaces():
    username = (request.args.get('username') or '').strip()
    if not username:
        return jsonify({'error': 'username is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500

    try:
        expire_workspace_invitations(conn)

        owned_cursor = conn.execute(
            'SELECT * FROM workspaces WHERE owner_username = ? ORDER BY created_at DESC',
            (username,),
        )
        owned_rows = [row_to_dict(item) for item in owned_cursor.fetchall()]

        member_cursor = conn.execute(
            '''
            SELECT workspace_id
            FROM workspace_members
            WHERE username = ? AND status = 'active'
            ''',
            (username,),
        )
        member_workspace_ids = [
            row_to_dict(item).get('workspace_id')
            for item in member_cursor.fetchall()
            if row_to_dict(item).get('workspace_id')
        ]
        owned_ids = {item.get('id') for item in owned_rows}
        extra_ids = [workspace_id for workspace_id in member_workspace_ids if workspace_id not in owned_ids]

        extra_rows = []
        if extra_ids:
            placeholders = ','.join(['?'] * len(extra_ids))
            query = f'SELECT * FROM workspaces WHERE id IN ({placeholders}) ORDER BY created_at DESC'
            extra_cursor = conn.execute(query, tuple(extra_ids))
            extra_rows = [row_to_dict(item) for item in extra_cursor.fetchall()]

        workspace_rows = [*owned_rows, *extra_rows]
        if not workspace_rows:
            now_iso = utcnow_iso()
            workspace_id = f'ws-{uuid.uuid4().hex[:12]}'
            conn.execute(
                '''
                INSERT INTO workspaces (id, name, plan, owner_username, settings_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    workspace_id,
                    f"{username}'s Workspace",
                    'Free',
                    username,
                    workspace_settings_to_json(DEFAULT_WORKSPACE_SETTINGS),
                    now_iso,
                    now_iso,
                ),
            )
            ensure_owner_membership(conn, workspace_id, username)
            conn.commit()
            workspace_rows = [{
                'id': workspace_id,
                'name': f"{username}'s Workspace",
                'plan': 'Free',
                'owner_username': username,
                'settings_json': workspace_settings_to_json(DEFAULT_WORKSPACE_SETTINGS),
                'created_at': now_iso,
                'updated_at': now_iso,
            }]
        else:
            conn.commit()

        payload = [get_workspace_details(conn, item, username) for item in workspace_rows]
        return jsonify(payload), 200
    finally:
        conn.close()


def create_workspace():
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    name = (data.get('name') or '').strip() or f"{username}'s Workspace"
    plan = (data.get('plan') or '').strip() or 'Free'
    settings_json = workspace_settings_to_json(data.get('settings') or DEFAULT_WORKSPACE_SETTINGS)
    if not username:
        return jsonify({'error': 'username is required'}), 400

    workspace_id = f'ws-{uuid.uuid4().hex[:12]}'
    now_iso = utcnow_iso()

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        conn.execute(
            '''
            INSERT INTO workspaces (id, name, plan, owner_username, settings_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ''',
            (
                workspace_id,
                name,
                plan,
                username,
                settings_json,
                now_iso,
                now_iso,
            ),
        )
        ensure_owner_membership(conn, workspace_id, username)
        conn.commit()
        workspace_row = get_workspace_record(conn, workspace_id)
        return jsonify(get_workspace_details(conn, workspace_row, username)), 201
    finally:
        conn.close()


def update_workspace(workspace_id):
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    name = (data.get('name') or '').strip()
    incoming_settings = data.get('settings')
    if not username:
        return jsonify({'error': 'username is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        workspace_row = get_workspace_record(conn, workspace_id)
        if not workspace_row:
            return jsonify({'error': 'Workspace not found'}), 404
        if workspace_row.get('owner_username') != username:
            return jsonify({'error': 'Only workspace owner can update settings'}), 403
        if not name and incoming_settings is None:
            return jsonify({'error': 'name or settings is required'}), 400

        next_name = name or normalize_workspace_name(workspace_row.get('name', ''), username)

        existing_settings = normalize_workspace_settings(workspace_row.get('settings_json'))
        if isinstance(incoming_settings, dict):
            merged_settings = {**existing_settings, **incoming_settings}
        else:
            merged_settings = existing_settings
        settings_json = workspace_settings_to_json(merged_settings)

        conn.execute(
            'UPDATE workspaces SET name = ?, settings_json = ?, updated_at = ? WHERE id = ?',
            (next_name, settings_json, utcnow_iso(), workspace_id),
        )
        conn.commit()
        updated = get_workspace_record(conn, workspace_id)
        return jsonify(get_workspace_details(conn, updated, username)), 200
    finally:
        conn.close()


def delete_workspace(workspace_id):
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or request.args.get('username') or '').strip()
    if not username:
        return jsonify({'error': 'username is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500

    doc_rows = []
    try:
        workspace_row = get_workspace_record(conn, workspace_id)
        if not workspace_row:
            return jsonify({'error': 'Workspace not found'}), 404
        if workspace_row.get('owner_username') != username:
            return jsonify({'error': 'Only workspace owner can delete this workspace'}), 403

        docs_cursor = conn.execute(
            'SELECT id, filename FROM documents WHERE workspace_id = ?',
            (workspace_id,),
        )
        doc_rows = [row_to_dict(item) for item in docs_cursor.fetchall()]
        doc_ids = [
            parse_int(item.get('id'), 0, 0)
            for item in doc_rows
            if parse_int(item.get('id'), 0, 0) > 0
        ]

        if doc_ids:
            placeholders = ','.join(['?'] * len(doc_ids))
            conn.execute(
                f'DELETE FROM document_share_links WHERE document_id IN ({placeholders})',
                tuple(doc_ids),
            )
            conn.execute(
                f'DELETE FROM document_summary_cache WHERE document_id IN ({placeholders})',
                tuple(doc_ids),
            )

        conn.execute('DELETE FROM documents WHERE workspace_id = ?', (workspace_id,))
        conn.execute('DELETE FROM workspace_members WHERE workspace_id = ?', (workspace_id,))
        conn.execute('DELETE FROM workspace_invitations WHERE workspace_id = ?', (workspace_id,))
        conn.execute('DELETE FROM workspaces WHERE id = ?', (workspace_id,))
        conn.commit()
    finally:
        conn.close()

    warnings = []
    for doc in doc_rows:
        warning = remove_document_file_from_storage(str(doc.get('filename') or '').strip())
        if warning:
            warnings.append(f"{str(doc.get('filename') or '').strip()}: {warning}")

    return jsonify({
        'workspace_id': workspace_id,
        'deleted_document_count': len(doc_rows),
        'warnings': warnings,
    }), 200


def list_workspace_invitations(workspace_id):
    username = (request.args.get('username') or '').strip()
    if not username:
        return jsonify({'error': 'username is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        workspace_row = get_workspace_record(conn, workspace_id)
        if not workspace_row:
            return jsonify({'error': 'Workspace not found'}), 404
        if workspace_row.get('owner_username') != username:
            return jsonify({'error': 'Only workspace owner can view invitations'}), 403

        expire_workspace_invitations(conn, workspace_id)
        conn.commit()
        cursor = conn.execute(
            '''
            SELECT *
            FROM workspace_invitations
            WHERE workspace_id = ?
            ORDER BY created_at DESC
            LIMIT 200
            ''',
            (workspace_id,),
        )
        invitations = [serialize_invitation_row(item) for item in cursor.fetchall()]
        return jsonify(invitations), 200
    finally:
        conn.close()


def create_workspace_invitations(workspace_id):
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    raw_emails = data.get('emails', [])
    expiry_days = data.get('expiry_days', INVITE_EXPIRY_DAYS)

    if not username:
        return jsonify({'error': 'username is required'}), 400

    if isinstance(raw_emails, str):
        candidates = [item.strip() for item in re.split(r'[\n,;]+', raw_emails) if item.strip()]
    elif isinstance(raw_emails, list):
        candidates = [str(item).strip() for item in raw_emails if str(item).strip()]
    else:
        return jsonify({'error': 'emails must be an array or a comma-separated string'}), 400

    normalized_emails = []
    invalid_emails = []
    for item in candidates:
        email = normalize_email(item)
        if is_valid_email(email):
            normalized_emails.append(email)
        else:
            invalid_emails.append(item)
    normalized_emails = list(dict.fromkeys(normalized_emails))

    if not normalized_emails:
        return jsonify({'error': 'No valid email addresses provided', 'invalid_emails': invalid_emails}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        workspace_row = get_workspace_record(conn, workspace_id)
        if not workspace_row:
            return jsonify({'error': 'Workspace not found'}), 404
        workspace_settings = normalize_workspace_settings(workspace_row.get('settings_json'))
        if not _user_can_manage_workspace_invites(conn, workspace_row, username, workspace_settings):
            return jsonify({'error': 'Only workspace owner can invite members'}), 403

        trusted_domains = [
            item for item in re.split(r'[\s,;]+', workspace_settings.get('allowed_email_domains', '')) if item
        ]
        if workspace_settings.get('restrict_invites_to_domains') and trusted_domains:
            invalid_domain_emails = [
                email for email in normalized_emails if email.split('@', 1)[-1] not in trusted_domains
            ]
            if invalid_domain_emails:
                return jsonify({
                    'error': 'Invitation emails must match the trusted workspace domains',
                    'invalid_emails': invalid_domain_emails,
                    'allowed_domains': trusted_domains,
                }), 400

        requested_expiry = data.get('expiry_days', None)
        if requested_expiry is None or str(requested_expiry).strip() == '':
            expiry_days = workspace_settings.get('default_invite_expiry_days', INVITE_EXPIRY_DAYS)
        else:
            expiry_days = requested_expiry

        expire_workspace_invitations(conn, workspace_id)
        now_iso = utcnow_iso()
        expires_at = expires_at_for_days(expiry_days)
        created_items = []
        send_errors = []

        for email in normalized_emails:
            conn.execute(
                '''
                UPDATE workspace_invitations
                SET status = 'cancelled', reviewed_by = ?, reviewed_at = ?, review_note = ?
                WHERE workspace_id = ?
                  AND email = ?
                  AND status IN ('pending', 'requested')
                ''',
                (username, now_iso, 'Replaced by newer invitation', workspace_id, email),
            )

            token = create_invite_token()
            conn.execute(
                '''
                INSERT INTO workspace_invitations (
                    workspace_id, email, token, status, expires_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ''',
                (workspace_id, email, token, 'pending', expires_at, now_iso),
            )

            invite_row_cursor = conn.execute(
                '''
                SELECT *
                FROM workspace_invitations
                WHERE token = ?
                ''',
                (token,),
            )
            invite_row = row_to_dict(invite_row_cursor.fetchone())
            invite_payload, ok, send_error = _deliver_workspace_invitation_email(
                workspace_row,
                invite_row,
                username,
            )
            if not ok:
                send_errors.append({'email': email, 'error': send_error})

            created_items.append(invite_payload)

        conn.commit()
        email_sent_count = len([item for item in created_items if item.get('email_sent')])
        return jsonify({
            'workspace_id': workspace_id,
            'created': created_items,
            'email_sent_count': email_sent_count,
            'email_failed_count': len(send_errors),
            'invalid_emails': invalid_emails,
            'send_errors': send_errors,
            'manual_share_recommended': bool(send_errors),
            'requires_owner_confirmation': True,
        }), 201
    finally:
        conn.close()


def cancel_workspace_invitation(workspace_id, invitation_id):
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or request.args.get('username') or '').strip()
    if not username:
        return jsonify({'error': 'username is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        workspace_row = get_workspace_record(conn, workspace_id)
        if not workspace_row:
            return jsonify({'error': 'Workspace not found'}), 404
        if workspace_row.get('owner_username') != username:
            return jsonify({'error': 'Only workspace owner can cancel invitations'}), 403

        cursor = conn.execute(
            '''
            SELECT *
            FROM workspace_invitations
            WHERE id = ? AND workspace_id = ?
            ''',
            (invitation_id, workspace_id),
        )
        invitation = row_to_dict(cursor.fetchone())
        if not invitation:
            return jsonify({'error': 'Invitation not found'}), 404

        if invitation.get('status') in ('approved', 'rejected', 'expired', 'cancelled'):
            return jsonify({'error': f'Invitation is already {invitation.get("status")}'}), 400

        conn.execute(
            '''
            UPDATE workspace_invitations
            SET status = 'cancelled', reviewed_by = ?, reviewed_at = ?, review_note = ?
            WHERE id = ?
            ''',
            (username, utcnow_iso(), 'Cancelled by owner', invitation_id),
        )
        conn.commit()

        refreshed_cursor = conn.execute(
            'SELECT * FROM workspace_invitations WHERE id = ?',
            (invitation_id,),
        )
        refreshed = serialize_invitation_row(refreshed_cursor.fetchone())
        return jsonify(refreshed), 200
    finally:
        conn.close()


def resend_workspace_invitation(workspace_id, invitation_id):
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    if not username:
        return jsonify({'error': 'username is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        workspace_row = get_workspace_record(conn, workspace_id)
        if not workspace_row:
            return jsonify({'error': 'Workspace not found'}), 404

        workspace_settings = normalize_workspace_settings(workspace_row.get('settings_json'))
        if not _user_can_manage_workspace_invites(conn, workspace_row, username, workspace_settings):
            return jsonify({'error': 'Only workspace owner can invite members'}), 403

        cursor = conn.execute(
            '''
            SELECT *
            FROM workspace_invitations
            WHERE id = ? AND workspace_id = ?
            ''',
            (invitation_id, workspace_id),
        )
        invitation = row_to_dict(cursor.fetchone())
        if not invitation:
            return jsonify({'error': 'Invitation not found'}), 404

        current_status = str(invitation.get('status') or '').strip().lower()
        if current_status == 'approved':
            return jsonify({'error': 'Approved invitations do not need to be resent'}), 400
        if current_status == 'requested':
            return jsonify({'error': 'This invitation is already awaiting owner approval'}), 400

        next_expires_at = expires_at_for_days(
            workspace_settings.get('default_invite_expiry_days', INVITE_EXPIRY_DAYS)
        )
        conn.execute(
            '''
            UPDATE workspace_invitations
            SET status = 'pending',
                expires_at = ?,
                requested_username = NULL,
                requested_at = NULL,
                reviewed_by = NULL,
                reviewed_at = NULL,
                review_note = ''
            WHERE id = ?
            ''',
            (next_expires_at, invitation_id),
        )
        conn.commit()

        refreshed_cursor = conn.execute(
            '''
            SELECT *
            FROM workspace_invitations
            WHERE id = ?
            ''',
            (invitation_id,),
        )
        refreshed = row_to_dict(refreshed_cursor.fetchone())
        invite_payload, ok, send_error = _deliver_workspace_invitation_email(
            workspace_row,
            refreshed,
            username,
        )
        payload = {
            **invite_payload,
            'manual_share_recommended': not ok,
        }
        if not ok:
            payload['send_errors'] = [{'email': invite_payload.get('email', ''), 'error': send_error}]
        return jsonify(payload), 200
    finally:
        conn.close()


def review_workspace_invitation(workspace_id, invitation_id):
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    action = (data.get('action') or '').strip().lower()
    note = (data.get('note') or '').strip()
    if not username:
        return jsonify({'error': 'username is required'}), 400
    if action not in ('approve', 'reject'):
        return jsonify({'error': 'action must be approve or reject'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        workspace_row = get_workspace_record(conn, workspace_id)
        if not workspace_row:
            return jsonify({'error': 'Workspace not found'}), 404
        if workspace_row.get('owner_username') != username:
            return jsonify({'error': 'Only workspace owner can review requests'}), 403

        expire_workspace_invitations(conn, workspace_id)
        cursor = conn.execute(
            '''
            SELECT *
            FROM workspace_invitations
            WHERE id = ? AND workspace_id = ?
            ''',
            (invitation_id, workspace_id),
        )
        invitation = row_to_dict(cursor.fetchone())
        if not invitation:
            return jsonify({'error': 'Invitation not found'}), 404
        if invitation.get('status') != 'requested':
            return jsonify({'error': f'Invitation status must be requested, current: {invitation.get("status")}'}), 400

        requested_username = (invitation.get('requested_username') or '').strip()
        if action == 'approve':
            if not requested_username:
                return jsonify({'error': 'No applicant found for this invitation'}), 400
            user_cursor = conn.execute('SELECT username FROM users WHERE username = ?', (requested_username,))
            applicant = user_cursor.fetchone()
            if not applicant:
                return jsonify({'error': 'Applicant account not found'}), 404

            ensure_owner_membership(conn, workspace_id, workspace_row.get('owner_username', ''))
            member_cursor = conn.execute(
                '''
                SELECT id
                FROM workspace_members
                WHERE workspace_id = ? AND username = ?
                ''',
                (workspace_id, requested_username),
            )
            existing_member = member_cursor.fetchone()
            if existing_member:
                conn.execute(
                    '''
                    UPDATE workspace_members
                    SET status = 'active', role = 'member'
                    WHERE workspace_id = ? AND username = ?
                    ''',
                    (workspace_id, requested_username),
                )
            else:
                conn.execute(
                    '''
                    INSERT INTO workspace_members (workspace_id, username, role, status, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    ''',
                    (workspace_id, requested_username, 'member', 'active', utcnow_iso()),
                )

            next_status = 'approved'
        else:
            next_status = 'rejected'

        conn.execute(
            '''
            UPDATE workspace_invitations
            SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?
            WHERE id = ?
            ''',
            (next_status, username, utcnow_iso(), note, invitation_id),
        )
        conn.commit()

        updated_cursor = conn.execute('SELECT * FROM workspace_invitations WHERE id = ?', (invitation_id,))
        updated_invitation = serialize_invitation_row(updated_cursor.fetchone())
        return jsonify(updated_invitation), 200
    finally:
        conn.close()


def get_invitation_by_token(token):
    safe_token = (token or '').strip()
    username = (request.args.get('username') or '').strip()
    if not safe_token:
        return jsonify({'error': 'token is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        cursor = conn.execute(
            '''
            SELECT inv.*, ws.name AS workspace_name, ws.owner_username
            FROM workspace_invitations inv
            JOIN workspaces ws ON ws.id = inv.workspace_id
            WHERE inv.token = ?
            ''',
            (safe_token,),
        )
        invitation = row_to_dict(cursor.fetchone())
        if not invitation:
            return jsonify({'error': 'Invitation not found'}), 404

        if invitation.get('status') in ('pending', 'requested') and invitation_is_expired(invitation.get('expires_at')):
            conn.execute(
                'UPDATE workspace_invitations SET status = ? WHERE token = ?',
                ('expired', safe_token),
            )
            conn.commit()
            invitation['status'] = 'expired'

        can_request = False
        mismatch_reason = ''
        user_email = ''
        if username:
            user_cursor = conn.execute('SELECT email FROM users WHERE username = ?', (username,))
            user_row = row_to_dict(user_cursor.fetchone()) or {}
            user_email = normalize_email(user_row.get('email', ''))
            invite_email = normalize_email(invitation.get('email', ''))
            if not user_email:
                mismatch_reason = 'The current account has no bound email, so invitation ownership cannot be verified'
            elif user_email != invite_email:
                mismatch_reason = 'The current account email does not match the invited email'
            elif invitation.get('status') == 'pending':
                can_request = True
            elif invitation.get('status') == 'requested':
                can_request = invitation.get('requested_username') == username

        payload = serialize_invitation_row(invitation)
        payload.update({
            'workspace_name': normalize_workspace_name(
                invitation.get('workspace_name', ''),
                invitation.get('owner_username', ''),
            ),
            'owner_username': invitation.get('owner_username', ''),
            'requires_owner_confirmation': True,
            'can_request': can_request,
            'mismatch_reason': mismatch_reason,
            'viewer_username': username,
            'viewer_email': user_email,
        })
        return jsonify(payload), 200
    finally:
        conn.close()


def request_join_by_invitation(token):
    safe_token = (token or '').strip()
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    if not safe_token:
        return jsonify({'error': 'token is required'}), 400
    if not username:
        return jsonify({'error': 'username is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        cursor = conn.execute(
            '''
            SELECT inv.*, ws.name AS workspace_name, ws.owner_username
            FROM workspace_invitations inv
            JOIN workspaces ws ON ws.id = inv.workspace_id
            WHERE inv.token = ?
            ''',
            (safe_token,),
        )
        invitation = row_to_dict(cursor.fetchone())
        if not invitation:
            return jsonify({'error': 'Invitation not found'}), 404

        if invitation.get('status') in ('approved', 'rejected', 'expired', 'cancelled'):
            return jsonify({'error': f'Invitation is {invitation.get("status")}'}), 400
        if invitation_is_expired(invitation.get('expires_at')):
            conn.execute(
                'UPDATE workspace_invitations SET status = ? WHERE token = ?',
                ('expired', safe_token),
            )
            conn.commit()
            return jsonify({'error': 'Invitation has expired'}), 400

        user_cursor = conn.execute('SELECT email FROM users WHERE username = ?', (username,))
        user_row = row_to_dict(user_cursor.fetchone()) or {}
        user_email = normalize_email(user_row.get('email', ''))
        invite_email = normalize_email(invitation.get('email', ''))
        if not user_email:
            return jsonify({'error': 'Your account has no email address; cannot match invitation'}), 400
        if user_email != invite_email:
            return jsonify({'error': 'Your account email does not match this invitation'}), 403

        if invitation.get('status') == 'requested':
            if invitation.get('requested_username') == username:
                return jsonify({'message': 'Join request already submitted and pending owner approval'}), 200
            return jsonify({'error': 'This invitation is already requested by another account'}), 409

        conn.execute(
            '''
            UPDATE workspace_invitations
            SET status = 'requested', requested_username = ?, requested_at = ?, reviewed_by = NULL, reviewed_at = NULL, review_note = ''
            WHERE token = ?
            ''',
            (username, utcnow_iso(), safe_token),
        )
        conn.commit()

        refreshed_cursor = conn.execute(
            '''
            SELECT inv.*, ws.name AS workspace_name, ws.owner_username
            FROM workspace_invitations inv
            JOIN workspaces ws ON ws.id = inv.workspace_id
            WHERE inv.token = ?
            ''',
            (safe_token,),
        )
        refreshed = row_to_dict(refreshed_cursor.fetchone())
        payload = serialize_invitation_row(refreshed)
        payload.update({
            'workspace_name': refreshed.get('workspace_name', ''),
            'owner_username': refreshed.get('owner_username', ''),
            'requires_owner_confirmation': True,
        })
        return jsonify(payload), 200
    finally:
        conn.close()
