import io
import json
import os
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from flask import current_app, jsonify, request, send_file

from .config import (
    DEFAULT_DOCUMENT_CATEGORY,
    DEFAULT_WORKSPACE_SETTINGS,
    DOCUMENT_WORKER_BATCH_SIZE,
    MIME_BY_EXT,
    S3_BUCKET,
    s3_client,
    TRASH_RETENTION_DAYS,
)
from .db import get_db_connection
from .document_processing import claim_next_queued_pdf_document, process_claimed_pdf_document
from .document_domain import (
    PDF_NEEDS_OCR_ERROR,
    PDF_NEEDS_OCR_STATUS,
    PDF_TEXT_PENDING_ERROR,
    PDF_TEXT_PENDING_STATUS,
    build_editable_file_bytes,
    convert_pdf_bytes_to_editable_draft,
    extract_document_content,
    extract_text_from_pdf_bytes,
    hard_delete_document_record,
    html_to_plaintext,
    infer_document_category,
    is_pdf_text_available,
    plaintext_to_html,
    purge_expired_trashed_documents,
    sanitize_editor_html,
    user_can_edit_document,
    normalize_pdf_text,
)
from .document_search import DOCUMENT_RESULT_COLUMNS_SQL, build_document_listing_base_query
from .share_domain import (
    check_document_access,
    get_document_link_sharing_mode,
    is_document_soft_deleted,
    user_can_manage_document_share_links,
)
from .security import get_authenticated_username
from .storage import allowed_file, detect_mimetype, read_file_bytes_from_storage, remove_document_file_from_storage, upload_local_file_to_storage, write_file_bytes_to_storage
from .summary_service import build_summary_input_hash, clear_document_summary_cache
from .utils import normalize_document_category, parse_bool, parse_int, row_to_dict, utcnow_iso
from .workspace_domain import get_or_create_default_workspace_id, get_workspace_record, get_workspace_settings, normalize_workspace_settings, workspace_belongs_to_user


_UPLOAD_PROCESSING_EXECUTOR = ThreadPoolExecutor(max_workers=1)


def _normalize_document_title(value):
    title = ' '.join(str(value or '').replace('\x00', '').split()).strip()
    return title[:200]


def _document_value(doc, key, default=''):
    if hasattr(doc, 'get'):
        return doc.get(key, default)
    try:
        return doc[key]
    except Exception:
        return default


def _cached_summary_from_document(doc_data):
    summary_text = str(doc_data.get('summary_text') or '').strip()
    if not summary_text:
        return None
    summary_input_hash = str(doc_data.get('summary_input_hash') or '').strip()
    current_input_hash = build_summary_input_hash(doc_data.get('content') or '')
    if not summary_input_hash or summary_input_hash != current_input_hash:
        return None
    try:
        key_sentences = json.loads(doc_data.get('key_sentences_json') or '[]')
    except Exception:
        key_sentences = []
    if not isinstance(key_sentences, list):
        key_sentences = []
    return {
        'summary_text': summary_text,
        'summary': summary_text,
        'summary_source': str(doc_data.get('summary_source') or '').strip(),
        'summary_model': str(doc_data.get('summary_model') or '').strip(),
        'ai_summary': str(doc_data.get('ai_summary') or '').strip(),
        'extractive_summary': str(doc_data.get('extractive_summary') or '').strip(),
        'key_sentences': [str(item).strip() for item in key_sentences if str(item).strip()],
        'summary_generated_at': doc_data.get('summary_generated_at') or '',
        'summary_error': str(doc_data.get('summary_error') or '').strip(),
        'summary_input_hash': summary_input_hash,
    }


def _title_with_extension(title, file_ext, fallback='Edited document'):
    safe_ext = str(file_ext or '').strip().lower().lstrip('.')
    safe_title = _normalize_document_title(title) or fallback
    if safe_ext:
        safe_title = re.sub(r'\.[A-Za-z0-9]{1,8}$', '', safe_title).strip() or fallback
        safe_title = f'{safe_title}.{safe_ext}'
    return _normalize_document_title(safe_title) or f'{fallback}.{safe_ext}'


def _normalize_ocr_import_format(value):
    safe_value = str(value or 'txt').strip().lower()
    if safe_value in ('txt', 'docx', 'pdf'):
        return safe_value
    raise ValueError('file_format must be one of txt, docx, or pdf')


def _insert_document_record(
    conn,
    *,
    filename,
    title,
    uploaded_at,
    file_type,
    content,
    content_html,
    username,
    tags='',
    category='',
    workspace_id='',
    processing_status='processed',
    processing_error='',
    processed_at=None,
):
    columns = [
        'filename',
        'title',
        'uploaded_at',
        'file_type',
        'content',
        'content_html',
        'username',
        'tags',
        'category',
        'workspace_id',
        'processing_status',
        'processing_error',
        'processed_at',
    ]
    values = [
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
        processing_status,
        processing_error,
        processed_at,
    ]
    placeholders = ', '.join(['?'] * len(columns))
    returning_sql = ' RETURNING id' if getattr(conn, 'db_type', '') == 'postgres' else ''
    cursor = conn.execute(
        f'''
        INSERT INTO documents ({', '.join(columns)})
        VALUES ({placeholders})
        {returning_sql}
        ''',
        tuple(values),
    )
    if getattr(conn, 'db_type', '') == 'postgres':
        row = row_to_dict(cursor.fetchone()) or {}
        return parse_int(row.get('id'), 0, 0)
    return parse_int(getattr(cursor, 'lastrowid', 0), 0, 0)


def _create_ocr_note_document(
    conn,
    *,
    username,
    workspace_id,
    title,
    text,
    category='',
    file_format='txt',
):
    safe_text = str(text or '').replace('\r\n', '\n').replace('\r', '\n').strip()
    if not safe_text:
        raise ValueError('No text provided')

    safe_format = _normalize_ocr_import_format(file_format)
    safe_title = str(title or '').strip() or 'OCR Note'
    safe_category = normalize_document_category(category or '') or DEFAULT_DOCUMENT_CATEGORY
    content_html = sanitize_editor_html(plaintext_to_html(safe_text))
    file_bytes, mimetype = build_editable_file_bytes(safe_format, safe_text, content_html)
    unique_filename = f'{uuid.uuid4().hex}.{safe_format}'

    try:
        write_file_bytes_to_storage(unique_filename, file_bytes, mimetype)
        new_doc_id = _insert_document_record(
            conn,
            filename=unique_filename,
            title=safe_title,
            uploaded_at=datetime.utcnow().isoformat(),
            file_type=safe_format,
            content=safe_text,
            content_html=content_html if safe_format in ('txt', 'docx') else '',
            username=username,
            tags='',
            category=safe_category,
            workspace_id=workspace_id,
            processing_status='processed',
            processing_error='',
            processed_at=utcnow_iso(),
        )
        if new_doc_id <= 0:
            raise RuntimeError('Document insert did not return an id')
        new_doc_cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (new_doc_id,))
        new_doc = row_to_dict(new_doc_cursor.fetchone()) or {}
        conn.commit()
        return new_doc_id, new_doc
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        remove_document_file_from_storage(unique_filename)
        raise


def _resolve_upload_workspace_context(username, requested_workspace_id):
    conn = get_db_connection()
    if not conn:
        return None, (jsonify({'error': 'Database connection failed'}), 500)

    try:
        workspace_id = ''
        workspace_settings = dict(DEFAULT_WORKSPACE_SETTINGS)
        if requested_workspace_id:
            if not workspace_belongs_to_user(conn, requested_workspace_id, username):
                return None, (jsonify({'error': 'No access to this workspace'}), 403)
            workspace_id = requested_workspace_id
        else:
            workspace_id = get_or_create_default_workspace_id(conn, username)

        workspace_row = get_workspace_record(conn, workspace_id)
        workspace_settings = normalize_workspace_settings((workspace_row or {}).get('settings_json'))
        if not workspace_settings.get('allow_uploads', True):
            return None, (jsonify({'error': 'Uploads are disabled in this workspace settings'}), 403)

        conn.commit()
        return {
            'workspace_id': workspace_id,
            'settings': workspace_settings,
        }, None
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        print(f'Upload workspace resolution failed: {e}')
        return None, (jsonify({'error': 'Workspace lookup failed'}), 500)
    finally:
        conn.close()


def _final_upload_category(original_filename, extracted_text, requested_category, workspace_settings):
    if requested_category:
        return requested_category
    if (workspace_settings or {}).get('auto_categorize', True):
        return infer_document_category(original_filename, extracted_text)
    final_category = normalize_document_category((workspace_settings or {}).get('default_category'))
    return final_category or DEFAULT_DOCUMENT_CATEGORY


def _client_pdf_text_status():
    safe_status = str(
        request.form.get('client_pdf_text_status')
        or request.form.get('client_pdf_text_state')
        or ''
    ).strip().lower()
    if safe_status in ('processed', 'ready', 'text', 'text_available'):
        return 'processed'
    if safe_status in ('text_pending', 'pending', 'deferred', 'awaiting_text'):
        return PDF_TEXT_PENDING_STATUS
    if safe_status in ('needs_ocr', 'no_text_available', 'no_text', 'action_required', 'scanned'):
        return PDF_NEEDS_OCR_STATUS
    if safe_status in ('client_failed', 'failed', 'error', 'unknown'):
        return 'client_failed'
    return ''


def _client_pdf_text_deferred():
    return parse_bool(
        request.form.get('client_pdf_text_deferred')
        or request.form.get('client_pdf_text_pending')
        or request.form.get('defer_client_pdf_text'),
        False,
    )


def _client_pdf_text():
    for field_name in ('client_extracted_text', 'client_pdf_text', 'extracted_text'):
        value = request.form.get(field_name)
        if value:
            return normalize_pdf_text(value)
    return ''


def _extract_pdf_upload_content(local_filepath):
    client_text = _client_pdf_text()
    if is_pdf_text_available(client_text):
        return normalize_pdf_text(client_text), '', 'processed', '', utcnow_iso()

    client_status = _client_pdf_text_status()
    if client_status == PDF_TEXT_PENDING_STATUS or (client_status == 'processed' and _client_pdf_text_deferred()):
        return '', '', PDF_TEXT_PENDING_STATUS, PDF_TEXT_PENDING_ERROR, ''
    if client_status == PDF_NEEDS_OCR_STATUS:
        return '', '', PDF_NEEDS_OCR_STATUS, PDF_NEEDS_OCR_ERROR, utcnow_iso()

    extracted_text, extracted_html = extract_document_content(
        local_filepath,
        'pdf',
        allow_pdf_ocr=False,
    )
    if is_pdf_text_available(extracted_text):
        return normalize_pdf_text(extracted_text), extracted_html or '', 'processed', '', utcnow_iso()

    return '', '', PDF_NEEDS_OCR_STATUS, PDF_NEEDS_OCR_ERROR, utcnow_iso()


def _reset_pdf_processing_claim(document_id, error_message):
    conn = get_db_connection()
    if not conn:
        print(f'PDF processing claim reset skipped for {document_id}: database unavailable')
        return
    try:
        conn.execute(
            '''
            UPDATE documents
            SET processing_status = ?,
                processing_error = ?,
                processing_started_at = NULL
            WHERE id = ?
              AND LOWER(COALESCE(file_type, '')) = 'pdf'
              AND LOWER(COALESCE(processing_status, '')) = 'processing'
            ''',
            ('queued', str(error_message or 'Failed to submit PDF processing job')[:500], document_id),
        )
        conn.commit()
    except Exception as error:
        try:
            conn.rollback()
        except Exception:
            pass
        print(f'PDF processing claim reset failed for {document_id}: {error}')
    finally:
        conn.close()


def _claim_next_pdf_processing_job():
    conn = get_db_connection()
    if not conn:
        raise RuntimeError('Database connection failed')
    try:
        claimed = claim_next_queued_pdf_document(conn)
        conn.commit()
        return claimed
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def recover_queued_pdf_uploads(limit=None):
    safe_limit = parse_int(
        limit if limit is not None else DOCUMENT_WORKER_BATCH_SIZE,
        DOCUMENT_WORKER_BATCH_SIZE,
        1,
        100,
    )
    queued_count = 0
    errors = []

    for _ in range(safe_limit):
        try:
            claimed = _claim_next_pdf_processing_job()
        except Exception as error:
            errors.append(str(error))
            print(f'Queued PDF upload recovery claim failed: {error}')
            break

        if not claimed:
            break

        document_id = parse_int(claimed.get('id'), 0, 0)
        try:
            _UPLOAD_PROCESSING_EXECUTOR.submit(process_claimed_pdf_document, claimed)
            queued_count += 1
        except Exception as error:
            errors.append(str(error))
            print(f'Queued PDF upload recovery submit failed for document {document_id}: {error}')
            _reset_pdf_processing_claim(document_id, error)

    if queued_count:
        print(f'Recovered {queued_count} queued PDF upload(s) for background processing.')
    return {
        'queued_count': queued_count,
        'error': '; '.join(errors)[:500],
    }


def get_documents():
    username = get_authenticated_username()
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

        listing_query = build_document_listing_base_query(
            conn,
            username=username,
            query=query,
            workspace_id=workspace_id,
            category_filter=category_filter,
            tag_filter=tag_filter,
            start_date=start_date,
            end_date=end_date,
            file_type_filter=file_type_filter,
        )
        base_sql = listing_query['base_sql']
        params = listing_query['params']
        search_order_sql = listing_query.get('search_order_sql') or ''
        final_order_by_sql = f'{search_order_sql}, {order_by_sql}' if search_order_sql else order_by_sql

        total_cursor = conn.execute(
            f'''
            SELECT COUNT(1) AS total
            FROM ({base_sql}) document_results
            ''',
            params,
        )
        total_row = row_to_dict(total_cursor.fetchone()) or {}
        total = parse_int(total_row.get('total', 0), 0, 0)

        cursor = conn.execute(
            f'''
            SELECT {DOCUMENT_RESULT_COLUMNS_SQL}
            FROM ({base_sql}) document_results
            ORDER BY {final_order_by_sql}
            LIMIT ? OFFSET ?
            ''',
            [*params, limit, offset],
        )
        docs = [row_to_dict(doc) or {} for doc in cursor.fetchall()]
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
                    FROM ({base_sql}) document_results
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
    username = get_authenticated_username()
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
            "deleted_at IS NOT NULL AND TRIM(CAST(deleted_at AS TEXT)) <> ''",
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
    username = get_authenticated_username()
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
    username = get_authenticated_username()
    requested_workspace_id = (request.form.get('workspace_id') or '').strip()
    requested_category = normalize_document_category(request.form.get('category', ''))
    if not username:
        return jsonify({'error': 'Auth token is required'}), 401

    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    if not (file and allowed_file(file.filename)):
        return jsonify({'error': 'File type not allowed'}), 400

    original_filename = file.filename
    try:
        ext = original_filename.rsplit('.', 1)[1].lower()
    except IndexError:
        return jsonify({'error': 'Filename must have an extension'}), 400

    workspace_context, workspace_error = _resolve_upload_workspace_context(username, requested_workspace_id)
    if workspace_error:
        return workspace_error
    workspace_id = (workspace_context or {}).get('workspace_id', '')
    workspace_settings = (workspace_context or {}).get('settings') or dict(DEFAULT_WORKSPACE_SETTINGS)

    unique_filename = f"{uuid.uuid4().hex}.{ext}"
    local_filepath = os.path.join(current_app.config['UPLOAD_FOLDER'], unique_filename)
    file.save(local_filepath)

    storage_written = False
    document_saved = False
    try:
        processing_status = 'processed'
        processing_error = ''
        processed_at = utcnow_iso()
        if ext == 'pdf':
            extracted_text, extracted_html, processing_status, processing_error, processed_at = _extract_pdf_upload_content(
                local_filepath
            )
            final_category = _final_upload_category(original_filename, extracted_text, requested_category, workspace_settings)
        else:
            extracted_text, extracted_html = extract_document_content(local_filepath, ext)
            final_category = _final_upload_category(
                original_filename,
                extracted_text,
                requested_category,
                workspace_settings,
            )

        try:
            mimetype = file.content_type or detect_mimetype(original_filename, ext)
            upload_local_file_to_storage(local_filepath, unique_filename, mimetype)
            if S3_BUCKET and s3_client:
                os.remove(local_filepath)
            storage_written = True
        except Exception as e:
            print(f"❌ Storage upload error: {e}")
            if os.path.exists(local_filepath):
                try:
                    os.remove(local_filepath)
                except Exception:
                    pass
            return jsonify({'error': f'Failed to save uploaded file: {str(e)}'}), 500

        conn = get_db_connection()
        if not conn:
            return jsonify({'error': 'Database connection failed'}), 500
        try:
            document_id = _insert_document_record(
                conn,
                filename=unique_filename,
                title=original_filename,
                uploaded_at=datetime.utcnow().isoformat(),
                file_type=ext,
                content=extracted_text,
                content_html=extracted_html if ext in ('docx', 'txt') else '',
                username=username,
                tags='',
                category=final_category,
                workspace_id=workspace_id,
                processing_status=processing_status,
                processing_error=processing_error,
                processed_at=processed_at,
            )
            if document_id <= 0:
                raise RuntimeError('Document insert did not return an id')
            conn.commit()
            document_saved = True
            return jsonify({
                'message': 'File uploaded successfully',
                'document_id': document_id,
                'processing_status': processing_status,
                'processing_error': processing_error,
            }), 201
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            print(f"Database Error: {e}")
            return jsonify({'error': 'Database save failed'}), 500
        finally:
            conn.close()
    except Exception as e:
        print(f"Upload processing error: {e}")
        return jsonify({'error': 'Upload processing failed'}), 500
    finally:
        if not document_saved:
            if storage_written:
                remove_document_file_from_storage(unique_filename)
            elif os.path.exists(local_filepath):
                try:
                    os.remove(local_filepath)
                except Exception:
                    pass
        elif S3_BUCKET and s3_client and os.path.exists(local_filepath):
            try:
                os.remove(local_filepath)
            except Exception:
                pass


def finalize_pdf_upload_text(doc_id):
    data = request.get_json(silent=True) if request.is_json else None
    if data is None:
        data = request.form or {}

    username = get_authenticated_username()
    if not username:
        return jsonify({'error': 'Auth token is required'}), 401

    status = str(
        data.get('status')
        or data.get('client_pdf_text_status')
        or data.get('client_pdf_text_state')
        or ''
    ).strip().lower()
    text = normalize_pdf_text(
        data.get('text')
        or data.get('client_extracted_text')
        or data.get('client_pdf_text')
        or data.get('extracted_text')
        or ''
    )

    if status in ('needs_ocr', 'no_text_available', 'no_text', 'action_required', 'scanned'):
        next_status = PDF_NEEDS_OCR_STATUS
        next_error = PDF_NEEDS_OCR_ERROR
        next_text = ''
    elif is_pdf_text_available(text):
        next_status = 'processed'
        next_error = ''
        next_text = text
    else:
        return jsonify({'error': 'No extracted PDF text provided'}), 400

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

        allowed, reason = check_document_access(conn, doc, username)
        if not allowed:
            return jsonify({'error': reason}), 403
        if not user_can_edit_document(conn, doc, username):
            return jsonify({'error': 'Only workspace members can finalize this document'}), 403

        file_type = str((doc.get('file_type') if hasattr(doc, 'get') else doc['file_type']) or '').lower().strip('.')
        if file_type != 'pdf':
            return jsonify({'error': 'Only PDF uploads can finalize extracted PDF text'}), 400

        now_iso = utcnow_iso()
        conn.execute(
            '''
            UPDATE documents
            SET content = ?,
                content_html = '',
                processing_status = ?,
                processing_error = ?,
                processing_started_at = NULL,
                processed_at = ?
            WHERE id = ?
            ''',
            (next_text, next_status, next_error, now_iso, doc_id),
        )
        clear_document_summary_cache(conn, doc_id)
        conn.commit()

        return jsonify({
            'message': 'PDF text finalized',
            'document_id': doc_id,
            'processing_status': next_status,
            'processing_error': next_error,
        }), 200
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        print(f"PDF text finalization failed: {e}")
        return jsonify({'error': 'PDF text finalization failed'}), 500
    finally:
        conn.close()


def get_document(doc_id):
    username = get_authenticated_username()
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
        cached_summary = _cached_summary_from_document(doc_data)
        if cached_summary:
            doc_data['cached_summary'] = cached_summary
        return jsonify(doc_data), 200
    finally:
        conn.close()


def delete_document(doc_id):
    data = request.get_json(silent=True) or {}
    username = get_authenticated_username()
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
        doc_data = row_to_dict(doc) or {}
        owner = str(doc_data.get('username') or '').strip()
        if owner and owner != username:
            return jsonify({'error': 'You can only restore your own documents'}), 403
        if not is_document_soft_deleted(doc_data):
            return jsonify({'message': 'Document is already active', 'id': doc_id, 'restored': False}), 200

        conn.execute('UPDATE documents SET deleted_at = NULL WHERE id = ?', (doc_id,))
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
    username = get_authenticated_username()
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
    username = get_authenticated_username()
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


def update_document_title(doc_id):
    data = request.get_json(silent=True) or {}
    username = get_authenticated_username()
    next_title = _normalize_document_title(data.get('title', ''))
    if not next_title:
        return jsonify({'error': 'title is required'}), 400

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

        conn.execute('UPDATE documents SET title = ? WHERE id = ?', (next_title, doc_id))
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
    username = get_authenticated_username()
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
        clear_document_summary_cache(conn, doc_id)
        conn.commit()

        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        updated_doc = cursor.fetchone()
        return jsonify(dict(updated_doc)), 200
    finally:
        conn.close()


def import_document_text(doc_id):
    data = request.get_json(silent=True) or {}
    username = get_authenticated_username()
    share_token = (data.get('share_token') or '').strip()
    text = str(data.get('text') or '')
    text = text.replace('\r\n', '\n').replace('\r', '\n').strip()
    custom_title = str(data.get('title') or '').strip()
    file_format = _normalize_ocr_import_format(data.get('file_format') or data.get('format') or 'txt')

    if not username:
        return jsonify({'error': 'Please sign in to save OCR text as a note'}), 401
    if not text:
        return jsonify({'error': 'No text provided'}), 400

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
        new_doc_id, new_doc = _create_ocr_note_document(
            conn,
            username=username,
            workspace_id=workspace_id,
            title=note_title,
            text=text,
            category=source_category or DEFAULT_DOCUMENT_CATEGORY,
            file_format=file_format,
        )
        return jsonify({
            'message': 'OCR note saved successfully',
            'new_doc_id': new_doc_id,
            'document': new_doc,
        }), 201
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except RuntimeError as e:
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        print(f"OCR text import failed: {e}")
        return jsonify({'error': 'Failed to save OCR note'}), 500
    finally:
        conn.close()


def import_workspace_text():
    data = request.get_json(silent=True) or {}
    username = get_authenticated_username()
    text = str(data.get('text') or '')
    text = text.replace('\r\n', '\n').replace('\r', '\n').strip()
    custom_title = str(data.get('title') or '').strip()
    requested_workspace_id = str(data.get('workspace_id') or '').strip()
    requested_category = normalize_document_category(data.get('category') or '')
    file_format = _normalize_ocr_import_format(data.get('file_format') or data.get('format') or 'txt')

    if not username:
        return jsonify({'error': 'Please sign in to save OCR text as a note'}), 401
    if not text:
        return jsonify({'error': 'No text provided'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'Database connection failed'}), 500

    try:
        workspace_id = requested_workspace_id or get_or_create_default_workspace_id(conn, username)
        if workspace_id and not workspace_belongs_to_user(conn, workspace_id, username):
            return jsonify({'error': 'Only workspace members can save OCR results as notes'}), 403

        workspace_settings = get_workspace_settings(conn, workspace_id)
        if not workspace_settings.get('allow_note_editing', True):
            return jsonify({'error': 'Editing is disabled in this workspace settings'}), 403

        note_title = custom_title or 'Image OCR Note'
        category = requested_category or workspace_settings.get('default_category') or DEFAULT_DOCUMENT_CATEGORY
        new_doc_id, new_doc = _create_ocr_note_document(
            conn,
            username=username,
            workspace_id=workspace_id,
            title=note_title,
            text=text,
            category=category,
            file_format=file_format,
        )
        return jsonify({
            'message': 'OCR note saved successfully',
            'new_doc_id': new_doc_id,
            'document': new_doc,
        }), 201
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except RuntimeError as e:
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        print(f"Workspace OCR text import failed: {e}")
        return jsonify({'error': 'Failed to save OCR note'}), 500
    finally:
        conn.close()


def convert_pdf_to_editable_draft(doc_id):
    data = request.get_json(silent=True) or {}
    username = get_authenticated_username()
    mode = str(data.get('mode') or 'simple').strip().lower()

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

        workspace_id = str(_document_value(doc, 'workspace_id') or '').strip()
        workspace_settings = get_workspace_settings(conn, workspace_id)
        if not workspace_settings.get('allow_note_editing', True):
            return jsonify({'error': 'Editing is disabled in this workspace settings'}), 403

        file_type = str(_document_value(doc, 'file_type') or '').lower().strip('.')
        if file_type != 'pdf':
            return jsonify({'error': 'Only PDF documents can be converted to an editable draft'}), 400

        filename = str(_document_value(doc, 'filename') or '').strip()
        try:
            file_bytes = read_file_bytes_from_storage(filename)
            draft = convert_pdf_bytes_to_editable_draft(
                file_bytes,
                mode=mode,
                fallback_text=_document_value(doc, 'content') or '',
            )
        except ValueError as e:
            return jsonify({'error': str(e)}), 422
        except Exception as e:
            print(f'PDF conversion draft failed: {e}')
            return jsonify({'error': 'Failed to convert PDF to editable draft'}), 500

        source_title = str(_document_value(doc, 'title') or _document_value(doc, 'filename') or 'Document').strip()
        return jsonify({
            **draft,
            'document_id': doc_id,
            'source_file_type': 'pdf',
            'title': source_title,
            'suggested_docx_title': _title_with_extension(source_title, 'docx', 'Edited document'),
            'suggested_pdf_title': _title_with_extension(source_title, 'pdf', 'Edited document'),
            'available_output_formats': ['docx', 'pdf'],
            'available_save_modes': ['replace', 'copy'],
        }), 200
    finally:
        conn.close()


def save_converted_pdf_document(doc_id):
    data = request.get_json(silent=True) or {}
    username = get_authenticated_username()
    output_format = str(data.get('output_format') or data.get('format') or 'docx').strip().lower().lstrip('.')
    save_mode = str(data.get('save_mode') or data.get('mode') or 'replace').strip().lower()
    content_html = data.get('content_html')
    content = data.get('content', '')

    if output_format not in ('docx', 'pdf'):
        return jsonify({'error': 'output_format must be docx or pdf'}), 400
    if save_mode not in ('replace', 'copy'):
        return jsonify({'error': 'save_mode must be replace or copy'}), 400
    if content_html is not None and not isinstance(content_html, str):
        return jsonify({'error': 'content_html must be a string'}), 400
    if content is None:
        content = ''
    if not isinstance(content, str):
        return jsonify({'error': 'content must be a string'}), 400

    conn = get_db_connection()
    new_filename = ''
    old_filename = ''
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

        workspace_id = str(_document_value(doc, 'workspace_id') or '').strip()
        workspace_settings = get_workspace_settings(conn, workspace_id)
        if not workspace_settings.get('allow_note_editing', True):
            return jsonify({'error': 'Editing is disabled in this workspace settings'}), 403

        source_file_type = str(_document_value(doc, 'file_type') or '').lower().strip('.')
        if source_file_type != 'pdf':
            return jsonify({'error': 'Only PDF conversion drafts can be saved with this endpoint'}), 400

        if content_html is None:
            content_html = plaintext_to_html(content)
        content_html = sanitize_editor_html(content_html)
        content = html_to_plaintext(content_html)
        if not content.strip():
            return jsonify({'error': 'Converted content is empty'}), 400

        output_content_html = content_html if output_format == 'docx' else ''
        file_bytes, mimetype = build_editable_file_bytes(output_format, content, content_html)
        new_filename = f'{uuid.uuid4().hex}.{output_format}'
        next_title = _title_with_extension(
            data.get('title') or _document_value(doc, 'title') or _document_value(doc, 'filename') or 'Edited document',
            output_format,
            'Edited document',
        )

        write_file_bytes_to_storage(new_filename, file_bytes, mimetype)

        if save_mode == 'copy':
            new_doc_id = _insert_document_record(
                conn,
                filename=new_filename,
                title=next_title,
                uploaded_at=datetime.utcnow().isoformat(),
                file_type=output_format,
                content=content,
                content_html=output_content_html,
                username=username,
                tags=_document_value(doc, 'tags') or '',
                category=normalize_document_category(_document_value(doc, 'category') or '') or DEFAULT_DOCUMENT_CATEGORY,
                workspace_id=workspace_id,
                processing_status='processed',
                processing_error='',
                processed_at=utcnow_iso(),
            )
            if new_doc_id <= 0:
                raise RuntimeError('Document insert did not return an id')
            cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (new_doc_id,))
            new_doc = row_to_dict(cursor.fetchone()) or {}
            conn.commit()
            return jsonify({
                'message': 'Converted document saved as a new file',
                'save_mode': 'copy',
                'document': new_doc,
                'source_document_id': doc_id,
            }), 201

        old_filename = str(_document_value(doc, 'filename') or '').strip()
        clear_document_summary_cache(conn, doc_id)
        conn.execute(
            '''
            UPDATE documents
            SET filename = ?,
                title = ?,
                file_type = ?,
                content = ?,
                content_html = ?,
                processing_status = ?,
                processing_error = ?,
                processed_at = ?
            WHERE id = ?
            ''',
            (
                new_filename,
                next_title,
                output_format,
                content,
                output_content_html,
                'processed',
                '',
                utcnow_iso(),
                doc_id,
            ),
        )
        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        updated_doc = row_to_dict(cursor.fetchone()) or {}
        conn.commit()

        storage_warning = ''
        if old_filename and old_filename != new_filename:
            storage_warning = remove_document_file_from_storage(old_filename) or ''

        return jsonify({
            'message': 'Original PDF replaced with converted document',
            'save_mode': 'replace',
            'document': updated_doc,
            'warning': storage_warning,
        }), 200
    except ValueError as e:
        try:
            conn.rollback()
        except Exception:
            pass
        if new_filename:
            remove_document_file_from_storage(new_filename)
        return jsonify({'error': str(e)}), 400
    except RuntimeError as e:
        try:
            conn.rollback()
        except Exception:
            pass
        if new_filename:
            remove_document_file_from_storage(new_filename)
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        print(f'Converted PDF save failed: {e}')
        try:
            conn.rollback()
        except Exception:
            pass
        if new_filename:
            remove_document_file_from_storage(new_filename)
        return jsonify({'error': 'Failed to save converted document'}), 500
    finally:
        conn.close()


def update_document_pdf_file(doc_id):
    username = get_authenticated_username()
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

        extracted_text = normalize_pdf_text(extract_text_from_pdf_bytes(file_bytes, allow_ocr=False))
        if is_pdf_text_available(extracted_text):
            conn.execute(
                '''
                UPDATE documents
                SET content = ?,
                    content_html = ?,
                    processing_status = ?,
                    processing_error = ?,
                    processed_at = ?
                WHERE id = ?
                ''',
                (extracted_text, '', 'processed', '', utcnow_iso(), doc_id),
            )
        else:
            conn.execute(
                '''
                UPDATE documents
                SET content = ?,
                    content_html = ?,
                    processing_status = ?,
                    processing_error = ?,
                    processed_at = ?
                WHERE id = ?
                ''',
                ('', '', PDF_NEEDS_OCR_STATUS, PDF_NEEDS_OCR_ERROR, utcnow_iso(), doc_id),
            )
        clear_document_summary_cache(conn, doc_id)
        conn.commit()

        cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (doc_id,))
        updated_doc = cursor.fetchone()
        return jsonify(dict(updated_doc)), 200
    finally:
        conn.close()


def get_document_file(doc_id):
    username = get_authenticated_username()
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

    response = send_file(
        io.BytesIO(file_bytes),
        mimetype=mimetype,
        download_name=title or filename,
        as_attachment=False,
    )
    if (request.args.get('auth_token') or '').strip():
        response.headers['Cache-Control'] = 'no-store, private, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response
