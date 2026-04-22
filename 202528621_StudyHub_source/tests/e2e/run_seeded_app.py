import atexit
import os
import tempfile

from werkzeug.security import generate_password_hash

os.environ.setdefault('APP_ENV', 'development')

from backend import create_app
from backend.config import DEFAULT_WORKSPACE_SETTINGS
from backend.db import get_db_connection
from backend.utils import utcnow_iso
from backend.workspace_domain import ensure_owner_membership, workspace_settings_to_json


def seed_app_data():
    conn = get_db_connection()
    now_iso = utcnow_iso()
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
                'alice',
                'alice@example.com',
                generate_password_hash('password123', method='pbkdf2:sha256'),
                1,
                None,
                None,
                now_iso,
            ),
        )
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
                'bob',
                'bob@example.com',
                generate_password_hash('password123', method='pbkdf2:sha256'),
                1,
                None,
                None,
                now_iso,
            ),
        )
        conn.execute(
            '''
            INSERT INTO workspaces (id, name, plan, owner_username, settings_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ''',
            (
                'ws-e2e',
                'E2E Workspace',
                'Free',
                'alice',
                workspace_settings_to_json(DEFAULT_WORKSPACE_SETTINGS),
                now_iso,
                now_iso,
            ),
        )
        ensure_owner_membership(conn, 'ws-e2e', 'alice')
        conn.execute(
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
                'graph-notes.txt',
                'Graph Notes',
                now_iso,
                'txt',
                'graph traversal bfs dfs shortest path smoke test content',
                '<p>graph traversal bfs dfs shortest path smoke test content</p>',
                'alice',
                'graphs,smoke',
                'Computer Science',
                'ws-e2e',
                '',
                '',
            ),
        )
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
                1,
                'ws-e2e',
                'graph-share-token',
                'alice',
                'active',
                '2026-12-31T23:59:59',
                now_iso,
                '',
            ),
        )
        conn.execute(
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
            (
                'bob',
                'bob@example.com',
                'upload_ocr',
                'Upload OCR duplicate smoke',
                'Seeded private duplicate suggestion for Playwright coverage.',
                'medium',
                'new',
                '/#/private-bob-page',
                'ws-e2e',
                None,
                'seeded-playwright',
                '',
                now_iso,
                now_iso,
                None,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def main():
    tempdir = tempfile.TemporaryDirectory(prefix='studyhub-e2e-')
    atexit.register(tempdir.cleanup)
    os.chdir(tempdir.name)
    app = create_app()
    from backend import feedback_service

    feedback_service.FEEDBACK_ADMIN_USERNAMES = 'alice'
    seed_app_data()
    port = int(os.environ.get('PORT', '5001'))
    app.run(host='127.0.0.1', port=port, debug=False, use_reloader=False)


if __name__ == '__main__':
    main()
