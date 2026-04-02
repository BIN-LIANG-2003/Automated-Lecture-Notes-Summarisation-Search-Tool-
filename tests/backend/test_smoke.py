import io
import os
import tempfile
import unittest
from datetime import datetime, timedelta

from werkzeug.security import generate_password_hash

from backend import create_app
from backend.config import DEFAULT_WORKSPACE_SETTINGS
from backend.db import get_db_connection
from backend.security import create_auth_token
from backend.utils import row_to_dict, utcnow_iso
from backend.workspace_domain import ensure_owner_membership, workspace_settings_to_json


class StudyHubBackendSmokeTests(unittest.TestCase):
    def setUp(self):
        self.original_cwd = os.getcwd()
        self.tempdir = tempfile.TemporaryDirectory(prefix='studyhub-backend-smoke-')
        os.chdir(self.tempdir.name)
        self.app = create_app()
        self.client = self.app.test_client()
        self.username = 'alice'
        self.email = 'alice@example.com'
        self.password = 'password123'
        self.workspace_id = 'ws-smoke'
        self._seed_user()
        self._seed_workspace()

    def tearDown(self):
        os.chdir(self.original_cwd)
        self.tempdir.cleanup()

    def _connection(self):
        conn = get_db_connection()
        self.assertIsNotNone(conn)
        return conn

    def _auth_headers(self, username=None):
        safe_username = str(username or self.username).strip()
        return {'Authorization': f'Bearer {create_auth_token(safe_username)}'}

    def _seed_user(self):
        conn = self._connection()
        try:
            conn.execute(
                'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
                (
                    self.username,
                    self.email,
                    generate_password_hash(self.password, method='pbkdf2:sha256'),
                ),
            )
            conn.commit()
        finally:
            conn.close()

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
                    deleted_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    filename,
                    title,
                    utcnow_iso(),
                    file_type,
                    content,
                    '',
                    self.username,
                    tags,
                    category,
                    self.workspace_id if workspace_id is None else workspace_id,
                    '',
                    '',
                ),
            )
            conn.commit()
            return cursor.lastrowid
        finally:
            conn.close()

    def _insert_share_link(self, document_id, token='public-share-token'):
        conn = self._connection()
        try:
            expires_at = (datetime.utcnow() + timedelta(days=7)).isoformat()
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
                    '',
                    token,
                    self.username,
                    'active',
                    expires_at,
                    utcnow_iso(),
                    '',
                ),
            )
            conn.commit()
            return token
        finally:
            conn.close()

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


if __name__ == '__main__':
    unittest.main()
