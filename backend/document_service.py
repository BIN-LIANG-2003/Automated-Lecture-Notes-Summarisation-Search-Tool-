import io
import os
import uuid
from datetime import datetime

from flask import current_app, jsonify, request, send_file

from .config import DEFAULT_DOCUMENT_CATEGORY, DEFAULT_WORKSPACE_SETTINGS, MIME_BY_EXT, S3_BUCKET, s3_client, TRASH_RETENTION_DAYS
from .db import get_db_connection
from .document_domain import (
    build_editable_file_bytes,
    extract_document_content,
    extract_text_from_pdf_bytes,
    hard_delete_document_record,
    html_to_plaintext,
    infer_document_category,
    plaintext_to_html,
    purge_expired_trashed_documents,
    sanitize_editor_html,
    user_can_edit_document,
)
from .share_domain import (
    check_document_access,
    get_document_link_sharing_mode,
    is_document_soft_deleted,
    user_can_manage_document_share_links,
)
from .storage import allowed_file, detect_mimetype, read_file_bytes_from_storage, remove_document_file_from_storage, write_file_bytes_to_storage
from .utils import normalize_document_category, parse_bool, parse_int, row_to_dict, utcnow_iso
from .workspace_domain import get_or_create_default_workspace_id, get_workspace_record, get_workspace_settings, normalize_workspace_settings, workspace_belongs_to_user


def get_documents():
    username = (request.args.get('username') or '').strip()
    workspace_id = (request.args.get('workspace_id') or '').strip()
    if not username:
        return jsonify({'error': 'username is required'}), 400

    query = (request.args.get('q') or '').strip().lower()
    tag_filter = (request.args.get('tag') or '').strip().lower()
    category_filter = (request.args.get('category') or '').strip().lower()
    start_date = (request.args.get('start_date') or '').strip()
    end_date = (request.args.get('end_date') or '').strip()
    file_type_filter = (request.args.get('file_type') or '').strip().lower().lstrip('.')
    include_meta = parse_bool(request.args.get('include_meta') or request.args.get('meta'), False)
    include_facets = parse_bool(request.args.get('include_facets'), False)
    limit = parse_int(request.args.get('limit'), 20, 1, 100)
    offset = parse_int(request.args.get('offset'), 0, 0)
    sort_key = (request.args.get('sort') or 'newest').strip().lower()
    order_by_map = {
        'newest': "uploaded_at DESC, id DESC",
        'oldest': "uploaded_at ASC, id ASC",
        'title_asc': "LOWER(COALESCE(title, '')) ASC, id ASC",
        'title_desc': "LOWER(COALESCE(title, '')) DESC, id DESC",
        'category_asc': "LOWER(COALESCE(category, '')) ASC, LOWER(COALESCE(title, '')) ASC, id ASC",
    }
    order_by_sql = order_by_map.get(sort_key, order_by_map['newest'])

    conn = get_db_connection()
    try:
        if workspace_id and not workspace_belongs_to_user(conn, workspace_id, username):
            return jsonify({'error': 'No access to this workspace'}), 403

        where_parts = [
            'username = ?',
            "COALESCE(deleted_at, '') = ''",
        ]
        params = [username]
        if workspace_id:
            where_parts.append('workspace_id = ?')
            params.append(workspace_id)
        if category_filter:
            where_parts.append("LOWER(COALESCE(category, '')) = ?")
            params.append(category_filter)
        if tag_filter:
            where_parts.append("(',' || LOWER(COALESCE(tags, '')) || ',') LIKE ?")
            params.append(f'%,{tag_filter},%')
        if query:
            where_parts.append(
                "("
                "LOWER(COALESCE(title, '')) LIKE ? OR "
                "LOWER(COALESCE(category, '')) LIKE ? OR "
                "LOWER(COALESCE(content, '')) LIKE ? OR "
                "LOWER(COALESCE(tags, '')) LIKE ?"
                ")"
            )
            like_query = f'%{query}%'
            params.extend([like_query, like_query, like_query, like_query])
        if start_date:
            where_parts.append("COALESCE(uploaded_at, '') >= ?")
            params.append(f'{start_date}T00:00:00')
        if end_date:
            where_parts.append("COALESCE(uploaded_at, '') <= ?")
            params.append(f'{end_date}T23:59:59')
        if file_type_filter:
            if file_type_filter in ('image', 'images'):
                image_exts = ('png', 'jpg', 'jpeg', 'webp', 'gif')
                placeholders = ','.join('?' for _ in image_exts)
                where_parts.append(f"LOWER(COALESCE(file_type, '')) IN ({placeholders})")
                params.extend(image_exts)
            elif file_type_filter in ('editable', 'editables'):
                editable_exts = ('txt', 'docx')
                placeholders = ','.join('?' for _ in editable_exts)
                where_parts.append(f"LOWER(COALESCE(file_type, '')) IN ({placeholders})")
                params.extend(editable_exts)
            elif file_type_filter.isalnum() and len(file_type_filter) <= 12:
                where_parts.append("LOWER(COALESCE(file_type, '')) = ?")
                params.append(file_type_filter)

        where_sql = ' AND '.join(where_parts)

        total_cursor = conn.execute(
            f'''
            SELECT COUNT(1) AS total
            FROM documents
            WHERE {where_sql}
            ''',
            params,
        )
        total_row = row_to_dict(total_cursor.fetchone()) or {}
        total = parse_int(total_row.get('total', 0), 0, 0)

        cursor = conn.execute(
            f'''
            SELECT *
            FROM documents
            WHERE {where_sql}
            ORDER BY {order_by_sql}
            LIMIT ? OFFSET ?
            ''',
            [*params, limit, offset],
        )
        docs = [dict(doc) for doc in cursor.fetchall()]
        if include_meta:
            payload = {
                'items': docs,
                'total': total,
                'limit': limit,
                'offset': offset,
                'has_more': (offset + len(docs)) < total,
            }
            if include_facets:
                facet_cursor = conn.execute(
                    f'''
                    SELECT category, tags, file_type
                    FROM documents
                    WHERE {where_sql}
                    ''',
                    params,
                )
                tag_set = set()
                category_set = set()
                file_type_counts = {}
                for row in facet_cursor.fetchall():
                    item = row_to_dict(row)
                    category = normalize_document_category((item or {}).get('category', ''))
                    category_set.add(category or DEFAULT_DOCUMENT_CATEGORY)
                    raw_tags = str((item or {}).get('tags') or '')
                    for raw_tag in raw_tags.split(','):
                        safe_tag = raw_tag.strip()
                        if safe_tag:
                            tag_set.add(safe_tag)
                    ext = str((item or {}).get('file_type') or '').strip().lower().strip('.')
                    if ext:
                        file_type_counts[ext] = file_type_counts.get(ext, 0) + 1
                        if ext in ('png', 'jpg', 'jpeg', 'webp', 'gif'):
                            file_type_counts['image'] = file_type_counts.get('image', 0) + 1
                        if ext in ('txt', 'docx'):
                            file_type_counts['editable'] = file_type_counts.get('editable', 0) + 1
                payload['facets'] = {
                    'tags': sorted(tag_set, key=lambda value: value.lower()),
                    'categories': sorted(category_set, key=lambda value: value.lower()),
                    'file_types': file_type_counts,
                }
            return jsonify(payload), 200
        return jsonify(docs), 200
    finally:
        conn.close()


def get_trashed_documents():
    username = (request.args.get('username') or '').strip()
    workspace_id = (request.args.get('workspace_id') or '').strip()
    if not username:
        return jsonify({'error': 'username is required'}), 400

    query = (request.args.get('q') or '').strip().lower()
    sort_key = (request.args.get('sort') or 'deleted_newest').strip().lower()
    order_by_map = {
        'deleted_newest': "deleted_at DESC, id DESC",
        'deleted_oldest': "deleted_at ASC, id ASC",
        'title_asc': "LOWER(COALESCE(title, '')) ASC, id ASC",
        'title_desc': "LOWER(COALESCE(title, '')) DESC, id DESC",
    }
    order_by_sql = order_by_map.get(sort_key, order_by_map['deleted_newest'])
    limit = parse_int(request.args.get('limit'), 100, 1, 300)
    offset = parse_int(request.args.get('offset'), 0, 0)

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500

    try:
        if workspace_id and not workspace_belongs_to_user(conn, workspace_id, username):
            return jsonify({'error': 'No access to this workspace'}), 403

        purge_result = purge_expired_trashed_documents(conn, username=username, workspace_id=workspace_id)

        where_parts = [
            'username = ?',
            "COALESCE(deleted_at, '') <> ''",
        ]
        params = [username]
        if workspace_id:
            where_parts.append('workspace_id = ?')
            params.append(workspace_id)
        if query:
            where_parts.append(
                "("
                "LOWER(COALESCE(title, '')) LIKE ? OR "
                "LOWER(COALESCE(filename, '')) LIKE ? OR "
                "LOWER(COALESCE(category, '')) LIKE ? OR "
                "LOWER(COALESCE(content, '')) LIKE ? OR "
                "LOWER(COALESCE(tags, '')) LIKE ?"
                ")"
            )
            like_query = f'%{query}%'
            params.extend([like_query, like_query, like_query, like_query, like_query])
        where_sql = ' AND '.join(where_parts)

        total_cursor = conn.execute(
            f'''
            SELECT COUNT(1) AS total
            FROM documents
            WHERE {where_sql}
            ''',
            tuple(params),
        )
        total_row = row_to_dict(total_cursor.fetchone()) or {}
        total = parse_int(total_row.get('total', 0), 0, 0)

        cursor = conn.execute(
            f'''
            SELECT *
            FROM documents
            WHERE {where_sql}
            ORDER BY {order_by_sql}
            LIMIT ? OFFSET ?
            ''',
            tuple([*params, limit, offset]),
        )
        items = [row_to_dict(item) for item in cursor.fetchall()]
        return jsonify({
            'items': items,
            'total': total,
            'limit': limit,
            'offset': offset,
            'q': query,
            'sort': sort_key,
            'retention_days': TRASH_RETENTION_DAYS,
            'purged_count': parse_int((purge_result or {}).get('purged_count', 0), 0, 0),
            'warnings': (purge_result or {}).get('warnings') if isinstance((purge_result or {}).get('warnings'), list) else [],
        }), 200
    finally:
        conn.close()


def clear_workspace_documents(workspace_id):
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
        if workspace_row.get('owner_username') != username:
            return jsonify({'error': 'Only workspace owner can clear workspace documents'}), 403

        docs_cursor = conn.execute(
            'SELECT id, filename FROM documents WHERE workspace_id = ?',
            (workspace_id,),
        )
        docs = [row_to_dict(item) for item in docs_cursor.fetchall()]
        if not docs:
            return jsonify({'deleted_count': 0, 'warnings': []}), 200

        doc_ids = [parse_int(item.get('id'), 0, 0) for item in docs]
        doc_ids = [item for item in doc_ids if item > 0]
        if doc_ids:
            placeholders = ','.join(['?'] * len(doc_ids))
            conn.execute(f'DELETE FROM document_share_links WHERE document_id IN ({placeholders})', tuple(doc_ids))
            conn.execute(f'DELETE FROM document_summary_cache WHERE document_id IN ({placeholders})', tuple(doc_ids))

        conn.execute('DELETE FROM documents WHERE workspace_id = ?', (workspace_id,))
        conn.commit()
    finally:
        conn.close()

    warnings = []
    for doc in docs:
        warning = remove_document_file_from_storage(str(doc.get('filename') or '').strip())
        if warning:
            warnings.append(f"{str(doc.get('filename') or '').strip()}: {warning}")

    return jsonify({
        'workspace_id': workspace_id,
        'deleted_count': len(docs),
        'warnings': warnings,
    }), 200


def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400

    file = request.files['file']
    username = (request.form.get('username') or 'Anonymous').strip()
    requested_workspace_id = (request.form.get('workspace_id') or '').strip()
    requested_category = normalize_document_category(request.form.get('category', ''))

    if requested_workspace_id and username:
        conn = get_db_connection()
        if not conn:
            return jsonify({'error': 'Database connection failed'}), 500
        try:
            if not workspace_belongs_to_user(conn, requested_workspace_id, username):
                return jsonify({'error': 'No access to this workspace'}), 403
        finally:
            conn.close()

    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    if not (file and allowed_file(file.filename)):
        return jsonify({'error': 'File type not allowed'}), 400

    original_filename = file.filename
    try:
        ext = original_filename.rsplit('.', 1)[1].lower()
    except IndexError:
        return jsonify({'error': 'Filename must have an extension'}), 400

    unique_filename = f"{uuid.uuid4().hex}.{ext}"
    local_filepath = os.path.join(current_app.config['UPLOAD_FOLDER'], unique_filename)
    file.save(local_filepath)

    try:
        extracted_text, extracted_html = extract_document_content(local_filepath, ext)

        try:
            if S3_BUCKET and s3_client:
                print(f"🚀 Uploading to S3: {S3_BUCKET}")
                s3_client.upload_file(
                    local_filepath,
                    S3_BUCKET,
                    unique_filename,
                    ExtraArgs={'ContentType': file.content_type},
                )
                print("✅ Upload to S3 successful")
                os.remove(local_filepath)
                print("🗑️ Local file removed")
            else:
                print("⚠️ S3_BUCKET not set or client failed, keeping local file")
        except Exception as e:
            print(f"❌ S3 Upload Error: {e}")
            return jsonify({'error': f'Failed to upload to S3: {str(e)}'}), 500

        conn = get_db_connection()
        if not conn:
            return jsonify({'error': 'Database connection failed'}), 500
        try:
            workspace_id = ''
            workspace_settings = dict(DEFAULT_WORKSPACE_SETTINGS)
            if username:
                if requested_workspace_id:
                    if not workspace_belongs_to_user(conn, requested_workspace_id, username):
                        return jsonify({'error': 'No access to this workspace'}), 403
                    workspace_id = requested_workspace_id
                else:
                    workspace_id = get_or_create_default_workspace_id(conn, username)

                workspace_row = get_workspace_record(conn, workspace_id)
                workspace_settings = normalize_workspace_settings((workspace_row or {}).get('settings_json'))
                if not workspace_settings.get('allow_uploads', True):
                    return jsonify({'error': 'Uploads are disabled in this workspace settings'}), 403

            if requested_category:
                final_category = requested_category
            elif workspace_settings.get('auto_categorize', True):
                final_category = infer_document_category(original_filename, extracted_text)
            else:
                final_category = normalize_document_category(workspace_settings.get('default_category'))
                if not final_category:
                    final_category = DEFAULT_DOCUMENT_CATEGORY

            conn.execute(
                '''
                INSERT INTO documents (
                    filename, title, uploaded_at, file_type, content, content_html, username, tags, category, workspace_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    unique_filename,
                    original_filename,
                    datetime.utcnow().isoformat(),
                    ext,
                    extracted_text,
                    extracted_html if ext in ('docx', 'txt') else '',
                    username,
                    '',
                    final_category,
                    workspace_id,
                ),
            )
            conn.commit()
            return jsonify({'message': 'File uploaded successfully'}), 201
        except Exception as e:
            print(f"Database Error: {e}")
            return jsonify({'error': 'Database save failed'}), 500
        finally:
            conn.close()
    finally:
        if os.path.exists(local_filepath) and not (S3_BUCKET and s3_client):
            pass


def get_document(doc_id):
    username = (request.args.get('username') or '').strip()
    share_token = (request.args.get('share_token') or '').strip()
    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        if is_document_soft_deleted(doc):
            return jsonify({'error': 'Document is in Trash'}), 404
        allowed, reason = check_document_access(conn, doc, username, share_token)
        if not allowed:
            return jsonify({'error': reason}), 403

        conn.execute('UPDATE documents SET last_access_at = ? WHERE id = ?', (datetime.utcnow().isoformat(), doc_id))
        conn.commit()
        doc_data = dict(doc)
        workspace_id = str(doc_data.get('workspace_id') or '').strip()
        workspace_settings = get_workspace_settings(conn, workspace_id)
        doc_data['link_sharing_mode'] = get_document_link_sharing_mode(conn, doc)
        doc_data['can_manage_share_links'] = user_can_manage_document_share_links(conn, doc, username)
        doc_data['allow_ai_tools'] = parse_bool(workspace_settings.get('allow_ai_tools', True), True)
        doc_data['allow_ocr'] = parse_bool(workspace_settings.get('allow_ocr', True), True)
        doc_data['allow_export'] = parse_bool(workspace_settings.get('allow_export', True), True)
        doc_data['summary_length'] = str(
            workspace_settings.get('summary_length', DEFAULT_WORKSPACE_SETTINGS.get('summary_length', 'medium')) or 'medium'
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


def delete_document(doc_id):
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or request.args.get('username') or '').strip()
    permanent = parse_bool(data.get('permanent') or request.args.get('permanent'), False)
    if not username:
        return jsonify({'error': 'username is required'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        cursor = conn.execute('SELECT id, filename, username, deleted_at FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        owner = (doc.get('username') if hasattr(doc, 'get') else doc['username']) or ''
        if owner and username != owner:
            return jsonify({'error': 'You can only delete your own documents'}), 403

        was_deleted = is_document_soft_deleted(doc)
        if permanent:
            deleted = hard_delete_document_record(conn, doc_id)
            if not deleted:
                return jsonify({'error': 'Document not found'}), 404
            conn.commit()
        else:
            if was_deleted:
                return jsonify({
                    'message': 'Document is already in Trash',
                    'id': doc_id,
                    'moved_to_trash': True,
                    'already_deleted': True,
                }), 200
            now_iso = utcnow_iso()
            conn.execute(
                'UPDATE documents SET deleted_at = ?, last_access_at = ? WHERE id = ?',
                (now_iso, now_iso, doc_id),
            )
            conn.execute('DELETE FROM document_share_links WHERE document_id = ?', (doc_id,))
            conn.commit()
    finally:
        conn.close()

    cleanup_warning = ''
    if permanent:
        cleanup_warning = remove_document_file_from_storage((deleted or {}).get('filename', ''))

    response = {
        'id': doc_id,
        'message': 'Document deleted permanently' if permanent else 'Document moved to Trash',
        'moved_to_trash': not permanent,
        'permanent': permanent,
        'trash_retention_days': TRASH_RETENTION_DAYS,
    }
    if cleanup_warning:
        response['warning'] = cleanup_warning
    return jsonify(response), 200


def restore_document(doc_id):
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
        doc_data = row_to_dict(doc) or {}
        owner = str(doc_data.get('username') or '').strip()
        if owner and owner != username:
            return jsonify({'error': 'You can only restore your own documents'}), 403
        if not is_document_soft_deleted(doc_data):
            return jsonify({'message': 'Document is already active', 'id': doc_id, 'restored': False}), 200

        conn.execute("UPDATE documents SET deleted_at = '' WHERE id = ?", (doc_id,))
        conn.commit()

        refreshed_cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        refreshed = row_to_dict(refreshed_cursor.fetchone()) or {}
        return jsonify({
            'message': 'Document restored successfully',
            'id': doc_id,
            'restored': True,
            'document': refreshed,
        }), 200
    finally:
        conn.close()


def update_document_tags(doc_id):
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or request.args.get('username') or '').strip()
    raw_tags = data.get('tags', [])

    if isinstance(raw_tags, list):
        tags_list = [str(tag).strip() for tag in raw_tags if str(tag).strip()]
    elif isinstance(raw_tags, str):
        tags_list = [tag.strip() for tag in raw_tags.split(',') if tag.strip()]
    else:
        return jsonify({'error': 'tags must be a list or comma-separated string'}), 400

    tags_value = ','.join(tags_list)

    conn = get_db_connection()
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        allowed, reason = check_document_access(conn, doc, username)
        if not allowed:
            return jsonify({'error': reason}), 403
        if not user_can_edit_document(conn, doc, username):
            return jsonify({'error': 'Only workspace members can edit this document'}), 403

        workspace_id = str((doc.get('workspace_id') if hasattr(doc, 'get') else doc['workspace_id']) or '').strip()
        workspace_settings = get_workspace_settings(conn, workspace_id)
        if not workspace_settings.get('allow_note_editing', True):
            return jsonify({'error': 'Editing is disabled in this workspace settings'}), 403

        conn.execute('UPDATE documents SET tags = ? WHERE id = ?', (tags_value, doc_id))
        conn.commit()

        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        return jsonify(dict(doc)), 200
    finally:
        conn.close()


def update_document_category(doc_id):
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or request.args.get('username') or '').strip()
    next_category = normalize_document_category(data.get('category', ''))
    if not next_category:
        next_category = DEFAULT_DOCUMENT_CATEGORY

    conn = get_db_connection()
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        allowed, reason = check_document_access(conn, doc, username)
        if not allowed:
            return jsonify({'error': reason}), 403
        if not user_can_edit_document(conn, doc, username):
            return jsonify({'error': 'Only workspace members can edit this document'}), 403

        workspace_id = str((doc.get('workspace_id') if hasattr(doc, 'get') else doc['workspace_id']) or '').strip()
        workspace_settings = get_workspace_settings(conn, workspace_id)
        if not workspace_settings.get('allow_note_editing', True):
            return jsonify({'error': 'Editing is disabled in this workspace settings'}), 403

        conn.execute('UPDATE documents SET category = ? WHERE id = ?', (next_category, doc_id))
        conn.commit()

        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        return jsonify(dict(doc)), 200
    finally:
        conn.close()


def update_document_content(doc_id):
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or request.args.get('username') or '').strip()
    content = data.get('content', '')
    content_html = data.get('content_html')

    if content is None:
        content = ''
    if not isinstance(content, str):
        return jsonify({'error': 'content must be a string'}), 400
    if content_html is not None and not isinstance(content_html, str):
        return jsonify({'error': 'content_html must be a string'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        allowed, reason = check_document_access(conn, doc, username)
        if not allowed:
            return jsonify({'error': reason}), 403
        if not user_can_edit_document(conn, doc, username):
            return jsonify({'error': 'Only workspace members can edit this document'}), 403

        workspace_id = str((doc.get('workspace_id') if hasattr(doc, 'get') else doc['workspace_id']) or '').strip()
        workspace_settings = get_workspace_settings(conn, workspace_id)
        if not workspace_settings.get('allow_note_editing', True):
            return jsonify({'error': 'Editing is disabled in this workspace settings'}), 403

        file_type = (doc.get('file_type') if hasattr(doc, 'get') else doc['file_type']) or ''
        file_type = str(file_type).lower().strip('.')
        existing_html = (doc.get('content_html') if hasattr(doc, 'get') else doc['content_html']) or ''

        if file_type in ('docx', 'txt'):
            if content_html is None:
                content_html = plaintext_to_html(content)
            if not content_html.strip() and existing_html.strip():
                content_html = existing_html
            content_html = sanitize_editor_html(content_html)
            content = html_to_plaintext(content_html)
        else:
            content_html = ''

        try:
            file_bytes, mimetype = build_editable_file_bytes(file_type, content, content_html)
            filename = doc.get('filename') if hasattr(doc, 'get') else doc['filename']
            write_file_bytes_to_storage(filename, file_bytes, mimetype)
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        except RuntimeError as e:
            return jsonify({'error': str(e)}), 500
        except Exception as e:
            print(f"File update failed: {e}")
            return jsonify({'error': 'Failed to update source file'}), 500

        conn.execute('UPDATE documents SET content = ?, content_html = ? WHERE id = ?', (content, content_html, doc_id))
        conn.commit()

        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        updated_doc = cursor.fetchone()
        return jsonify(dict(updated_doc)), 200
    finally:
        conn.close()


def import_document_text(doc_id):
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    share_token = (data.get('share_token') or '').strip()
    text = str(data.get('text') or '')
    text = text.replace('\r\n', '\n').replace('\r', '\n').strip()
    custom_title = str(data.get('title') or '').strip()

    if not username:
        return jsonify({'error': 'Please sign in to save OCR text as a note'}), 401
    if not text:
        return jsonify({'error': 'No text provided'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500

    unique_filename = ''
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        allowed, reason = check_document_access(conn, doc, username, share_token)
        if not allowed:
            return jsonify({'error': reason}), 403
        if not user_can_edit_document(conn, doc, username):
            return jsonify({'error': 'Only workspace members can save OCR results as notes'}), 403

        workspace_id = str((doc.get('workspace_id') if hasattr(doc, 'get') else doc['workspace_id']) or '').strip()
        workspace_settings = get_workspace_settings(conn, workspace_id)
        if not workspace_settings.get('allow_note_editing', True):
            return jsonify({'error': 'Editing is disabled in this workspace settings'}), 403

        source_title = str((doc.get('title') if hasattr(doc, 'get') else doc['title']) or 'Untitled').strip()
        source_category = normalize_document_category(
            (doc.get('category') if hasattr(doc, 'get') else doc['category']) or ''
        )
        note_title = custom_title or f'{source_title} OCR Note'
        content_html = sanitize_editor_html(plaintext_to_html(text))
        file_bytes, mimetype = build_editable_file_bytes('txt', text, content_html)

        unique_filename = f'{uuid.uuid4().hex}.txt'
        write_file_bytes_to_storage(unique_filename, file_bytes, mimetype)

        insert_cursor = conn.execute(
            '''
            INSERT INTO documents (
                filename, title, uploaded_at, file_type, content, content_html, username, tags, category, workspace_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            (
                unique_filename,
                note_title,
                datetime.utcnow().isoformat(),
                'txt',
                text,
                content_html,
                username,
                '',
                source_category or DEFAULT_DOCUMENT_CATEGORY,
                workspace_id,
            ),
        )
        conn.commit()

        new_doc_id = insert_cursor.lastrowid
        new_doc_cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (new_doc_id,))
        new_doc = new_doc_cursor.fetchone()
        return jsonify({
            'message': 'OCR note saved successfully',
            'new_doc_id': new_doc_id,
            'document': row_to_dict(new_doc) or {},
        }), 201
    except ValueError as e:
        if unique_filename:
            remove_document_file_from_storage(unique_filename)
        return jsonify({'error': str(e)}), 400
    except RuntimeError as e:
        if unique_filename:
            remove_document_file_from_storage(unique_filename)
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        if unique_filename:
            remove_document_file_from_storage(unique_filename)
        print(f"OCR text import failed: {e}")
        return jsonify({'error': 'Failed to save OCR note'}), 500
    finally:
        conn.close()


def update_document_pdf_file(doc_id):
    username = ((request.args.get('username') or request.form.get('username') or '').strip())
    if request.files and 'file' in request.files:
        file_bytes = request.files['file'].read()
    else:
        file_bytes = request.get_data(cache=False) or b''

    if not file_bytes:
        return jsonify({'error': 'No PDF data provided'}), 400
    if not file_bytes.lstrip().startswith(b'%PDF'):
        return jsonify({'error': 'Invalid PDF payload'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        allowed, reason = check_document_access(conn, doc, username)
        if not allowed:
            return jsonify({'error': reason}), 403
        if not user_can_edit_document(conn, doc, username):
            return jsonify({'error': 'Only workspace members can edit this document'}), 403

        workspace_id = str((doc.get('workspace_id') if hasattr(doc, 'get') else doc['workspace_id']) or '').strip()
        workspace_settings = get_workspace_settings(conn, workspace_id)
        if not workspace_settings.get('allow_note_editing', True):
            return jsonify({'error': 'Editing is disabled in this workspace settings'}), 403

        file_type = (doc.get('file_type') if hasattr(doc, 'get') else doc['file_type']) or ''
        if str(file_type).lower() != 'pdf':
            return jsonify({'error': 'This endpoint only supports PDF documents'}), 400

        filename = doc.get('filename') if hasattr(doc, 'get') else doc['filename']
        try:
            write_file_bytes_to_storage(filename, file_bytes, MIME_BY_EXT['pdf'])
        except Exception as e:
            print(f"PDF file update failed: {e}")
            return jsonify({'error': 'Failed to update source PDF file'}), 500

        extracted_text = extract_text_from_pdf_bytes(file_bytes)
        if not extracted_text.strip():
            extracted_text = (doc.get('content') if hasattr(doc, 'get') else doc['content']) or ''
        conn.execute('UPDATE documents SET content = ?, content_html = ? WHERE id = ?', (extracted_text, '', doc_id))
        conn.commit()

        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        updated_doc = cursor.fetchone()
        return jsonify(dict(updated_doc)), 200
    finally:
        conn.close()


def get_document_file(doc_id):
    username = (request.args.get('username') or '').strip()
    share_token = (request.args.get('share_token') or '').strip()
    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500
    try:
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        doc = cursor.fetchone()
        if not doc:
            return jsonify({'error': 'Document not found'}), 404

        allowed, reason = check_document_access(conn, doc, username, share_token)
        if not allowed:
            return jsonify({'error': reason}), 403

        doc_data = row_to_dict(doc) or {}
        filename = doc_data.get('filename', '')
        title = doc_data.get('title', '')
        file_ext = doc_data.get('file_type', '')
        mimetype = detect_mimetype(filename, file_ext)
    finally:
        conn.close()

    try:
        file_bytes = read_file_bytes_from_storage(filename)
    except FileNotFoundError:
        return jsonify({'error': 'File not found'}), 404
    except Exception as e:
        print(f"File stream error: {e}")
        return jsonify({'error': 'Could not read file from storage'}), 500

    return send_file(
        io.BytesIO(file_bytes),
        mimetype=mimetype,
        download_name=title or filename,
        as_attachment=False,
    )
