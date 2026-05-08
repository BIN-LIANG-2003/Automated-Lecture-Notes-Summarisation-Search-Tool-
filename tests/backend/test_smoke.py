import io
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

from docx import Document as DocxDocument
from reportlab.pdfgen import canvas
from werkzeug.security import generate_password_hash

os.environ.setdefault('APP_ENV', 'development')

from backend import create_app
from backend.config import AUTH_COOKIE_NAME, DEFAULT_WORKSPACE_SETTINGS
from backend.db import get_db_connection
from backend import document_service
from backend.document_domain import extract_text_from_pdf_bytes, sanitize_editor_html
from backend.document_processing import process_queued_documents_once
from backend import security
from backend.security import create_auth_token
from backend.shared import (
    assess_ocr_text_quality,
    build_document_summary_cache_key,
    build_hf_summarizer_input,
    build_summary_cache_text_hash,
)
from backend.summary_service import (
    build_summary_bundle,
    finish_summary_generation,
    get_summary_length_targets,
    split_summary_chunks,
    try_begin_summary_generation,
)
from backend.utils import parse_int, row_to_dict, utcnow_iso
from backend.workspace_domain import ensure_owner_membership, normalize_workspace_settings, workspace_settings_to_json


class StudyHubBackendSmokeTests(unittest.TestCase):
    def setUp(self):
        self.original_cwd = os.getcwd()
        self.tempdir = tempfile.TemporaryDirectory(prefix='studyhub-backend-smoke-')
        os.chdir(self.tempdir.name)
        self.external_summary_url_patcher = patch('backend.summary_service.EXTERNAL_SUMMARY_SERVICE_URL', '')
        self.external_summary_auth_patcher = patch('backend.summary_service.EXTERNAL_SUMMARY_AUTH_TOKEN', '')
        self.external_summary_url_patcher.start()
        self.external_summary_auth_patcher.start()
        self.app = create_app()
        self.client = self.app.test_client()
        self.username = 'alice'
        self.email = 'alice@example.com'
        self.password = 'password123'
        self.workspace_id = 'ws-smoke'
        self._seed_user()
        self._seed_workspace()

    def tearDown(self):
        self.external_summary_auth_patcher.stop()
        self.external_summary_url_patcher.stop()
        os.chdir(self.original_cwd)
        self.tempdir.cleanup()

    def _connection(self):
        conn = get_db_connection()
        self.assertIsNotNone(conn)
        return conn

    def _auth_headers(self, username=None):
        safe_username = str(username or self.username).strip()
        return {'Authorization': f'Bearer {create_auth_token(safe_username)}'}

    def _insert_user(self, username, email):
        conn = self._connection()
        try:
            conn.execute(
                '''
                INSERT INTO users (
                    username,
                    email,
                    password_hash,
                    email_verified,
                    email_verification_token,
                    email_verification_expires_at,
                    verified_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    username,
                    email,
                    generate_password_hash(self.password, method='pbkdf2:sha256'),
                    1,
                    None,
                    None,
                    utcnow_iso(),
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def _seed_user(self):
        self._insert_user(self.username, self.email)

    def _seed_workspace(self):
        conn = self._connection()
        now_iso = utcnow_iso()
        try:
            conn.execute(
                '''
                INSERT INTO workspaces (id, name, plan, owner_username, settings_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    self.workspace_id,
                    'Smoke Workspace',
                    'Free',
                    self.username,
                    workspace_settings_to_json(DEFAULT_WORKSPACE_SETTINGS),
                    now_iso,
                    now_iso,
                ),
            )
            ensure_owner_membership(conn, self.workspace_id, self.username)
            conn.commit()
        finally:
            conn.close()

    def test_user_can_update_email_notification_preference(self):
        response = self.client.patch(
            '/api/auth/preferences',
            headers=self._auth_headers(),
            json={'email_notifications_enabled': False},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertFalse(payload['preferences']['email_notifications_enabled'])

        me_response = self.client.get('/api/auth/me', headers=self._auth_headers())
        self.assertEqual(me_response.status_code, 200)
        me_payload = me_response.get_json()
        self.assertFalse(me_payload['preferences']['email_notifications_enabled'])

    def test_login_sets_http_only_cookie_and_cookie_can_restore_session(self):
        login_response = self.client.post(
            '/api/auth/login',
            json={
                'username': self.email,
                'password': self.password,
                'remember': True,
            },
        )
        self.assertEqual(login_response.status_code, 200)
        self.assertTrue(str(login_response.get_json().get('auth_token') or '').strip())
        cookie_header = login_response.headers.get('Set-Cookie', '')
        self.assertIn(f'{AUTH_COOKIE_NAME}=', cookie_header)
        self.assertIn('HttpOnly', cookie_header)
        self.assertIn('SameSite=Lax', cookie_header)

        me_response = self.client.get('/api/auth/me')
        self.assertEqual(me_response.status_code, 200)
        me_payload = me_response.get_json()
        self.assertEqual(me_payload.get('username'), self.username)
        self.assertTrue(str(me_payload.get('auth_token') or '').strip())

        logout_response = self.client.post('/api/auth/logout')
        self.assertEqual(logout_response.status_code, 200)
        self.assertIn(f'{AUTH_COOKIE_NAME}=', logout_response.headers.get('Set-Cookie', ''))

        after_logout_response = self.client.get('/api/auth/me')
        self.assertEqual(after_logout_response.status_code, 401)

    def test_auth_me_refreshes_cookie_for_legacy_bearer_session(self):
        bearer_only_client = self.app.test_client()
        response = bearer_only_client.get('/api/auth/me', headers=self._auth_headers())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json().get('username'), self.username)
        cookie_header = response.headers.get('Set-Cookie', '')
        self.assertIn(f'{AUTH_COOKIE_NAME}=', cookie_header)
        self.assertIn('HttpOnly', cookie_header)

    @patch('backend.workspace_service.send_workspace_invite_email', return_value=(True, ''))
    def test_workspace_invite_respects_recipient_email_preference(self, mock_send_invite):
        self._insert_user('bob', 'bob@example.com')
        conn = self._connection()
        try:
            conn.execute(
                'UPDATE users SET email_notifications_enabled = ? WHERE username = ?',
                (0, 'bob'),
            )
            conn.commit()
        finally:
            conn.close()

        response = self.client.post(
            f'/api/workspaces/{self.workspace_id}/invitations',
            headers=self._auth_headers(),
            json={'emails': ['bob@example.com']},
        )
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertEqual(payload['email_sent_count'], 0)
        self.assertEqual(payload['email_failed_count'], 1)
        self.assertTrue(payload['manual_share_recommended'])
        self.assertTrue(payload['created'][0]['email_skipped'])
        self.assertIn('disabled', payload['send_errors'][0]['error'])
        mock_send_invite.assert_not_called()

    @patch('backend.workspace_service.send_workspace_invite_email', return_value=(True, ''))
    def test_workspace_invite_rejects_blocked_email_domains(self, mock_send_invite):
        settings = {
            **DEFAULT_WORKSPACE_SETTINGS,
            'block_invites_from_domains': True,
            'blocked_email_domains': 'blocked.edu, spam.test',
        }
        conn = self._connection()
        try:
            conn.execute(
                'UPDATE workspaces SET settings_json = ? WHERE id = ?',
                (workspace_settings_to_json(settings), self.workspace_id),
            )
            conn.commit()
        finally:
            conn.close()

        response = self.client.post(
            f'/api/workspaces/{self.workspace_id}/invitations',
            headers=self._auth_headers(),
            json={'emails': ['student@blocked.edu']},
        )

        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertEqual(payload['error'], 'These email domains cannot join this workspace')
        self.assertEqual(payload['invalid_emails'], ['student@blocked.edu'])
        self.assertEqual(payload['blocked_domains'], ['blocked.edu', 'spam.test'])
        mock_send_invite.assert_not_called()

    def _insert_document(
        self,
        title,
        content,
        *,
        tags='',
        category='Computer Science',
        file_type='txt',
        workspace_id=None,
        filename='document.txt',
        uploaded_at='',
        processing_status='processed',
        processing_error='',
        processed_at=None,
    ):
        conn = self._connection()
        try:
            cursor = conn.execute(
                '''
                INSERT INTO documents (
                    filename,
                    title,
                    uploaded_at,
                    file_type,
                    content,
                    content_html,
                    username,
                    tags,
                    category,
                    workspace_id,
                    last_access_at,
                    deleted_at,
                    processing_status,
                    processing_error,
                    processed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    filename,
                    title,
                    uploaded_at or utcnow_iso(),
                    file_type,
                    content,
                    '',
                    self.username,
                    tags,
                    category,
                    self.workspace_id if workspace_id is None else workspace_id,
                    '',
                    '',
                    processing_status,
                    processing_error,
                    (uploaded_at or utcnow_iso()) if processed_at is None else processed_at,
                ),
            )
            conn.commit()
            return cursor.lastrowid
        finally:
            conn.close()

    def _save_pdf_upload_file(self, filename, *lines):
        os.makedirs('uploads', exist_ok=True)
        pdf_buffer = self._build_pdf_upload(*(lines or ['legacy queued pdf coverage']))
        with open(os.path.join('uploads', filename), 'wb') as f:
            f.write(pdf_buffer.getvalue())

    def _insert_share_link(
        self,
        document_id,
        token='public-share-token',
        *,
        status='active',
        expires_at='',
        workspace_id='',
    ):
        conn = self._connection()
        try:
            safe_expires_at = expires_at or (datetime.utcnow() + timedelta(days=7)).isoformat()
            conn.execute(
                '''
                INSERT INTO document_share_links (
                    document_id,
                    workspace_id,
                    token,
                    created_by,
                    status,
                    expires_at,
                    created_at,
                    last_access_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    document_id,
                    workspace_id,
                    token,
                    self.username,
                    status,
                    safe_expires_at,
                    utcnow_iso(),
                    '',
                ),
            )
            conn.commit()
            return token
        finally:
            conn.close()

    def _build_docx_upload(self, *paragraphs):
        document = DocxDocument()
        for paragraph in paragraphs or ['']:
            document.add_paragraph(str(paragraph))
        buffer = io.BytesIO()
        document.save(buffer)
        buffer.seek(0)
        return buffer

    def _build_pdf_upload(self, *lines):
        buffer = io.BytesIO()
        pdf = canvas.Canvas(buffer)
        y = 780
        for line in lines or ['']:
            pdf.drawString(72, y, str(line))
            y -= 18
        pdf.save()
        buffer.seek(0)
        return buffer

    def _build_png_header(self, width=1, height=1):
        return io.BytesIO(
            b'\x89PNG\r\n\x1a\n'
            + b'\x00\x00\x00\rIHDR'
            + int(width).to_bytes(4, 'big')
            + int(height).to_bytes(4, 'big')
            + b'\x08\x02\x00\x00\x00'
            + b'\x00\x00\x00\x00'
        )

    def _build_valid_png_upload(self):
        from PIL import Image

        buffer = io.BytesIO()
        Image.new('RGB', (1, 1), color=(255, 255, 255)).save(buffer, format='PNG')
        buffer.seek(0)
        return buffer

    def _fake_http_response(self, status_code=200, payload=None, text='', headers=None):
        class FakeResponse:
            def __init__(self, status_code, payload, text, headers):
                self.status_code = status_code
                self._payload = payload
                self.text = text
                self.headers = headers or {'content-type': 'application/json'}

            def json(self):
                if isinstance(self._payload, Exception):
                    raise self._payload
                return self._payload

        return FakeResponse(status_code, payload, text, headers)

    def test_documents_requires_auth_and_returns_items_when_authenticated(self):
        self._insert_document(
            'Protected Notes',
            'private content about algorithms',
            filename='protected-notes.txt',
        )

        response = self.client.get('/api/documents?include_meta=1')
        self.assertEqual(response.status_code, 401)
        self.assertIn('error', response.get_json())

        ok_response = self.client.get('/api/documents?include_meta=1', headers=self._auth_headers())
        self.assertEqual(ok_response.status_code, 200)
        payload = ok_response.get_json()
        self.assertEqual(payload['total'], 1)
        self.assertEqual(payload['items'][0]['title'], 'Protected Notes')

    def test_workspace_member_document_listing_includes_owner_files(self):
        self._insert_document(
            'Shared Workspace Notes',
            'shared content from the workspace owner',
            filename='shared-workspace-notes.txt',
        )
        self._insert_user('bob', 'bob@example.com')
        self._insert_user('charlie', 'charlie@example.com')
        conn = self._connection()
        try:
            conn.execute(
                '''
                INSERT INTO workspace_members (workspace_id, username, role, status, created_at)
                VALUES (?, ?, ?, ?, ?)
                ''',
                (self.workspace_id, 'bob', 'member', 'active', utcnow_iso()),
            )
            conn.commit()
        finally:
            conn.close()

        response = self.client.get(
            f'/api/documents?include_meta=1&workspace_id={self.workspace_id}',
            headers=self._auth_headers('bob'),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload['total'], 1)
        self.assertEqual(payload['items'][0]['title'], 'Shared Workspace Notes')
        self.assertEqual(payload['items'][0]['username'], self.username)

        personal_response = self.client.get('/api/documents?include_meta=1', headers=self._auth_headers('bob'))
        self.assertEqual(personal_response.status_code, 200)
        self.assertEqual(personal_response.get_json()['total'], 0)

        denied_response = self.client.get(
            f'/api/documents?include_meta=1&workspace_id={self.workspace_id}',
            headers=self._auth_headers('charlie'),
        )
        self.assertEqual(denied_response.status_code, 403)

    def test_workspace_invitation_link_directly_adds_member(self):
        self._insert_user('bob', 'bob@example.com')
        token = 'direct-join-token'
        expires_at = (datetime.utcnow() + timedelta(days=7)).isoformat()
        conn = self._connection()
        try:
            conn.execute(
                '''
                INSERT INTO workspace_invitations (
                    workspace_id,
                    email,
                    token,
                    status,
                    expires_at,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ''',
                (self.workspace_id, 'bob@example.com', token, 'pending', expires_at, utcnow_iso()),
            )
            conn.commit()
        finally:
            conn.close()

        invitation_response = self.client.get(
            f'/api/invitations/{token}',
            headers=self._auth_headers('bob'),
        )
        self.assertEqual(invitation_response.status_code, 200)
        invitation_payload = invitation_response.get_json()
        self.assertFalse(invitation_payload['requires_owner_confirmation'])
        self.assertTrue(invitation_payload['can_request'])

        join_response = self.client.post(
            f'/api/invitations/{token}/request-join',
            headers=self._auth_headers('bob'),
            json={},
        )
        self.assertEqual(join_response.status_code, 200)
        join_payload = join_response.get_json()
        self.assertEqual(join_payload['status'], 'approved')
        self.assertEqual(join_payload['workspace_id'], self.workspace_id)
        self.assertFalse(join_payload['requires_owner_confirmation'])

        conn = self._connection()
        try:
            member_cursor = conn.execute(
                '''
                SELECT role, status
                FROM workspace_members
                WHERE workspace_id = ? AND username = ?
                ''',
                (self.workspace_id, 'bob'),
            )
            member = row_to_dict(member_cursor.fetchone())
            invite_cursor = conn.execute(
                'SELECT status, requested_username FROM workspace_invitations WHERE token = ?',
                (token,),
            )
            invite = row_to_dict(invite_cursor.fetchone())
        finally:
            conn.close()

        self.assertEqual(member['role'], 'member')
        self.assertEqual(member['status'], 'active')
        self.assertEqual(invite['status'], 'approved')
        self.assertEqual(invite['requested_username'], 'bob')

        workspaces_response = self.client.get('/api/workspaces', headers=self._auth_headers('bob'))
        self.assertEqual(workspaces_response.status_code, 200)
        workspace_ids = [item['id'] for item in workspaces_response.get_json()]
        self.assertIn(self.workspace_id, workspace_ids)

    def test_workspace_owner_can_view_and_remove_members(self):
        self._insert_user('bob', 'bob@example.com')
        conn = self._connection()
        try:
            conn.execute(
                '''
                INSERT INTO workspace_members (workspace_id, username, role, status, created_at)
                VALUES (?, ?, ?, ?, ?)
                ''',
                (self.workspace_id, 'bob', 'member', 'active', utcnow_iso()),
            )
            conn.commit()
        finally:
            conn.close()

        list_response = self.client.get('/api/workspaces', headers=self._auth_headers())
        self.assertEqual(list_response.status_code, 200)
        workspace = next(
            item for item in list_response.get_json() if item['id'] == self.workspace_id
        )
        member_rows = workspace['members']
        member_usernames = [item['username'] for item in member_rows]
        self.assertIn(self.username, member_usernames)
        self.assertIn('bob', member_usernames)
        bob_member = next(item for item in member_rows if item['username'] == 'bob')
        self.assertEqual(bob_member['email'], 'bob@example.com')

        remove_response = self.client.delete(
            f'/api/workspaces/{self.workspace_id}/members/bob',
            headers=self._auth_headers(),
        )
        self.assertEqual(remove_response.status_code, 200)
        remove_payload = remove_response.get_json()
        self.assertEqual(remove_payload['removed_username'], 'bob')
        self.assertNotIn(
            'bob',
            [item['username'] for item in remove_payload['workspace']['members']],
        )

        conn = self._connection()
        try:
            member_cursor = conn.execute(
                '''
                SELECT status
                FROM workspace_members
                WHERE workspace_id = ? AND username = ?
                ''',
                (self.workspace_id, 'bob'),
            )
            member = row_to_dict(member_cursor.fetchone())
        finally:
            conn.close()
        self.assertEqual(member['status'], 'removed')

        denied_response = self.client.get(
            f'/api/documents?include_meta=1&workspace_id={self.workspace_id}',
            headers=self._auth_headers('bob'),
        )
        self.assertEqual(denied_response.status_code, 403)

        owner_remove_response = self.client.delete(
            f'/api/workspaces/{self.workspace_id}/members/{self.username}',
            headers=self._auth_headers(),
        )
        self.assertEqual(owner_remove_response.status_code, 400)

    def test_non_owner_workspace_payload_hides_member_details(self):
        self._insert_user('bob', 'bob@example.com')
        conn = self._connection()
        try:
            conn.execute(
                '''
                INSERT INTO workspace_members (workspace_id, username, role, status, created_at)
                VALUES (?, ?, ?, ?, ?)
                ''',
                (self.workspace_id, 'bob', 'member', 'active', utcnow_iso()),
            )
            conn.commit()
        finally:
            conn.close()

        response = self.client.get('/api/workspaces', headers=self._auth_headers('bob'))
        self.assertEqual(response.status_code, 200)
        workspace = next(item for item in response.get_json() if item['id'] == self.workspace_id)
        self.assertFalse(workspace['is_owner'])
        self.assertEqual(workspace['members_count'], 2)
        self.assertEqual(workspace['members'], [])

    def test_approved_invitation_cannot_reactivate_removed_member(self):
        self._insert_user('bob', 'bob@example.com')
        token = 'approved-consumed-token'
        expires_at = (datetime.utcnow() + timedelta(days=7)).isoformat()
        conn = self._connection()
        try:
            conn.execute(
                '''
                INSERT INTO workspace_invitations (
                    workspace_id,
                    email,
                    token,
                    status,
                    expires_at,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ''',
                (self.workspace_id, 'bob@example.com', token, 'pending', expires_at, utcnow_iso()),
            )
            conn.commit()
        finally:
            conn.close()

        join_response = self.client.post(
            f'/api/invitations/{token}/request-join',
            headers=self._auth_headers('bob'),
            json={},
        )
        self.assertEqual(join_response.status_code, 200)

        remove_response = self.client.delete(
            f'/api/workspaces/{self.workspace_id}/members/bob',
            headers=self._auth_headers(),
        )
        self.assertEqual(remove_response.status_code, 200)

        invitation_response = self.client.get(
            f'/api/invitations/{token}?username=bob',
            headers=self._auth_headers('bob'),
        )
        self.assertEqual(invitation_response.status_code, 200)
        invitation_payload = invitation_response.get_json()
        self.assertFalse(invitation_payload['viewer_is_active_member'])
        self.assertFalse(invitation_payload['can_open_workspace'])
        self.assertEqual(
            invitation_payload['mismatch_reason'],
            'This invitation was already used and this account no longer has workspace access',
        )

        retry_response = self.client.post(
            f'/api/invitations/{token}/request-join',
            headers=self._auth_headers('bob'),
            json={},
        )
        self.assertEqual(retry_response.status_code, 409)
        self.assertEqual(retry_response.get_json()['error'], 'Invitation has already been used')

        conn = self._connection()
        try:
            member_cursor = conn.execute(
                '''
                SELECT status
                FROM workspace_members
                WHERE workspace_id = ? AND username = ?
                ''',
                (self.workspace_id, 'bob'),
            )
            member = row_to_dict(member_cursor.fetchone())
        finally:
            conn.close()
        self.assertEqual(member['status'], 'removed')

    def test_removing_member_cancels_open_invitations_for_that_user(self):
        self._insert_user('bob', 'bob@example.com')
        token = 'pending-token-for-removed-member'
        expires_at = (datetime.utcnow() + timedelta(days=7)).isoformat()
        conn = self._connection()
        try:
            conn.execute(
                '''
                INSERT INTO workspace_members (workspace_id, username, role, status, created_at)
                VALUES (?, ?, ?, ?, ?)
                ''',
                (self.workspace_id, 'bob', 'member', 'active', utcnow_iso()),
            )
            conn.execute(
                '''
                INSERT INTO workspace_invitations (
                    workspace_id,
                    email,
                    token,
                    status,
                    expires_at,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ''',
                (self.workspace_id, 'bob@example.com', token, 'pending', expires_at, utcnow_iso()),
            )
            conn.commit()
        finally:
            conn.close()

        remove_response = self.client.delete(
            f'/api/workspaces/{self.workspace_id}/members/bob',
            headers=self._auth_headers(),
        )
        self.assertEqual(remove_response.status_code, 200)

        retry_response = self.client.post(
            f'/api/invitations/{token}/request-join',
            headers=self._auth_headers('bob'),
            json={},
        )
        self.assertEqual(retry_response.status_code, 400)
        self.assertEqual(retry_response.get_json()['error'], 'Invitation is cancelled')

        conn = self._connection()
        try:
            member_cursor = conn.execute(
                '''
                SELECT status
                FROM workspace_members
                WHERE workspace_id = ? AND username = ?
                ''',
                (self.workspace_id, 'bob'),
            )
            member = row_to_dict(member_cursor.fetchone())
            invite_cursor = conn.execute(
                'SELECT status, reviewed_by, review_note FROM workspace_invitations WHERE token = ?',
                (token,),
            )
            invite = row_to_dict(invite_cursor.fetchone())
        finally:
            conn.close()

        self.assertEqual(member['status'], 'removed')
        self.assertEqual(invite['status'], 'cancelled')
        self.assertEqual(invite['reviewed_by'], self.username)
        self.assertEqual(invite['review_note'], 'Cancelled because member was removed')

    @patch('backend.workspace_service.send_workspace_invite_email', return_value=(True, ''))
    def test_member_invite_does_not_replace_existing_owner_invite(self, _mock_send_invite):
        self._insert_user('bob', 'bob@example.com')
        owner_token = 'owner-open-invite-token'
        expires_at = (datetime.utcnow() + timedelta(days=7)).isoformat()
        conn = self._connection()
        try:
            next_settings = {
                **DEFAULT_WORKSPACE_SETTINGS,
                'allow_member_invites': True,
            }
            conn.execute(
                'UPDATE workspaces SET settings_json = ? WHERE id = ?',
                (workspace_settings_to_json(next_settings), self.workspace_id),
            )
            conn.execute(
                '''
                INSERT INTO workspace_members (workspace_id, username, role, status, created_at)
                VALUES (?, ?, ?, ?, ?)
                ''',
                (self.workspace_id, 'bob', 'member', 'active', utcnow_iso()),
            )
            conn.execute(
                '''
                INSERT INTO workspace_invitations (
                    workspace_id,
                    email,
                    token,
                    status,
                    expires_at,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ''',
                (
                    self.workspace_id,
                    'charlie@example.com',
                    owner_token,
                    'pending',
                    expires_at,
                    utcnow_iso(),
                ),
            )
            conn.commit()
        finally:
            conn.close()

        response = self.client.post(
            f'/api/workspaces/{self.workspace_id}/invitations',
            headers=self._auth_headers('bob'),
            json={'emails': ['charlie@example.com']},
        )
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertEqual(len(payload['created']), 1)
        self.assertEqual(payload['created'][0]['email'], 'charlie@example.com')

        conn = self._connection()
        try:
            cursor = conn.execute(
                '''
                SELECT token, status
                FROM workspace_invitations
                WHERE workspace_id = ? AND email = ?
                ORDER BY created_at ASC, id ASC
                ''',
                (self.workspace_id, 'charlie@example.com'),
            )
            invitations = [row_to_dict(item) for item in cursor.fetchall()]
        finally:
            conn.close()

        self.assertEqual(len(invitations), 2)
        original = next(item for item in invitations if item['token'] == owner_token)
        self.assertEqual(original['status'], 'pending')
        self.assertTrue(any(item['token'] != owner_token and item['status'] == 'pending' for item in invitations))

    def test_non_owner_cannot_resend_workspace_invitation(self):
        self._insert_user('bob', 'bob@example.com')
        token = 'owner-resend-invite-token'
        expires_at = (datetime.utcnow() + timedelta(days=7)).isoformat()
        conn = self._connection()
        try:
            next_settings = {
                **DEFAULT_WORKSPACE_SETTINGS,
                'allow_member_invites': True,
            }
            conn.execute(
                'UPDATE workspaces SET settings_json = ? WHERE id = ?',
                (workspace_settings_to_json(next_settings), self.workspace_id),
            )
            conn.execute(
                '''
                INSERT INTO workspace_members (workspace_id, username, role, status, created_at)
                VALUES (?, ?, ?, ?, ?)
                ''',
                (self.workspace_id, 'bob', 'member', 'active', utcnow_iso()),
            )
            cursor = conn.execute(
                '''
                INSERT INTO workspace_invitations (
                    workspace_id,
                    email,
                    token,
                    status,
                    expires_at,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ''',
                (
                    self.workspace_id,
                    'charlie@example.com',
                    token,
                    'pending',
                    expires_at,
                    utcnow_iso(),
                ),
            )
            invitation_id = cursor.lastrowid
            conn.commit()
        finally:
            conn.close()

        response = self.client.post(
            f'/api/workspaces/{self.workspace_id}/invitations/{invitation_id}/resend',
            headers=self._auth_headers('bob'),
            json={},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()['error'], 'Only workspace owner can resend invitations')

    def test_workspace_member_can_leave_shared_workspace(self):
        self._insert_user('bob', 'bob@example.com')
        conn = self._connection()
        try:
            conn.execute(
                '''
                INSERT INTO workspace_members (workspace_id, username, role, status, created_at)
                VALUES (?, ?, ?, ?, ?)
                ''',
                (self.workspace_id, 'bob', 'member', 'active', utcnow_iso()),
            )
            conn.commit()
        finally:
            conn.close()

        leave_response = self.client.delete(
            f'/api/workspaces/{self.workspace_id}/members/bob',
            headers=self._auth_headers('bob'),
        )
        self.assertEqual(leave_response.status_code, 200)
        self.assertEqual(leave_response.get_json()['removed_username'], 'bob')

        conn = self._connection()
        try:
            member_cursor = conn.execute(
                '''
                SELECT status
                FROM workspace_members
                WHERE workspace_id = ? AND username = ?
                ''',
                (self.workspace_id, 'bob'),
            )
            member = row_to_dict(member_cursor.fetchone())
        finally:
            conn.close()
        self.assertEqual(member['status'], 'removed')

        workspaces_response = self.client.get('/api/workspaces', headers=self._auth_headers('bob'))
        self.assertEqual(workspaces_response.status_code, 200)
        workspace_ids = [item['id'] for item in workspaces_response.get_json()]
        self.assertNotIn(self.workspace_id, workspace_ids)

    def test_friend_requests_messages_and_notifications_flow(self):
        self._insert_user('bob', 'bob@example.com')
        self._insert_user('charlie', 'charlie@example.com')

        create_response = self.client.post(
            '/api/friends/requests',
            headers=self._auth_headers(),
            json={
                'mode': 'email',
                'email': 'bob@example.com',
                'message': 'Study partner?',
            },
        )
        self.assertEqual(create_response.status_code, 201)
        self.assertEqual(create_response.get_json()['message'], 'Friend request sent.')

        bob_summary_response = self.client.get('/api/friends/summary', headers=self._auth_headers('bob'))
        self.assertEqual(bob_summary_response.status_code, 200)
        bob_summary = bob_summary_response.get_json()
        self.assertEqual(len(bob_summary['incoming_requests']), 1)
        self.assertGreaterEqual(bob_summary['unread_count'], 1)
        request_id = bob_summary['incoming_requests'][0]['id']

        accept_response = self.client.post(
            f'/api/friends/requests/{request_id}/respond',
            headers=self._auth_headers('bob'),
            json={'action': 'accept'},
        )
        self.assertEqual(accept_response.status_code, 200)
        accepted_summary = accept_response.get_json()['summary']
        self.assertEqual([friend['username'] for friend in accepted_summary['friends']], ['alice'])

        alice_summary_response = self.client.get('/api/friends/summary', headers=self._auth_headers())
        self.assertEqual(alice_summary_response.status_code, 200)
        alice_summary = alice_summary_response.get_json()
        self.assertEqual([friend['username'] for friend in alice_summary['friends']], ['bob'])
        self.assertTrue(
            any(item['title'] == 'Friend request accepted' for item in alice_summary['notifications'])
        )

        message_response = self.client.post(
            '/api/friends/messages',
            headers=self._auth_headers(),
            json={'recipient_username': 'bob', 'body': 'Can you see this note?'},
        )
        self.assertEqual(message_response.status_code, 201)

        bob_after_message = self.client.get('/api/friends/summary', headers=self._auth_headers('bob')).get_json()
        unread_messages = [item for item in bob_after_message['messages'] if item.get('is_unread')]
        self.assertEqual(len(unread_messages), 1)
        self.assertEqual(unread_messages[0]['body'], 'Can you see this note?')

        read_response = self.client.post(
            '/api/friends/read',
            headers=self._auth_headers('bob'),
            json={'peer_username': 'alice'},
        )
        self.assertEqual(read_response.status_code, 200)
        read_summary = read_response.get_json()['summary']
        self.assertFalse(any(item.get('is_unread') for item in read_summary['messages']))

        charlie_summary = self.client.get('/api/friends/summary', headers=self._auth_headers('charlie')).get_json()
        charlie_code = charlie_summary['user']['friend_code']
        username_request = self.client.post(
            '/api/friends/requests',
            headers=self._auth_headers(),
            json={
                'mode': 'username',
                'username': 'charlie',
                'friend_code': charlie_code,
            },
        )
        self.assertEqual(username_request.status_code, 201)

    def test_workspace_settings_preserve_uploaded_image_icon(self):
        icon_data_url = 'data:image/png;base64,iVBORw0KGgo='
        normalized = normalize_workspace_settings({'workspace_icon': icon_data_url})
        self.assertEqual(normalized['workspace_icon'], icon_data_url)

        rejected = normalize_workspace_settings({'workspace_icon': 'data:image/svg+xml;base64,PHN2Zz4='})
        self.assertEqual(rejected['workspace_icon'], DEFAULT_WORKSPACE_SETTINGS['workspace_icon'])

    def test_friend_file_share_accept_copies_document_to_recipient_workspace(self):
        self._insert_user('bob', 'bob@example.com')
        conn = self._connection()
        try:
            conn.execute(
                'INSERT INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)',
                ('alice', 'bob', utcnow_iso()),
            )
            now_iso = utcnow_iso()
            conn.execute(
                '''
                INSERT INTO workspaces (id, name, plan, owner_username, settings_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    'ws-bob-received',
                    'Bob Received Files',
                    'Free',
                    'bob',
                    workspace_settings_to_json(DEFAULT_WORKSPACE_SETTINGS),
                    now_iso,
                    now_iso,
                ),
            )
            ensure_owner_membership(conn, 'ws-bob-received', 'bob')
            conn.commit()
        finally:
            conn.close()

        os.makedirs('uploads', exist_ok=True)
        source_filename = 'friend-source.txt'
        with open(os.path.join('uploads', source_filename), 'wb') as f:
            f.write(b'friend share source text')
        document_id = self._insert_document(
            'Friend Source Note',
            'friend share source text',
            file_type='txt',
            filename=source_filename,
        )

        share_response = self.client.post(
            '/api/friends/file-shares',
            headers=self._auth_headers(),
            json={'recipient_username': 'bob', 'document_id': document_id, 'note': 'Use this one.'},
        )
        self.assertEqual(share_response.status_code, 201)
        share_payload = share_response.get_json()
        sent_file_messages = [
            item for item in share_payload['summary']['messages']
            if item.get('message_type') == 'friend_file_share'
        ]
        self.assertEqual(len(sent_file_messages), 1)
        self.assertEqual(sent_file_messages[0]['direction'], 'sent')
        self.assertEqual(sent_file_messages[0]['metadata']['document_title'], 'Friend Source Note')
        self.assertEqual(sent_file_messages[0]['metadata']['note'], 'Use this one.')

        bob_summary = self.client.get('/api/friends/summary', headers=self._auth_headers('bob')).get_json()
        received_file_messages = [
            item for item in bob_summary['messages']
            if item.get('message_type') == 'friend_file_share'
        ]
        self.assertEqual(len(received_file_messages), 1)
        self.assertEqual(received_file_messages[0]['direction'], 'received')
        self.assertEqual(received_file_messages[0]['metadata']['document_title'], 'Friend Source Note')
        self.assertIn('Shared file: Friend Source Note', received_file_messages[0]['body'])
        pending = next(
            item for item in bob_summary['notifications']
            if item.get('type') == 'friend_file_share'
        )
        self.assertEqual(pending['metadata']['status'], 'pending')
        self.assertEqual(pending['metadata']['source_document_id'], document_id)

        accept_response = self.client.post(
            f"/api/friends/file-shares/{pending['id']}/respond",
            headers=self._auth_headers('bob'),
            json={'action': 'accept', 'target_workspace_id': 'ws-bob-received'},
        )
        self.assertEqual(accept_response.status_code, 200)
        payload = accept_response.get_json()
        self.assertEqual(payload['status'], 'accepted')
        self.assertGreater(payload['document_id'], 0)
        self.assertEqual(payload['workspace_id'], 'ws-bob-received')
        self.assertEqual(payload['document']['workspace_id'], 'ws-bob-received')
        self.assertEqual(payload['document']['username'], 'bob')
        self.assertEqual(payload['document']['title'], 'Friend Source Note')
        self.assertIsNone(payload['document']['last_access_at'])
        self.assertIsNone(payload['document']['deleted_at'])

        copied_filename = payload['document']['filename']
        self.assertNotEqual(copied_filename, source_filename)
        with open(os.path.join('uploads', copied_filename), 'rb') as f:
            self.assertEqual(f.read(), b'friend share source text')

    def test_friend_file_share_accept_rebuilds_copy_when_source_file_is_missing(self):
        self._insert_user('bob', 'bob@example.com')
        conn = self._connection()
        try:
            conn.execute(
                'INSERT INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)',
                ('alice', 'bob', utcnow_iso()),
            )
            now_iso = utcnow_iso()
            conn.execute(
                '''
                INSERT INTO workspaces (id, name, plan, owner_username, settings_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    'ws-bob-rebuilt',
                    'Bob Rebuilt Files',
                    'Free',
                    'bob',
                    workspace_settings_to_json(DEFAULT_WORKSPACE_SETTINGS),
                    now_iso,
                    now_iso,
                ),
            )
            ensure_owner_membership(conn, 'ws-bob-rebuilt', 'bob')
            conn.commit()
        finally:
            conn.close()

        document_id = self._insert_document(
            'Missing Source PDF',
            'fallback copy text from database',
            file_type='pdf',
            filename='missing-source-file.pdf',
        )

        share_response = self.client.post(
            '/api/friends/file-shares',
            headers=self._auth_headers(),
            json={'recipient_username': 'bob', 'document_id': document_id},
        )
        self.assertEqual(share_response.status_code, 201)

        bob_summary = self.client.get('/api/friends/summary', headers=self._auth_headers('bob')).get_json()
        pending = next(
            item for item in bob_summary['notifications']
            if item.get('type') == 'friend_file_share'
        )

        accept_response = self.client.post(
            f"/api/friends/file-shares/{pending['id']}/respond",
            headers=self._auth_headers('bob'),
            json={'action': 'accept', 'target_workspace_id': 'ws-bob-rebuilt'},
        )
        self.assertEqual(accept_response.status_code, 200)
        payload = accept_response.get_json()
        self.assertEqual(payload['status'], 'accepted')
        self.assertIn('rebuilt the copy from saved text', payload.get('warning', ''))
        self.assertEqual(payload['document']['workspace_id'], 'ws-bob-rebuilt')

        copied_filename = payload['document']['filename']
        with open(os.path.join('uploads', copied_filename), 'rb') as f:
            copied_text = extract_text_from_pdf_bytes(f.read())
        self.assertIn('fallback copy text from database', copied_text)

    @patch('backend.share_link_service.send_document_share_email', return_value=(True, ''))
    def test_email_share_to_friend_creates_acceptance_notification(self, _mock_send_share_email):
        self._insert_user('bob', 'bob@example.com')
        conn = self._connection()
        try:
            conn.execute(
                'INSERT INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)',
                ('alice', 'bob', utcnow_iso()),
            )
            now_iso = utcnow_iso()
            conn.execute(
                '''
                INSERT INTO workspaces (id, name, plan, owner_username, settings_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    'ws-bob-email-share',
                    'Bob Email Share Files',
                    'Free',
                    'bob',
                    workspace_settings_to_json(DEFAULT_WORKSPACE_SETTINGS),
                    now_iso,
                    now_iso,
                ),
            )
            ensure_owner_membership(conn, 'ws-bob-email-share', 'bob')
            conn.commit()
        finally:
            conn.close()

        self.client.patch(
            '/api/auth/preferences',
            headers=self._auth_headers('bob'),
            json={'email_notifications_enabled': False},
        )

        os.makedirs('uploads', exist_ok=True)
        source_filename = 'email-friend-share.txt'
        with open(os.path.join('uploads', source_filename), 'wb') as f:
            f.write(b'email friend share source text')
        document_id = self._insert_document(
            'Email Friend Share',
            'email friend share source text',
            file_type='txt',
            filename=source_filename,
        )

        share_response = self.client.post(
            f'/api/documents/{document_id}/email-share',
            headers=self._auth_headers(),
            json={
                'recipient_email': 'bob@example.com',
                'message': 'Please add this to your workspace.',
                'expiry_days': 7,
            },
        )
        self.assertEqual(share_response.status_code, 200)

        bob_summary = self.client.get('/api/friends/summary', headers=self._auth_headers('bob')).get_json()
        pending = next(
            item for item in bob_summary['notifications']
            if item.get('type') == 'friend_file_share'
        )
        self.assertEqual(pending['metadata']['status'], 'pending')
        self.assertEqual(pending['metadata']['source_document_id'], document_id)
        self.assertEqual(pending['metadata']['document_title'], 'Email Friend Share')
        self.assertTrue(str(pending['metadata'].get('share_token') or '').strip())

        accept_response = self.client.post(
            f"/api/friends/file-shares/{pending['id']}/respond",
            headers=self._auth_headers('bob'),
            json={'action': 'accept', 'target_workspace_id': 'ws-bob-email-share'},
        )
        self.assertEqual(accept_response.status_code, 200)
        payload = accept_response.get_json()
        self.assertEqual(payload['status'], 'accepted')
        self.assertEqual(payload['workspace_id'], 'ws-bob-email-share')
        self.assertEqual(payload['document']['username'], 'bob')
        self.assertEqual(payload['document']['title'], 'Email Friend Share')

    def test_authenticated_share_link_can_be_saved_to_workspace(self):
        self._insert_user('bob', 'bob@example.com')
        conn = self._connection()
        try:
            now_iso = utcnow_iso()
            conn.execute(
                '''
                INSERT INTO workspaces (id, name, plan, owner_username, settings_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    'ws-bob-public-share',
                    'Bob Public Share Files',
                    'Free',
                    'bob',
                    workspace_settings_to_json(DEFAULT_WORKSPACE_SETTINGS),
                    now_iso,
                    now_iso,
                ),
            )
            ensure_owner_membership(conn, 'ws-bob-public-share', 'bob')
            conn.commit()
        finally:
            conn.close()

        os.makedirs('uploads', exist_ok=True)
        source_filename = 'public-share-source.txt'
        with open(os.path.join('uploads', source_filename), 'wb') as f:
            f.write(b'public share source text')
        document_id = self._insert_document(
            'Public Share Save',
            'public share source text',
            file_type='txt',
            filename=source_filename,
        )
        token = self._insert_share_link(document_id, token='save-public-share-token', workspace_id=self.workspace_id)

        response = self.client.post(
            f'/api/share-links/{token}/save',
            headers=self._auth_headers('bob'),
            json={'workspace_id': 'ws-bob-public-share'},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload['status'], 'saved')
        self.assertEqual(payload['workspace_id'], 'ws-bob-public-share')
        self.assertEqual(payload['document']['username'], 'bob')
        self.assertEqual(payload['document']['title'], 'Public Share Save')

        copied_filename = payload['document']['filename']
        self.assertNotEqual(copied_filename, source_filename)
        with open(os.path.join('uploads', copied_filename), 'rb') as f:
            self.assertEqual(f.read(), b'public share source text')

    @patch('backend.shared.EXTERNAL_OCR_SERVICE_URL', 'https://private.example.invalid/ocr')
    @patch('backend.shared.HF_TOKEN', 'hf-test-token')
    @patch('backend.shared.requests.post')
    def test_image_ocr_falls_back_to_huggingface_after_external_404(self, mock_post):
        mock_post.side_effect = [
            self._fake_http_response(404, {'error': 'not found'}),
            self._fake_http_response(200, [{'generated_text': 'Fallback OCR lecture text'}]),
        ]

        response = self.client.post(
            '/api/extract-text',
            headers=self._auth_headers(),
            data={
                'image': (io.BytesIO(b'not-a-real-image-but-route-sends-bytes'), 'lecture.png'),
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload.get('source'), 'huggingface')
        self.assertEqual(payload.get('text'), 'Fallback OCR lecture text')
        self.assertEqual(mock_post.call_count, 2)

    @patch('backend.shared.EXTERNAL_OCR_SERVICE_URL', 'https://private.example.invalid/ocr')
    @patch('backend.shared.HF_TOKEN', '')
    @patch('backend.shared.requests.post')
    def test_image_ocr_error_redacts_external_endpoint_details(self, mock_post):
        mock_post.side_effect = RuntimeError(
            "HTTPSConnectionPool(host='private.example.invalid', url='https://private.example.invalid/ocr') failed"
        )

        response = self.client.post(
            '/api/extract-text',
            headers=self._auth_headers(),
            data={
                'image': (io.BytesIO(b'not-a-real-image-but-route-sends-bytes'), 'lecture.png'),
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 502)
        payload = response.get_json()
        self.assertEqual(payload.get('error'), 'OCR failed')
        self.assertIn('[external OCR host]', str(payload))
        self.assertNotIn('private.example.invalid', str(payload))
        self.assertNotIn('https://private.example.invalid/ocr', str(payload))

    @patch('backend.shared.EXTERNAL_OCR_SERVICE_URL', 'https://private.example.invalid/ocr')
    @patch('backend.shared.HF_TOKEN', '')
    @patch('backend.shared.requests.request')
    def test_ocr_health_redacts_external_url_and_checks_reachability(self, mock_request):
        mock_request.return_value = self._fake_http_response(404, {'error': 'not found'})

        anonymous_response = self.client.get('/api/ocr/health')

        self.assertEqual(anonymous_response.status_code, 503)
        anonymous_payload = anonymous_response.get_json()
        self.assertFalse(anonymous_payload.get('ok'))
        self.assertIn('details', anonymous_payload)
        self.assertNotIn('external_ocr_configured', anonymous_payload)
        self.assertNotIn('external_ocr_probe', anonymous_payload)
        self.assertNotIn('private.example.invalid', str(anonymous_payload))

        response = self.client.get('/api/ocr/health', headers=self._auth_headers())

        self.assertEqual(response.status_code, 503)
        payload = response.get_json()
        self.assertFalse(payload.get('ok'))
        self.assertTrue(payload.get('external_ocr_configured'))
        self.assertNotIn('external_ocr_service_url', payload)
        self.assertNotIn('private.example.invalid', str(payload))
        self.assertEqual(payload.get('external_ocr_probe', {}).get('status_code'), 404)

    def test_auth_secret_policy_requires_strong_secret_or_explicit_development(self):
        def run_config_import(env_updates):
            env = os.environ.copy()
            for key in (
                'APP_ENV',
                'FLASK_ENV',
                'AUTH_TOKEN_SECRET',
                'FLASK_SECRET_KEY',
                'RENDER',
                'DYNO',
                'FLY_APP_NAME',
                'K_SERVICE',
                'RAILWAY_ENVIRONMENT',
            ):
                env.pop(key, None)
            env['PYTHONPATH'] = self.original_cwd
            env['PYTHON_DOTENV_DISABLED'] = '1'
            env.update(env_updates)
            return subprocess.run(
                [
                    sys.executable,
                    '-c',
                    (
                        'import backend.config as config; '
                        'print(f"SECRET_LEN={len(config.AUTH_TOKEN_SECRET)}"); '
                        'print(f"SECRET_SOURCE={config.AUTH_TOKEN_SECRET_SOURCE}")'
                    ),
                ],
                cwd=self.original_cwd,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

        missing_secret = run_config_import({})
        self.assertNotEqual(missing_secret.returncode, 0)
        self.assertIn('AUTH_TOKEN_SECRET', f'{missing_secret.stdout}\n{missing_secret.stderr}')

        explicit_dev = run_config_import({'APP_ENV': 'development'})
        self.assertEqual(explicit_dev.returncode, 0, explicit_dev.stderr)
        self.assertIn('SECRET_SOURCE=generated-development', explicit_dev.stdout)
        self.assertIn('per-process random secret', explicit_dev.stdout)

        weak_dev = run_config_import({'FLASK_ENV': 'development', 'AUTH_TOKEN_SECRET': 'short'})
        self.assertEqual(weak_dev.returncode, 0, weak_dev.stderr)
        self.assertIn('SECRET_SOURCE=generated-development', weak_dev.stdout)

        strong_secret = run_config_import({'AUTH_TOKEN_SECRET': 's' * 32})
        self.assertEqual(strong_secret.returncode, 0, strong_secret.stderr)
        self.assertIn('SECRET_LEN=32', strong_secret.stdout)
        self.assertIn('SECRET_SOURCE=auth_token_secret', strong_secret.stdout)

        strong_legacy = run_config_import({'FLASK_SECRET_KEY': 'l' * 32})
        self.assertEqual(strong_legacy.returncode, 0, strong_legacy.stderr)
        self.assertIn('SECRET_LEN=32', strong_legacy.stdout)
        self.assertIn('SECRET_SOURCE=flask_secret_key', strong_legacy.stdout)

    def test_app_base_url_has_no_production_hardcoded_fallback(self):
        env = os.environ.copy()
        for key in ('APP_ENV', 'FLASK_ENV', 'APP_BASE_URL', 'AUTH_TOKEN_SECRET', 'FLASK_SECRET_KEY'):
            env.pop(key, None)
        env['PYTHONPATH'] = self.original_cwd
        env['PYTHON_DOTENV_DISABLED'] = '1'
        env['APP_ENV'] = 'production'
        env['AUTH_TOKEN_SECRET'] = 's' * 32
        result = subprocess.run(
            [sys.executable, '-c', 'import backend.config'],
            cwd=self.original_cwd,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('APP_BASE_URL', f'{result.stdout}\n{result.stderr}')

        env['APP_BASE_URL'] = 'https://configured.example'
        configured = subprocess.run(
            [
                sys.executable,
                '-c',
                'import backend.config as config; print(config.APP_BASE_URL)',
            ],
            cwd=self.original_cwd,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(configured.returncode, 0, configured.stderr)
        self.assertIn('https://configured.example', configured.stdout)

    def test_generated_links_use_configured_app_base_url(self):
        from backend import feedback_service, share_domain, shared, workspace_domain

        configured_base = 'https://configured.example'
        with patch('backend.shared.INVITE_BASE_URL', configured_base), \
                patch('backend.shared.APP_BASE_URL', configured_base), \
                patch('backend.workspace_domain.INVITE_BASE_URL', configured_base), \
                patch('backend.share_domain.INVITE_BASE_URL', configured_base), \
                patch('backend.feedback_service.APP_BASE_URL', configured_base):
            verification_url = shared.build_email_verification_url('verify-token')
            auth_page_html, _, _ = shared._render_auth_message_page('Done', 'Verified', success=True)
            invite_url = workspace_domain.build_invite_url('invite-token')
            share_url = share_domain.build_document_share_url('share-token')
            feedback_url = feedback_service._feedback_admin_link(42)

        self.assertEqual(verification_url, f'{configured_base}/api/auth/verify-email?token=verify-token')
        self.assertIn(f'{configured_base}/#/login', auth_page_html)
        self.assertEqual(invite_url, f'{configured_base}/#/invite/invite-token')
        self.assertEqual(share_url, f'{configured_base}/#/shared/share-token')
        self.assertEqual(feedback_url, f'{configured_base}/#/admin/feedback?feedback=42')

    def test_old_render_app_base_url_not_in_executable_code(self):
        old_domain = ''.join([
            'automated-',
            'lecture-',
            'notes-',
            'summarisation',
            '.',
            'on',
            'render',
            '.',
            'com',
        ])
        executable_roots = ['app.py', 'backend', 'src', 'summary_service']
        offenders = []
        for root in executable_roots:
            root_path = os.path.join(self.original_cwd, root)
            if os.path.isfile(root_path):
                candidates = [root_path]
            else:
                candidates = [
                    os.path.join(dirpath, filename)
                    for dirpath, _dirnames, filenames in os.walk(root_path)
                    for filename in filenames
                    if filename.endswith(('.py', '.js', '.jsx', '.ts', '.tsx'))
                ]
            for path in candidates:
                with open(path, 'r', encoding='utf-8') as handle:
                    if old_domain in handle.read():
                        offenders.append(os.path.relpath(path, self.original_cwd))
        self.assertEqual(offenders, [])

    def test_cors_allows_configured_localhost_and_rejects_unknown_origin(self):
        allowed = self.client.get('/api/health', headers={'Origin': 'http://localhost:5173'})
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173')

        blocked = self.client.get('/api/health', headers={'Origin': 'https://evil.example'})
        self.assertEqual(blocked.status_code, 200)
        self.assertIsNone(blocked.headers.get('Access-Control-Allow-Origin'))

    def test_health_endpoint_exposes_safe_build_metadata_only(self):
        response = self.client.get('/api/health')
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload.get('ok'))
        self.assertEqual(payload.get('app'), 'StudyHub')
        self.assertIn(payload.get('storage_mode'), ('local', 's3'))
        self.assertIn('database_mode', payload)
        self.assertNotIn('token', json.dumps(payload).lower())
        self.assertNotIn('secret', json.dumps(payload).lower())
        self.assertNotIn('database_url', json.dumps(payload).lower())

    def test_default_security_headers_are_sent(self):
        response = self.client.get('/api/health')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get('X-Content-Type-Options'), 'nosniff')
        self.assertEqual(response.headers.get('X-Frame-Options'), 'DENY')
        self.assertIn("frame-ancestors 'none'", response.headers.get('Content-Security-Policy', ''))
        self.assertIn('camera=()', response.headers.get('Permissions-Policy', ''))

    def test_debug_mode_defaults_to_false_outside_explicit_debug_flag(self):
        import backend.config as config

        self.assertFalse(config.DEBUG_ENABLED)

    def test_rate_limit_guard_blocks_repeated_login_attempts(self):
        security.clear_rate_limit_state()
        original_rule = security.RATE_LIMIT_RULES.get('login')
        original_enabled = security.RATE_LIMIT_ENABLED
        security.RATE_LIMIT_ENABLED = True
        security.RATE_LIMIT_RULES['login'] = (1, 60)
        try:
            first = self.client.post('/api/auth/login', json={'username': 'nobody', 'password': 'bad'})
            second = self.client.post('/api/auth/login', json={'username': 'nobody', 'password': 'bad'})
        finally:
            security.RATE_LIMIT_ENABLED = original_enabled
            if original_rule:
                security.RATE_LIMIT_RULES['login'] = original_rule
            security.clear_rate_limit_state()

        self.assertNotEqual(first.status_code, 429)
        self.assertEqual(second.status_code, 429)
        self.assertIn('Retry-After', second.headers)

    @patch('backend.share_link_service.send_document_share_email', return_value=(True, ''))
    def test_send_note_by_email_creates_share_link_and_returns_share_payload(self, _mock_send_share_email):
        document_id = self._insert_document(
            'Email Share Notes',
            'share by email smoke content',
            filename='email-share-notes.txt',
        )

        response = self.client.post(
            f'/api/documents/{document_id}/email-share',
            headers=self._auth_headers(),
            json={
                'username': self.username,
                'recipient_email': 'classmate@example.com',
                'message': 'Please review this note before class.',
                'expiry_days': 5,
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload.get('sent'))
        self.assertEqual(payload.get('recipient_email'), 'classmate@example.com')
        self.assertTrue(str(payload.get('expires_at') or '').strip())
        self.assertIn('share', payload)
        self.assertTrue(str(payload['share'].get('token') or '').strip())
        self.assertTrue(str(payload['share'].get('share_url') or '').strip())
        self.assertEqual(payload['share'].get('expiry_days'), 5)
        self.assertFalse(bool(payload.get('reused_existing')))

        conn = self._connection()
        try:
            share_row = row_to_dict(
                conn.execute(
                    '''
                    SELECT token, status, created_by, recipient_email
                    FROM document_share_links
                    WHERE document_id = ?
                    ORDER BY id DESC
                    LIMIT 1
                    ''',
                    (document_id,),
                ).fetchone()
            ) or {}
        finally:
            conn.close()
        self.assertEqual(str(share_row.get('status') or '').strip().lower(), 'active')
        self.assertEqual(str(share_row.get('created_by') or '').strip(), self.username)
        self.assertEqual(str(share_row.get('recipient_email') or '').strip(), 'classmate@example.com')

    @patch('backend.share_link_service.send_document_share_email', return_value=(True, ''))
    def test_workspace_share_links_list_links_across_documents(self, _mock_send_share_email):
        first_document_id = self._insert_document(
            'First Shared Notes',
            'first share content',
            filename='first-share.txt',
        )
        second_document_id = self._insert_document(
            'Second Shared Notes',
            'second share content',
            filename='second-share.txt',
        )

        for document_id in (first_document_id, second_document_id):
            response = self.client.post(
                f'/api/documents/{document_id}/email-share',
                headers=self._auth_headers(),
                json={
                    'username': self.username,
                    'recipient_email': 'classmate@example.com',
                    'message': 'Please review this note.',
                },
            )
            self.assertEqual(response.status_code, 200)

        list_response = self.client.get(
            f'/api/workspaces/{self.workspace_id}/share-links?username={self.username}',
            headers=self._auth_headers(),
        )
        self.assertEqual(list_response.status_code, 200)
        payload = list_response.get_json()
        items = payload.get('items') or []
        self.assertEqual(len(items), 2)
        document_ids = {int(item.get('document_id') or 0) for item in items}
        self.assertEqual(document_ids, {first_document_id, second_document_id})
        self.assertTrue(all(item.get('recipient_email') == 'classmate@example.com' for item in items))
        titles = {item.get('document_title') for item in items}
        self.assertEqual(titles, {'First Shared Notes', 'Second Shared Notes'})

    def test_register_rejects_passwords_without_required_length_letters_and_numbers(self):
        weak_passwords = [
            ('short1', 'too short'),
            ('password', 'missing number'),
            ('1234567', 'missing letter'),
        ]

        for index, (password, reason) in enumerate(weak_passwords, start=1):
            with self.subTest(reason=reason):
                response = self.client.post(
                    '/api/auth/register',
                    json={
                        'username': f'weakuser{index}',
                        'email': f'weakuser{index}@example.com',
                        'password': password,
                        'verification_code': '123456',
                    },
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.get_json().get('error'),
                    'Password must be at least 7 characters and include both letters and numbers.',
                )

    @patch('backend.shared.create_registration_verification_code', return_value='123456')
    @patch('backend.shared.send_registration_verification_code_email', return_value=(True, ''))
    def test_register_uses_six_digit_email_code_and_signs_in(
            self,
            mock_send_code_email,
            _mock_create_code):
        send_code_response = self.client.post(
            '/api/auth/registration-code',
            json={'email': 'newuser@example.com'},
        )
        self.assertEqual(send_code_response.status_code, 200)
        send_payload = send_code_response.get_json()
        self.assertEqual(send_payload.get('message'), 'Verification code sent. It expires in 5 minutes.')
        expires_at = send_payload.get('verification_expires_at')
        self.assertTrue(str(expires_at or '').strip())
        expiry_dt = datetime.fromisoformat(expires_at)
        self.assertLessEqual(expiry_dt, datetime.utcnow() + timedelta(minutes=6))
        mock_send_code_email.assert_called_once()

        register_response = self.client.post(
            '/api/auth/register',
            json={
                'username': 'newuser',
                'email': 'newuser@example.com',
                'password': 'password123',
                'verification_code': '123456',
            },
        )
        self.assertEqual(register_response.status_code, 201)
        register_payload = register_response.get_json()
        self.assertFalse(register_payload.get('verification_required'))
        self.assertEqual(register_payload.get('message'), 'Account created. You are signed in.')
        self.assertEqual(register_payload.get('username'), 'newuser')
        self.assertTrue(str(register_payload.get('auth_token') or '').strip())
        self.assertEqual(
            register_payload.get('preferences'),
            {'email_notifications_enabled': True},
        )
        cookie_header = register_response.headers.get('Set-Cookie', '')
        self.assertIn(f'{AUTH_COOKIE_NAME}=', cookie_header)
        self.assertIn('HttpOnly', cookie_header)

        conn = self._connection()
        try:
            user_row = row_to_dict(
                conn.execute(
                    '''
                    SELECT username, email_verified, email_verification_token, email_verification_expires_at
                    FROM users
                    WHERE username = ?
                    ''',
                    ('newuser',),
                ).fetchone()
            )
        finally:
            conn.close()

        self.assertIsNotNone(user_row)
        self.assertTrue(bool(user_row.get('email_verified')))
        verification_token = str(user_row.get('email_verification_token') or '').strip()
        self.assertFalse(verification_token)
        self.assertFalse(str(user_row.get('email_verification_expires_at') or '').strip())
        conn = self._connection()
        try:
            remaining_code = conn.execute(
                'SELECT email FROM registration_email_codes WHERE email = ?',
                ('newuser@example.com',),
            ).fetchone()
        finally:
            conn.close()
        self.assertIsNone(remaining_code)

        me_after_register = self.client.get('/api/auth/me')
        self.assertEqual(me_after_register.status_code, 200)
        self.assertEqual(me_after_register.get_json().get('username'), 'newuser')

    @patch('backend.shared.create_registration_verification_code', return_value='123456')
    @patch('backend.shared.send_registration_verification_code_email', return_value=(True, ''))
    def test_register_rejects_invalid_email_verification_code(self, _mock_send_code_email, _mock_create_code):
        send_code_response = self.client.post(
            '/api/auth/registration-code',
            json={'email': 'wrongcode@example.com'},
        )
        self.assertEqual(send_code_response.status_code, 200)

        register_response = self.client.post(
            '/api/auth/register',
            json={
                'username': 'wrongcode',
                'email': 'wrongcode@example.com',
                'password': 'password123',
                'verification_code': '000000',
            },
        )
        self.assertEqual(register_response.status_code, 400)
        self.assertEqual(register_response.get_json().get('error'), 'Verification code is incorrect.')

        conn = self._connection()
        try:
            user_row = conn.execute(
                'SELECT username FROM users WHERE username = ?',
                ('wrongcode',),
            ).fetchone()
        finally:
            conn.close()
        self.assertIsNone(user_row)

    def test_register_rejects_expired_email_verification_code(self):
        conn = self._connection()
        try:
            conn.execute(
                '''
                INSERT INTO registration_email_codes (email, code_hash, expires_at, sent_at)
                VALUES (?, ?, ?, ?)
                ''',
                (
                    'expiredcode@example.com',
                    generate_password_hash('654321', method='pbkdf2:sha256'),
                    (datetime.utcnow() - timedelta(minutes=1)).isoformat(),
                    utcnow_iso(),
                ),
            )
            conn.commit()
        finally:
            conn.close()

        register_response = self.client.post(
            '/api/auth/register',
            json={
                'username': 'expiredcode',
                'email': 'expiredcode@example.com',
                'password': 'password123',
                'verification_code': '654321',
            },
        )
        self.assertEqual(register_response.status_code, 400)
        self.assertEqual(register_response.get_json().get('error'), 'Verification code expired. Send a new code.')

        conn = self._connection()
        try:
            remaining_code = conn.execute(
                'SELECT email FROM registration_email_codes WHERE email = ?',
                ('expiredcode@example.com',),
            ).fetchone()
            user_row = conn.execute(
                'SELECT username FROM users WHERE username = ?',
                ('expiredcode',),
            ).fetchone()
        finally:
            conn.close()
        self.assertIsNone(remaining_code)
        self.assertIsNone(user_row)

    def test_keyword_search_returns_ranked_results_and_facets(self):
        self._insert_document(
            'Graph Algorithms',
            'bfs dfs adjacency list shortest path',
            tags='graphs,algorithms',
            category='Computer Science',
            filename='graph-algorithms.txt',
        )
        self._insert_document(
            'Algorithms Notes',
            'graph shortest path dynamic programming',
            tags='algorithms',
            category='Computer Science',
            filename='algorithms-notes.txt',
        )
        self._insert_document(
            'History of Graph Theory',
            'Euler bridges and graph history',
            tags='history,graphs',
            category='Mathematics',
            filename='graph-history.txt',
        )

        response = self.client.get(
            '/api/documents?include_meta=1&include_facets=1&q=graph&sort=newest',
            headers=self._auth_headers(),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload['total'], 3)
        self.assertEqual(payload['items'][0]['title'], 'Graph Algorithms')
        self.assertIn('Computer Science', payload['facets']['categories'])
        self.assertIn('Mathematics', payload['facets']['categories'])
        self.assertGreaterEqual(payload['facets']['file_types'].get('txt', 0), 3)

    def test_update_document_title_changes_visible_name_and_search_index(self):
        document_id = self._insert_document(
            'Original Lecture Name.pdf',
            'renaming smoke coverage',
            filename='stored-original.pdf',
            file_type='pdf',
        )

        response = self.client.put(
            f'/api/documents/{document_id}/title',
            headers=self._auth_headers(),
            json={'title': '  Renamed Lecture 08.pdf  '},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload['title'], 'Renamed Lecture 08.pdf')
        self.assertEqual(payload['filename'], 'stored-original.pdf')

        search_response = self.client.get(
            '/api/documents',
            headers=self._auth_headers(),
            query_string={'q': 'Renamed Lecture 08', 'include_meta': '1'},
        )
        self.assertEqual(search_response.status_code, 200)
        search_payload = search_response.get_json()
        self.assertEqual(search_payload['total'], 1)
        self.assertEqual(search_payload['items'][0]['title'], 'Renamed Lecture 08.pdf')

        empty_response = self.client.put(
            f'/api/documents/{document_id}/title',
            headers=self._auth_headers(),
            json={'title': '   '},
        )
        self.assertEqual(empty_response.status_code, 400)

    def test_rich_text_sanitizer_strips_script_javascript_and_unsafe_attributes(self):
        sanitized = sanitize_editor_html(
            '<p style="color: #123456; position:absolute">Safe <strong>bold</strong></p>'
            '<script>alert(1)</script>'
            '<img src=x onerror=alert(1)>'
            '<a href="javascript:alert(1)" onclick="alert(2)">bad link</a>'
            '<span style="background-image:url(javascript:alert(3)); font-weight: 700">text</span>'
        )

        lowered = sanitized.lower()
        self.assertIn('<strong>bold</strong>', lowered)
        self.assertIn('color:', lowered)
        self.assertIn('font-weight:', lowered)
        self.assertNotIn('<script', lowered)
        self.assertNotIn('onerror', lowered)
        self.assertNotIn('onclick', lowered)
        self.assertNotIn('javascript:', lowered)
        self.assertNotIn('position:', lowered)
        self.assertNotIn('background-image', lowered)

    def test_pdf_conversion_draft_can_replace_or_copy_document(self):
        filename = 'convert-source.pdf'
        self._save_pdf_upload_file(filename, 'First line for conversion', 'Second line for conversion')
        document_id = self._insert_document(
            'Convert Source.pdf',
            'First line for conversion\nSecond line for conversion',
            filename=filename,
            file_type='pdf',
        )

        draft_response = self.client.post(
            f'/api/documents/{document_id}/convert-to-editable',
            headers=self._auth_headers(),
            json={'mode': 'layout'},
        )
        self.assertEqual(draft_response.status_code, 200)
        draft_payload = draft_response.get_json()
        self.assertEqual(draft_payload['document_id'], document_id)
        self.assertIn('First line for conversion', draft_payload['content'])
        self.assertIn('content_html', draft_payload)
        self.assertIn('copy', draft_payload['available_save_modes'])

        copy_response = self.client.put(
            f'/api/documents/{document_id}/converted-file',
            headers=self._auth_headers(),
            json={
                'output_format': 'docx',
                'save_mode': 'copy',
                'title': 'Converted Copy.docx',
                'content_html': '<h1>Converted Copy</h1><p>Edited copy body</p>',
            },
        )
        self.assertEqual(copy_response.status_code, 201)
        copy_payload = copy_response.get_json()
        copy_doc = copy_payload['document']
        self.assertNotEqual(copy_doc['id'], document_id)
        self.assertEqual(copy_doc['title'], 'Converted Copy.docx')
        self.assertEqual(copy_doc['file_type'], 'docx')
        self.assertEqual(copy_payload['source_document_id'], document_id)

        pdf_copy_response = self.client.put(
            f'/api/documents/{document_id}/converted-file',
            headers=self._auth_headers(),
            json={
                'output_format': 'pdf',
                'save_mode': 'copy',
                'title': 'Converted Copy.pdf',
                'content_html': '<h1>Converted PDF Copy</h1><p>Edited PDF copy body</p>',
            },
        )
        self.assertEqual(pdf_copy_response.status_code, 201)
        pdf_copy_payload = pdf_copy_response.get_json()
        pdf_copy_doc = pdf_copy_payload['document']
        self.assertNotEqual(pdf_copy_doc['id'], document_id)
        self.assertEqual(pdf_copy_doc['title'], 'Converted Copy.pdf')
        self.assertEqual(pdf_copy_doc['file_type'], 'pdf')
        pdf_copy_path = os.path.join('uploads', pdf_copy_doc['filename'])
        self.assertTrue(os.path.exists(pdf_copy_path))
        with open(pdf_copy_path, 'rb') as f:
            pdf_copy_bytes = f.read()
        self.assertIn('Edited PDF copy body', extract_text_from_pdf_bytes(pdf_copy_bytes, allow_ocr=False))
        self.assertNotIn(b'STSong', pdf_copy_bytes)

        replace_response = self.client.put(
            f'/api/documents/{document_id}/converted-file',
            headers=self._auth_headers(),
            json={
                'output_format': 'pdf',
                'save_mode': 'replace',
                'title': 'Converted Replacement.pdf',
                'content_html': '<h1>Converted Replacement</h1><p>Edited replacement body</p>',
            },
        )
        self.assertEqual(replace_response.status_code, 200)
        replace_payload = replace_response.get_json()
        replaced_doc = replace_payload['document']
        self.assertEqual(replaced_doc['id'], document_id)
        self.assertEqual(replaced_doc['title'], 'Converted Replacement.pdf')
        self.assertEqual(replaced_doc['file_type'], 'pdf')
        self.assertIn('Edited replacement body', replaced_doc['content'])
        replace_path = os.path.join('uploads', replaced_doc['filename'])
        self.assertTrue(os.path.exists(replace_path))
        with open(replace_path, 'rb') as f:
            replacement_pdf_bytes = f.read()
        self.assertIn('Edited replacement body', extract_text_from_pdf_bytes(replacement_pdf_bytes, allow_ocr=False))
        self.assertNotIn(b'STSong', replacement_pdf_bytes)
        self.assertFalse(os.path.exists(os.path.join('uploads', filename)))

    def test_share_link_public_access_returns_document_payload(self):
        document_id = self._insert_document(
            'Shared Revision Sheet',
            'public share smoke content',
            workspace_id='',
            filename='shared-revision-sheet.txt',
        )
        share_token = self._insert_share_link(document_id)

        response = self.client.get(f'/api/share-links/{share_token}')
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload['id'], document_id)
        self.assertEqual(payload['title'], 'Shared Revision Sheet')
        self.assertEqual(payload['share']['token'], share_token)

    def test_public_share_link_does_not_expose_or_mutate_other_private_documents(self):
        shared_id = self._insert_document(
            'Shared Public Note',
            'shared public note content',
            workspace_id='',
            filename='shared-public-note.txt',
        )
        private_id = self._insert_document(
            'Other Private Note',
            'other private note content',
            workspace_id='',
            filename='other-private-note.txt',
        )
        share_token = self._insert_share_link(shared_id)

        other_response = self.client.get(f'/api/documents/{private_id}?share_token={share_token}')
        self.assertEqual(other_response.status_code, 403)

        mutate_response = self.client.put(
            f'/api/documents/{shared_id}/title',
            json={'title': 'Mutation via share token'},
        )
        self.assertEqual(mutate_response.status_code, 401)

    def test_wrong_user_cannot_access_mutate_download_summarize_or_ocr_private_document(self):
        self._insert_user('bob', 'bob@example.com')
        document_id = self._insert_document(
            'Alice Private Note',
            'alice private access control content',
            workspace_id='',
            filename='alice-private-note.txt',
        )
        os.makedirs('uploads', exist_ok=True)
        with open(os.path.join('uploads', 'alice-private-note.txt'), 'wb') as handle:
            handle.write(b'alice private access control content')
        bob_headers = self._auth_headers('bob')

        self.assertEqual(self.client.get(f'/api/documents/{document_id}', headers=bob_headers).status_code, 403)
        self.assertEqual(
            self.client.put(
                f'/api/documents/{document_id}/title',
                headers=bob_headers,
                json={'title': 'Stolen title'},
            ).status_code,
            403,
        )
        self.assertEqual(self.client.delete(f'/api/documents/{document_id}', headers=bob_headers).status_code, 403)
        file_response = self.client.get(f'/api/documents/{document_id}/file', headers=bob_headers)
        self.assertEqual(file_response.status_code, 403)
        file_response.close()
        self.assertEqual(
            self.client.post(
                f'/api/documents/{document_id}/summarize',
                headers=bob_headers,
                json={},
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                f'/api/extract-text/{document_id}',
                headers=bob_headers,
                data=b'not an image',
                content_type='application/octet-stream',
            ).status_code,
            403,
        )

    def test_share_token_cannot_trigger_ai_or_ocr_work(self):
        document_id = self._insert_document(
            'Read Only Shared Note',
            'public share should allow reading but not AI processing',
            filename='readonly-share.txt',
        )
        share_token = self._insert_share_link(document_id, token='readonly-share-token')

        read_response = self.client.get(f'/api/documents/{document_id}?share_token={share_token}')
        self.assertEqual(read_response.status_code, 200)

        summarize_response = self.client.post(
            '/api/analyze-text',
            json={'doc_id': document_id, 'share_token': share_token},
        )
        self.assertEqual(summarize_response.status_code, 401)

        ocr_response = self.client.post(
            f'/api/extract-text/{document_id}',
            data={'share_token': share_token},
        )
        self.assertEqual(ocr_response.status_code, 401)

    def test_legacy_uploads_route_rejects_anonymous_document_file_access(self):
        filename = 'legacy-private-route.txt'
        self._insert_document(
            'Legacy Private Route',
            'private route smoke content',
            workspace_id='',
            filename=filename,
        )
        os.makedirs('uploads', exist_ok=True)
        with open(os.path.join('uploads', filename), 'wb') as handle:
            handle.write(b'private route smoke content')

        anonymous_response = self.client.get(f'/uploads/{filename}')
        self.assertEqual(anonymous_response.status_code, 401)
        anonymous_response.close()

        authenticated_response = self.client.get(
            f'/uploads/{filename}',
            headers=self._auth_headers(),
        )
        self.assertEqual(authenticated_response.status_code, 200)
        self.assertEqual(authenticated_response.get_data(), b'private route smoke content')
        authenticated_response.close()

        cookie_client = self.app.test_client()
        cookie_client.set_cookie(AUTH_COOKIE_NAME, create_auth_token(self.username))
        cookie_response = cookie_client.get(f'/uploads/{filename}')
        self.assertEqual(cookie_response.status_code, 200)
        self.assertEqual(cookie_response.get_data(), b'private route smoke content')
        cookie_response.close()

    def test_document_file_query_token_requires_valid_token_and_uses_no_store_headers(self):
        document_id = self._insert_document(
            'Preview Token Note',
            'preview token content',
            workspace_id='',
            filename='preview-token-note.txt',
        )
        os.makedirs('uploads', exist_ok=True)
        with open(os.path.join('uploads', 'preview-token-note.txt'), 'wb') as handle:
            handle.write(b'preview token content')

        missing_response = self.client.get(f'/api/documents/{document_id}/file')
        self.assertEqual(missing_response.status_code, 401)
        missing_response.close()

        invalid_response = self.client.get(f'/api/documents/{document_id}/file?auth_token=bad-token')
        self.assertEqual(invalid_response.status_code, 401)
        invalid_response.close()

        with patch('backend.security.AUTH_TOKEN_TTL_SECONDS', -1):
            expired_response = self.client.get(
                f'/api/documents/{document_id}/file?auth_token={create_auth_token(self.username)}'
            )
        self.assertEqual(expired_response.status_code, 401)
        expired_response.close()

        valid_response = self.client.get(
            f'/api/documents/{document_id}/file?auth_token={create_auth_token(self.username)}'
        )
        self.assertEqual(valid_response.status_code, 200)
        self.assertEqual(valid_response.headers.get('Cache-Control'), 'no-store, private, max-age=0')
        self.assertEqual(valid_response.headers.get('Referrer-Policy'), 'no-referrer')
        self.assertEqual(valid_response.headers.get('X-Robots-Tag'), 'noindex, nofollow')
        valid_response.close()

    def test_frontend_file_preview_urls_do_not_embed_auth_token(self):
        for relative_path in ('src/pages/Home.jsx', 'src/pages/DocumentDetail.jsx'):
            with open(os.path.join(self.original_cwd, relative_path), encoding='utf-8') as handle:
                source = handle.read()
            self.assertNotIn("params.set('auth_token'", source)
            self.assertNotIn("previewFileParams.set('auth_token'", source)

    def test_frontend_auth_session_does_not_store_raw_bearer_token(self):
        with open(os.path.join(self.original_cwd, 'src/lib/authSession.js'), encoding='utf-8') as handle:
            source = handle.read()
        self.assertNotIn("sessionStorage.setItem('auth_token', safeToken)", source)
        self.assertNotIn("sessionStorage.setItem('auth_token'", source)
        self.assertNotIn("sessionStorage.getItem('auth_token'", source)
        self.assertIn('authToken: COOKIE_AUTH_TOKEN', source)

    def test_expired_and_revoked_share_links_are_rejected(self):
        expired_doc_id = self._insert_document(
            'Expired Shared Note',
            'expired share smoke content',
            workspace_id='',
            filename='expired-shared-note.txt',
        )
        revoked_doc_id = self._insert_document(
            'Revoked Shared Note',
            'revoked share smoke content',
            workspace_id='',
            filename='revoked-shared-note.txt',
        )
        expired_token = self._insert_share_link(
            expired_doc_id,
            token='expired-share-token',
            status='active',
            expires_at=(datetime.utcnow() - timedelta(days=1)).isoformat(),
        )
        revoked_token = self._insert_share_link(
            revoked_doc_id,
            token='revoked-share-token',
            status='revoked',
        )

        expired_response = self.client.get(f'/api/share-links/{expired_token}')
        self.assertEqual(expired_response.status_code, 403)
        self.assertIn('expired', str(expired_response.get_json().get('error', '')).lower())

        revoked_response = self.client.get(f'/api/share-links/{revoked_token}')
        self.assertEqual(revoked_response.status_code, 403)
        self.assertIn('no longer active', str(revoked_response.get_json().get('error', '')).lower())

        conn = self._connection()
        try:
            row = row_to_dict(
                conn.execute(
                    'SELECT status FROM document_share_links WHERE token = ? LIMIT 1',
                    (expired_token,),
                ).fetchone()
            ) or {}
            self.assertEqual(str(row.get('status') or '').strip().lower(), 'expired')
        finally:
            conn.close()

    def test_upload_requires_auth(self):
        response = self.client.post(
            '/api/documents/upload',
            data={
                'file': (io.BytesIO(b'unauthenticated upload attempt'), 'unauth-upload.txt'),
                'category': 'Computer Science',
                'workspace_id': self.workspace_id,
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 401)
        self.assertIn('auth token', str(response.get_json().get('error', '')).lower())

    def test_upload_rejects_unsupported_extension(self):
        response = self.client.post(
            '/api/documents/upload',
            headers=self._auth_headers(),
            data={
                'file': (io.BytesIO(b'not allowed'), 'malware.exe'),
                'workspace_id': self.workspace_id,
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('File type not allowed', response.get_json().get('error', ''))

    def test_upload_rejects_renamed_invalid_pdf(self):
        response = self.client.post(
            '/api/documents/upload',
            headers=self._auth_headers(),
            data={
                'file': (io.BytesIO(b'this is not a pdf'), 'renamed.pdf'),
                'workspace_id': self.workspace_id,
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('does not match', response.get_json().get('error', ''))

    def test_upload_rejects_extension_content_mismatch(self):
        response = self.client.post(
            '/api/documents/upload',
            headers=self._auth_headers(),
            data={
                'file': (self._build_pdf_upload('pdf bytes with wrong image extension'), 'wrong.png'),
                'workspace_id': self.workspace_id,
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('does not match', response.get_json().get('error', ''))

    def test_upload_rejects_invalid_docx_structure(self):
        fake_docx = io.BytesIO()
        import zipfile
        with zipfile.ZipFile(fake_docx, 'w') as archive:
            archive.writestr('not-word/document.txt', 'renamed zip')
        fake_docx.seek(0)

        response = self.client.post(
            '/api/documents/upload',
            headers=self._auth_headers(),
            data={
                'file': (fake_docx, 'fake.docx'),
                'workspace_id': self.workspace_id,
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('Office document', response.get_json().get('error', ''))

    def test_upload_rejects_docx_zip_with_too_many_entries(self):
        fake_docx = io.BytesIO()
        import zipfile
        with zipfile.ZipFile(fake_docx, 'w') as archive:
            archive.writestr('[Content_Types].xml', '<Types></Types>')
            archive.writestr('word/document.xml', '<w:document></w:document>')
            for index in range(1001):
                archive.writestr(f'word/extra-{index}.xml', '')
        fake_docx.seek(0)

        response = self.client.post(
            '/api/documents/upload',
            headers=self._auth_headers(),
            data={
                'file': (fake_docx, 'too-complex.docx'),
                'workspace_id': self.workspace_id,
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('too complex', response.get_json().get('error', ''))

    def test_upload_rejects_oversized_image_dimensions(self):
        response = self.client.post(
            '/api/documents/upload',
            headers=self._auth_headers(),
            data={
                'file': (self._build_png_header(100000, 100000), 'huge.png'),
                'workspace_id': self.workspace_id,
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('too large', response.get_json().get('error', ''))

    def test_upload_valid_png_file_creates_document(self):
        upload_response = self.client.post(
            '/api/documents/upload',
            data={
                'file': (self._build_valid_png_upload(), 'upload-image-smoke.png'),
                'category': 'Computer Science',
                'workspace_id': self.workspace_id,
            },
            headers=self._auth_headers(),
            content_type='multipart/form-data',
        )
        self.assertEqual(upload_response.status_code, 201)
        upload_payload = upload_response.get_json()
        document_id = parse_int(upload_payload.get('document_id'), 0, 0)
        self.assertGreater(document_id, 0)

        detail_response = self.client.get(f'/api/documents/{document_id}', headers=self._auth_headers())
        self.assertEqual(detail_response.status_code, 200)
        detail_payload = detail_response.get_json()
        self.assertEqual(detail_payload.get('title'), 'upload-image-smoke.png')
        self.assertEqual(str(detail_payload.get('file_type')).lower(), 'png')

    def test_upload_text_file_creates_document_visible_in_listing(self):
        upload_response = self.client.post(
            '/api/documents/upload',
            data={
                'file': (io.BytesIO(b'uploadsmoke keyword content for search'), 'upload-smoke.txt'),
                'category': 'Computer Science',
                'workspace_id': self.workspace_id,
            },
            headers=self._auth_headers(),
            content_type='multipart/form-data',
        )
        self.assertEqual(upload_response.status_code, 201)

        response = self.client.get(
            '/api/documents?include_meta=1&q=uploadsmoke',
            headers=self._auth_headers(),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload['total'], 1)
        self.assertEqual(payload['items'][0]['title'], 'upload-smoke.txt')

    def test_upload_docx_file_creates_searchable_document(self):
        upload_response = self.client.post(
            '/api/documents/upload',
            data={
                'file': (
                    self._build_docx_upload(
                        'docxsmoke summary coverage',
                        'This DOCX fixture proves parsing stays wired for smoke tests.',
                    ),
                    'upload-docx-smoke.docx',
                ),
                'category': 'Computer Science',
                'workspace_id': self.workspace_id,
            },
            headers=self._auth_headers(),
            content_type='multipart/form-data',
        )
        self.assertEqual(upload_response.status_code, 201)

        response = self.client.get(
            '/api/documents?include_meta=1&q=docxsmoke',
            headers=self._auth_headers(),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload['total'], 1)
        self.assertEqual(payload['items'][0]['title'], 'upload-docx-smoke.docx')
        self.assertEqual(str(payload['items'][0]['file_type']).lower(), 'docx')

    def test_upload_pdf_file_is_searchable_or_visible_with_pdf_file_type(self):
        upload_response = self.client.post(
            '/api/documents/upload',
            data={
                'file': (
                    self._build_pdf_upload(
                        'pdfsmoke searchable coverage',
                        'This generated PDF fixture keeps PDF upload smoke coverage lightweight.',
                    ),
                    'upload-pdf-smoke.pdf',
                ),
                'category': 'Computer Science',
                'workspace_id': self.workspace_id,
                'client_pdf_text_status': 'text_pending',
                'client_pdf_text_deferred': '1',
            },
            headers=self._auth_headers(),
            content_type='multipart/form-data',
        )
        self.assertEqual(upload_response.status_code, 201)
        upload_payload = upload_response.get_json()
        self.assertEqual(upload_payload.get('processing_status'), 'text_pending')
        document_id = parse_int(upload_payload.get('document_id'), 0, 0)
        self.assertGreater(document_id, 0)

        pending_summary_response = self.client.post(
            '/api/analyze-text',
            headers=self._auth_headers(),
            json={'doc_id': document_id},
        )
        self.assertEqual(pending_summary_response.status_code, 409)
        pending_summary_payload = pending_summary_response.get_json()
        self.assertEqual(pending_summary_payload.get('processing_status'), 'text_pending')

        finalize_response = self.client.post(
            f'/api/documents/{document_id}/pdf-text',
            headers=self._auth_headers(),
            json={
                'status': 'processed',
                'text': (
                    'pdfsmoke searchable coverage. '
                    'This generated PDF fixture keeps PDF upload smoke coverage lightweight.'
                ),
            },
        )
        self.assertEqual(finalize_response.status_code, 200)
        finalize_payload = finalize_response.get_json()
        self.assertEqual(finalize_payload.get('processing_status'), 'processed')

        doc_response = self.client.get(
            f'/api/documents/{document_id}',
            headers=self._auth_headers(),
        )
        self.assertEqual(doc_response.status_code, 200)
        doc_payload = doc_response.get_json()
        self.assertIn('pdfsmoke searchable coverage', doc_payload.get('content') or '')
        self.assertEqual(doc_payload.get('processing_status'), 'processed')

        search_response = self.client.get(
            '/api/documents?include_meta=1&q=pdfsmoke',
            headers=self._auth_headers(),
        )
        self.assertEqual(search_response.status_code, 200)
        search_payload = search_response.get_json()
        self.assertEqual(search_payload['total'], 1)
        self.assertEqual(search_payload['items'][0]['title'], 'upload-pdf-smoke.pdf')
        self.assertEqual(str(search_payload['items'][0]['file_type']).lower(), 'pdf')
        self.assertEqual(search_payload['items'][0].get('processing_status'), 'processed')

        summary_response = self.client.post(
            '/api/analyze-text',
            headers=self._auth_headers(),
            json={'doc_id': document_id},
        )
        self.assertEqual(summary_response.status_code, 200)
        summary_payload = summary_response.get_json()
        self.assertEqual(summary_payload.get('text_source'), 'document_content')
        self.assertIn('summary', summary_payload)

    def test_hybrid_summary_short_text_uses_textrank_only(self):
        bundle = build_summary_bundle(
            'Graph traversal compares breadth first search. '
            'Depth first search explores paths before siblings.'
        )
        self.assertEqual(bundle.get('summary_source'), 'textrank_only')
        self.assertFalse(bundle.get('used_fallback'))
        self.assertIn('Graph traversal', bundle.get('summary_text'))
        self.assertGreaterEqual(len(bundle.get('key_sentences') or []), 1)

    def test_hybrid_summary_long_text_chunking(self):
        chunks = split_summary_chunks(' '.join(f'word{i}' for i in range(1500)), 650, 80)
        self.assertEqual(len(chunks), 3)
        self.assertGreater(len(chunks[0].split()), len(chunks[-1].split()))

    def test_modal_summary_service_fails_closed_without_token_in_production(self):
        if importlib.util.find_spec('fastapi') is None:
            self.skipTest('FastAPI is only installed for the standalone Modal summary service')
        from fastapi import HTTPException
        from summary_service import app as modal_summary_app

        with patch.dict(os.environ, {
            'APP_ENV': 'production',
            'FLASK_ENV': 'production',
            'ENV': 'production',
            'SUMMARY_SERVICE_AUTH_TOKEN': '',
            'ALLOW_UNAUTHENTICATED_SUMMARY_SERVICE': '0',
        }):
            with self.assertRaises(HTTPException) as raised:
                modal_summary_app._auth_dependency()
        self.assertEqual(raised.exception.status_code, 503)

    def test_modal_summary_service_requires_bearer_token_when_configured(self):
        if importlib.util.find_spec('fastapi') is None:
            self.skipTest('FastAPI is only installed for the standalone Modal summary service')
        from fastapi import HTTPException
        from summary_service import app as modal_summary_app

        with patch.dict(os.environ, {
            'APP_ENV': 'development',
            'SUMMARY_SERVICE_AUTH_TOKEN': 'summary-secret',
            'ALLOW_UNAUTHENTICATED_SUMMARY_SERVICE': '0',
        }):
            with self.assertRaises(HTTPException) as raised:
                modal_summary_app._auth_dependency()
            self.assertEqual(raised.exception.status_code, 401)
            modal_summary_app._auth_dependency('Bearer summary-secret')

    def test_modal_summary_health_does_not_load_model(self):
        if importlib.util.find_spec('fastapi') is None:
            self.skipTest('FastAPI is only installed for the standalone Modal summary service')
        from fastapi.testclient import TestClient
        from summary_service import app as modal_summary_app

        with patch.object(modal_summary_app, '_load_model_once') as load_model:
            response = TestClient(modal_summary_app.create_app()).get('/health')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'ok': True, 'service': 'studyhub-summary'})
        load_model.assert_not_called()

    def test_modal_summary_ready_loads_cached_model(self):
        if importlib.util.find_spec('fastapi') is None:
            self.skipTest('FastAPI is only installed for the standalone Modal summary service')
        from fastapi.testclient import TestClient
        from summary_service import app as modal_summary_app

        with patch.object(modal_summary_app, '_load_model_once') as load_model:
            response = TestClient(modal_summary_app.create_app()).get('/ready')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'ok': True, 'model_loaded': True})
        load_model.assert_called_once()

    def test_modal_summary_returns_json_when_model_path_missing(self):
        if importlib.util.find_spec('fastapi') is None:
            self.skipTest('FastAPI is only installed for the standalone Modal summary service')
        from fastapi.testclient import TestClient
        from summary_service import app as modal_summary_app

        with patch.dict(os.environ, {
            'APP_ENV': 'development',
            'SUMMARY_SERVICE_AUTH_TOKEN': 'summary-secret',
            'ALLOW_UNAUTHENTICATED_SUMMARY_SERVICE': '0',
        }):
            with patch.object(
                modal_summary_app,
                '_load_model_once',
                side_effect=modal_summary_app.SummaryModelPathMissingError('summary model path not found'),
            ):
                response = TestClient(modal_summary_app.create_app()).post(
                    '/summarize',
                    headers={'Authorization': 'Bearer summary-secret'},
                    json={
                        'text': 'Short lecture note content about graph traversal and revision planning.',
                        'summary_length': 'short',
                    },
                )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {'error': 'summary model path not found'})

    def test_modal_ocr_service_fails_closed_without_token_in_production(self):
        if importlib.util.find_spec('fastapi') is None:
            self.skipTest('FastAPI is only installed for the standalone Modal OCR service')
        from fastapi.testclient import TestClient
        from ocr_service import app as modal_ocr_app

        with patch.dict(os.environ, {
            'APP_ENV': 'production',
            'FLASK_ENV': 'production',
            'ENV': 'production',
            'OCR_SERVICE_AUTH_TOKEN': '',
            'ALLOW_UNAUTHENTICATED_OCR_SERVICE': '0',
        }):
            response = TestClient(modal_ocr_app.app).post('/ocr', content=b'not an image')
        self.assertEqual(response.status_code, 503)

    def test_modal_ocr_service_requires_bearer_token_when_configured(self):
        if importlib.util.find_spec('fastapi') is None:
            self.skipTest('FastAPI is only installed for the standalone Modal OCR service')
        from fastapi.testclient import TestClient
        from ocr_service import app as modal_ocr_app

        with patch.dict(os.environ, {
            'APP_ENV': 'development',
            'OCR_SERVICE_AUTH_TOKEN': 'ocr-secret',
            'ALLOW_UNAUTHENTICATED_OCR_SERVICE': '0',
        }):
            client = TestClient(modal_ocr_app.app)
            missing = client.post('/ocr', content=b'not an image')
            invalid = client.post('/ocr', content=b'not an image', headers={'Authorization': 'Bearer wrong'})
        self.assertEqual(missing.status_code, 401)
        self.assertEqual(invalid.status_code, 401)

    def test_modal_summary_service_reports_truncated_long_input_metadata(self):
        if importlib.util.find_spec('fastapi') is None:
            self.skipTest('FastAPI is only installed for the standalone Modal summary service')
        from summary_service import app as modal_summary_app

        content = ' '.join(f'word{i}' for i in range(1000))
        with patch.dict(os.environ, {
            'SUMMARY_CHUNK_WORDS': '100',
            'SUMMARY_CHUNK_OVERLAP': '10',
            'SUMMARY_MAX_CHUNKS': '2',
        }):
            with patch.object(modal_summary_app, '_generate_one', return_value='Generated revision summary.'):
                result = modal_summary_app._summarize_sync(content, 'short')

        self.assertEqual(result.get('chunk_count'), 2)
        self.assertEqual(result.get('input_word_count'), 1000)
        self.assertEqual(result.get('processed_word_count'), 190)
        self.assertTrue(result.get('truncated'))

    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_summary_length_preset_mapping_controls_generation_targets(self, mock_post):
        mock_post.return_value = self._fake_http_response(200, [{'summary_text': 'AI preset summary.'}])
        content = ' '.join([
            'Graph traversal compares breadth first search and depth first search in lecture examples.'
            ' Priority queues, stacks, and recursion shape the algorithmic tradeoffs.'
        ] * 12)

        short_bundle = build_summary_bundle(content, summary_length='short')
        short_payload = mock_post.call_args.kwargs.get('json') or {}
        mock_post.reset_mock()

        long_bundle = build_summary_bundle(content, summary_length='long')
        long_payload = mock_post.call_args.kwargs.get('json') or {}

        self.assertEqual(get_summary_length_targets('short')['target_max_words'], 90)
        self.assertEqual(get_summary_length_targets('short')['textrank_sentence_count'], 3)
        self.assertEqual(get_summary_length_targets('medium')['target_max_words'], 140)
        self.assertEqual(get_summary_length_targets('medium')['textrank_sentence_count'], 5)
        self.assertEqual(get_summary_length_targets('long')['target_max_words'], 220)
        self.assertEqual(get_summary_length_targets('long')['textrank_sentence_count'], 7)
        self.assertEqual(short_bundle.get('target_max_words'), 90)
        self.assertEqual(short_bundle.get('textrank_sentence_count'), 3)
        self.assertEqual(long_bundle.get('target_max_words'), 220)
        self.assertEqual(long_bundle.get('textrank_sentence_count'), 7)
        self.assertGreater(
            long_payload.get('parameters', {}).get('max_new_tokens', 0),
            short_payload.get('parameters', {}).get('max_new_tokens', 0),
        )

    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_document_summarize_endpoint_uses_hf_and_caches_bundle(self, mock_post):
        mock_post.return_value = self._fake_http_response(200, [{'summary_text': 'AI summary of graph traversal notes.'}])
        content = ' '.join(
            ['Graph traversal lecture notes compare breadth first search and depth first search.'] * 18
        )
        document_id = self._insert_document('Graph Notes', content)

        response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload.get('summary_source'), 'bart_hf')
        self.assertEqual(payload.get('ai_summary'), 'AI summary of graph traversal notes.')
        self.assertFalse(payload.get('used_fallback'))
        self.assertTrue(payload.get('summary_input_hash'))
        self.assertTrue(payload.get('summary_cache_key'))

        doc_response = self.client.get(
            f'/api/documents/{document_id}',
            headers=self._auth_headers(),
        )
        self.assertEqual(doc_response.status_code, 200)
        cached_summary = doc_response.get_json().get('cached_summary') or {}
        self.assertEqual(cached_summary.get('summary_source'), 'bart_hf')
        self.assertEqual(cached_summary.get('summary_text'), 'AI summary of graph traversal notes.')

        cached_response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={},
        )
        self.assertEqual(cached_response.status_code, 200)
        self.assertTrue(cached_response.get_json().get('cache_hit'))
        self.assertEqual(mock_post.call_count, 1)

    @patch('backend.summary_service.EXTERNAL_SUMMARY_AUTH_TOKEN', 'summary-token')
    @patch('backend.summary_service.EXTERNAL_SUMMARY_SERVICE_URL', 'https://summary.example.test/summarize')
    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_external_summary_success_uses_modal_and_skips_bart(self, mock_post):
        mock_post.return_value = self._fake_http_response(
            200,
            {
                'summary': 'Custom FLAN-T5 summary for graph traversal notes.',
                'summary_source': 'custom_flan_t5_large',
                'summary_model': 'google/flan-t5-large+lora',
                'summary_length': 'long',
                'chunk_count': 2,
                'input_word_count': 300,
                'processed_word_count': 300,
                'truncated': False,
            },
        )
        content = ' '.join(
            ['Graph traversal notes compare queues, stacks, complexity, and revision examples.'] * 18
        )
        document_id = self._insert_document('External Summary Notes', content)

        response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={'summary_length': 'long'},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload.get('summary_source'), 'custom_flan_t5_large')
        self.assertEqual(payload.get('summary_model'), 'google/flan-t5-large+lora')
        self.assertEqual(payload.get('summary_length'), 'long')
        self.assertEqual(payload.get('ai_summary'), 'Custom FLAN-T5 summary for graph traversal notes.')
        self.assertFalse(payload.get('used_fallback'))
        self.assertIn('summary', payload)
        self.assertIn('summary_text', payload)
        self.assertIsInstance(payload.get('keywords'), list)
        self.assertIsInstance(payload.get('key_sentences'), list)
        self.assertGreaterEqual(len(payload.get('key_sentences') or []), 1)
        self.assertTrue(payload.get('summary_input_hash'))
        self.assertTrue(payload.get('summary_cache_key'))
        self.assertFalse(payload.get('cache_hit'))
        self.assertEqual(payload.get('options_used', {}).get('summary_length'), 'long')
        self.assertEqual(payload.get('options_used', {}).get('chunk_count'), 2)
        self.assertEqual(payload.get('options_used', {}).get('input_word_count'), 300)
        self.assertEqual(payload.get('options_used', {}).get('processed_word_count'), 300)
        self.assertFalse(payload.get('options_used', {}).get('truncated'))
        self.assertEqual(mock_post.call_count, 1)
        external_call = mock_post.call_args
        self.assertEqual(external_call.args[0], 'https://summary.example.test/summarize')
        self.assertEqual(external_call.kwargs.get('json', {}).get('summary_length'), 'long')
        self.assertEqual(
            external_call.kwargs.get('headers', {}).get('Authorization'),
            'Bearer summary-token',
        )

    @patch('backend.summary_service.EXTERNAL_SUMMARY_SERVICE_URL', 'https://summary.example.test/summarize')
    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_external_summary_failure_falls_back_to_bart(self, mock_post):
        mock_post.side_effect = [
            self._fake_http_response(500, {'error': 'modal down'}),
            self._fake_http_response(200, [{'summary_text': 'BART fallback summary.'}]),
        ]
        content = ' '.join(
            ['Fallback lectures explain how the service should continue when Modal is unavailable.'] * 18
        )
        document_id = self._insert_document('External Failure Notes', content)

        response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload.get('summary_source'), 'bart_hf')
        self.assertEqual(payload.get('ai_summary'), 'BART fallback summary.')
        self.assertFalse(payload.get('used_fallback'))
        self.assertEqual(mock_post.call_count, 2)
        self.assertEqual(mock_post.call_args_list[0].args[0], 'https://summary.example.test/summarize')
        self.assertIn('facebook/bart-large-cnn', mock_post.call_args_list[1].args[0])
        conn = self._connection()
        try:
            cache_count = conn.execute(
                'SELECT COUNT(*) AS count FROM document_summary_cache WHERE document_id = ?',
                (document_id,),
            ).fetchone()['count']
            doc_row = row_to_dict(conn.execute(
                'SELECT summary_text, summary_cache_key FROM documents WHERE id = ?',
                (document_id,),
            ).fetchone())
        finally:
            conn.close()
        self.assertEqual(cache_count, 0)
        self.assertFalse(str(doc_row.get('summary_text') or '').strip())
        self.assertFalse(str(doc_row.get('summary_cache_key') or '').strip())

        mock_post.reset_mock()
        mock_post.side_effect = None
        mock_post.return_value = self._fake_http_response(
            200,
            {
                'summary': 'Recovered custom FLAN-T5 summary.',
                'summary_source': 'custom_flan_t5_large',
                'summary_model': 'google/flan-t5-large+lora',
                'summary_length': 'medium',
                'chunk_count': 1,
            },
        )
        recovered_response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={},
        )
        self.assertEqual(recovered_response.status_code, 200)
        self.assertEqual(recovered_response.get_json().get('summary_source'), 'custom_flan_t5_large')
        self.assertEqual(recovered_response.get_json().get('ai_summary'), 'Recovered custom FLAN-T5 summary.')
        self.assertEqual(mock_post.call_count, 1)

    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_no_external_summary_config_keeps_existing_bart_flow(self, mock_post):
        mock_post.return_value = self._fake_http_response(200, [{'summary_text': 'Configured BART summary.'}])
        content = ' '.join(
            ['No external summary configuration should preserve the existing Hugging Face flow.'] * 18
        )
        document_id = self._insert_document('No External Summary Notes', content)

        response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload.get('summary_source'), 'bart_hf')
        self.assertEqual(payload.get('ai_summary'), 'Configured BART summary.')
        self.assertEqual(mock_post.call_count, 1)
        self.assertIn('facebook/bart-large-cnn', mock_post.call_args.args[0])

    def test_summary_cache_key_separates_lengths_and_external_model(self):
        content = ' '.join(
            ['Cache keys must separate length presets and the active summary model identity.'] * 18
        )
        short_key = build_document_summary_cache_key(content, 'short', 5)
        medium_bart_key = build_document_summary_cache_key(content, 'medium', 5)
        long_key = build_document_summary_cache_key(content, 'long', 5)

        with patch('backend.summary_service.EXTERNAL_SUMMARY_SERVICE_URL', 'https://summary.example.test/summarize'):
            medium_external_key = build_document_summary_cache_key(content, 'medium', 5)

        self.assertNotEqual(short_key, medium_bart_key)
        self.assertNotEqual(medium_bart_key, long_key)
        self.assertNotEqual(medium_bart_key, medium_external_key)

    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_summary_lock_is_released_after_post_generation_exception(self, mock_post):
        mock_post.side_effect = [
            self._fake_http_response(200, [{'summary_text': 'First generated summary.'}]),
            self._fake_http_response(200, [{'summary_text': 'Second generated summary.'}]),
        ]
        content = ' '.join(
            ['Lock release notes describe robust cleanup after summary generation succeeds.'] * 18
        )
        document_id = self._insert_document('Lock Release Notes', content)

        with patch('backend.shared.save_document_summary_cache', side_effect=RuntimeError('cache write boom')):
            with patch.object(self.app.logger, 'error'):
                failed_response = self.client.post(
                    f'/api/documents/{document_id}/summarize',
                    headers=self._auth_headers(),
                    json={},
                )

        self.assertEqual(failed_response.status_code, 500)

        retry_response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={},
        )

        self.assertEqual(retry_response.status_code, 200)
        self.assertEqual(retry_response.get_json().get('ai_summary'), 'Second generated summary.')
        self.assertEqual(mock_post.call_count, 2)

    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_summary_length_cache_keys_do_not_cross_reuse(self, mock_post):
        mock_post.side_effect = [
            self._fake_http_response(200, [{'summary_text': 'Short cached summary.'}]),
            self._fake_http_response(200, [{'summary_text': 'Medium cached summary.'}]),
            self._fake_http_response(200, [{'summary_text': 'Long cached summary.'}]),
        ]
        content = ' '.join(
            ['Length cache notes require each preset to retain its own generated output.'] * 18
        )
        document_id = self._insert_document('Length Cache Notes', content)

        short_response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={'summary_length': 'short'},
        )
        medium_response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={'summary_length': 'medium'},
        )
        long_response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={'summary_length': 'long'},
        )

        self.assertEqual(short_response.get_json().get('ai_summary'), 'Short cached summary.')
        self.assertEqual(medium_response.get_json().get('ai_summary'), 'Medium cached summary.')
        self.assertEqual(long_response.get_json().get('ai_summary'), 'Long cached summary.')
        self.assertNotEqual(short_response.get_json().get('summary_cache_key'), medium_response.get_json().get('summary_cache_key'))
        self.assertNotEqual(medium_response.get_json().get('summary_cache_key'), long_response.get_json().get('summary_cache_key'))

        cached_short_response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={'summary_length': 'short'},
        )

        self.assertEqual(cached_short_response.status_code, 200)
        self.assertTrue(cached_short_response.get_json().get('cache_hit'))
        self.assertEqual(cached_short_response.get_json().get('ai_summary'), 'Short cached summary.')
        self.assertEqual(mock_post.call_count, 3)

    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_document_summary_fields_are_used_when_cache_table_misses(self, mock_post):
        mock_post.return_value = self._fake_http_response(200, [{'summary_text': 'Document field summary.'}])
        content = ' '.join(
            ['Document field cache notes should avoid another external summarizer call.'] * 18
        )
        document_id = self._insert_document('Document Field Cache Notes', content)

        response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={},
        )
        self.assertEqual(response.status_code, 200)

        conn = self._connection()
        try:
            conn.execute('DELETE FROM document_summary_cache WHERE document_id = ?', (document_id,))
            conn.commit()
        finally:
            conn.close()

        cached_response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={},
        )

        self.assertEqual(cached_response.status_code, 200)
        self.assertTrue(cached_response.get_json().get('cache_hit'))
        self.assertEqual(cached_response.get_json().get('ai_summary'), 'Document field summary.')
        self.assertEqual(mock_post.call_count, 1)

    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_document_detail_ignores_cached_summary_for_different_summary_key(self, mock_post):
        mock_post.return_value = self._fake_http_response(200, [{'summary_text': 'Short detail summary.'}])
        content = ' '.join(
            ['Detail cache notes keep summary length settings from showing the wrong cached output.'] * 18
        )
        document_id = self._insert_document('Detail Cache Notes', content)

        response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={'summary_length': 'short'},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json().get('ai_summary'), 'Short detail summary.')

        next_settings = {
            **DEFAULT_WORKSPACE_SETTINGS,
            'summary_length': 'long',
        }
        conn = self._connection()
        try:
            conn.execute(
                'UPDATE workspaces SET settings_json = ? WHERE id = ?',
                (workspace_settings_to_json(next_settings), self.workspace_id),
            )
            conn.commit()
        finally:
            conn.close()

        doc_response = self.client.get(
            f'/api/documents/{document_id}',
            headers=self._auth_headers(),
        )
        self.assertEqual(doc_response.status_code, 200)
        self.assertEqual(doc_response.get_json().get('summary_length'), 'long')
        self.assertNotIn('cached_summary', doc_response.get_json())

    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_summary_rechecks_cache_after_lock_before_hf_call(self, mock_post):
        content = ' '.join(
            ['Lock window notes avoid duplicate model calls when another worker has just cached output.'] * 18
        )
        document_id = self._insert_document('Lock Window Notes', content)
        input_hash = build_summary_cache_text_hash(content)
        summary_cache_key = build_document_summary_cache_key(content, 'medium', 5)

        def acquire_lock_and_seed_cache(conn, requested_doc_id, requested_cache_key, lease_seconds=None):
            acquired = try_begin_summary_generation(
                conn,
                requested_doc_id,
                requested_cache_key,
                lease_seconds=lease_seconds,
            )
            if acquired:
                now_iso = utcnow_iso()
                payload = {
                    'summary': 'Cached after lock summary.',
                    'summary_text': 'Cached after lock summary.',
                    'keywords': [],
                    'key_sentences': ['Cached after lock summary.'],
                    'summary_source': 'bart_hf',
                    'summary_model': 'facebook/bart-large-cnn',
                    'ai_summary': 'Cached after lock summary.',
                    'extractive_summary': 'Cached key sentence.',
                    'used_fallback': False,
                    'summary_error': '',
                    'summary_input_hash': input_hash,
                    'summary_cache_key': summary_cache_key,
                    'summary_note': '',
                    'options_used': {
                        'summary_length': 'medium',
                        'keyword_limit': 5,
                    },
                }
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
                        document_id,
                        self.workspace_id,
                        self.username,
                        summary_cache_key,
                        'medium',
                        5,
                        json.dumps(payload),
                        'bart_hf',
                        '',
                        now_iso,
                        now_iso,
                    ),
                )
                conn.commit()
            return acquired

        with patch('backend.shared.try_begin_summary_generation', side_effect=acquire_lock_and_seed_cache):
            response = self.client.post(
                f'/api/documents/{document_id}/summarize',
                headers=self._auth_headers(),
                json={},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload.get('cache_hit'))
        self.assertEqual(payload.get('summary_text'), 'Cached after lock summary.')
        mock_post.assert_not_called()

    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_summary_lock_failure_returns_retryable_error(self, mock_post):
        content = ' '.join(
            ['Lock failure notes should not look like normal in-progress dedupe.'] * 18
        )
        document_id = self._insert_document('Lock Failure Notes', content)

        with patch('backend.shared.try_begin_summary_generation', return_value=None):
            response = self.client.post(
                f'/api/documents/{document_id}/summarize',
                headers=self._auth_headers(),
                json={},
            )

        self.assertEqual(response.status_code, 503)
        self.assertIn('lock', response.get_json().get('error', '').lower())
        mock_post.assert_not_called()

    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_document_summarize_endpoint_falls_back_when_hf_fails(self, mock_post):
        mock_post.side_effect = Exception('hf offline')
        content = ' '.join(
            ['Neural networks learn representations from examples. Optimization changes weights during training.'] * 18
        )
        document_id = self._insert_document('Fallback Notes', content)

        response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload.get('summary_source'), 'textrank_fallback')
        self.assertTrue(payload.get('used_fallback'))
        self.assertIn('Neural networks', payload.get('summary') or '')
        self.assertIn('hf offline', payload.get('summary_error') or '')

    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_transient_textrank_fallback_is_not_cached_over_later_hf_success(self, mock_post):
        mock_post.side_effect = [
            Exception('hf temporarily offline'),
            self._fake_http_response(200, [{'summary_text': 'Recovered AI summary.'}]),
        ]
        content = ' '.join(
            ['Transient fallback notes should retry the primary AI model after a temporary outage.'] * 18
        )
        document_id = self._insert_document('Transient Fallback Notes', content)

        first_response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={},
        )
        self.assertEqual(first_response.status_code, 200)
        self.assertEqual(first_response.get_json().get('summary_source'), 'textrank_fallback')

        conn = self._connection()
        try:
            cache_count = row_to_dict(
                conn.execute(
                    'SELECT COUNT(*) AS count FROM document_summary_cache WHERE document_id = ?',
                    (document_id,),
                ).fetchone()
            )
            doc = row_to_dict(
                conn.execute(
                    'SELECT summary_text, summary_cache_key FROM documents WHERE id = ?',
                    (document_id,),
                ).fetchone()
            )
        finally:
            conn.close()
        self.assertEqual(parse_int(cache_count.get('count'), 0, 0), 0)
        self.assertFalse(str(doc.get('summary_text') or '').strip())
        self.assertFalse(str(doc.get('summary_cache_key') or '').strip())

        second_response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={},
        )
        self.assertEqual(second_response.status_code, 200)
        self.assertEqual(second_response.get_json().get('summary_source'), 'bart_hf')
        self.assertEqual(second_response.get_json().get('ai_summary'), 'Recovered AI summary.')
        self.assertEqual(mock_post.call_count, 2)

    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_summary_cache_is_invalidated_when_document_text_changes(self, mock_post):
        mock_post.return_value = self._fake_http_response(200, [{'summary_text': 'Initial AI summary.'}])
        content = ' '.join(
            ['Caching notes explain why summaries must match the latest extracted text.'] * 18
        )
        document_id = self._insert_document('Cache Invalidation Notes', content)

        response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={},
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json().get('summary_input_hash'))

        update_response = self.client.put(
            f'/api/documents/{document_id}/content',
            headers=self._auth_headers(),
            json={'content': 'Updated extracted text invalidates the previous cached summary.'},
        )
        self.assertEqual(update_response.status_code, 200)

        conn = self._connection()
        try:
            cursor = conn.execute(
                'SELECT summary_text, summary_input_hash, key_sentences_json FROM documents WHERE id = ?',
                (document_id,),
            )
            doc = row_to_dict(cursor.fetchone()) or {}
        finally:
            conn.close()

        self.assertFalse(str(doc.get('summary_text') or '').strip())
        self.assertFalse(str(doc.get('summary_input_hash') or '').strip())
        self.assertFalse(str(doc.get('key_sentences_json') or '').strip())

        doc_response = self.client.get(
            f'/api/documents/{document_id}',
            headers=self._auth_headers(),
        )
        self.assertEqual(doc_response.status_code, 200)
        self.assertNotIn('cached_summary', doc_response.get_json())

    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_duplicate_summary_generation_returns_in_progress(self, mock_post):
        content = ' '.join(
            ['Duplicate prevention avoids sending the same lecture text to the AI service twice.'] * 18
        )
        document_id = self._insert_document('Duplicate Summary Notes', content)
        input_hash = build_summary_cache_text_hash(content)
        summary_cache_key = build_document_summary_cache_key(content, 'medium', 5)
        conn = self._connection()
        lock_token = try_begin_summary_generation(conn, document_id, summary_cache_key)
        self.assertTrue(lock_token)
        conn.close()
        try:
            response = self.client.post(
                f'/api/documents/{document_id}/summarize',
                headers=self._auth_headers(),
                json={},
            )
        finally:
            release_conn = self._connection()
            try:
                finish_summary_generation(release_conn, document_id, summary_cache_key, lock_token)
            finally:
                release_conn.close()

        self.assertEqual(response.status_code, 202)
        payload = response.get_json()
        self.assertTrue(payload.get('in_progress'))
        self.assertEqual(payload.get('summary_input_hash'), input_hash)
        self.assertEqual(payload.get('summary_cache_key'), summary_cache_key)
        mock_post.assert_not_called()

    def test_summary_generation_lock_recovers_stale_lease(self):
        document_id = self._insert_document(
            'Stale Lock Notes',
            'Stale lock recovery notes keep retries from getting stuck forever.',
        )
        summary_cache_key = build_document_summary_cache_key(
            'Stale lock recovery notes keep retries from getting stuck forever.',
            'medium',
            5,
        )
        conn = self._connection()
        lock_token = ''
        try:
            conn.execute(
                '''
                INSERT INTO summary_generation_locks (
                    document_id,
                    summary_cache_key,
                    lease_expires_at,
                    created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?)
                ''',
                (document_id, summary_cache_key, '2000-01-01T00:00:00', utcnow_iso(), utcnow_iso()),
            )
            conn.commit()
            lock_token = try_begin_summary_generation(conn, document_id, summary_cache_key)
            self.assertTrue(lock_token)
        finally:
            finish_summary_generation(conn, document_id, summary_cache_key, lock_token)
            conn.close()

    def test_summary_generation_lock_release_requires_matching_token(self):
        document_id = self._insert_document(
            'Lock Owner Notes',
            'Lock owner notes prevent stale workers from clearing replacement locks.',
        )
        summary_cache_key = build_document_summary_cache_key(
            'Lock owner notes prevent stale workers from clearing replacement locks.',
            'medium',
            5,
        )
        conn = self._connection()
        try:
            conn.execute(
                '''
                INSERT INTO summary_generation_locks (
                    document_id,
                    summary_cache_key,
                    lock_token,
                    lease_expires_at,
                    created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ''',
                (
                    document_id,
                    summary_cache_key,
                    'old-lock-token',
                    '2000-01-01T00:00:00',
                    utcnow_iso(),
                    utcnow_iso(),
                ),
            )
            conn.commit()
            replacement_token = try_begin_summary_generation(conn, document_id, summary_cache_key)
            self.assertTrue(replacement_token)
            self.assertNotEqual(replacement_token, 'old-lock-token')

            finish_summary_generation(conn, document_id, summary_cache_key, 'old-lock-token')
            row = row_to_dict(
                conn.execute(
                    '''
                    SELECT lock_token
                    FROM summary_generation_locks
                    WHERE document_id = ?
                      AND summary_cache_key = ?
                    ''',
                    (document_id, summary_cache_key),
                ).fetchone()
            )
            self.assertEqual(row.get('lock_token'), replacement_token)

            finish_summary_generation(conn, document_id, summary_cache_key, replacement_token)
            missing = conn.execute(
                '''
                SELECT lock_token
                FROM summary_generation_locks
                WHERE document_id = ?
                  AND summary_cache_key = ?
                ''',
                (document_id, summary_cache_key),
            ).fetchone()
            self.assertIsNone(missing)
        finally:
            conn.close()

    def test_summary_generation_lock_uses_long_default_lease(self):
        document_id = self._insert_document(
            'Long Lease Notes',
            'Long lease notes protect chunked summaries from duplicate generation.',
        )
        summary_cache_key = build_document_summary_cache_key(
            'Long lease notes protect chunked summaries from duplicate generation.',
            'medium',
            5,
        )
        conn = self._connection()
        lock_token = ''
        try:
            started_at = datetime.utcnow()
            lock_token = try_begin_summary_generation(conn, document_id, summary_cache_key)
            self.assertTrue(lock_token)
            cursor = conn.execute(
                '''
                SELECT lease_expires_at
                FROM summary_generation_locks
                WHERE document_id = ?
                  AND summary_cache_key = ?
                ''',
                (document_id, summary_cache_key),
            )
            row = row_to_dict(cursor.fetchone()) or {}
            lease_expires_at = datetime.fromisoformat(row.get('lease_expires_at'))
            self.assertGreater((lease_expires_at - started_at).total_seconds(), 800)
        finally:
            finish_summary_generation(conn, document_id, summary_cache_key, lock_token)
            conn.close()

    @patch('backend.summary_service.HF_TOKEN', 'test-hf-token')
    @patch('backend.summary_service.requests.post')
    def test_summary_cache_is_not_reused_after_input_hash_changes(self, mock_post):
        mock_post.side_effect = [
            self._fake_http_response(200, [{'summary_text': 'First AI summary.'}]),
            self._fake_http_response(200, [{'summary_text': 'Second AI summary.'}]),
        ]
        first_content = ' '.join(
            ['Hash version one describes queues and stacks for graph search.'] * 18
        )
        second_content = ' '.join(
            ['Hash version two describes dynamic programming tables and recurrence relations.'] * 18
        )
        document_id = self._insert_document('Hash Notes', first_content)

        first_response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={},
        )
        self.assertEqual(first_response.status_code, 200)
        first_hash = first_response.get_json().get('summary_input_hash')

        conn = self._connection()
        try:
            conn.execute('UPDATE documents SET content = ? WHERE id = ?', (second_content, document_id))
            conn.commit()
        finally:
            conn.close()

        second_response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers(),
            json={},
        )
        self.assertEqual(second_response.status_code, 200)
        second_payload = second_response.get_json()
        self.assertEqual(second_payload.get('ai_summary'), 'Second AI summary.')
        self.assertNotEqual(second_payload.get('summary_input_hash'), first_hash)
        self.assertEqual(mock_post.call_count, 2)

    def test_document_summarize_endpoint_enforces_document_access(self):
        self._insert_user('bob', 'bob@example.com')
        document_id = self._insert_document('Private Notes', 'Private document summary text.')

        response = self.client.post(
            f'/api/documents/{document_id}/summarize',
            headers=self._auth_headers('bob'),
            json={},
        )

        self.assertEqual(response.status_code, 403)

    @patch('backend.document_processing.extract_document_content', return_value=('workerpdf searchable text', ''))
    def test_legacy_queued_pdf_is_processed_by_worker(self, mock_extract):
        filename = 'worker-pdf-smoke.pdf'
        self._save_pdf_upload_file(filename, 'worker queued pdf coverage')
        document_id = self._insert_document(
            'worker-pdf-smoke.pdf',
            '',
            file_type='pdf',
            filename=filename,
            processing_status='queued',
            processed_at='',
        )
        mock_extract.assert_not_called()

        conn = self._connection()
        try:
            cursor = conn.execute('SELECT content, processing_status, processed_at FROM documents WHERE id = ?', (document_id,))
            queued_doc = row_to_dict(cursor.fetchone()) or {}
        finally:
            conn.close()
        self.assertEqual(queued_doc.get('processing_status'), 'queued')
        self.assertEqual(queued_doc.get('content') or '', '')
        self.assertFalse(str(queued_doc.get('processed_at') or '').strip())

        result = process_queued_documents_once(limit=1)
        self.assertEqual(result.get('claimed_count'), 1)
        self.assertEqual(result.get('processed_count'), 1)
        self.assertEqual(result.get('needs_ocr_count'), 0)
        self.assertEqual(result.get('failed_count'), 0)
        mock_extract.assert_called_once()

        conn = self._connection()
        try:
            cursor = conn.execute(
                '''
                SELECT content, processing_status, processing_error, processing_started_at, processed_at
                FROM documents
                WHERE id = ?
                ''',
                (document_id,),
            )
            processed_doc = row_to_dict(cursor.fetchone()) or {}
        finally:
            conn.close()
        self.assertEqual(processed_doc.get('processing_status'), 'processed')
        self.assertEqual(processed_doc.get('processing_error') or '', '')
        self.assertIn('workerpdf searchable text', processed_doc.get('content') or '')
        self.assertTrue(str(processed_doc.get('processing_started_at') or '').strip())
        self.assertTrue(str(processed_doc.get('processed_at') or '').strip())

        search_response = self.client.get(
            '/api/documents?include_meta=1&q=workerpdf',
            headers=self._auth_headers(),
        )
        self.assertEqual(search_response.status_code, 200)
        search_payload = search_response.get_json()
        self.assertEqual(search_payload['total'], 1)
        self.assertEqual(search_payload['items'][0]['title'], 'worker-pdf-smoke.pdf')

    @patch('backend.document_service._UPLOAD_PROCESSING_EXECUTOR.submit')
    def test_queued_pdf_recovery_atomically_claims_before_submit(self, mock_submit):
        filename = 'recover-pdf-smoke.pdf'
        self._save_pdf_upload_file(filename, 'recover queued pdf coverage')
        document_id = self._insert_document(
            'recover-pdf-smoke.pdf',
            '',
            file_type='pdf',
            filename=filename,
            processing_status='queued',
            processed_at='',
        )

        first_recovery = document_service.recover_queued_pdf_uploads(limit=5)
        self.assertEqual(first_recovery.get('queued_count'), 1)
        self.assertEqual(first_recovery.get('error'), '')
        mock_submit.assert_called_once()

        conn = self._connection()
        try:
            cursor = conn.execute(
                'SELECT processing_status, processing_started_at FROM documents WHERE id = ?',
                (document_id,),
            )
            claimed_doc = row_to_dict(cursor.fetchone()) or {}
        finally:
            conn.close()
        self.assertEqual(claimed_doc.get('processing_status'), 'processing')
        self.assertTrue(str(claimed_doc.get('processing_started_at') or '').strip())

        second_recovery = document_service.recover_queued_pdf_uploads(limit=5)
        self.assertEqual(second_recovery.get('queued_count'), 0)
        self.assertEqual(mock_submit.call_count, 1)

    @patch('backend.document_processing.extract_document_content', side_effect=RuntimeError('pdf worker boom'))
    def test_pdf_worker_persists_processing_failure(self, _mock_extract):
        filename = 'worker-pdf-failure.pdf'
        self._save_pdf_upload_file(filename, 'worker failure pdf coverage')
        document_id = self._insert_document(
            'worker-pdf-failure.pdf',
            '',
            file_type='pdf',
            filename=filename,
            processing_status='queued',
            processed_at='',
        )

        result = process_queued_documents_once(limit=1)
        self.assertEqual(result.get('claimed_count'), 1)
        self.assertEqual(result.get('processed_count'), 0)
        self.assertEqual(result.get('failed_count'), 1)

        conn = self._connection()
        try:
            cursor = conn.execute(
                'SELECT processing_status, processing_error, processed_at FROM documents WHERE id = ?',
                (document_id,),
            )
            failed_doc = row_to_dict(cursor.fetchone()) or {}
        finally:
            conn.close()
        self.assertEqual(failed_doc.get('processing_status'), 'failed')
        self.assertIn('pdf worker boom', failed_doc.get('processing_error') or '')
        self.assertTrue(str(failed_doc.get('processed_at') or '').strip())

    @patch('backend.shared.extract_document_text_from_storage')
    def test_scanned_pdf_summary_reports_ocr_needed_without_request_extraction(self, mock_extract_from_storage):
        upload_response = self.client.post(
            '/api/documents/upload',
            data={
                'file': (
                    self._build_pdf_upload('scanned summary pdf coverage'),
                    'scanned-summary.pdf',
                ),
                'workspace_id': self.workspace_id,
                'client_pdf_text_status': 'needs_ocr',
            },
            headers=self._auth_headers(),
            content_type='multipart/form-data',
        )
        self.assertEqual(upload_response.status_code, 201)
        upload_payload = upload_response.get_json()
        self.assertEqual(upload_payload.get('processing_status'), 'needs_ocr')
        document_id = parse_int(upload_payload.get('document_id'), 0, 0)
        self.assertGreater(document_id, 0)

        response = self.client.post(
            '/api/analyze-text',
            headers=self._auth_headers(),
            json={'doc_id': document_id},
        )
        self.assertEqual(response.status_code, 409)
        payload = response.get_json()
        self.assertEqual(payload.get('processing_status'), 'needs_ocr')
        self.assertIn('OCR', payload.get('error') or '')
        mock_extract_from_storage.assert_not_called()

    @patch('backend.document_processing.extract_document_content', return_value=('Text extraction failed.', ''))
    def test_legacy_worker_marks_no_text_pdf_needs_ocr(self, _mock_extract):
        filename = 'worker-no-text.pdf'
        self._save_pdf_upload_file(filename, 'worker no text pdf coverage')
        document_id = self._insert_document(
            'worker-no-text.pdf',
            '',
            file_type='pdf',
            filename=filename,
            processing_status='queued',
            processed_at='',
        )

        result = process_queued_documents_once(limit=1)
        self.assertEqual(result.get('claimed_count'), 1)
        self.assertEqual(result.get('processed_count'), 0)
        self.assertEqual(result.get('needs_ocr_count'), 1)
        self.assertEqual(result.get('failed_count'), 0)

        conn = self._connection()
        try:
            cursor = conn.execute(
                'SELECT content, processing_status, processing_error, processed_at FROM documents WHERE id = ?',
                (document_id,),
            )
            doc = row_to_dict(cursor.fetchone()) or {}
        finally:
            conn.close()
        self.assertEqual(doc.get('content') or '', '')
        self.assertEqual(doc.get('processing_status'), 'needs_ocr')
        self.assertIn('OCR', doc.get('processing_error') or '')
        self.assertTrue(str(doc.get('processed_at') or '').strip())

    def test_ocr_quality_check_allows_normal_text(self):
        quality = assess_ocr_text_quality(
            'Graph traversal notes explain how BFS and DFS visit nodes in a predictable order. '
            'These OCR results include ordinary sentences, short keywords, and no runaway control syntax.'
        )
        self.assertTrue(quality['ok'])
        self.assertEqual(quality['reason'], '')

    def test_ocr_quality_check_rejects_runaway_latex_hallucination(self):
        suspicious_text = ' '.join(
            [
                r'\begin{align*} \frac{a}{b} \mathfrak{A} \stackrel{x}{y} \underset{n}{m} \infty'
                for _ in range(18)
            ]
        )
        quality = assess_ocr_text_quality(suspicious_text)
        self.assertFalse(quality['ok'])
        self.assertIn('latex', quality['reason'].lower())
        self.assertGreaterEqual(
            parse_int(quality['metrics'].get('structural_token_total', 0), 0, 0),
            10,
        )

    def test_hf_summarizer_input_prefixes_t5_family_models(self):
        payload = build_hf_summarizer_input(
            'Graph traversal notes explain BFS and DFS.',
            'google/flan-t5-base',
        )
        self.assertTrue(payload.startswith('summarize: '))
        self.assertIn('Graph traversal notes explain BFS and DFS.', payload)

    def test_hf_summarizer_input_keeps_non_t5_models_unchanged(self):
        payload = build_hf_summarizer_input(
            'Graph traversal notes explain BFS and DFS.',
            'facebook/bart-large-cnn',
        )
        self.assertEqual(payload, 'Graph traversal notes explain BFS and DFS.')

    def test_search_edge_case_queries_do_not_error(self):
        self._insert_document(
            'C++ Primer',
            'c++ templates pointers references smoke coverage',
            filename='cpp-primer.txt',
        )
        self._insert_document(
            'AI NLP Notes',
            'ai nlp transformers language models smoke coverage',
            tags='ai,nlp',
            filename='ai-nlp-notes.txt',
        )
        self._insert_document(
            'Machine Learning Basics',
            'machine-learning regression clustering smoke coverage',
            filename='machine-learning-basics.txt',
        )
        self._insert_document(
            'General Study Notes',
            'baseline notes for whitespace search coverage',
            filename='general-study-notes.txt',
        )

        cases = [
            ('C++', 1),
            ('AI/NLP', 1),
            ('machine-learning', 1),
            ('   \n\t  ', 4),
        ]
        for query, minimum_total in cases:
            with self.subTest(query=query):
                response = self.client.get(
                    '/api/documents',
                    headers=self._auth_headers(),
                    query_string={
                        'include_meta': '1',
                        'include_facets': '1',
                        'q': query,
                    },
                )
                self.assertEqual(response.status_code, 200)
                payload = response.get_json()
                self.assertIsInstance(payload.get('items'), list)
                self.assertIsInstance(payload.get('facets'), dict)
                self.assertGreaterEqual(parse_int(payload.get('total', 0), 0, 0), minimum_total)

    def test_search_pagination_is_stable_for_same_query_across_offsets(self):
        self._insert_document(
            'Graph A',
            'graph smoke pagination content',
            filename='graph-a.txt',
            uploaded_at='2026-01-01T10:00:00',
        )
        self._insert_document(
            'Graph B',
            'graph smoke pagination content',
            filename='graph-b.txt',
            uploaded_at='2026-01-01T10:00:00',
        )
        self._insert_document(
            'Graph C',
            'graph smoke pagination content',
            filename='graph-c.txt',
            uploaded_at='2026-01-01T10:00:00',
        )

        titles = []
        totals = []
        for offset in (0, 1, 2):
            response = self.client.get(
                '/api/documents',
                headers=self._auth_headers(),
                query_string={
                    'include_meta': '1',
                    'q': 'graph',
                    'sort': 'title_asc',
                    'limit': '1',
                    'offset': str(offset),
                },
            )
            self.assertEqual(response.status_code, 200)
            payload = response.get_json()
            totals.append(payload.get('total'))
            self.assertEqual(len(payload.get('items') or []), 1)
            titles.append(payload['items'][0]['title'])

        self.assertEqual(totals, [3, 3, 3])
        self.assertEqual(titles, ['Graph A', 'Graph B', 'Graph C'])

    @patch('backend.feedback_service.send_resend_email', return_value=(True, ''))
    def test_feedback_submit_and_mine_are_private(self, _mock_send_email):
        submit_response = self.client.post(
            '/api/feedback',
            headers=self._auth_headers(),
            json={
                'type': 'bug_report',
                'title': 'Upload queue visual issue',
                'description': 'The upload queue looks stuck after finishing.',
                'priority': 'high',
                'page_path': '/#/files',
                'workspace_id': self.workspace_id,
            },
        )
        self.assertEqual(submit_response.status_code, 201)
        item = submit_response.get_json()['item']
        self.assertEqual(item['title'], 'Upload queue visual issue')
        self.assertNotIn('user_email_snapshot', item)

        mine_response = self.client.get('/api/feedback/mine', headers=self._auth_headers())
        self.assertEqual(mine_response.status_code, 200)
        mine_payload = mine_response.get_json()
        self.assertEqual(mine_payload['total'], 1)
        self.assertEqual(mine_payload['items'][0]['id'], item['id'])

        self._insert_user('bob', 'bob@example.com')
        bob_response = self.client.post(
            '/api/feedback',
            headers=self._auth_headers('bob'),
            json={
                'type': 'feature_request',
                'title': 'Bob private feedback',
                'description': 'Only Bob should see this feedback.',
                'priority': 'low',
            },
        )
        self.assertEqual(bob_response.status_code, 201)
        bob_item_id = bob_response.get_json()['item']['id']

        alice_cannot_read_bob = self.client.get(
            f'/api/feedback/{bob_item_id}',
            headers=self._auth_headers(),
        )
        self.assertEqual(alice_cannot_read_bob.status_code, 404)

        mine_again = self.client.get('/api/feedback/mine', headers=self._auth_headers())
        self.assertEqual(mine_again.status_code, 200)
        self.assertEqual(mine_again.get_json()['total'], 1)

    @patch('backend.feedback_service.FEEDBACK_ADMIN_USERNAMES', 'admin')
    @patch('backend.feedback_service.send_resend_email', return_value=(True, ''))
    def test_feedback_admin_status_public_reply_and_internal_note_visibility(self, mock_send_email):
        self._insert_user('admin', 'admin@example.com')
        submit_response = self.client.post(
            '/api/feedback',
            headers=self._auth_headers(),
            json={
                'type': 'ui_usability',
                'title': 'Feedback modal smoke',
                'description': 'The feedback system should keep public and internal updates separate.',
                'priority': 'medium',
            },
        )
        self.assertEqual(submit_response.status_code, 201)
        feedback_id = submit_response.get_json()['item']['id']

        non_admin_list = self.client.get('/api/admin/feedback', headers=self._auth_headers())
        self.assertEqual(non_admin_list.status_code, 403)

        admin_list = self.client.get('/api/admin/feedback', headers=self._auth_headers('admin'))
        self.assertEqual(admin_list.status_code, 200)
        self.assertEqual(admin_list.get_json()['total'], 1)

        status_response = self.client.patch(
            f'/api/admin/feedback/{feedback_id}',
            headers=self._auth_headers('admin'),
            json={'status': 'resolved', 'assigned_to': 'admin'},
        )
        self.assertEqual(status_response.status_code, 200)
        status_payload = status_response.get_json()['item']
        self.assertEqual(status_payload['status'], 'resolved')
        self.assertNotIn('labels', status_payload)

        admin_close_response = self.client.patch(
            f'/api/admin/feedback/{feedback_id}',
            headers=self._auth_headers('admin'),
            json={'status': 'closed'},
        )
        self.assertEqual(admin_close_response.status_code, 400)

        reply_response = self.client.post(
            f'/api/admin/feedback/{feedback_id}/public-reply',
            headers=self._auth_headers('admin'),
            json={'message': 'This has been fixed for the next demo.'},
        )
        self.assertEqual(reply_response.status_code, 200)

        follow_up_response = self.client.post(
            f'/api/feedback/{feedback_id}/follow-up',
            headers=self._auth_headers(),
            json={'message': 'I checked again and this is working now.'},
        )
        self.assertEqual(follow_up_response.status_code, 200)
        self.assertIn(
            'user_follow_up',
            [event['event_type'] for event in follow_up_response.get_json()['item']['events']],
        )

        note_response = self.client.post(
            f'/api/admin/feedback/{feedback_id}/internal-note',
            headers=self._auth_headers('admin'),
            json={'message': 'Internal triage note should not leak.'},
        )
        self.assertEqual(note_response.status_code, 200)
        admin_events = note_response.get_json()['item']['events']
        self.assertIn('internal_note', [event['event_type'] for event in admin_events])

        user_detail = self.client.get(f'/api/feedback/{feedback_id}', headers=self._auth_headers())
        self.assertEqual(user_detail.status_code, 200)
        user_events = user_detail.get_json()['item']['events']
        event_types = [event['event_type'] for event in user_events]
        self.assertIn('status_changed', event_types)
        self.assertIn('public_reply', event_types)
        self.assertIn('user_follow_up', event_types)
        self.assertNotIn('internal_note', event_types)

        close_response = self.client.post(
            f'/api/feedback/{feedback_id}/close',
            headers=self._auth_headers(),
        )
        self.assertEqual(close_response.status_code, 200)
        self.assertEqual(close_response.get_json()['item']['status'], 'closed')

        follow_up_after_close = self.client.post(
            f'/api/feedback/{feedback_id}/follow-up',
            headers=self._auth_headers(),
            json={'message': 'This should start a new feedback item instead.'},
        )
        self.assertEqual(follow_up_after_close.status_code, 409)

        admin_detail = self.client.get(
            f'/api/admin/feedback/{feedback_id}',
            headers=self._auth_headers('admin'),
        )
        self.assertEqual(admin_detail.status_code, 200)
        self.assertEqual(admin_detail.get_json()['item']['status'], 'closed')
        self.assertGreaterEqual(mock_send_email.call_count, 4)

    @patch('backend.feedback_service.send_resend_email', return_value=(False, 'simulated email failure'))
    def test_feedback_email_failure_does_not_rollback_submission(self, _mock_send_email):
        response = self.client.post(
            '/api/feedback',
            headers=self._auth_headers(),
            json={
                'type': 'performance',
                'title': 'Slow search feedback',
                'description': 'Search took longer than expected on a large workspace.',
                'priority': 'medium',
            },
        )
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertFalse(payload['admin_notified'])

        mine_response = self.client.get('/api/feedback/mine', headers=self._auth_headers())
        self.assertEqual(mine_response.status_code, 200)
        self.assertEqual(mine_response.get_json()['total'], 1)

    @patch('backend.feedback_service.send_resend_email', return_value=(True, ''))
    def test_feedback_similar_returns_safe_cross_user_suggestions(self, _mock_send_email):
        self._insert_user('bob', 'bob@example.com')
        bob_response = self.client.post(
            '/api/feedback',
            headers=self._auth_headers('bob'),
            json={
                'type': 'upload_ocr',
                'title': 'Upload OCR duplicate smoke',
                'description': 'Bob private reproduction details should not be exposed in similar suggestions.',
                'priority': 'medium',
                'page_path': '/#/private-bob-page',
            },
        )
        self.assertEqual(bob_response.status_code, 201)

        response = self.client.get(
            '/api/feedback/similar?q=Upload OCR duplicate',
            headers=self._auth_headers(),
        )
        self.assertEqual(response.status_code, 200)
        items = response.get_json().get('items') or []
        self.assertTrue(items)
        suggestion = next(
            (item for item in items if item.get('title') == 'Upload OCR duplicate smoke'),
            None,
        )
        self.assertIsNotNone(suggestion)
        self.assertEqual(suggestion.get('type'), 'upload_ocr')
        self.assertEqual(suggestion.get('status'), 'new')
        self.assertFalse(suggestion.get('is_own'))
        self.assertIn('id', suggestion)
        self.assertNotIn('username', suggestion)
        self.assertNotIn('user_email_snapshot', suggestion)
        self.assertNotIn('page_path', suggestion)
        self.assertNotIn('events', suggestion)
        self.assertEqual(suggestion.get('preview'), '')

    @patch('backend.feedback_service.FEEDBACK_ADMIN_USERNAMES', 'admin')
    @patch('backend.feedback_service.send_resend_email', return_value=(False, 'simulated email failure'))
    def test_feedback_status_update_persists_when_notification_email_fails(self, _mock_send_email):
        self._insert_user('admin', 'admin@example.com')
        submit_response = self.client.post(
            '/api/feedback',
            headers=self._auth_headers(),
            json={
                'type': 'bug_report',
                'title': 'Status failure persistence smoke',
                'description': 'Status changes should persist even when notification email fails.',
                'priority': 'medium',
            },
        )
        self.assertEqual(submit_response.status_code, 201)
        feedback_id = submit_response.get_json()['item']['id']

        status_response = self.client.patch(
            f'/api/admin/feedback/{feedback_id}',
            headers=self._auth_headers('admin'),
            json={'status': 'resolved'},
        )
        self.assertEqual(status_response.status_code, 200)
        self.assertEqual(status_response.get_json()['item']['status'], 'resolved')

        user_detail = self.client.get(f'/api/feedback/{feedback_id}', headers=self._auth_headers())
        self.assertEqual(user_detail.status_code, 200)
        item = user_detail.get_json()['item']
        self.assertEqual(item['status'], 'resolved')
        self.assertIn(
            'status_changed',
            [event['event_type'] for event in item.get('events') or []],
        )


if __name__ == '__main__':
    unittest.main()
