from datetime import datetime, timedelta

from .config import (
    DEFAULT_DOCUMENT_CATEGORY,
    DOCUMENT_PROCESSING_STALE_MINUTES,
    DOCUMENT_WORKER_BATCH_SIZE,
    UPLOAD_PDF_OCR_FALLBACK,
)
from .db import get_db_connection
from .document_domain import (
    PDF_NEEDS_OCR_ERROR,
    PDF_NEEDS_OCR_STATUS,
    extract_document_content,
    infer_document_category,
    is_pdf_text_available,
    normalize_pdf_text,
)
from .storage import storage_file_as_local_path
from .utils import normalize_document_category, parse_int, row_to_dict, utcnow_iso
from .workspace_domain import get_workspace_settings


def _short_error(error):
    message = str(error or 'Document processing failed').strip()
    return (message or 'Document processing failed')[:500]


def _active_document_sql(table_alias='documents'):
    prefix = f'{table_alias}.' if table_alias else ''
    return f"COALESCE(TRIM(CAST({prefix}deleted_at AS TEXT)), '') = ''"


def _processing_stale_cutoff():
    minutes = parse_int(DOCUMENT_PROCESSING_STALE_MINUTES, 30, 5, 1440)
    return (datetime.utcnow() - timedelta(minutes=minutes)).isoformat()


def claim_next_queued_pdf_document(conn):
    stale_cutoff = _processing_stale_cutoff()
    cursor = conn.execute(
        f'''
        SELECT id
        FROM documents
        WHERE LOWER(COALESCE(file_type, '')) = 'pdf'
          AND {_active_document_sql('documents')}
          AND (
              LOWER(COALESCE(processing_status, '')) = 'queued'
              OR (
                  LOWER(COALESCE(processing_status, '')) = 'processing'
                  AND processing_started_at IS NOT NULL
                  AND TRIM(CAST(processing_started_at AS TEXT)) <> ''
                  AND processing_started_at <= ?
              )
          )
        ORDER BY uploaded_at ASC, id ASC
        LIMIT 1
        ''',
        (stale_cutoff,),
    )
    row = row_to_dict(cursor.fetchone()) or {}
    document_id = parse_int(row.get('id'), 0, 0)
    if document_id <= 0:
        return None

    now_iso = utcnow_iso()
    update_cursor = conn.execute(
        '''
        UPDATE documents
        SET processing_status = ?,
            processing_error = ?,
            processing_started_at = ?,
            processed_at = NULL
        WHERE id = ?
          AND LOWER(COALESCE(file_type, '')) = 'pdf'
          AND COALESCE(TRIM(CAST(deleted_at AS TEXT)), '') = ''
          AND (
              LOWER(COALESCE(processing_status, '')) = 'queued'
              OR (
                  LOWER(COALESCE(processing_status, '')) = 'processing'
                  AND processing_started_at IS NOT NULL
                  AND TRIM(CAST(processing_started_at AS TEXT)) <> ''
                  AND processing_started_at <= ?
              )
          )
        ''',
        ('processing', '', now_iso, document_id, stale_cutoff),
    )
    if getattr(update_cursor, 'rowcount', 0) != 1:
        return None

    cursor = conn.execute('SELECT * FROM documents WHERE id = ?', (document_id,))
    claimed = row_to_dict(cursor.fetchone()) or {}
    return claimed or None


_claim_next_queued_pdf_document = claim_next_queued_pdf_document


def _final_processing_category(title, extracted_text, current_category, workspace_settings):
    safe_current = normalize_document_category(current_category or '')
    if safe_current and safe_current != DEFAULT_DOCUMENT_CATEGORY:
        return safe_current
    if (workspace_settings or {}).get('auto_categorize', True):
        return infer_document_category(title, extracted_text)
    final_category = normalize_document_category((workspace_settings or {}).get('default_category'))
    return final_category or DEFAULT_DOCUMENT_CATEGORY


def _workspace_settings_for_document(workspace_id):
    safe_workspace_id = str(workspace_id or '').strip()
    if not safe_workspace_id:
        return {}
    conn = get_db_connection()
    if not conn:
        return {}
    try:
        return get_workspace_settings(conn, safe_workspace_id)
    finally:
        conn.close()


def _mark_document_processed(document_id, extracted_text, extracted_html, category):
    conn = get_db_connection()
    if not conn:
        raise RuntimeError('Database connection failed')
    try:
        now_iso = utcnow_iso()
        conn.execute(
            '''
            UPDATE documents
            SET content = ?,
                content_html = ?,
                category = ?,
                processing_status = ?,
                processing_error = ?,
                processed_at = ?
            WHERE id = ?
            ''',
            (extracted_text, extracted_html or '', category, 'processed', '', now_iso, document_id),
        )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def _mark_document_failed(document_id, error):
    conn = get_db_connection()
    if not conn:
        print(f'Document processing failure update skipped for {document_id}: database unavailable')
        return
    try:
        now_iso = utcnow_iso()
        conn.execute(
            '''
            UPDATE documents
            SET processing_status = ?,
                processing_error = ?,
                processed_at = ?
            WHERE id = ?
            ''',
            ('failed', _short_error(error), now_iso, document_id),
        )
        conn.commit()
    except Exception as update_error:
        try:
            conn.rollback()
        except Exception:
            pass
        print(f'Document processing failure update failed for {document_id}: {update_error}')
    finally:
        conn.close()


def _mark_document_needs_ocr(document_id, category):
    conn = get_db_connection()
    if not conn:
        print(f'Document OCR-needed update skipped for {document_id}: database unavailable')
        return
    try:
        now_iso = utcnow_iso()
        conn.execute(
            '''
            UPDATE documents
            SET content = ?,
                content_html = ?,
                category = ?,
                processing_status = ?,
                processing_error = ?,
                processed_at = ?
            WHERE id = ?
            ''',
            ('', '', category, PDF_NEEDS_OCR_STATUS, PDF_NEEDS_OCR_ERROR, now_iso, document_id),
        )
        conn.commit()
    except Exception as update_error:
        try:
            conn.rollback()
        except Exception:
            pass
        print(f'Document OCR-needed update failed for {document_id}: {update_error}')
    finally:
        conn.close()


def process_claimed_pdf_document(document_row):
    doc = row_to_dict(document_row) or {}
    document_id = parse_int(doc.get('id'), 0, 0)
    filename = str(doc.get('filename') or '').strip()
    title = str(doc.get('title') or filename).strip() or filename
    if document_id <= 0 or not filename:
        return {'status': 'failed', 'document_id': document_id, 'error': 'Invalid document row'}

    try:
        with storage_file_as_local_path(filename, suffix='.pdf') as local_path:
            extracted_text, extracted_html = extract_document_content(
                local_path,
                'pdf',
                allow_pdf_ocr=UPLOAD_PDF_OCR_FALLBACK,
            )
        workspace_id = str(doc.get('workspace_id') or '').strip()
        workspace_settings = _workspace_settings_for_document(workspace_id)
        final_category = _final_processing_category(
            title,
            extracted_text,
            doc.get('category') or '',
            workspace_settings,
        )
        if not is_pdf_text_available(extracted_text):
            _mark_document_needs_ocr(document_id, final_category)
            return {'status': PDF_NEEDS_OCR_STATUS, 'document_id': document_id, 'error': PDF_NEEDS_OCR_ERROR}
        _mark_document_processed(document_id, normalize_pdf_text(extracted_text), extracted_html or '', final_category)
        return {'status': 'processed', 'document_id': document_id, 'error': ''}
    except Exception as error:
        print(f'Document processing failed for {document_id}: {error}')
        _mark_document_failed(document_id, error)
        return {'status': 'failed', 'document_id': document_id, 'error': _short_error(error)}


def process_queued_documents_once(limit=None):
    max_items = parse_int(limit if limit is not None else DOCUMENT_WORKER_BATCH_SIZE, DOCUMENT_WORKER_BATCH_SIZE, 1, 100)
    result = {
        'claimed_count': 0,
        'processed_count': 0,
        'needs_ocr_count': 0,
        'failed_count': 0,
        'error': '',
    }

    for _ in range(max_items):
        conn = get_db_connection()
        if not conn:
            result['error'] = 'Database connection failed'
            break
        try:
            claimed = _claim_next_queued_pdf_document(conn)
            conn.commit()
        except Exception as error:
            try:
                conn.rollback()
            except Exception:
                pass
            result['error'] = _short_error(error)
            print(f'Document worker claim failed: {error}')
            break
        finally:
            conn.close()

        if not claimed:
            break

        result['claimed_count'] += 1
        outcome = process_claimed_pdf_document(claimed)
        if outcome.get('status') == 'processed':
            result['processed_count'] += 1
        elif outcome.get('status') == PDF_NEEDS_OCR_STATUS:
            result['needs_ocr_count'] += 1
        else:
            result['failed_count'] += 1

    return result
