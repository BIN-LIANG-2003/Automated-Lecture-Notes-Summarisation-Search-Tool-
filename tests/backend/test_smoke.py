import io
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

from docx import Document as DocxDocument
from reportlab.pdfgen import canvas
from werkzeug.security import generate_password_hash

from backend import create_app
from backend.config import DEFAULT_WORKSPACE_SETTINGS
from backend.db import get_db_connection
from backend.security import create_auth_token
from backend.shared import assess_ocr_text_quality, build_hf_summarizer_input
from backend.utils import parse_int, row_to_dict, utcnow_iso
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
                    self.username,
                    self.email,
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
        uploaded_at='',
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
                ),
            )
            conn.commit()
            return cursor.lastrowid
        finally:
            conn.close()

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

    @patch('backend.shared.send_registration_verification_email', return_value=(True, ''))
    def test_register_requires_email_verification_before_password_login(self, _mock_send_email):
        register_response = self.client.post(
            '/api/auth/register',
            json={
                'username': 'newuser',
                'email': 'newuser@example.com',
                'password': 'password123',
            },
        )
        self.assertEqual(register_response.status_code, 201)
        register_payload = register_response.get_json()
        self.assertTrue(register_payload.get('verification_required'))
        self.assertNotIn('auth_token', register_payload)

        login_before_verify = self.client.post(
            '/api/auth/login',
            json={'username': 'newuser@example.com', 'password': 'password123'},
        )
        self.assertEqual(login_before_verify.status_code, 403)
        self.assertEqual(login_before_verify.get_json().get('code'), 'email_not_verified')

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
        self.assertFalse(bool(user_row.get('email_verified')))
        verification_token = str(user_row.get('email_verification_token') or '').strip()
        self.assertTrue(verification_token)
        self.assertTrue(str(user_row.get('email_verification_expires_at') or '').strip())

        verify_response = self.client.get(f'/api/auth/verify-email?token={verification_token}')
        self.assertEqual(verify_response.status_code, 200)
        self.assertIn('Email verified', verify_response.get_data(as_text=True))

        login_after_verify = self.client.post(
            '/api/auth/login',
            json={'username': 'newuser@example.com', 'password': 'password123'},
        )
        self.assertEqual(login_after_verify.status_code, 200)
        self.assertTrue(str(login_after_verify.get_json().get('auth_token') or '').strip())

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
            },
            headers=self._auth_headers(),
            content_type='multipart/form-data',
        )
        self.assertEqual(upload_response.status_code, 201)

        search_response = self.client.get(
            '/api/documents?include_meta=1&q=pdfsmoke',
            headers=self._auth_headers(),
        )
        self.assertEqual(search_response.status_code, 200)
        search_payload = search_response.get_json()
        matching_items = [
            item
            for item in (search_payload.get('items') or [])
            if item.get('title') == 'upload-pdf-smoke.pdf'
        ]
        if matching_items:
            self.assertEqual(str(matching_items[0]['file_type']).lower(), 'pdf')
            return

        listing_response = self.client.get(
            '/api/documents?include_meta=1&sort=newest',
            headers=self._auth_headers(),
        )
        self.assertEqual(listing_response.status_code, 200)
        listing_payload = listing_response.get_json()
        listed_items = [
            item
            for item in (listing_payload.get('items') or [])
            if item.get('title') == 'upload-pdf-smoke.pdf'
        ]
        self.assertTrue(listed_items, 'Uploaded PDF should remain visible in the document listing.')
        self.assertEqual(str(listed_items[0]['file_type']).lower(), 'pdf')

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


if __name__ == '__main__':
    unittest.main()
