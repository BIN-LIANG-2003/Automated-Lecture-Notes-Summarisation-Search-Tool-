import os
from pathlib import Path

from flask import Flask
from flask_cors import CORS

from . import config, db, security, shared
from .auth import auth_bp
from .documents import documents_bp
from .frontend import frontend_bp
from .ocr import ocr_bp
from .share_links import share_links_bp
from .summarize import summarize_bp
from .workspaces import workspaces_bp


def create_app():
    project_root = Path(__file__).resolve().parents[1]
    static_folder = project_root / 'dist'
    app = Flask(__name__, static_folder=str(static_folder), static_url_path='')
    CORS(app)

    os.makedirs(config.UPLOAD_FOLDER, exist_ok=True)
    app.config['UPLOAD_FOLDER'] = config.UPLOAD_FOLDER
    app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024

    shared.app = app
    db.init_db()
    app.before_request(security.enforce_auth_token_middleware)

    app.register_blueprint(auth_bp)
    app.register_blueprint(workspaces_bp)
    app.register_blueprint(documents_bp)
    app.register_blueprint(share_links_bp)
    app.register_blueprint(ocr_bp)
    app.register_blueprint(summarize_bp)
    app.register_blueprint(frontend_bp)

    return app
