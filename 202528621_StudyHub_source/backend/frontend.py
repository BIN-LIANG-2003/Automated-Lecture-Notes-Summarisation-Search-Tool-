from flask import Blueprint

from . import shared

frontend_bp = Blueprint('frontend', __name__)


@frontend_bp.route('/uploads/<filename>')
def uploaded_file(filename):
    return shared.uploaded_file(filename)


@frontend_bp.route('/')
def serve_index():
    return shared.serve_index()


@frontend_bp.route('/<path:path>')
def catch_all(path):
    return shared.catch_all(path)
