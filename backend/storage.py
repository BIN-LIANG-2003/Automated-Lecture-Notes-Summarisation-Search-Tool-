import mimetypes
import os
import shutil
import tempfile
from contextlib import contextmanager

from flask import current_app, has_app_context
from werkzeug.utils import secure_filename

from .config import ALLOWED_EXTENSIONS, MIME_BY_EXT, S3_BUCKET, UPLOAD_FOLDER, s3_client


def _upload_folder():
    if has_app_context():
        return current_app.config.get('UPLOAD_FOLDER', UPLOAD_FOLDER)
    return UPLOAD_FOLDER


def _safe_storage_filename(filename):
    safe_filename = secure_filename(str(filename or '').strip())
    if not safe_filename:
        raise ValueError('filename is required')
    return safe_filename


def storage_uses_s3():
    return bool(S3_BUCKET and s3_client)


def local_storage_path(filename):
    safe_filename = _safe_storage_filename(filename)
    upload_dir = _upload_folder()
    if not os.path.isabs(upload_dir):
        upload_dir = os.path.abspath(upload_dir)
    return os.path.join(upload_dir, safe_filename)


@contextmanager
def storage_file_as_local_path(filename, suffix=''):
    safe_filename = _safe_storage_filename(filename)
    if storage_uses_s3():
        temp_path = ''
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
                temp_path = temp_file.name
            s3_client.download_file(S3_BUCKET, safe_filename, temp_path)
            yield temp_path
        finally:
            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except Exception:
                    pass
        return

    yield local_storage_path(safe_filename)


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def detect_mimetype(filename, file_ext=''):
    ext = (file_ext or '').lower().strip('.')
    if ext in MIME_BY_EXT:
        return MIME_BY_EXT[ext]
    guessed = mimetypes.guess_type(filename)[0]
    return guessed or 'application/octet-stream'


def remove_document_file_from_storage(filename):
    safe_filename = str(filename or '').strip()
    if not safe_filename:
        return ''
    try:
        if storage_uses_s3():
            s3_client.delete_object(Bucket=S3_BUCKET, Key=safe_filename)
        else:
            local_path = local_storage_path(safe_filename)
            if os.path.exists(local_path):
                os.remove(local_path)
        return ''
    except Exception as e:
        warning = f'File cleanup failed: {e}'
        print(f'⚠️ {warning}')
        return warning


def write_file_bytes_to_storage(filename, file_bytes, mimetype='application/octet-stream'):
    if not filename:
        raise ValueError('filename is required')

    if storage_uses_s3():
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=filename,
            Body=file_bytes,
            ContentType=mimetype,
        )
        return

    local_path = local_storage_path(filename)
    with open(local_path, 'wb') as f:
        f.write(file_bytes)


def upload_local_file_to_storage(local_path, filename, mimetype='application/octet-stream'):
    safe_filename = _safe_storage_filename(filename)
    if not local_path:
        raise ValueError('local_path is required')

    if storage_uses_s3():
        s3_client.upload_file(
            local_path,
            S3_BUCKET,
            safe_filename,
            ExtraArgs={'ContentType': mimetype},
        )
        return

    destination = local_storage_path(safe_filename)
    if os.path.abspath(local_path) != os.path.abspath(destination):
        shutil.copyfile(local_path, destination)


def read_file_bytes_from_storage(filename):
    safe_filename = _safe_storage_filename(filename)

    if storage_uses_s3():
        s3_obj = s3_client.get_object(Bucket=S3_BUCKET, Key=safe_filename)
        return s3_obj['Body'].read()

    local_path = local_storage_path(safe_filename)
    with open(local_path, 'rb') as f:
        return f.read()


__all__ = [
    'ALLOWED_EXTENSIONS',
    'UPLOAD_FOLDER',
    'allowed_file',
    'detect_mimetype',
    'local_storage_path',
    'read_file_bytes_from_storage',
    'remove_document_file_from_storage',
    'storage_file_as_local_path',
    'storage_uses_s3',
    'upload_local_file_to_storage',
    'write_file_bytes_to_storage',
]
