from flask import Blueprint

from . import friend_service

friends_bp = Blueprint('friends', __name__)


@friends_bp.route('/api/friends/summary', methods=['GET'])
def get_friend_summary():
    return friend_service.get_friend_summary()


@friends_bp.route('/api/friends/requests', methods=['POST'])
def create_friend_request():
    return friend_service.create_friend_request()


@friends_bp.route('/api/friends/requests/<int:request_id>/respond', methods=['POST'])
def respond_friend_request(request_id):
    return friend_service.respond_friend_request(request_id)


@friends_bp.route('/api/friends/messages', methods=['POST'])
def send_friend_message():
    return friend_service.send_friend_message()


@friends_bp.route('/api/friends/read', methods=['POST'])
def mark_friend_items_read():
    return friend_service.mark_friend_items_read()
