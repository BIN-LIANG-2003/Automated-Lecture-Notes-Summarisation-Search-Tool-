from flask import Blueprint

from . import document_service

documents_bp = Blueprint('documents', __name__)


@documents_bp.route('/api/documents', methods=['GET'])
def get_documents():
    return document_service.get_documents()


@documents_bp.route('/api/documents/trash', methods=['GET'])
def get_trashed_documents():
    return document_service.get_trashed_documents()


@documents_bp.route('/api/workspaces/<workspace_id>/documents', methods=['DELETE'])
def clear_workspace_documents(workspace_id):
    return document_service.clear_workspace_documents(workspace_id)


@documents_bp.route('/api/documents/upload', methods=['POST'])
def upload_file():
    return document_service.upload_file()


@documents_bp.route('/api/canvas/files', methods=['POST'])
def get_canvas_files():
    return document_service.get_canvas_files()


@documents_bp.route('/api/canvas/import', methods=['POST'])
def import_canvas_file():
    return document_service.import_canvas_file()


@documents_bp.route('/api/documents/<int:doc_id>', methods=['GET'])
def get_document(doc_id):
    return document_service.get_document(doc_id)


@documents_bp.route('/api/documents/<int:doc_id>', methods=['DELETE'])
def delete_document(doc_id):
    return document_service.delete_document(doc_id)


@documents_bp.route('/api/documents/<int:doc_id>/restore', methods=['POST'])
def restore_document(doc_id):
    return document_service.restore_document(doc_id)


@documents_bp.route('/api/documents/<int:doc_id>/tags', methods=['PUT'])
def update_document_tags(doc_id):
    return document_service.update_document_tags(doc_id)


@documents_bp.route('/api/documents/<int:doc_id>/category', methods=['PUT'])
def update_document_category(doc_id):
    return document_service.update_document_category(doc_id)


@documents_bp.route('/api/documents/<int:doc_id>/content', methods=['PUT'])
def update_document_content(doc_id):
    return document_service.update_document_content(doc_id)


@documents_bp.route('/api/documents/<int:doc_id>/pdf', methods=['PUT'])
def update_document_pdf_file(doc_id):
    return document_service.update_document_pdf_file(doc_id)


@documents_bp.route('/api/documents/<int:doc_id>/file', methods=['GET'])
def get_document_file(doc_id):
    return document_service.get_document_file(doc_id)
