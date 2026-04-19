import os
from pathlib import Path

from flask import Flask, jsonify
from flask_cors import CORS

from . import config, db, document_service, security, shared
from .auth import auth_bp
from .documents import documents_bp
from .feedback import feedback_bp
from .friends import friends_bp
from .frontend import frontend_bp
from .ocr import ocr_bp
from .share_links import share_links_bp
from .summarize import summarize_bp
from .workspaces import workspaces_bp


def create_app():
    project_root = Path(__file__).resolve().parents[1]
    static_folder = project_root / 'dist'
    app = Flask(__name__, static_folder=str(static_folder), static_url_path='')
    CORS(
        app,
        origins=config.CORS_ALLOWED_ORIGINS,
        supports_credentials=True,
        resources={r"/api/*": {"origins": config.CORS_ALLOWED_ORIGINS}},
    )

    os.makedirs(config.UPLOAD_FOLDER, exist_ok=True)
    app.config['UPLOAD_FOLDER'] = config.UPLOAD_FOLDER
    app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024

    shared.app = app
    db.init_db()
    document_service.recover_queued_pdf_uploads()
    app.before_request(security.rate_limit_middleware)
    app.before_request(security.enforce_auth_token_middleware)

    @app.after_request
    def add_security_headers(response):
        response.headers.setdefault('X-Content-Type-Options', 'nosniff')
        response.headers.setdefault('X-Frame-Options', 'DENY')
        response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
        response.headers.setdefault(
            'Permissions-Policy',
            'camera=(), microphone=(), geolocation=(), payment=()',
        )
        response.headers.setdefault(
            'Content-Security-Policy',
            "default-src 'self'; "
            "base-uri 'self'; "
            "object-src 'none'; "
            "frame-ancestors 'none'; "
            "form-action 'self'; "
            "script-src 'self' https://accounts.google.com https://apis.google.com; "
            "style-src 'self' 'unsafe-inline' https://accounts.google.com; "
            "img-src 'self' data: blob: https:; "
            "font-src 'self' data:; "
            "connect-src 'self' https://accounts.google.com; "
            "frame-src 'self' https://accounts.google.com; "
            "worker-src 'self' blob:",
        )
        if config.IS_PRODUCTION_ENV:
            response.headers.setdefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
        return response

    @app.route('/api/health', methods=['GET'])
    def health():
        from .storage import storage_uses_s3

        database_mode = ''
        conn = db.get_db_connection()
        try:
            database_mode = str(getattr(conn, 'db_type', '') or '').strip()
        finally:
            if conn:
                conn.close()

        build_sha = (
            os.environ.get('RENDER_GIT_COMMIT')
            or os.environ.get('GIT_COMMIT')
            or os.environ.get('BUILD_SHA')
            or ''
        ).strip()
        return jsonify({
            'ok': True,
            'app': 'StudyHub',
            'environment': 'production' if config.IS_PRODUCTION_ENV else 'development',
            'storage_mode': 's3' if storage_uses_s3() else 'local',
            'database_mode': database_mode or 'unknown',
            'ocr_external_configured': bool(config.EXTERNAL_OCR_SERVICE_URL),
            'summary_external_configured': bool(config.EXTERNAL_SUMMARY_SERVICE_URL),
            'build_sha': build_sha[:40],
        })

    app.register_blueprint(auth_bp)
    app.register_blueprint(workspaces_bp)
    app.register_blueprint(documents_bp)
    app.register_blueprint(share_links_bp)
    app.register_blueprint(feedback_bp)
    app.register_blueprint(friends_bp)
    app.register_blueprint(ocr_bp)
    app.register_blueprint(summarize_bp)
    app.register_blueprint(frontend_bp)

    return app
