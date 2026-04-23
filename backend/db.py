import os
import secrets
import sqlite3

import psycopg2
from psycopg2.extras import RealDictCursor

from .utils import utcnow_iso


FRIEND_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'


class DBWrapper:
    """
    Wraps SQLite and PostgreSQL differences behind one small execution API.
    Render uses PostgreSQL (%s placeholders); local development uses SQLite (? placeholders).
    """

    def __init__(self, conn, db_type):
        self.conn = conn
        self.db_type = db_type

    def execute(self, query, params=()):
        if self.db_type == 'postgres':
            query = query.replace('?', '%s')

        try:
            if self.db_type == 'postgres':
                cursor = self.conn.cursor()
                cursor.execute(query, params)
                return cursor
            return self.conn.execute(query, params)
        except Exception as e:
            print(f'Database Execution Error: {e}')
            raise e

    def commit(self):
        self.conn.commit()

    def rollback(self):
        self.conn.rollback()

    def close(self):
        self.conn.close()


def get_db_connection():
    database_url = os.environ.get('DATABASE_URL')

    if database_url:
        try:
            if database_url.startswith('postgres://'):
                database_url = database_url.replace('postgres://', 'postgresql://', 1)

            conn = psycopg2.connect(database_url, cursor_factory=RealDictCursor)
            return DBWrapper(conn, 'postgres')
        except Exception as e:
            print(f'❌ PostgreSQL connection failed: {e}')
            return None

    conn = sqlite3.connect('database.db')
    conn.row_factory = sqlite3.Row
    return DBWrapper(conn, 'sqlite')


def row_value(row, key, default=None):
    if not row:
        return default
    if hasattr(row, 'get'):
        return row.get(key, default)
    try:
        return row[key]
    except Exception:
        return default


def generate_friend_code(length=8):
    safe_length = max(6, int(length or 8))
    return ''.join(secrets.choice(FRIEND_CODE_ALPHABET) for _ in range(safe_length))


def generate_unique_friend_code(conn, length=8):
    for _ in range(100):
        code = generate_friend_code(length)
        cursor = conn.execute('SELECT username FROM users WHERE friend_code = ? LIMIT 1', (code,))
        if not cursor.fetchone():
            return code
    return generate_friend_code(12)


def ensure_user_friend_code(conn, username):
    safe_username = str(username or '').strip()
    if not safe_username:
        return ''
    ensure_users_column(conn, 'friend_code', 'TEXT')
    cursor = conn.execute(
        'SELECT username, friend_code FROM users WHERE username = ? LIMIT 1',
        (safe_username,),
    )
    row = cursor.fetchone()
    if not row:
        return ''
    current_code = str(row_value(row, 'friend_code', '') or '').strip().upper()
    if current_code:
        return current_code
    for _ in range(100):
        next_code = generate_unique_friend_code(conn)
        try:
            conn.execute(
                'UPDATE users SET friend_code = ? WHERE username = ?',
                (next_code, safe_username),
            )
            return next_code
        except Exception:
            continue
    return ''


def backfill_user_friend_codes(conn):
    ensure_users_column(conn, 'friend_code', 'TEXT')
    cursor = conn.execute(
        '''
        SELECT username
        FROM users
        WHERE friend_code IS NULL OR TRIM(CAST(friend_code AS TEXT)) = ''
        '''
    )
    for row in cursor.fetchall():
        ensure_user_friend_code(conn, row_value(row, 'username', ''))


def table_column_exists(conn, table_name, column_name):
    safe_table = str(table_name or '').strip()
    safe_column = str(column_name or '').strip()
    if not safe_table or not safe_column:
        return False

    if conn.db_type == 'sqlite':
        cursor = conn.execute(f'PRAGMA table_info({safe_table})')
        rows = cursor.fetchall()
        return any((row['name'] if hasattr(row, 'keys') else row[1]) == safe_column for row in rows)

    cursor = conn.execute(
        '''
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = ? AND column_name = ?
        ''',
        (safe_table, safe_column),
    )
    return cursor.fetchone() is not None


def documents_column_exists(conn, column_name):
    return table_column_exists(conn, 'documents', column_name)


def ensure_documents_column(conn, column_name, column_type='TEXT'):
    safe_column = str(column_name or '').strip()
    safe_type = str(column_type or 'TEXT').strip().upper()
    if not safe_column:
        return
    if documents_column_exists(conn, safe_column):
        return
    conn.execute(f'ALTER TABLE documents ADD COLUMN {safe_column} {safe_type}')


def ensure_documents_columns(conn, timestamp_type='TEXT'):
    ensure_documents_column(conn, 'content_html', 'TEXT')
    ensure_documents_column(conn, 'category', 'TEXT')
    ensure_documents_column(conn, 'workspace_id', 'TEXT')
    ensure_documents_column(conn, 'deleted_at', 'TEXT')
    ensure_documents_column(conn, 'processing_status', 'TEXT')
    ensure_documents_column(conn, 'processing_error', 'TEXT')
    ensure_documents_column(conn, 'processing_started_at', timestamp_type)
    ensure_documents_column(conn, 'processed_at', timestamp_type)
    ensure_documents_column(conn, 'summary_text', 'TEXT')
    ensure_documents_column(conn, 'summary_source', 'TEXT')
    ensure_documents_column(conn, 'summary_model', 'TEXT')
    ensure_documents_column(conn, 'extractive_summary', 'TEXT')
    ensure_documents_column(conn, 'ai_summary', 'TEXT')
    ensure_documents_column(conn, 'key_sentences_json', 'TEXT')
    ensure_documents_column(conn, 'summary_generated_at', timestamp_type)
    ensure_documents_column(conn, 'summary_error', 'TEXT')
    ensure_documents_column(conn, 'summary_input_hash', 'TEXT')
    ensure_documents_column(conn, 'summary_cache_key', 'TEXT')
    conn.execute(
        '''
        UPDATE documents
        SET processing_status = 'processed'
        WHERE processing_status IS NULL OR TRIM(CAST(processing_status AS TEXT)) = ''
        '''
    )
    conn.execute(
        '''
        UPDATE documents
        SET processed_at = uploaded_at
        WHERE processing_status = 'processed'
          AND (processed_at IS NULL OR TRIM(CAST(processed_at AS TEXT)) = '')
        '''
    )


def ensure_workspaces_column(conn, column_name, column_type='TEXT'):
    safe_column = str(column_name or '').strip()
    safe_type = str(column_type or 'TEXT').strip().upper()
    if not safe_column:
        return
    if table_column_exists(conn, 'workspaces', safe_column):
        return
    conn.execute(f'ALTER TABLE workspaces ADD COLUMN {safe_column} {safe_type}')


def ensure_workspaces_columns(conn):
    ensure_workspaces_column(conn, 'settings_json', 'TEXT')


def ensure_document_share_links_column(conn, column_name, column_type='TEXT'):
    safe_column = str(column_name or '').strip()
    safe_type = str(column_type or 'TEXT').strip()
    if not safe_column:
        return
    if table_column_exists(conn, 'document_share_links', safe_column):
        return
    conn.execute(f'ALTER TABLE document_share_links ADD COLUMN {safe_column} {safe_type}')


def ensure_document_share_links_columns(conn):
    ensure_document_share_links_column(conn, 'recipient_email', 'TEXT')


def ensure_friend_messages_column(conn, column_name, column_type='TEXT'):
    safe_column = str(column_name or '').strip()
    safe_type = str(column_type or 'TEXT').strip()
    if not safe_column:
        return
    if table_column_exists(conn, 'friend_messages', safe_column):
        return
    conn.execute(f'ALTER TABLE friend_messages ADD COLUMN {safe_column} {safe_type}')


def ensure_friend_messages_columns(conn):
    ensure_friend_messages_column(conn, 'message_type', 'TEXT')
    ensure_friend_messages_column(conn, 'metadata_json', 'TEXT')
    conn.execute(
        '''
        UPDATE friend_messages
        SET message_type = 'text'
        WHERE message_type IS NULL OR TRIM(CAST(message_type AS TEXT)) = ''
        '''
    )


def ensure_users_column(conn, column_name, column_type='TEXT'):
    safe_column = str(column_name or '').strip()
    safe_type = str(column_type or 'TEXT').strip()
    if not safe_column:
        return
    if table_column_exists(conn, 'users', safe_column):
        return
    conn.execute(f'ALTER TABLE users ADD COLUMN {safe_column} {safe_type}')


def ensure_users_columns(conn, timestamp_type='TEXT'):
    email_verified_type = 'BOOLEAN NOT NULL DEFAULT FALSE' if conn.db_type == 'postgres' else 'INTEGER NOT NULL DEFAULT 0'
    email_notifications_type = 'BOOLEAN NOT NULL DEFAULT TRUE' if conn.db_type == 'postgres' else 'INTEGER NOT NULL DEFAULT 1'
    ensure_users_column(conn, 'friend_code', 'TEXT')
    ensure_users_column(conn, 'email_verified', email_verified_type)
    ensure_users_column(conn, 'email_verification_token', 'TEXT')
    ensure_users_column(conn, 'email_verification_expires_at', timestamp_type)
    ensure_users_column(conn, 'verified_at', timestamp_type)
    ensure_users_column(conn, 'email_notifications_enabled', email_notifications_type)

    backfill_verified_at = utcnow_iso()
    verified_value = True if conn.db_type == 'postgres' else 1
    if conn.db_type == 'postgres':
        conn.execute(
            '''
            UPDATE users
            SET email_verified = ?,
                verified_at = COALESCE(verified_at, ?)
            WHERE (email_verified IS NULL OR email_verified = FALSE)
              AND (email_verification_token IS NULL OR email_verification_token = '')
              AND email_verification_expires_at IS NULL
            ''',
            (verified_value, backfill_verified_at),
        )
    else:
        conn.execute(
            '''
            UPDATE users
            SET email_verified = ?,
                verified_at = COALESCE(verified_at, ?)
            WHERE (email_verified IS NULL OR email_verified = 0)
              AND (email_verification_token IS NULL OR email_verification_token = '')
              AND email_verification_expires_at IS NULL
            ''',
            (verified_value, backfill_verified_at),
        )


def init_db():
    conn = get_db_connection()
    if not conn:
        print('⚠️ Warning: Could not connect to database for initialization.')
        return

    print(f'✅ Connected to database type: {conn.db_type}')

    if conn.db_type == 'postgres':
        id_type = 'SERIAL PRIMARY KEY'
        timestamp_type = 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
        optional_timestamp_type = 'TIMESTAMP'
    else:
        id_type = 'INTEGER PRIMARY KEY AUTOINCREMENT'
        timestamp_type = 'TEXT'
        optional_timestamp_type = 'TEXT'

    users_sql = f'''
        CREATE TABLE IF NOT EXISTS users (
            id {id_type},
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE,
            friend_code TEXT,
            password_hash TEXT NOT NULL,
            email_verified {'BOOLEAN NOT NULL DEFAULT FALSE' if conn.db_type == 'postgres' else 'INTEGER NOT NULL DEFAULT 0'},
            email_verification_token TEXT,
            email_verification_expires_at {optional_timestamp_type},
            verified_at {optional_timestamp_type},
            email_notifications_enabled {'BOOLEAN NOT NULL DEFAULT TRUE' if conn.db_type == 'postgres' else 'INTEGER NOT NULL DEFAULT 1'}
        );
    '''

    docs_sql = f'''
        CREATE TABLE IF NOT EXISTS documents (
            id {id_type},
            filename TEXT NOT NULL,
            title TEXT,
            uploaded_at {timestamp_type},
            file_type TEXT,
            content TEXT,
            content_html TEXT,
            tags TEXT,
            category TEXT,
            workspace_id TEXT,
            username TEXT,
            last_access_at {timestamp_type},
            deleted_at {timestamp_type},
            processing_status TEXT NOT NULL DEFAULT 'processed',
            processing_error TEXT,
            processing_started_at {optional_timestamp_type},
            processed_at {timestamp_type},
            summary_text TEXT,
            summary_source TEXT,
            summary_model TEXT,
            extractive_summary TEXT,
            ai_summary TEXT,
            key_sentences_json TEXT,
            summary_generated_at {optional_timestamp_type},
            summary_error TEXT,
            summary_input_hash TEXT,
            summary_cache_key TEXT
        );
    '''

    workspaces_sql = f'''
        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            plan TEXT NOT NULL DEFAULT 'Free',
            owner_username TEXT NOT NULL,
            settings_json TEXT,
            created_at {timestamp_type},
            updated_at {timestamp_type}
        );
    '''

    workspace_members_sql = f'''
        CREATE TABLE IF NOT EXISTS workspace_members (
            id {id_type},
            workspace_id TEXT NOT NULL,
            username TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            status TEXT NOT NULL DEFAULT 'active',
            created_at {timestamp_type}
        );
    '''

    workspace_invitations_sql = f'''
        CREATE TABLE IF NOT EXISTS workspace_invitations (
            id {id_type},
            workspace_id TEXT NOT NULL,
            email TEXT NOT NULL,
            token TEXT UNIQUE NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            expires_at {timestamp_type},
            created_at {timestamp_type},
            requested_username TEXT,
            requested_at {timestamp_type},
            reviewed_by TEXT,
            reviewed_at {timestamp_type},
            review_note TEXT
        );
    '''

    document_share_links_sql = f'''
        CREATE TABLE IF NOT EXISTS document_share_links (
            id {id_type},
            document_id INTEGER NOT NULL,
            workspace_id TEXT,
            token TEXT UNIQUE NOT NULL,
            created_by TEXT,
            recipient_email TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            expires_at {timestamp_type},
            created_at {timestamp_type},
            last_access_at {timestamp_type}
        );
    '''

    document_summary_cache_sql = f'''
        CREATE TABLE IF NOT EXISTS document_summary_cache (
            id {id_type},
            document_id INTEGER NOT NULL,
            workspace_id TEXT,
            username TEXT,
            content_hash TEXT NOT NULL,
            summary_length TEXT NOT NULL,
            keyword_limit INTEGER NOT NULL DEFAULT 5,
            summary_json TEXT NOT NULL,
            summary_source TEXT,
            summary_note TEXT,
            created_at {timestamp_type},
            updated_at {timestamp_type}
        );
    '''

    summary_generation_locks_sql = '''
        CREATE TABLE IF NOT EXISTS summary_generation_locks (
            document_id INTEGER NOT NULL,
            summary_cache_key TEXT NOT NULL,
            lock_token TEXT,
            lease_expires_at TEXT NOT NULL,
            created_at TEXT,
            updated_at TEXT,
            PRIMARY KEY (document_id, summary_cache_key)
        );
    '''

    feedback_items_sql = f'''
        CREATE TABLE IF NOT EXISTS feedback_items (
            id {id_type},
            username TEXT NOT NULL,
            user_email_snapshot TEXT,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'medium',
            status TEXT NOT NULL DEFAULT 'new',
            page_path TEXT,
            workspace_id TEXT,
            document_id INTEGER,
            user_agent TEXT,
            assigned_to TEXT,
            created_at {timestamp_type},
            updated_at {timestamp_type},
            resolved_at {optional_timestamp_type}
        );
    '''

    feedback_events_sql = f'''
        CREATE TABLE IF NOT EXISTS feedback_events (
            id {id_type},
            feedback_id INTEGER NOT NULL,
            actor_username TEXT,
            actor_role TEXT NOT NULL DEFAULT 'system',
            event_type TEXT NOT NULL,
            old_status TEXT,
            new_status TEXT,
            message TEXT,
            visibility TEXT NOT NULL DEFAULT 'internal',
            created_at {timestamp_type}
        );
    '''

    friend_requests_sql = f'''
        CREATE TABLE IF NOT EXISTS friend_requests (
            id {id_type},
            requester_username TEXT NOT NULL,
            target_username TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            message TEXT,
            created_at {timestamp_type},
            responded_at {optional_timestamp_type}
        );
    '''

    friendships_sql = f'''
        CREATE TABLE IF NOT EXISTS friendships (
            id {id_type},
            user_a TEXT NOT NULL,
            user_b TEXT NOT NULL,
            created_at {timestamp_type}
        );
    '''

    friend_messages_sql = f'''
        CREATE TABLE IF NOT EXISTS friend_messages (
            id {id_type},
            sender_username TEXT NOT NULL,
            recipient_username TEXT NOT NULL,
            body TEXT NOT NULL,
            message_type TEXT,
            metadata_json TEXT,
            created_at {timestamp_type},
            read_at {optional_timestamp_type}
        );
    '''

    user_notifications_sql = f'''
        CREATE TABLE IF NOT EXISTS user_notifications (
            id {id_type},
            username TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'system',
            title TEXT NOT NULL,
            body TEXT,
            actor_username TEXT,
            link_url TEXT,
            metadata_json TEXT,
            created_at {timestamp_type},
            read_at {optional_timestamp_type}
        );
    '''

    registration_email_codes_sql = f'''
        CREATE TABLE IF NOT EXISTS registration_email_codes (
            email TEXT PRIMARY KEY,
            code_hash TEXT NOT NULL,
            expires_at {optional_timestamp_type} NOT NULL,
            sent_at {timestamp_type}
        );
    '''

    workspace_members_unique_sql = '''
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_workspace_user
        ON workspace_members(workspace_id, username);
    '''

    workspace_owner_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_workspaces_owner_username
        ON workspaces(owner_username);
    '''

    users_email_verification_token_idx_sql = '''
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_verification_token
        ON users(email_verification_token);
    '''

    users_friend_code_idx_sql = '''
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_friend_code
        ON users(friend_code)
        WHERE friend_code IS NOT NULL AND friend_code <> '';
    '''

    workspace_invitation_lookup_sql = '''
        CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace_status
        ON workspace_invitations(workspace_id, status);
    '''

    document_share_links_doc_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_document_share_links_doc_status
        ON document_share_links(document_id, status);
    '''

    document_summary_cache_lookup_idx_sql = '''
        CREATE UNIQUE INDEX IF NOT EXISTS idx_document_summary_cache_lookup
        ON document_summary_cache(document_id, content_hash, summary_length, keyword_limit);
    '''

    document_summary_cache_recent_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_document_summary_cache_updated
        ON document_summary_cache(updated_at);
    '''

    summary_generation_locks_expires_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_summary_generation_locks_expires
        ON summary_generation_locks(lease_expires_at);
    '''

    documents_owner_deleted_uploaded_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_documents_owner_deleted_uploaded
        ON documents(username, deleted_at, uploaded_at);
    '''

    documents_workspace_deleted_uploaded_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_documents_workspace_deleted_uploaded
        ON documents(username, workspace_id, deleted_at, uploaded_at);
    '''

    documents_owner_category_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_documents_owner_category
        ON documents(username, category);
    '''

    documents_owner_file_type_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_documents_owner_file_type
        ON documents(username, file_type);
    '''

    feedback_items_user_updated_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_feedback_items_user_updated
        ON feedback_items(username, updated_at);
    '''

    feedback_items_status_updated_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_feedback_items_status_updated
        ON feedback_items(status, updated_at);
    '''

    feedback_events_feedback_created_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_feedback_events_feedback_created
        ON feedback_events(feedback_id, created_at);
    '''

    friend_requests_target_status_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_friend_requests_target_status
        ON friend_requests(target_username, status, created_at);
    '''

    friend_requests_requester_status_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_friend_requests_requester_status
        ON friend_requests(requester_username, status, created_at);
    '''

    friendships_pair_unique_sql = '''
        CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair
        ON friendships(user_a, user_b);
    '''

    friendships_user_a_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_friendships_user_a
        ON friendships(user_a, created_at);
    '''

    friendships_user_b_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_friendships_user_b
        ON friendships(user_b, created_at);
    '''

    friend_messages_recipient_read_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_friend_messages_recipient_read
        ON friend_messages(recipient_username, read_at, created_at);
    '''

    friend_messages_pair_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_friend_messages_pair
        ON friend_messages(sender_username, recipient_username, created_at);
    '''

    user_notifications_username_read_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_user_notifications_username_read
        ON user_notifications(username, read_at, created_at);
    '''

    registration_email_codes_expires_idx_sql = '''
        CREATE INDEX IF NOT EXISTS idx_registration_email_codes_expires
        ON registration_email_codes(expires_at);
    '''

    try:
        conn.execute(users_sql)
        conn.execute(docs_sql)
        conn.execute(workspaces_sql)
        conn.execute(workspace_members_sql)
        conn.execute(workspace_invitations_sql)
        conn.execute(document_share_links_sql)
        conn.execute(document_summary_cache_sql)
        conn.execute(summary_generation_locks_sql)
        conn.execute(feedback_items_sql)
        conn.execute(feedback_events_sql)
        conn.execute(friend_requests_sql)
        conn.execute(friendships_sql)
        conn.execute(friend_messages_sql)
        conn.execute(user_notifications_sql)
        conn.execute(registration_email_codes_sql)
        ensure_users_columns(conn, optional_timestamp_type)
        backfill_user_friend_codes(conn)
        ensure_documents_columns(conn, optional_timestamp_type)
        ensure_workspaces_columns(conn)
        ensure_document_share_links_columns(conn)
        ensure_friend_messages_columns(conn)
        conn.execute(workspace_members_unique_sql)
        conn.execute(workspace_owner_idx_sql)
        conn.execute(users_email_verification_token_idx_sql)
        conn.execute(users_friend_code_idx_sql)
        conn.execute(workspace_invitation_lookup_sql)
        conn.execute(document_share_links_doc_idx_sql)
        conn.execute(document_summary_cache_lookup_idx_sql)
        conn.execute(document_summary_cache_recent_idx_sql)
        conn.execute(summary_generation_locks_expires_idx_sql)
        conn.execute(documents_owner_deleted_uploaded_idx_sql)
        conn.execute(documents_workspace_deleted_uploaded_idx_sql)
        conn.execute(documents_owner_category_idx_sql)
        conn.execute(documents_owner_file_type_idx_sql)
        conn.execute(feedback_items_user_updated_idx_sql)
        conn.execute(feedback_items_status_updated_idx_sql)
        conn.execute(feedback_events_feedback_created_idx_sql)
        conn.execute(friend_requests_target_status_idx_sql)
        conn.execute(friend_requests_requester_status_idx_sql)
        conn.execute(friendships_pair_unique_sql)
        conn.execute(friendships_user_a_idx_sql)
        conn.execute(friendships_user_b_idx_sql)
        conn.execute(friend_messages_recipient_read_idx_sql)
        conn.execute(friend_messages_pair_idx_sql)
        conn.execute(user_notifications_username_read_idx_sql)
        conn.execute(registration_email_codes_expires_idx_sql)

        from .document_search import ensure_document_search_support
        from .workspace_domain import backfill_documents_workspace_ids

        ensure_document_search_support(conn)
        backfill_documents_workspace_ids(conn)
        conn.commit()
        print('✅ Database tables initialized successfully.')
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        print(f'❌ Error initializing tables: {e}')
        raise
    finally:
        conn.close()
