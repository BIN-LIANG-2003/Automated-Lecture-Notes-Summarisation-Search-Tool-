import mimetypes
import os
import shutil
import struct
import tempfile
import zipfile
from contextlib import contextmanager

from flask import current_app, has_app_context
from PIL import Image, UnidentifiedImageError
from werkzeug.utils import secure_filename

from .config import ALLOWED_EXTENSIONS, MIME_BY_EXT, S3_BUCKET, UPLOAD_FOLDER, s3_client

MAX_DOCX_ZIP_ENTRIES = 1000
MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024
MAX_DOCX_COMPRESSION_RATIO = 250


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


def _read_file_prefix(path, size=4096):
    with open(path, 'rb') as handle:
        return handle.read(size)


def _validate_docx_zip_structure(archive):
    infos = archive.infolist()
    if len(infos) > MAX_DOCX_ZIP_ENTRIES:
        return False, 'Uploaded DOCX file is too complex'

    names = {info.filename for info in infos}
    required = {'[Content_Types].xml', 'word/document.xml'}
    if not required.issubset(names):
        return False, 'Uploaded DOCX file is missing required Office document parts'

    total_uncompressed = 0
    total_compressed = 0
    for info in infos:
        total_uncompressed += max(0, int(info.file_size or 0))
        total_compressed += max(0, int(info.compress_size or 0))
        if total_uncompressed > MAX_DOCX_UNCOMPRESSED_BYTES:
            return False, 'Uploaded DOCX file is too large after decompression'

    if total_compressed > 0 and total_uncompressed / total_compressed > MAX_DOCX_COMPRESSION_RATIO:
        return False, 'Uploaded DOCX file compression ratio is unsafe'
    return True, ''


def _image_dimensions_from_bytes(prefix):
    if prefix.startswith(b'\x89PNG\r\n\x1a\n') and len(prefix) >= 24:
        return struct.unpack('>II', prefix[16:24])
    if prefix.startswith((b'GIF87a', b'GIF89a')) and len(prefix) >= 10:
        return struct.unpack('<HH', prefix[6:10])
    if prefix.startswith(b'\xff\xd8'):
        index = 2
        while index + 9 < len(prefix):
            if prefix[index] != 0xFF:
                index += 1
                continue
            marker = prefix[index + 1]
            index += 2
            if marker in (0xD8, 0xD9):
                continue
            if index + 2 > len(prefix):
                break
            segment_length = int.from_bytes(prefix[index:index + 2], 'big')
            if segment_length < 2:
                break
            if marker in {
                0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
            } and index + 7 <= len(prefix):
                height = int.from_bytes(prefix[index + 3:index + 5], 'big')
                width = int.from_bytes(prefix[index + 5:index + 7], 'big')
                return width, height
            index += segment_length
    if prefix.startswith(b'RIFF') and prefix[8:12] == b'WEBP':
        chunk = prefix[12:16]
        if chunk == b'VP8X' and len(prefix) >= 30:
            width = int.from_bytes(prefix[24:27], 'little') + 1
            height = int.from_bytes(prefix[27:30], 'little') + 1
            return width, height
        if chunk == b'VP8L' and len(prefix) >= 25:
            bits = int.from_bytes(prefix[21:25], 'little')
            width = (bits & 0x3FFF) + 1
            height = ((bits >> 14) & 0x3FFF) + 1
            return width, height
        if chunk == b'VP8 ' and len(prefix) >= 30 and prefix[23:26] == b'\x9d\x01\x2a':
            width = int.from_bytes(prefix[26:28], 'little') & 0x3FFF
            height = int.from_bytes(prefix[28:30], 'little') & 0x3FFF
            return width, height
    return None


def validate_upload_file_content(path, original_filename='', file_ext='', max_image_pixels=40_000_000):
    ext = str(file_ext or '').strip().lower().lstrip('.')
    if ext not in ALLOWED_EXTENSIONS:
        return False, 'File type not allowed'
    if not path or not os.path.exists(path):
        return False, 'Uploaded file could not be read'
    if os.path.getsize(path) <= 0:
        return False, 'Uploaded file is empty'

    prefix = _read_file_prefix(path, 65536)
    if ext == 'pdf':
        if prefix.startswith(b'%PDF-'):
            return True, ''
        return False, 'Uploaded file content does not match its .pdf extension'

    if ext == 'docx':
        if not zipfile.is_zipfile(path):
            return False, 'Uploaded file content does not match its .docx extension'
        try:
            with zipfile.ZipFile(path) as archive:
                return _validate_docx_zip_structure(archive)
        except Exception:
            return False, 'Uploaded DOCX file is not readable'

    if ext == 'txt':
        if b'\x00' in prefix:
            return False, 'Uploaded text file appears to contain binary data'
        sample = prefix[:8192]
        if sample:
            printable = sum(
                1 for byte in sample
                if byte in (9, 10, 13) or 32 <= byte <= 126 or byte >= 128
            )
            if printable / max(1, len(sample)) < 0.85:
                return False, 'Uploaded text file appears to contain binary data'
        return True, ''

    image_magic_ok = {
        'png': prefix.startswith(b'\x89PNG\r\n\x1a\n'),
        'jpg': prefix.startswith(b'\xff\xd8'),
        'jpeg': prefix.startswith(b'\xff\xd8'),
        'gif': prefix.startswith((b'GIF87a', b'GIF89a')),
        'webp': prefix.startswith(b'RIFF') and prefix[8:12] == b'WEBP',
    }.get(ext, False)
    if not image_magic_ok:
        return False, f'Uploaded file content does not match its .{ext} extension'

    dimensions = _image_dimensions_from_bytes(prefix)
    if not dimensions:
        return False, 'Uploaded image dimensions could not be verified'
    width, height = dimensions
    if width <= 0 or height <= 0:
        return False, 'Uploaded image dimensions are invalid'
    if width * height > max_image_pixels:
        return False, 'Uploaded image is too large'
    try:
        Image.MAX_IMAGE_PIXELS = max_image_pixels
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            opened_width, opened_height = image.size
        if opened_width <= 0 or opened_height <= 0:
            return False, 'Uploaded image dimensions are invalid'
        if opened_width * opened_height > max_image_pixels:
            return False, 'Uploaded image is too large'
    except Image.DecompressionBombError:
        return False, 'Uploaded image is too large'
    except (UnidentifiedImageError, OSError, ValueError):
        return False, 'Uploaded image could not be verified'
    return True, ''


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
    'validate_upload_file_content',
    'local_storage_path',
    'read_file_bytes_from_storage',
    'remove_document_file_from_storage',
    'storage_file_as_local_path',
    'storage_uses_s3',
    'upload_local_file_to_storage',
    'write_file_bytes_to_storage',
]
