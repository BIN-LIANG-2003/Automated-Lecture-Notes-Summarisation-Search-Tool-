import mimetypes
import os

from flask import current_app, has_app_context
from werkzeug.utils import secure_filename

from .config import ALLOWED_EXTENSIONS, MIME_BY_EXT, S3_BUCKET, UPLOAD_FOLDER, s3_client


def _upload_folder():
    if has_app_context():
        return current_app.config.get('UPLOAD_FOLDER', UPLOAD_FOLDER)
    return UPLOAD_FOLDER


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
        if S3_BUCKET and s3_client:
            s3_client.delete_object(Bucket=S3_BUCKET, Key=safe_filename)
        else:
            local_path = os.path.join(_upload_folder(), safe_filename)
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

    if S3_BUCKET and s3_client:
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=filename,
            Body=file_bytes,
            ContentType=mimetype,
        )
        return

    local_path = os.path.join(_upload_folder(), filename)
    with open(local_path, 'wb') as f:
        f.write(file_bytes)


def read_file_bytes_from_storage(filename):
    safe_filename = secure_filename(str(filename or '').strip())
    if not safe_filename:
        raise ValueError('filename is required')

    if S3_BUCKET and s3_client:
        s3_obj = s3_client.get_object(Bucket=S3_BUCKET, Key=safe_filename)
        return s3_obj['Body'].read()

    local_path = os.path.join(_upload_folder(), safe_filename)
    with open(local_path, 'rb') as f:
        return f.read()


__all__ = [
    'ALLOWED_EXTENSIONS',
    'UPLOAD_FOLDER',
    'allowed_file',
    'detect_mimetype',
    'read_file_bytes_from_storage',
    'remove_document_file_from_storage',
    'write_file_bytes_to_storage',
]
