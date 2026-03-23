from flask import Blueprint

from . import share_link_service

share_links_bp = Blueprint('share_links', __name__)


@share_links_bp.route('/api/documents/<int:doc_id>/share-links', methods=['POST'])
def create_document_share_link(doc_id):
    return share_link_service.create_document_share_link(doc_id)


@share_links_bp.route('/api/documents/<int:doc_id>/share-links', methods=['GET'])
def list_document_share_links(doc_id):
    return share_link_service.list_document_share_links(doc_id)


@share_links_bp.route('/api/documents/<int:doc_id>/share-links', methods=['DELETE'])
def revoke_all_document_share_links(doc_id):
    return share_link_service.revoke_all_document_share_links(doc_id)


@share_links_bp.route('/api/documents/<int:doc_id>/share-links/<int:share_link_id>', methods=['DELETE'])
def revoke_document_share_link(doc_id, share_link_id):
    return share_link_service.revoke_document_share_link(doc_id, share_link_id)


@share_links_bp.route('/api/share-links/<token>', methods=['GET'])
def get_document_by_share_token(token):
    return share_link_service.get_document_by_share_token(token)
