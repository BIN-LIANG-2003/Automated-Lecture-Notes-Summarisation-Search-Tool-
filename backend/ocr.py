from flask import Blueprint

from . import shared

ocr_bp = Blueprint('ocr', __name__)


@ocr_bp.route('/api/ocr/health', methods=['GET'])
def ocr_health():
    return shared.ocr_health()


@ocr_bp.route('/api/extract-text', methods=['POST'])
@ocr_bp.route('/api/extract-text/<int:doc_id>', methods=['POST'])
def extract_text_from_image(doc_id=None):
    return shared.extract_text_from_image(doc_id)
