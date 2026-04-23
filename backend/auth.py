from flask import Blueprint

from . import shared

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/api/auth/register', methods=['POST'])
def register():
    return shared.register()


@auth_bp.route('/api/auth/registration-code', methods=['POST'])
def send_registration_code():
    return shared.send_registration_code()


@auth_bp.route('/api/auth/login', methods=['POST'])
def login():
    return shared.login()


@auth_bp.route('/api/auth/google', methods=['POST'])
def google_login():
    return shared.google_login()


@auth_bp.route('/api/auth/verify-email', methods=['GET'])
def verify_email():
    return shared.verify_email()


@auth_bp.route('/api/auth/resend-verification', methods=['POST'])
def resend_verification():
    return shared.resend_verification()


@auth_bp.route('/api/auth/me', methods=['GET'])
def get_current_user():
    return shared.me()


@auth_bp.route('/api/auth/preferences', methods=['PATCH', 'PUT'])
def update_preferences():
    return shared.update_preferences()


@auth_bp.route('/api/auth/logout', methods=['POST'])
def logout():
    return shared.logout()
