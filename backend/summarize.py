from flask import Blueprint

from . import shared

summarize_bp = Blueprint('summarize', __name__)


@summarize_bp.route('/api/analyze-text', methods=['POST'])
def analyze_text():
    return shared.analyze_text()
