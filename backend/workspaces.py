from flask import Blueprint

from . import workspace_service

workspaces_bp = Blueprint('workspaces', __name__)


@workspaces_bp.route('/api/workspaces', methods=['GET'])
def get_workspaces():
    return workspace_service.get_workspaces()


@workspaces_bp.route('/api/workspaces', methods=['POST'])
def create_workspace():
    return workspace_service.create_workspace()


@workspaces_bp.route('/api/workspaces/<workspace_id>', methods=['PUT'])
def update_workspace(workspace_id):
    return workspace_service.update_workspace(workspace_id)


@workspaces_bp.route('/api/workspaces/<workspace_id>', methods=['DELETE'])
def delete_workspace(workspace_id):
    return workspace_service.delete_workspace(workspace_id)


@workspaces_bp.route('/api/workspaces/<workspace_id>/invitations', methods=['GET'])
def list_workspace_invitations(workspace_id):
    return workspace_service.list_workspace_invitations(workspace_id)


@workspaces_bp.route('/api/workspaces/<workspace_id>/invitations', methods=['POST'])
def create_workspace_invitations(workspace_id):
    return workspace_service.create_workspace_invitations(workspace_id)


@workspaces_bp.route('/api/workspaces/<workspace_id>/invitations/<int:invitation_id>', methods=['DELETE'])
def cancel_workspace_invitation(workspace_id, invitation_id):
    return workspace_service.cancel_workspace_invitation(workspace_id, invitation_id)


@workspaces_bp.route('/api/workspaces/<workspace_id>/invitations/<int:invitation_id>/resend', methods=['POST'])
def resend_workspace_invitation(workspace_id, invitation_id):
    return workspace_service.resend_workspace_invitation(workspace_id, invitation_id)


@workspaces_bp.route('/api/workspaces/<workspace_id>/invitations/<int:invitation_id>/review', methods=['POST'])
def review_workspace_invitation(workspace_id, invitation_id):
    return workspace_service.review_workspace_invitation(workspace_id, invitation_id)


@workspaces_bp.route('/api/invitations/<token>', methods=['GET'])
def get_invitation_by_token(token):
    return workspace_service.get_invitation_by_token(token)


@workspaces_bp.route('/api/invitations/<token>/request-join', methods=['POST'])
def request_join_by_invitation(token):
    return workspace_service.request_join_by_invitation(token)
