import os

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
CANVAS_DEFAULT_DOMAIN = (os.environ.get('CANVAS_DEFAULT_DOMAIN') or 'canvas.instructure.com').strip().lower()
try:
    CANVAS_MAX_LIST_PAGES = max(1, min(20, int((os.environ.get('CANVAS_MAX_LIST_PAGES') or '5').strip())))
except Exception:
    CANVAS_MAX_LIST_PAGES = 5

GOOGLE_CLIENT_ID = '1076922320508-6jdkr9v6g7rku2dipd6kr3n3thojdvn4.apps.googleusercontent.com'
AUTH_TOKEN_SECRET = (
    (os.environ.get('AUTH_TOKEN_SECRET') or '').strip()
    or (os.environ.get('FLASK_SECRET_KEY') or '').strip()
    or 'studyhub-dev-secret-change-me'
)
AUTH_TOKEN_SALT = 'studyhub-auth-token-v1'
try:
    AUTH_TOKEN_TTL_SECONDS = max(3600, int((os.environ.get('AUTH_TOKEN_TTL_SECONDS') or '604800').strip()))
except Exception:
    AUTH_TOKEN_TTL_SECONDS = 604800
AUTH_BYPASS_ENDPOINTS = {
    'register',
    'login',
    'google_login',
    'get_document_by_share_token',
    'get_invitation_by_token',
    'ocr_health',
}

HF_TOKEN = (os.environ.get('HF_API_TOKEN') or '').strip()
HF_MODEL_BASE_URL = (os.environ.get('HF_MODEL_BASE_URL') or 'https://router.huggingface.co/hf-inference/models').rstrip('/')
OCR_MODEL_ID = os.environ.get('HF_OCR_MODEL') or 'lbin2021/my-lecture-ocr'
SUMMARIZER_MODEL_ID = os.environ.get('HF_SUMMARIZER_MODEL') or 'facebook/bart-large-cnn'
OCRMYPDF_BINARY = (os.getenv('OCRMYPDF_BINARY') or 'ocrmypdf').strip() or 'ocrmypdf'
OCRMYPDF_LANGUAGE = (os.getenv('OCRMYPDF_LANGUAGE') or 'eng').strip() or 'eng'
_pdf_ocr_enabled_raw = str(os.getenv('ENABLE_PDF_OCR_FALLBACK') or '1').strip().lower()
ENABLE_PDF_OCR_FALLBACK = _pdf_ocr_enabled_raw not in ('0', 'false', 'no', 'off')
try:
    OCRMYPDF_TIMEOUT_SECONDS = max(15, int((os.getenv('OCRMYPDF_TIMEOUT_SECONDS') or '180').strip()))
except Exception:
    OCRMYPDF_TIMEOUT_SECONDS = 180
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
WORKSPACE_HOME_TABS = {'home', 'files', 'ai'}
WORKSPACE_DOCUMENT_LAYOUTS = {'grid', 'compact'}
WORKSPACE_DOCUMENT_SORTS = {'newest', 'oldest', 'title_asc', 'title_desc'}
WORKSPACE_DOCUMENT_PAGE_SIZES = {12, 20, 40}
WORKSPACE_SIDEBAR_DENSITIES = {'comfortable', 'compact'}
DEFAULT_WORKSPACE_ACCENT_COLOR = '#2f76e8'
DEFAULT_CANVAS_DOMAIN = 'canvas.instructure.com'
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
    'preferred_canvas_domain': DEFAULT_CANVAS_DOMAIN,
    'recent_items_limit': 10,
    'sidebar_density': 'comfortable',
    'show_starred_section': True,
    'show_recent_section': True,
    'show_quick_actions': True,
    'show_usage_chart': True,
    'show_recent_activity': True,
    'show_canvas_import': True,
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
    'allow_member_share_management': False,
    'max_active_share_links_per_document': 5,
    'auto_revoke_previous_share_links': False,
    'allow_export': True,
}
SUMMARY_CACHE_VERSION = 'v2'

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
INVITE_BASE_URL = (os.environ.get('APP_BASE_URL') or DEFAULT_INVITE_BASE_URL).rstrip('/')
RESEND_API_KEY = (os.environ.get('RESEND_API_KEY') or '').strip()
RESEND_FROM_EMAIL = (os.environ.get('RESEND_FROM_EMAIL') or 'StudyHub <onboarding@resend.dev>').strip()
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
