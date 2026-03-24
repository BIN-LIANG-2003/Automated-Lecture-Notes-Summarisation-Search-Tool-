import json
import re
import uuid
import html
from datetime import datetime, timedelta

import requests

from .config import (
    CATEGORY_KEYWORDS,
    DEFAULT_DOCUMENT_CATEGORY,
    DEFAULT_WORKSPACE_SETTINGS,
    INVITE_BASE_URL,
    INVITE_EXPIRY_DAYS,
    RESEND_API_KEY,
    RESEND_FROM_EMAIL,
    WORKSPACE_DOCUMENT_LAYOUTS,
    WORKSPACE_DOCUMENT_PAGE_SIZES,
    WORKSPACE_DOCUMENT_SORTS,
    WORKSPACE_HOME_TABS,
    WORKSPACE_LINK_SHARING_MODES,
    WORKSPACE_SIDEBAR_DENSITIES,
    WORKSPACE_SUMMARY_LENGTH_LEVELS,
)
from .db import documents_column_exists
from .utils import normalize_document_category, normalize_email, parse_bool, parse_int, row_to_dict, utcnow_iso


def normalize_workspace_name(name, owner_username=''):
    raw = str(name or '').strip()
    owner = str(owner_username or '').strip()
    if not raw:
        return f"{owner}'s Workspace" if owner else 'Untitled Workspace'
    if raw.endswith(' 的工作空间'):
        base = raw[:-len(' 的工作空间')].strip()
        if base:
            return f"{base}'s Workspace"
        return f"{owner}'s Workspace" if owner else 'Workspace'
    if raw == '未命名空间':
        return 'Untitled Workspace'
    return raw


def normalize_workspace_accent_color(value):
    raw = str(value or '').strip().lower()
    if re.fullmatch(r'#[0-9a-f]{6}', raw):
        return raw
    return DEFAULT_WORKSPACE_SETTINGS['accent_color']


def normalize_workspace_domain_token(value):
    raw = str(value or '').strip().lower().lstrip('@')
    if raw.startswith('http://') or raw.startswith('https://'):
        raw = raw.split('://', 1)[1] or ''
    raw = raw.split('/', 1)[0].strip()
    if not raw or '.' not in raw:
        return ''
    if not re.fullmatch(r'[a-z0-9.-]{3,255}', raw):
        return ''
    return raw


def normalize_workspace_domain_list(value):
    if isinstance(value, list):
        candidates = value
    else:
        candidates = re.split(r'[\n,;]+', str(value or ''))
    output = []
    seen = set()
    for item in candidates:
        token = normalize_workspace_domain_token(item)
        if not token or token in seen:
            continue
        seen.add(token)
        output.append(token)
    return ', '.join(output[:8])


def normalize_workspace_settings(raw_settings):
    if isinstance(raw_settings, str):
        try:
            source = json.loads(raw_settings)
        except Exception:
            source = {}
    elif isinstance(raw_settings, dict):
        source = raw_settings
    else:
        source = {}

    base = dict(DEFAULT_WORKSPACE_SETTINGS)
    workspace_icon = str(source.get('workspace_icon', base['workspace_icon']) or '').strip()
    base['workspace_icon'] = workspace_icon[:2] or DEFAULT_WORKSPACE_SETTINGS['workspace_icon']

    description = str(source.get('description', base['description']) or '').strip()
    base['description'] = re.sub(r'\s+', ' ', description)[:220]
    base['accent_color'] = normalize_workspace_accent_color(source.get('accent_color', base['accent_color']))

    default_category = normalize_document_category(source.get('default_category', base['default_category']))
    base['default_category'] = default_category or DEFAULT_DOCUMENT_CATEGORY

    base['auto_categorize'] = parse_bool(source.get('auto_categorize', base['auto_categorize']), True)

    default_home_tab = str(source.get('default_home_tab', base['default_home_tab']) or '').strip().lower()
    if default_home_tab not in WORKSPACE_HOME_TABS:
        default_home_tab = DEFAULT_WORKSPACE_SETTINGS['default_home_tab']
    base['default_home_tab'] = default_home_tab

    default_documents_layout = str(
        source.get('default_documents_layout', base['default_documents_layout']) or ''
    ).strip().lower()
    if default_documents_layout not in WORKSPACE_DOCUMENT_LAYOUTS:
        default_documents_layout = DEFAULT_WORKSPACE_SETTINGS['default_documents_layout']
    base['default_documents_layout'] = default_documents_layout

    default_documents_sort = str(
        source.get('default_documents_sort', base['default_documents_sort']) or ''
    ).strip().lower()
    if default_documents_sort not in WORKSPACE_DOCUMENT_SORTS:
        default_documents_sort = DEFAULT_WORKSPACE_SETTINGS['default_documents_sort']
    base['default_documents_sort'] = default_documents_sort

    base['default_documents_page_size'] = parse_int(
        source.get('default_documents_page_size', base['default_documents_page_size']),
        DEFAULT_WORKSPACE_SETTINGS['default_documents_page_size'],
        12,
        40,
    )
    if base['default_documents_page_size'] not in WORKSPACE_DOCUMENT_PAGE_SIZES:
        base['default_documents_page_size'] = DEFAULT_WORKSPACE_SETTINGS['default_documents_page_size']

    base['recent_items_limit'] = parse_int(
        source.get('recent_items_limit', base['recent_items_limit']),
        10,
        5,
        20,
    )
    sidebar_density = str(source.get('sidebar_density', base['sidebar_density']) or '').strip().lower()
    if sidebar_density not in WORKSPACE_SIDEBAR_DENSITIES:
        sidebar_density = DEFAULT_WORKSPACE_SETTINGS['sidebar_density']
    base['sidebar_density'] = sidebar_density
    base['show_starred_section'] = parse_bool(source.get('show_starred_section', base['show_starred_section']), True)
    base['show_recent_section'] = parse_bool(source.get('show_recent_section', base['show_recent_section']), True)
    base['show_quick_actions'] = parse_bool(source.get('show_quick_actions', base['show_quick_actions']), True)
    base['show_usage_chart'] = parse_bool(source.get('show_usage_chart', base['show_usage_chart']), True)
    base['show_recent_activity'] = parse_bool(
        source.get('show_recent_activity', base['show_recent_activity']),
        True,
    )
    base['allow_uploads'] = parse_bool(source.get('allow_uploads', base['allow_uploads']), True)
    base['allow_note_editing'] = parse_bool(source.get('allow_note_editing', base['allow_note_editing']), True)
    base['allow_ai_tools'] = parse_bool(source.get('allow_ai_tools', base['allow_ai_tools']), True)
    base['allow_ocr'] = parse_bool(source.get('allow_ocr', base['allow_ocr']), True)

    summary_length = str(source.get('summary_length', base['summary_length']) or '').strip().lower()
    if summary_length not in WORKSPACE_SUMMARY_LENGTH_LEVELS:
        summary_length = DEFAULT_WORKSPACE_SETTINGS['summary_length']
    base['summary_length'] = summary_length

    base['keyword_limit'] = parse_int(source.get('keyword_limit', base['keyword_limit']), 5, 3, 12)
    base['notify_upload_events'] = parse_bool(
        source.get('notify_upload_events', base['notify_upload_events']),
        True,
    )
    base['notify_summary_events'] = parse_bool(
        source.get('notify_summary_events', base['notify_summary_events']),
        True,
    )
    base['notify_sharing_events'] = parse_bool(
        source.get('notify_sharing_events', base['notify_sharing_events']),
        True,
    )
    base['allow_member_invites'] = parse_bool(
        source.get('allow_member_invites', base['allow_member_invites']),
        False,
    )
    base['default_invite_expiry_days'] = parse_int(
        source.get('default_invite_expiry_days', base['default_invite_expiry_days']),
        7,
        1,
        30,
    )
    base['default_share_expiry_days'] = parse_int(
        source.get('default_share_expiry_days', base['default_share_expiry_days']),
        7,
        1,
        30,
    )
    base['max_active_share_links_per_document'] = parse_int(
        source.get('max_active_share_links_per_document', base['max_active_share_links_per_document']),
        5,
        1,
        20,
    )
    base['auto_revoke_previous_share_links'] = parse_bool(
        source.get('auto_revoke_previous_share_links', base['auto_revoke_previous_share_links']),
        False,
    )

    link_sharing_mode = str(source.get('link_sharing_mode', base['link_sharing_mode']) or '').strip().lower()
    if link_sharing_mode not in WORKSPACE_LINK_SHARING_MODES:
        link_sharing_mode = DEFAULT_WORKSPACE_SETTINGS['link_sharing_mode']
    base['link_sharing_mode'] = link_sharing_mode
    base['restrict_invites_to_domains'] = parse_bool(
        source.get('restrict_invites_to_domains', base['restrict_invites_to_domains']),
        False,
    )
    base['allowed_email_domains'] = normalize_workspace_domain_list(
        source.get('allowed_email_domains', base['allowed_email_domains'])
    )
    base['allow_member_share_management'] = parse_bool(
        source.get('allow_member_share_management', base['allow_member_share_management']),
        False,
    )

    base['allow_export'] = parse_bool(source.get('allow_export', base['allow_export']), True)
    return base


def workspace_settings_to_json(value):
    normalized = normalize_workspace_settings(value)
    return json.dumps(normalized, ensure_ascii=False)


def is_valid_email(value):
    email = normalize_email(value)
    return bool(re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', email))


def expires_at_for_days(days):
    safe_days = parse_int(days, INVITE_EXPIRY_DAYS, 1, 30)
    return (datetime.utcnow() + timedelta(days=safe_days)).isoformat()


def create_invite_token():
    return f'{uuid.uuid4().hex}{uuid.uuid4().hex}'


def build_invite_url(token):
    safe_token = str(token or '').strip()
    if not safe_token:
        return ''
    return f'{INVITE_BASE_URL}/#/invite/{safe_token}'


def send_workspace_invite_email(to_email, workspace_name, inviter_username, invite_url, expires_at):
    recipient = normalize_email(to_email)
    if not recipient:
        return False, 'Missing recipient email'
    if not RESEND_API_KEY:
        return False, 'RESEND_API_KEY is not configured'

    safe_workspace_name = str(workspace_name or '').strip() or 'Untitled Workspace'
    safe_inviter_username = str(inviter_username or '').strip() or 'A StudyHub member'
    safe_invite_url = str(invite_url or '').strip()
    safe_expiry_label = str(expires_at or '').strip() or 'Unknown'
    safe_recipient = recipient

    subject = f'StudyHub invite: {safe_workspace_name}'
    html = f'''
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 560px; margin: 0 auto;">
          <h2 style="margin-bottom: 12px;">You're invited to collaborate in StudyHub</h2>
          <p><strong>{html.escape(safe_inviter_username)}</strong> invited you to join <strong>{html.escape(safe_workspace_name)}</strong>.</p>
          <p>To use this invitation, sign in with <strong>{html.escape(safe_recipient)}</strong>, open the invitation, and request access. The workspace owner still needs to approve your request before you join.</p>
          <p style="margin: 18px 0;">
            <a href="{html.escape(safe_invite_url)}" style="display: inline-block; padding: 10px 14px; border-radius: 8px; text-decoration: none; background: #2563eb; color: #ffffff;">
              Open invitation
            </a>
          </p>
          <p style="margin-bottom: 8px;"><strong>Expires:</strong> {html.escape(safe_expiry_label)}</p>
          <p style="margin-bottom: 8px;"><strong>Direct link:</strong></p>
          <p style="margin-top: 0; word-break: break-word;">
            <a href="{html.escape(safe_invite_url)}" style="color: #2563eb;">{html.escape(safe_invite_url)}</a>
          </p>
          <p style="font-size: 12px; color: #6b7280;">If you did not expect this email, you can ignore it.</p>
        </div>
    '''
    text = (
        f'{safe_inviter_username} invited you to join "{safe_workspace_name}" on StudyHub.\n\n'
        f'Sign in with {safe_recipient}, open the invitation link below, and request access.\n'
        'The workspace owner still needs to approve your request before you join.\n\n'
        f'Invitation link: {safe_invite_url}\n'
        f'Expires: {safe_expiry_label}\n'
    )
    payload = {
        'from': RESEND_FROM_EMAIL,
        'to': [recipient],
        'subject': subject,
        'html': html,
        'text': text,
    }
    try:
        response = requests.post(
            'https://api.resend.com/emails',
            headers={
                'Authorization': f'Bearer {RESEND_API_KEY}',
                'Content-Type': 'application/json',
            },
            json=payload,
            timeout=15,
        )
        if response.status_code >= 400:
            return False, f'Resend failed ({response.status_code}): {response.text[:220]}'
        return True, ''
    except Exception as e:
        return False, f'Resend request error: {e}'


def expire_workspace_invitations(conn, workspace_id=''):
    now_iso = utcnow_iso()
    if workspace_id:
        conn.execute(
            '''
            UPDATE workspace_invitations
            SET status = 'expired'
            WHERE workspace_id = ?
              AND status IN ('pending', 'requested')
              AND expires_at < ?
            ''',
            (workspace_id, now_iso),
        )
    else:
        conn.execute(
            '''
            UPDATE workspace_invitations
            SET status = 'expired'
            WHERE status IN ('pending', 'requested')
              AND expires_at < ?
            ''',
            (now_iso,),
        )


def serialize_invitation_row(row):
    data = row_to_dict(row) or {}
    return {
        'id': data.get('id'),
        'workspace_id': data.get('workspace_id', ''),
        'email': data.get('email', ''),
        'token': data.get('token', ''),
        'status': data.get('status', ''),
        'expires_at': data.get('expires_at', ''),
        'created_at': data.get('created_at', ''),
        'requested_username': data.get('requested_username', ''),
        'requested_at': data.get('requested_at', ''),
        'reviewed_by': data.get('reviewed_by', ''),
        'reviewed_at': data.get('reviewed_at', ''),
        'review_note': data.get('review_note', ''),
        'invite_url': build_invite_url(data.get('token', '')),
    }


def ensure_owner_membership(conn, workspace_id, owner_username):
    cursor = conn.execute(
        'SELECT id FROM workspace_members WHERE workspace_id = ? AND username = ?',
        (workspace_id, owner_username),
    )
    existing = cursor.fetchone()
    if existing:
        conn.execute(
            '''
            UPDATE workspace_members
            SET role = ?, status = ?
            WHERE workspace_id = ? AND username = ?
            ''',
            ('owner', 'active', workspace_id, owner_username),
        )
    else:
        conn.execute(
            '''
            INSERT INTO workspace_members (workspace_id, username, role, status, created_at)
            VALUES (?, ?, ?, ?, ?)
            ''',
            (workspace_id, owner_username, 'owner', 'active', utcnow_iso()),
        )


def get_workspace_record(conn, workspace_id):
    cursor = conn.execute('SELECT * FROM workspaces WHERE id = ?', (workspace_id,))
    return row_to_dict(cursor.fetchone())


def workspace_belongs_to_user(conn, workspace_id, username):
    if not username:
        return False
    owner_cursor = conn.execute(
        'SELECT 1 FROM workspaces WHERE id = ? AND owner_username = ?',
        (workspace_id, username),
    )
    if owner_cursor.fetchone() is not None:
        return True
    cursor = conn.execute(
        '''
        SELECT 1
        FROM workspace_members
        WHERE workspace_id = ? AND username = ? AND status = 'active'
        ''',
        (workspace_id, username),
    )
    return cursor.fetchone() is not None


def get_or_create_default_workspace_id(conn, username):
    owner = str(username or '').strip()
    if not owner:
        return ''

    cursor = conn.execute(
        '''
        SELECT id
        FROM workspaces
        WHERE owner_username = ?
        ORDER BY created_at ASC, id ASC
        LIMIT 1
        ''',
        (owner,),
    )
    row = cursor.fetchone()
    row_data = row_to_dict(row)
    workspace_id = row_data.get('id') if row_data else ''
    if workspace_id:
        ensure_owner_membership(conn, workspace_id, owner)
        return workspace_id

    workspace_id = f'ws-{uuid.uuid4().hex[:12]}'
    now_iso = utcnow_iso()
    conn.execute(
        '''
        INSERT INTO workspaces (id, name, plan, owner_username, settings_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ''',
        (
            workspace_id,
            f"{owner}'s Workspace",
            'Free',
            owner,
            workspace_settings_to_json(DEFAULT_WORKSPACE_SETTINGS),
            now_iso,
            now_iso,
        ),
    )
    ensure_owner_membership(conn, workspace_id, owner)
    return workspace_id


def backfill_documents_workspace_ids(conn):
    if not documents_column_exists(conn, 'workspace_id'):
        return

    cursor = conn.execute(
        '''
        SELECT DISTINCT username
        FROM documents
        WHERE username IS NOT NULL
          AND TRIM(username) <> ''
          AND (workspace_id IS NULL OR TRIM(workspace_id) = '')
        '''
    )
    usernames = [
        (row_to_dict(item).get('username') or '').strip()
        for item in cursor.fetchall()
    ]
    usernames = [item for item in usernames if item]

    for owner in usernames:
        workspace_id = get_or_create_default_workspace_id(conn, owner)
        if not workspace_id:
            continue
        conn.execute(
            '''
            UPDATE documents
            SET workspace_id = ?
            WHERE username = ?
              AND (workspace_id IS NULL OR TRIM(workspace_id) = '')
            ''',
            (workspace_id, owner),
        )


def get_workspace_details(conn, workspace_row, for_username=''):
    workspace = row_to_dict(workspace_row) or {}
    workspace_id = workspace.get('id', '')
    owner_username = workspace.get('owner_username', '')
    is_owner = bool(for_username and for_username == owner_username)
    settings = normalize_workspace_settings(workspace.get('settings_json'))

    members_cursor = conn.execute(
        '''
        SELECT username, role, status, created_at
        FROM workspace_members
        WHERE workspace_id = ? AND status = 'active'
        ORDER BY created_at ASC
        ''',
        (workspace_id,),
    )
    members = [row_to_dict(item) for item in members_cursor.fetchall()]

    pending_requests = []
    invitations = []
    if is_owner:
        invite_cursor = conn.execute(
            '''
            SELECT *
            FROM workspace_invitations
            WHERE workspace_id = ?
              AND status IN ('pending', 'requested')
            ORDER BY created_at DESC
            ''',
            (workspace_id,),
        )
        invitations = [serialize_invitation_row(item) for item in invite_cursor.fetchall()]
        pending_requests = [item for item in invitations if item.get('status') == 'requested']

    return {
        'id': workspace_id,
        'name': normalize_workspace_name(workspace.get('name', ''), owner_username),
        'plan': 'Free' if workspace.get('plan', '') in ('', '免费版') else workspace.get('plan', ''),
        'owner_username': owner_username,
        'settings': settings,
        'created_at': workspace.get('created_at', ''),
        'updated_at': workspace.get('updated_at', ''),
        'is_owner': is_owner,
        'members_count': len(members),
        'members': members if is_owner else [],
        'invites': invitations,
        'pending_requests': pending_requests,
    }


def get_workspace_settings(conn, workspace_id):
    target_id = str(workspace_id or '').strip()
    if not target_id:
        return dict(DEFAULT_WORKSPACE_SETTINGS)
    workspace_row = get_workspace_record(conn, target_id)
    return normalize_workspace_settings((workspace_row or {}).get('settings_json'))
