import os
import secrets

import boto3
from docx.enum.text import WD_COLOR_INDEX

try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:
    # Keep running even when python-dotenv is not installed.
    pass


UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

ALLOWED_EXTENSIONS = {'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'docx', 'webp'}

GOOGLE_CLIENT_ID = '1076922320508-6jdkr9v6g7rku2dipd6kr3n3thojdvn4.apps.googleusercontent.com'
MIN_AUTH_TOKEN_SECRET_LENGTH = 32
WEAK_AUTH_TOKEN_SECRET_VALUES = {
    '',
    'changeme',
    'change-me',
    'default',
    'replace-with-at-least-32-random-characters',
    'secret',
    'studyhub',
    'studyhub-dev-secret-change-me',
}


def _is_explicit_development_environment():
    return any(
        str(os.environ.get(env_name) or '').strip().lower() == 'development'
        for env_name in ('APP_ENV', 'FLASK_ENV')
    )


def _is_production_environment():
    return any(
        str(os.environ.get(env_name) or '').strip().lower() == 'production'
        for env_name in ('APP_ENV', 'FLASK_ENV')
    )


def _auth_token_secret_is_weak(value):
    safe_value = str(value or '').strip()
    lowered_value = safe_value.lower()
    if lowered_value in WEAK_AUTH_TOKEN_SECRET_VALUES:
        return True
    if len(safe_value) < MIN_AUTH_TOKEN_SECRET_LENGTH:
        return True
    return False


def _generate_development_auth_token_secret(reason):
    generated_secret = secrets.token_urlsafe(48)
    print(
        '⚠️ AUTH_TOKEN_SECRET is missing or weak in explicit development mode; '
        'generated a per-process random secret. Existing auth tokens will be invalid after restart. '
        f'Set a strong AUTH_TOKEN_SECRET for stable local sessions. Reason: {reason}.'
    )
    return generated_secret


def _resolve_auth_token_secret():
    primary_secret = (os.environ.get('AUTH_TOKEN_SECRET') or '').strip()
    legacy_secret = (os.environ.get('FLASK_SECRET_KEY') or '').strip()
    is_explicit_development = _is_explicit_development_environment()

    if primary_secret:
        if not _auth_token_secret_is_weak(primary_secret):
            return primary_secret, 'auth_token_secret'
        if is_explicit_development:
            return _generate_development_auth_token_secret('AUTH_TOKEN_SECRET is weak'), 'generated-development'
        raise RuntimeError(
            'AUTH_TOKEN_SECRET must be a strong non-default value outside explicit development mode. '
            f'Use at least {MIN_AUTH_TOKEN_SECRET_LENGTH} characters and avoid default placeholders.'
        )

    if legacy_secret:
        if not _auth_token_secret_is_weak(legacy_secret):
            return legacy_secret, 'flask_secret_key'
        if is_explicit_development:
            return _generate_development_auth_token_secret('FLASK_SECRET_KEY is weak'), 'generated-development'
        raise RuntimeError(
            'FLASK_SECRET_KEY cannot be used for auth tokens unless it is strong. '
            f'Set AUTH_TOKEN_SECRET to at least {MIN_AUTH_TOKEN_SECRET_LENGTH} characters.'
        )

    if is_explicit_development:
        return _generate_development_auth_token_secret('AUTH_TOKEN_SECRET is missing'), 'generated-development'

    raise RuntimeError(
        'AUTH_TOKEN_SECRET must be set outside explicit development mode. '
        'For local development set APP_ENV=development or FLASK_ENV=development, or provide a strong AUTH_TOKEN_SECRET.'
    )


AUTH_TOKEN_SECRET, AUTH_TOKEN_SECRET_SOURCE = _resolve_auth_token_secret()
IS_PRODUCTION_ENV = _is_production_environment()

AUTH_TOKEN_SALT = 'studyhub-auth-token-v1'
try:
    AUTH_TOKEN_TTL_SECONDS = max(3600, int((os.environ.get('AUTH_TOKEN_TTL_SECONDS') or '604800').strip()))
except Exception:
    AUTH_TOKEN_TTL_SECONDS = 604800
AUTH_COOKIE_NAME = (os.environ.get('AUTH_COOKIE_NAME') or 'studyhub_auth').strip() or 'studyhub_auth'
AUTH_COOKIE_SAMESITE = (os.environ.get('AUTH_COOKIE_SAMESITE') or 'Lax').strip() or 'Lax'
AUTH_COOKIE_SECURE = str(
    os.environ.get('AUTH_COOKIE_SECURE') or ('1' if IS_PRODUCTION_ENV else '0')
).strip().lower() in ('1', 'true', 'yes', 'on')
AUTH_BYPASS_ENDPOINTS = {
    'register',
    'login',
    'google_login',
    'verify_email',
    'resend_verification',
    'get_document_by_share_token',
    'get_invitation_by_token',
    'ocr_health',
}

try:
    EMAIL_VERIFICATION_TTL_HOURS = max(
        1,
        min(168, int((os.environ.get('EMAIL_VERIFICATION_TTL_HOURS') or '24').strip())),
    )
except Exception:
    EMAIL_VERIFICATION_TTL_HOURS = 24

HF_TOKEN = (os.environ.get('HF_API_TOKEN') or '').strip()
HF_MODEL_BASE_URL = (os.environ.get('HF_MODEL_BASE_URL') or 'https://router.huggingface.co/hf-inference/models').rstrip('/')
OCR_MODEL_ID = os.environ.get('HF_OCR_MODEL') or 'lbin2021/my-lecture-ocr'
SUMMARIZER_MODEL_ID = os.environ.get('HF_SUMMARIZER_MODEL') or 'facebook/bart-large-cnn'
HF_SUMMARIZER_MODEL = SUMMARIZER_MODEL_ID
try:
    HF_SUMMARIZER_TIMEOUT_SECONDS = max(15, int((os.environ.get('HF_SUMMARIZER_TIMEOUT_SECONDS') or '60').strip()))
except Exception:
    HF_SUMMARIZER_TIMEOUT_SECONDS = 60
EXTERNAL_SUMMARY_SERVICE_URL = (os.environ.get("EXTERNAL_SUMMARY_SERVICE_URL") or "").strip()
EXTERNAL_SUMMARY_AUTH_TOKEN = (os.environ.get("EXTERNAL_SUMMARY_AUTH_TOKEN") or "").strip()
try:
    EXTERNAL_SUMMARY_TIMEOUT_SECONDS = max(
        15,
        int((os.environ.get("EXTERNAL_SUMMARY_TIMEOUT_SECONDS") or "120").strip()),
    )
except Exception:
    EXTERNAL_SUMMARY_TIMEOUT_SECONDS = 120
SUMMARY_PRIMARY_STRATEGY = (os.environ.get('SUMMARY_PRIMARY_STRATEGY') or 'auto').strip().lower() or 'auto'
_summary_fallback_raw = str(os.environ.get('SUMMARY_FALLBACK_ENABLED') or '1').strip().lower()
SUMMARY_FALLBACK_ENABLED = _summary_fallback_raw not in ('0', 'false', 'no', 'off')
try:
    SUMMARY_MIN_WORDS_FOR_BART = max(1, int((os.environ.get('SUMMARY_MIN_WORDS_FOR_BART') or '120').strip()))
except Exception:
    SUMMARY_MIN_WORDS_FOR_BART = 120
try:
    SUMMARY_CHUNK_WORDS = max(120, int((os.environ.get('SUMMARY_CHUNK_WORDS') or '650').strip()))
except Exception:
    SUMMARY_CHUNK_WORDS = 650
try:
    SUMMARY_CHUNK_OVERLAP = max(0, int((os.environ.get('SUMMARY_CHUNK_OVERLAP') or '80').strip()))
except Exception:
    SUMMARY_CHUNK_OVERLAP = 80
try:
    TEXTRANK_SENTENCE_COUNT = max(1, int((os.environ.get('TEXTRANK_SENTENCE_COUNT') or '3').strip()))
except Exception:
    TEXTRANK_SENTENCE_COUNT = 3
try:
    SUMMARY_TARGET_MAX_WORDS = max(40, int((os.environ.get('SUMMARY_TARGET_MAX_WORDS') or '140').strip()))
except Exception:
    SUMMARY_TARGET_MAX_WORDS = 140
try:
    SUMMARY_GENERATION_LOCK_LEASE_SECONDS = max(
        300,
        int((os.environ.get('SUMMARY_GENERATION_LOCK_LEASE_SECONDS') or '900').strip()),
    )
except Exception:
    SUMMARY_GENERATION_LOCK_LEASE_SECONDS = 900
EXTERNAL_OCR_SERVICE_URL = (os.environ.get('EXTERNAL_OCR_SERVICE_URL') or '').strip()
EXTERNAL_OCR_AUTH_TOKEN = (os.environ.get("EXTERNAL_OCR_AUTH_TOKEN") or "").strip()
try:
    EXTERNAL_OCR_TIMEOUT_SECONDS = max(15, int((os.getenv('EXTERNAL_OCR_TIMEOUT_SECONDS') or '60').strip()))
except Exception:
    EXTERNAL_OCR_TIMEOUT_SECONDS = 60
OCRMYPDF_BINARY = (os.getenv('OCRMYPDF_BINARY') or 'ocrmypdf').strip() or 'ocrmypdf'
OCRMYPDF_LANGUAGE = (os.getenv('OCRMYPDF_LANGUAGE') or 'eng').strip() or 'eng'
_pdf_ocr_enabled_raw = str(os.getenv('ENABLE_PDF_OCR_FALLBACK') or '1').strip().lower()
ENABLE_PDF_OCR_FALLBACK = _pdf_ocr_enabled_raw not in ('0', 'false', 'no', 'off')
try:
    OCRMYPDF_TIMEOUT_SECONDS = max(15, int((os.getenv('OCRMYPDF_TIMEOUT_SECONDS') or '180').strip()))
except Exception:
    OCRMYPDF_TIMEOUT_SECONDS = 180
_upload_pdf_ocr_raw = str(os.getenv('UPLOAD_PDF_OCR_FALLBACK') or '0').strip().lower()
UPLOAD_PDF_OCR_FALLBACK = _upload_pdf_ocr_raw not in ('0', 'false', 'no', 'off')
try:
    DOCUMENT_WORKER_BATCH_SIZE = max(1, min(100, int((os.getenv('DOCUMENT_WORKER_BATCH_SIZE') or '5').strip())))
except Exception:
    DOCUMENT_WORKER_BATCH_SIZE = 5
try:
    DOCUMENT_WORKER_POLL_SECONDS = max(1, min(300, int((os.getenv('DOCUMENT_WORKER_POLL_SECONDS') or '5').strip())))
except Exception:
    DOCUMENT_WORKER_POLL_SECONDS = 5
try:
    DOCUMENT_PROCESSING_STALE_MINUTES = max(
        5,
        min(1440, int((os.getenv('DOCUMENT_PROCESSING_STALE_MINUTES') or '30').strip())),
    )
except Exception:
    DOCUMENT_PROCESSING_STALE_MINUTES = 30
try:
    TRASH_RETENTION_DAYS = max(1, min(365, int((os.getenv('TRASH_RETENTION_DAYS') or '30').strip())))
except Exception:
    TRASH_RETENTION_DAYS = 30

DEFAULT_DOCUMENT_CATEGORY = 'Uncategorized'
CATEGORY_KEYWORDS = {
    'Computer Science': (
        'computer', 'algorithm', 'network', 'database', 'data structure', 'python', 'java', 'c++',
        'operating system', 'os', 'software', 'machine learning', 'deep learning', 'programming'
    ),
    'Mathematics': (
        'math', 'algebra', 'calculus', 'geometry', 'equation', 'probability', 'statistics', 'linear algebra'
    ),
    'Physics': ('physics', 'mechanics', 'thermodynamics', 'quantum', 'electromagnetic', 'optics'),
    'Chemistry': ('chemistry', 'organic', 'inorganic', 'molecule', 'reaction', 'chemical'),
    'Biology': ('biology', 'cell', 'genetics', 'ecology', 'anatomy', 'physiology'),
    'Economics': ('economics', 'microeconomics', 'macroeconomics', 'market', 'inflation', 'gdp'),
    'Business': ('business', 'management', 'marketing', 'finance', 'accounting', 'strategy'),
    'Language': ('english', 'language', 'vocabulary', 'grammar', 'literature', 'essay'),
}
WORKSPACE_SUMMARY_LENGTH_LEVELS = {'short', 'medium', 'long'}
WORKSPACE_LINK_SHARING_MODES = {'restricted', 'workspace', 'public'}
WORKSPACE_HOME_TABS = {'home', 'files'}
WORKSPACE_DOCUMENT_LAYOUTS = {'grid', 'compact'}
WORKSPACE_DOCUMENT_SORTS = {'newest', 'oldest', 'title_asc', 'title_desc'}
WORKSPACE_DOCUMENT_PAGE_SIZES = {12, 20, 40}
WORKSPACE_SIDEBAR_DENSITIES = {'comfortable', 'compact'}
DEFAULT_WORKSPACE_ACCENT_COLOR = '#2f76e8'
DEFAULT_WORKSPACE_SETTINGS = {
    'workspace_icon': '📚',
    'description': '',
    'accent_color': DEFAULT_WORKSPACE_ACCENT_COLOR,
    'default_category': DEFAULT_DOCUMENT_CATEGORY,
    'auto_categorize': True,
    'default_home_tab': 'home',
    'default_documents_layout': 'grid',
    'default_documents_sort': 'newest',
    'default_documents_page_size': 20,
    'recent_items_limit': 10,
    'sidebar_density': 'comfortable',
    'show_starred_section': True,
    'show_recent_section': True,
    'show_quick_actions': True,
    'show_usage_chart': True,
    'show_recent_activity': True,
    'allow_uploads': True,
    'allow_note_editing': True,
    'allow_ai_tools': True,
    'allow_ocr': True,
    'summary_length': 'medium',
    'keyword_limit': 5,
    'notify_upload_events': True,
    'notify_summary_events': True,
    'notify_sharing_events': True,
    'allow_member_invites': False,
    'default_invite_expiry_days': 7,
    'default_share_expiry_days': 7,
    'link_sharing_mode': 'workspace',
    'restrict_invites_to_domains': False,
    'allowed_email_domains': '',
    'block_invites_from_domains': False,
    'blocked_email_domains': '',
    'allow_member_share_management': False,
    'max_active_share_links_per_document': 5,
    'auto_revoke_previous_share_links': False,
    'allow_export': True,
}
SUMMARY_CONFIG_VERSION = (
    os.environ.get('SUMMARY_CONFIG_VERSION')
    or os.environ.get('SUMMARY_CACHE_VERSION')
    or 'v2'
).strip() or 'v2'
SUMMARY_CACHE_VERSION = SUMMARY_CONFIG_VERSION

MIME_BY_EXT = {
    'pdf': 'application/pdf',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'txt': 'text/plain',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
}

EDITOR_ALLOWED_TAGS = {
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup', 'mark', 'span', 'div',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre',
    'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col', 'img', 'hr'
}
EDITOR_ALLOWED_STYLE_PROPS = {
    'font-weight', 'font-style', 'text-decoration', 'color', 'background-color',
    'text-align', 'font-size', 'font-family', 'vertical-align', 'margin-left',
    'width', 'height', 'border', 'border-collapse'
}
BLOCK_TAGS = {
    'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'
}

NAMED_COLORS = {
    'black': (0, 0, 0),
    'white': (255, 255, 255),
    'red': (255, 0, 0),
    'green': (0, 128, 0),
    'blue': (0, 0, 255),
    'yellow': (255, 255, 0),
    'gray': (128, 128, 128),
    'grey': (128, 128, 128),
    'orange': (255, 165, 0),
    'purple': (128, 0, 128),
    'brown': (165, 42, 42),
}

HIGHLIGHT_RGB_BY_INDEX = {
    WD_COLOR_INDEX.YELLOW: (255, 255, 0),
    WD_COLOR_INDEX.BRIGHT_GREEN: (0, 255, 0),
    WD_COLOR_INDEX.TURQUOISE: (0, 255, 255),
    WD_COLOR_INDEX.PINK: (255, 192, 203),
    WD_COLOR_INDEX.BLUE: (0, 0, 255),
    WD_COLOR_INDEX.RED: (255, 0, 0),
    WD_COLOR_INDEX.DARK_BLUE: (0, 0, 139),
    WD_COLOR_INDEX.TEAL: (0, 128, 128),
    WD_COLOR_INDEX.GREEN: (0, 128, 0),
    WD_COLOR_INDEX.VIOLET: (238, 130, 238),
    WD_COLOR_INDEX.DARK_RED: (139, 0, 0),
    WD_COLOR_INDEX.DARK_YELLOW: (128, 128, 0),
    WD_COLOR_INDEX.GRAY_50: (128, 128, 128),
    WD_COLOR_INDEX.GRAY_25: (192, 192, 192),
    WD_COLOR_INDEX.BLACK: (0, 0, 0),
    WD_COLOR_INDEX.WHITE: (255, 255, 255),
}

S3_BUCKET = os.environ.get('S3_BUCKET_NAME')
S3_KEY = os.environ.get('AWS_ACCESS_KEY_ID')
S3_SECRET = os.environ.get('AWS_SECRET_ACCESS_KEY')
S3_REGION = os.environ.get('AWS_REGION', 'us-west-2')

DEFAULT_INVITE_BASE_URL = 'https://automated-lecture-notes-summarisation.onrender.com'
APP_BASE_URL = (os.environ.get('APP_BASE_URL') or DEFAULT_INVITE_BASE_URL).rstrip('/')
INVITE_BASE_URL = APP_BASE_URL
RESEND_API_KEY = (os.environ.get('RESEND_API_KEY') or '').strip()
RESEND_FROM_EMAIL = (os.environ.get('RESEND_FROM_EMAIL') or 'StudyHub <onboarding@resend.dev>').strip()
SUPPORT_EMAIL = (os.environ.get('SUPPORT_EMAIL') or 'hello@studies-hub.com').strip()
FEEDBACK_ADMIN_USERNAMES = (os.environ.get('FEEDBACK_ADMIN_USERNAMES') or '').strip()
INVITE_EXPIRY_DAYS = 7

try:
    s3_client = boto3.client(
        's3',
        aws_access_key_id=S3_KEY,
        aws_secret_access_key=S3_SECRET,
        region_name=S3_REGION,
    )
    print('✅ AWS S3 Client initialized.')
except Exception as e:
    print(f'⚠️ AWS S3 Client failed to initialize: {e}')
    s3_client = None
