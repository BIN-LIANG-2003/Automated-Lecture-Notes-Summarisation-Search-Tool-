from flask import Blueprint

from . import feedback_service

feedback_bp = Blueprint('feedback', __name__)


@feedback_bp.route('/api/feedback/config', methods=['GET'])
def get_feedback_config():
    return feedback_service.get_feedback_config()


@feedback_bp.route('/api/feedback', methods=['POST'])
def submit_feedback():
    return feedback_service.submit_feedback()


@feedback_bp.route('/api/feedback/mine', methods=['GET'])
def list_my_feedback():
    return feedback_service.list_my_feedback()


@feedback_bp.route('/api/feedback/similar', methods=['GET'])
def similar_feedback():
    return feedback_service.similar_feedback()


@feedback_bp.route('/api/feedback/<int:feedback_id>', methods=['GET'])
def get_my_feedback(feedback_id):
    return feedback_service.get_my_feedback(feedback_id)


@feedback_bp.route('/api/admin/feedback', methods=['GET'])
def list_admin_feedback():
    return feedback_service.list_admin_feedback()


@feedback_bp.route('/api/admin/feedback/<int:feedback_id>', methods=['GET'])
def get_admin_feedback(feedback_id):
    return feedback_service.get_admin_feedback(feedback_id)


@feedback_bp.route('/api/admin/feedback/<int:feedback_id>', methods=['PATCH'])
def update_admin_feedback(feedback_id):
    return feedback_service.update_admin_feedback(feedback_id)


@feedback_bp.route('/api/admin/feedback/<int:feedback_id>/public-reply', methods=['POST'])
def add_public_reply(feedback_id):
    return feedback_service.add_public_reply(feedback_id)


@feedback_bp.route('/api/admin/feedback/<int:feedback_id>/internal-note', methods=['POST'])
def add_internal_note(feedback_id):
    return feedback_service.add_internal_note(feedback_id)
