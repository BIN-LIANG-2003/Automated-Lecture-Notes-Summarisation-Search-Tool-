const formatInviteStatusLabel = (status) => {
  if (status === 'requested') return 'Opened';
  if (status === 'pending') return 'Ready to join';
  if (status === 'approved') return 'Approved';
  if (status === 'rejected') return 'Rejected';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'expired') return 'Expired';
  return status || 'Unknown';
};

const formatInviteDateTime = (value) => {
  if (!value) return '';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  return dt.toLocaleString();
};

const normalizeMemberRecord = (member) => {
  if (typeof member === 'string') {
    return {
      username: member,
      role: 'member',
      status: 'active',
      email: '',
      created_at: '',
    };
  }
  if (!member || typeof member !== 'object') {
    return {
      username: '',
      role: 'member',
      status: 'active',
      email: '',
      created_at: '',
    };
  }
  return {
    username: String(member.username || '').trim(),
    role: String(member.role || 'member').trim().toLowerCase(),
    status: String(member.status || 'active').trim().toLowerCase(),
    email: String(member.email || '').trim(),
    created_at: String(member.created_at || member.createdAt || '').trim(),
  };
};

const summarizeInviteDelivery = (delivery) => {
  if (!delivery) return { title: '', body: '' };
  const createdCount = Math.max(0, Number(delivery.createdCount) || 0);
  const sentCount = Math.max(0, Number(delivery.emailSentCount) || 0);
  const failedCount = Math.max(0, Number(delivery.emailFailedCount) || 0);

  if (delivery.type === 'local') {
    return {
      title: 'Saved locally only',
      body: `${createdCount} invite target(s) were saved locally. Sign in and configure email delivery to send real invite emails.`,
    };
  }
  if (delivery.type === 'resend' && failedCount === 0) {
    return {
      title: 'Invitation email resent',
      body: 'The recipient has a fresh invitation email and can join the workspace from it.',
    };
  }
  if (failedCount > 0 && sentCount > 0) {
    return {
      title: 'Partially delivered',
      body: `${sentCount} email(s) were sent and ${failedCount} could not be delivered.`,
    };
  }
  if (failedCount > 0) {
    return {
      title: 'Manual sharing needed',
      body: `Created ${createdCount} invite(s), but email delivery is not ready. Resend the invitation when email delivery is available.`,
    };
  }
  return {
    title: 'Invitation emails sent',
    body: `${sentCount || createdCount} invite email(s) were sent successfully.`,
  };
};

const formatDomains = (value) =>
  String(value || '')
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);

export default function WorkspaceInviteModal({
  open = false,
  workspaceActionLoading = false,
  onClose,
  isLoggedIn = false,
  workspaceInviteDraft = '',
  onChangeWorkspaceInviteDraft,
  onInviteMembers,
  latestInviteDelivery = null,
  workspaceSettingsDraft = {},
  updateWorkspaceSettingsDraft,
  onSaveWorkspaceAccessSettings,
  canManageAccessSettings = false,
  canInviteMembers = true,
  inviteItems = [],
  onResendInvitation,
  onRemoveInvite,
  memberItems = [],
  currentUsername = '',
  canManageMembers = false,
  onRemoveMember,
}) {
  if (!open) return null;

  const inviteDeliverySummary = summarizeInviteDelivery(latestInviteDelivery);
  const inviteOpenCount = Array.isArray(inviteItems) ? inviteItems.length : 0;
  const accessSettings = workspaceSettingsDraft || {};
  const ownerOnlyDisabled = workspaceActionLoading || (isLoggedIn && !canManageAccessSettings);
  const blockedDomainsFromDraft = formatDomains(accessSettings.blocked_email_domains);
  const normalizedMembers = Array.isArray(memberItems)
    ? memberItems.map(normalizeMemberRecord).filter((member) => member.username)
    : [];
  const invitationsBlocked = isLoggedIn && !canInviteMembers;

  return (
    <div
      className="notion-modal-backdrop"
      role="presentation"
      onClick={() => {
        if (workspaceActionLoading) return;
        onClose?.();
      }}
    >
      <section
        className="notion-modal-card notion-settings-modal notion-invite-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-invite-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="notion-settings-header">
          <div>
            <p className="notion-settings-kicker">Workspace Access</p>
            <h3 id="workspace-invite-title">Invite Members</h3>
            <p className="notion-settings-subtitle">
              {invitationsBlocked
                ? 'Members cannot invite others in this workspace.'
                : isLoggedIn
                ? 'Paste email addresses, send invitations, and track pending invites.'
                : 'Guest mode only saves local invite targets. Sign in to send real invitation emails.'}
            </p>
          </div>
          <button
            type="button"
            className="notion-modal-close"
            onClick={() => {
              if (workspaceActionLoading) return;
              onClose?.();
            }}
            aria-label="Close invite members"
          >
            ×
          </button>
        </header>

        {invitationsBlocked ? (
          <section className="notion-settings-block notion-invite-blocked" role="status">
            <h4>Invitations are disabled</h4>
            <p className="notion-settings-help">
              This workspace does not allow members to invite other people. Please contact the workspace owner.
            </p>
          </section>
        ) : (
          <>
            <section className="notion-settings-block notion-invite-compose-block">
              <div className="notion-doc-share-manager-head">
                <div>
                  <h4>Invite People</h4>
                  <span className="notion-settings-help">
                    Enter one or more email addresses. Each recipient gets an email invitation for this workspace.
                  </span>
                </div>
              </div>
              <label htmlFor="workspace-invite-email-input" className="sr-only">
                Invite email
              </label>
              <textarea
                id="workspace-invite-email-input"
                rows={4}
                value={workspaceInviteDraft}
                onChange={(event) => onChangeWorkspaceInviteDraft?.(event.target.value)}
                placeholder="alice@school.edu, bob@school.edu"
                disabled={workspaceActionLoading}
                autoFocus
              />
              <div className="notion-modal-actions notion-invite-primary-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onInviteMembers}
                  disabled={workspaceActionLoading}
                >
                  {workspaceActionLoading
                    ? 'Processing...'
                    : isLoggedIn
                      ? 'Send Invite Emails'
                      : 'Save Invite Targets'}
                </button>
              </div>
              {latestInviteDelivery && (
                <div
                  className={`notion-invite-feedback ${
                    latestInviteDelivery.emailFailedCount ? 'warning' : 'success'
                  }`}
                  role="status"
                >
                  <strong>{inviteDeliverySummary.title}</strong>
                  <p>{inviteDeliverySummary.body}</p>
                  {latestInviteDelivery.invalidEmails?.length > 0 && (
                    <p>Ignored invalid emails: {latestInviteDelivery.invalidEmails.join(', ')}</p>
                  )}
                  {latestInviteDelivery.failedItems?.length > 0 && (
                    <ul className="notion-invite-feedback-list">
                      {latestInviteDelivery.failedItems.map((item, index) => (
                        <li key={`${item.email || 'invite-failure'}-${index}`}>
                          <strong>{item.email || 'Unknown recipient'}</strong>
                          <span>{item.error || 'Failed to send email'}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>

        {canManageAccessSettings && (
          <section className="notion-settings-block" aria-label="Invitation settings">
            <div className="notion-doc-share-manager-head">
              <h4>Invitation Settings</h4>
              <span className="notion-settings-help">
                Control who can send invitations and which email domains cannot join this workspace.
              </span>
            </div>

          <div className="notion-invite-access-grid">
            <div className="notion-invite-access-column">
              <h5>Invitation rules</h5>
              <label className="notion-checkbox-row">
                <input
                  type="checkbox"
                  checked={Boolean(accessSettings.allow_member_invites)}
                  onChange={(event) =>
                    updateWorkspaceSettingsDraft?.({ allow_member_invites: event.target.checked })
                  }
                  disabled={ownerOnlyDisabled}
                />
                <span>Allow members to invite others</span>
              </label>
              <label className="notion-checkbox-row">
                <input
                  type="checkbox"
                  checked={Boolean(accessSettings.block_invites_from_domains)}
                  onChange={(event) =>
                    updateWorkspaceSettingsDraft?.({ block_invites_from_domains: event.target.checked })
                  }
                  disabled={ownerOnlyDisabled}
                />
                <span>Block specific email domains</span>
              </label>
              <div className="notion-settings-row">
                <label htmlFor="workspace-invite-domain-list-input">Blocked Domains</label>
                <textarea
                  id="workspace-invite-domain-list-input"
                  rows={2}
                  value={accessSettings.blocked_email_domains || ''}
                  onChange={(event) =>
                    updateWorkspaceSettingsDraft?.({ blocked_email_domains: event.target.value })
                  }
                  placeholder="spam.com, blocked-school.edu"
                  disabled={ownerOnlyDisabled}
                />
              </div>
              <div className="notion-settings-row">
                <label htmlFor="workspace-invite-expiry-days-input">Invitation Expiry (days)</label>
                <input
                  id="workspace-invite-expiry-days-input"
                  type="number"
                  min="1"
                  max="30"
                  value={accessSettings.default_invite_expiry_days || 7}
                  onChange={(event) =>
                    updateWorkspaceSettingsDraft?.({
                      default_invite_expiry_days: Number(event.target.value) || 7,
                    })
                  }
                  disabled={ownerOnlyDisabled}
                />
              </div>
              <p className="notion-settings-help">
                {blockedDomainsFromDraft.length
                  ? `Blocked domains: ${blockedDomainsFromDraft.join(', ')}`
                  : 'No blocked domains configured. Any valid email can be invited.'}
              </p>
            </div>
          </div>

          <div className="notion-modal-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSaveWorkspaceAccessSettings}
              disabled={ownerOnlyDisabled}
            >
              {workspaceActionLoading ? 'Saving...' : 'Save Invitation Settings'}
            </button>
          </div>
        </section>
        )}

        {canManageMembers && (
          <section className="notion-settings-block" aria-label="Workspace members">
            <div className="notion-doc-share-manager-head">
              <h4>Workspace Members</h4>
              <span className="notion-settings-help">
                {normalizedMembers.length} active member{normalizedMembers.length === 1 ? '' : 's'}
              </span>
            </div>
            {normalizedMembers.length > 0 ? (
              <ul className="notion-inline-list notion-invite-list notion-invite-modal-list">
                {normalizedMembers.map((member) => {
                  const isOwner = member.role === 'owner';
                  const isCurrentUser = member.username === currentUsername;
                  const canRemoveThisMember = !isOwner && !isCurrentUser;
                  return (
                    <li key={member.username} className="notion-invite-card">
                      <div className="notion-invite-card-main">
                        <div className="notion-invite-card-head">
                          <strong>{member.username}</strong>
                          <span
                            className={`notion-invite-status ${
                              isOwner ? 'notion-invite-status-approved' : 'notion-invite-status-pending'
                            }`}
                          >
                            {isOwner ? 'Owner' : 'Member'}
                          </span>
                        </div>
                        <p className="notion-invite-card-meta">
                          {[
                            member.email || '',
                            member.created_at ? `Joined ${formatInviteDateTime(member.created_at)}` : '',
                          ]
                            .filter(Boolean)
                            .join(' · ') || 'Active workspace access'}
                        </p>
                      </div>
                      <div className="notion-inline-list-actions notion-invite-card-actions">
                        {canRemoveThisMember ? (
                          <button
                            type="button"
                            className="notion-inline-list-remove"
                            onClick={() => onRemoveMember?.(member)}
                            disabled={workspaceActionLoading}
                          >
                            Remove
                          </button>
                        ) : (
                          <span className="notion-settings-help">
                            {isOwner ? 'Cannot remove owner' : 'Current account'}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="notion-settings-help">No active members yet.</p>
            )}
          </section>
        )}

        <section className="notion-settings-block" aria-label="Open invitations">
          <div className="notion-doc-share-manager-head">
            <h4>Pending Invitations</h4>
            <span className="notion-settings-help">
              Resend emails or cancel old invitations before they are used.
            </span>
          </div>
          {inviteOpenCount > 0 ? (
            <ul className="notion-inline-list notion-invite-list notion-invite-modal-list">
              {inviteItems.map((invite) => {
                const inviteId =
                  typeof invite === 'object' ? invite?.id || invite?.email : invite;
                const inviteEmail = typeof invite === 'string' ? invite : invite?.email;
                const inviteStatus =
                  typeof invite === 'object' ? invite?.status || 'pending' : 'pending';
                const requestedUsername =
                  typeof invite === 'object' ? String(invite?.requested_username || '').trim() : '';
                const requestedAt =
                  typeof invite === 'object' ? String(invite?.requested_at || '').trim() : '';
                const expiresAt =
                  typeof invite === 'object' ? String(invite?.expires_at || '').trim() : '';
                const hasServerInvitation =
                  typeof invite === 'object' && Number(invite?.id) > 0;
                const isRequested = inviteStatus === 'requested';

                return (
                  <li key={`${inviteId}`} className="notion-invite-card">
                    <div className="notion-invite-card-main">
                      <div className="notion-invite-card-head">
                        <strong>{inviteEmail || 'Unknown email'}</strong>
                        <span className={`notion-invite-status notion-invite-status-${inviteStatus}`}>
                          {formatInviteStatusLabel(inviteStatus)}
                        </span>
                      </div>
                      <p className="notion-invite-card-meta">
                        {isRequested
                          ? `Opened by ${requestedUsername || 'member'}${
                              requestedAt ? ` · ${formatInviteDateTime(requestedAt)}` : ''
                            }`
                          : expiresAt
                            ? `Expires ${formatInviteDateTime(expiresAt)}`
                            : hasServerInvitation
                              ? 'Invitation is ready'
                              : 'Saved locally only'}
                      </p>
                    </div>

                    <div className="notion-inline-list-actions notion-invite-card-actions">
                      <>
                        {hasServerInvitation && !isRequested && (
                          <button
                            type="button"
                            className="notion-inline-list-switch"
                            onClick={() => onResendInvitation?.(invite)}
                            disabled={workspaceActionLoading}
                          >
                            Resend email
                          </button>
                        )}
                        <button
                          type="button"
                          className="notion-inline-list-remove"
                          onClick={() => onRemoveInvite?.(invite)}
                          disabled={workspaceActionLoading}
                        >
                          {hasServerInvitation ? 'Cancel' : 'Remove'}
                        </button>
                      </>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="notion-settings-help">No open invitations yet.</p>
          )}
        </section>
          </>
        )}
      </section>
    </div>
  );
}
