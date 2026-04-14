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
      body: 'The recipient has a fresh invitation email and can join from the link.',
    };
  }
  if (failedCount > 0 && sentCount > 0) {
    return {
      title: 'Partially delivered',
      body: `${sentCount} email(s) were sent and ${failedCount} still need manual sharing.`,
    };
  }
  if (failedCount > 0) {
    return {
      title: 'Manual sharing needed',
      body: `Created ${createdCount} invite(s), but email delivery is not ready. Use Copy Invite Message or Copy Latest Link.`,
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

const getLinkSharingModeHelp = (mode) => {
  const safeMode = String(mode || '').trim().toLowerCase();
  if (safeMode === 'restricted') {
    return 'Restricted blocks document share links. People must already be inside the workspace to open files.';
  }
  if (safeMode === 'public') {
    return 'Anyone With Link makes document access public. Shared links still work, and direct document access is no longer limited to workspace members.';
  }
  return 'Workspace Members keeps documents private by default, but valid share links still open the document while workspace members keep their normal access.';
};

export default function WorkspaceInviteModal({
  open = false,
  workspaceActionLoading = false,
  onClose,
  isLoggedIn = false,
  workspaceInviteDraft = '',
  onChangeWorkspaceInviteDraft,
  onInviteMembers,
  inviteCopied = false,
  onCopyInviteLink,
  onCopyInviteMessage,
  workspaceInviteLink = '',
  latestInviteDelivery = null,
  trustedInviteDomains = [],
  defaultInviteExpiryDays = 7,
  workspaceSettingsDraft = {},
  updateWorkspaceSettingsDraft,
  onSaveWorkspaceAccessSettings,
  canManageAccessSettings = false,
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
  const trustedDomainsFromDraft = formatDomains(accessSettings.allowed_email_domains);
  const displayedTrustedDomains = trustedDomainsFromDraft.length
    ? trustedDomainsFromDraft
    : trustedInviteDomains;
  const displayedInviteExpiryDays =
    Number(accessSettings.default_invite_expiry_days) || defaultInviteExpiryDays || 7;
  const normalizedMembers = Array.isArray(memberItems)
    ? memberItems.map(normalizeMemberRecord).filter((member) => member.username)
    : [];

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
              {isLoggedIn
                ? 'Paste email addresses, send invitations, and track active invite links.'
                : 'Guest mode only saves local invite targets. Sign in to send real invitation emails.'}
            </p>
          </div>
          <div className="notion-settings-header-badges">
            <span className="notion-summary-chip">{inviteOpenCount} open</span>
            <span className="notion-summary-chip">Expiry {displayedInviteExpiryDays}d</span>
            <span className="notion-summary-chip">
              {displayedTrustedDomains?.length
                ? `Domains: ${displayedTrustedDomains.join(', ')}`
                : 'Any valid email'}
            </span>
            <span className="notion-summary-chip">
              {isLoggedIn ? 'Email + invite link' : 'Local targets only'}
            </span>
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

        <div className="notion-invite-modal-layout">
          <section className="notion-settings-block">
            <h4>Invite People</h4>
            <p className="notion-settings-help">
              Invitees must sign in with the same email address that was invited. Then the link adds them directly.
            </p>
            <label htmlFor="workspace-invite-email-input" className="sr-only">
              Invite email
            </label>
            <textarea
              id="workspace-invite-email-input"
              rows={6}
              value={workspaceInviteDraft}
              onChange={(event) => onChangeWorkspaceInviteDraft?.(event.target.value)}
              placeholder="alice@school.edu, bob@school.edu"
              disabled={workspaceActionLoading}
              autoFocus
            />
            <div className="notion-modal-actions">
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
              <button
                type="button"
                className="btn"
                onClick={() => onCopyInviteLink?.()}
                disabled={workspaceActionLoading}
              >
                {inviteCopied ? 'Link Copied' : 'Copy Latest Link'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => onCopyInviteMessage?.()}
                disabled={workspaceActionLoading}
              >
                Copy Invite Message
              </button>
            </div>
            {workspaceInviteLink && (
              <a
                className="notion-inline-panel-hint notion-inline-panel-link"
                href={workspaceInviteLink}
                target="_blank"
                rel="noreferrer"
              >
                {workspaceInviteLink}
              </a>
            )}
          </section>

          <section className="notion-settings-block">
            <h4>Delivery Status</h4>
            {latestInviteDelivery ? (
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
            ) : (
              <p className="notion-settings-help">
                No invite batch has been sent yet. Start by pasting one or more email addresses.
              </p>
            )}
          </section>
        </div>

        <section className="notion-settings-block" aria-label="Access settings">
          <div className="notion-doc-share-manager-head">
            <h4>Access Settings</h4>
            <span className="notion-settings-help">
              Invitation rules and document link behavior for this workspace.
            </span>
          </div>

          <div className="notion-invite-access-grid">
            <div className="notion-invite-access-column">
              <h5>Invitations and trusted domains</h5>
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
                  checked={Boolean(accessSettings.restrict_invites_to_domains)}
                  onChange={(event) =>
                    updateWorkspaceSettingsDraft?.({ restrict_invites_to_domains: event.target.checked })
                  }
                  disabled={ownerOnlyDisabled}
                />
                <span>Restrict invitations to trusted email domains</span>
              </label>
              <div className="notion-settings-row">
                <label htmlFor="workspace-invite-domain-list-input">Trusted Domains</label>
                <textarea
                  id="workspace-invite-domain-list-input"
                  rows={2}
                  value={accessSettings.allowed_email_domains || ''}
                  onChange={(event) =>
                    updateWorkspaceSettingsDraft?.({ allowed_email_domains: event.target.value })
                  }
                  placeholder="school.edu, club.org"
                  disabled={ownerOnlyDisabled}
                />
              </div>
              <div className="notion-settings-row">
                <label htmlFor="workspace-invite-expiry-days-input">Invitation Link Expiry (days)</label>
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
                {trustedDomainsFromDraft.length
                  ? `Trusted domains: ${trustedDomainsFromDraft.join(', ')}`
                  : 'No trusted domains configured. Leave the restriction off if any valid email can be invited.'}
              </p>
            </div>

            <div className="notion-invite-access-column">
              <h5>Link sharing</h5>
              <div className="notion-settings-row">
                <label htmlFor="workspace-invite-link-mode-select">Link Sharing</label>
                <select
                  id="workspace-invite-link-mode-select"
                  value={accessSettings.link_sharing_mode || 'workspace'}
                  onChange={(event) =>
                    updateWorkspaceSettingsDraft?.({ link_sharing_mode: event.target.value })
                  }
                  disabled={ownerOnlyDisabled}
                >
                  <option value="restricted">Restricted</option>
                  <option value="workspace">Workspace Members</option>
                  <option value="public">Anyone With Link</option>
                </select>
              </div>
              <p className="notion-settings-help">
                {getLinkSharingModeHelp(accessSettings.link_sharing_mode)}
              </p>
              <div className="notion-settings-row">
                <label htmlFor="workspace-invite-share-expiry-input">Share Link Expiry (days)</label>
                <input
                  id="workspace-invite-share-expiry-input"
                  type="number"
                  min="1"
                  max="30"
                  value={accessSettings.default_share_expiry_days || 7}
                  onChange={(event) =>
                    updateWorkspaceSettingsDraft?.({
                      default_share_expiry_days: Number(event.target.value) || 7,
                    })
                  }
                  disabled={ownerOnlyDisabled}
                />
              </div>
              <div className="notion-settings-row">
                <label htmlFor="workspace-invite-share-link-limit-input">Max Active Links Per Note</label>
                <input
                  id="workspace-invite-share-link-limit-input"
                  type="number"
                  min="1"
                  max="20"
                  value={accessSettings.max_active_share_links_per_document || 5}
                  onChange={(event) =>
                    updateWorkspaceSettingsDraft?.({
                      max_active_share_links_per_document: Number(event.target.value) || 5,
                    })
                  }
                  disabled={ownerOnlyDisabled}
                />
              </div>
              <label className="notion-checkbox-row">
                <input
                  type="checkbox"
                  checked={Boolean(accessSettings.allow_member_share_management)}
                  onChange={(event) =>
                    updateWorkspaceSettingsDraft?.({
                      allow_member_share_management: event.target.checked,
                    })
                  }
                  disabled={ownerOnlyDisabled}
                />
                <span>Allow members to manage share links</span>
              </label>
              <label className="notion-checkbox-row">
                <input
                  type="checkbox"
                  checked={Boolean(accessSettings.auto_revoke_previous_share_links)}
                  onChange={(event) =>
                    updateWorkspaceSettingsDraft?.({
                      auto_revoke_previous_share_links: event.target.checked,
                    })
                  }
                  disabled={ownerOnlyDisabled}
                />
                <span>Auto revoke existing active links when creating a new one</span>
              </label>
            </div>
          </div>

          <div className="notion-modal-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSaveWorkspaceAccessSettings}
              disabled={ownerOnlyDisabled}
            >
              {workspaceActionLoading ? 'Saving...' : 'Save Access Settings'}
            </button>
            {!canManageAccessSettings && (
              <p className="notion-settings-help">
                Only the workspace owner can change access settings.
              </p>
            )}
          </div>
        </section>

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
            <h4>Open Invitations</h4>
            <span className="notion-settings-help">
              Resend emails or remove old invitation links before they are used.
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
                const inviteUrl =
                  typeof invite === 'object' ? String(invite?.invite_url || '').trim() : '';
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
                              ? 'Invite link is ready to share'
                              : 'Saved locally only'}
                      </p>
                      {inviteUrl && (
                        <a
                          className="notion-invite-card-link"
                          href={inviteUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {inviteUrl}
                        </a>
                      )}
                    </div>

                    <div className="notion-inline-list-actions notion-invite-card-actions">
                      <>
                        {inviteUrl && (
                          <button
                            type="button"
                            className="notion-inline-list-secondary"
                            onClick={() => onCopyInviteLink?.(invite)}
                            disabled={workspaceActionLoading}
                          >
                            Copy link
                          </button>
                        )}
                        {inviteUrl && (
                          <button
                            type="button"
                            className="notion-inline-list-secondary"
                            onClick={() => onCopyInviteMessage?.(invite)}
                            disabled={workspaceActionLoading}
                          >
                            Copy message
                          </button>
                        )}
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
      </section>
    </div>
  );
}
