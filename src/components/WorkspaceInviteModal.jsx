const formatInviteStatusLabel = (status) => {
  if (status === 'requested') return 'Pending approval';
  if (status === 'pending') return 'Awaiting request';
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
      body: 'The recipient has a fresh invitation email and can use the same invite flow again.',
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
  inviteItems = [],
  onResendInvitation,
  onReviewInvitation,
  onRemoveInvite,
}) {
  if (!open) return null;

  const inviteDeliverySummary = summarizeInviteDelivery(latestInviteDelivery);
  const inviteOpenCount = Array.isArray(inviteItems) ? inviteItems.length : 0;

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
                ? 'Paste email addresses, send invitations, and track who still needs approval.'
                : 'Guest mode only saves local invite targets. Sign in to send real invitation emails.'}
            </p>
          </div>
          <div className="notion-settings-header-badges">
            <span className="notion-summary-chip">{inviteOpenCount} open</span>
            <span className="notion-summary-chip">Expiry {defaultInviteExpiryDays || 7}d</span>
            <span className="notion-summary-chip">
              {trustedInviteDomains?.length
                ? `Domains: ${trustedInviteDomains.join(', ')}`
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
              Invitees must sign in with the same email address that was invited before they can request access.
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

        <section className="notion-settings-block" aria-label="Open invitations">
          <div className="notion-doc-share-manager-head">
            <h4>Open Invitations</h4>
            <span className="notion-settings-help">
              Review pending requests, resend emails, or remove old invitation links.
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
                          ? `Requested by ${requestedUsername || 'member'}${
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
                      {isRequested ? (
                        <>
                          <button
                            type="button"
                            className="notion-inline-list-switch"
                            onClick={() => onReviewInvitation?.(invite, 'approve')}
                            disabled={workspaceActionLoading}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            className="notion-inline-list-remove"
                            onClick={() => onReviewInvitation?.(invite, 'reject')}
                            disabled={workspaceActionLoading}
                          >
                            Reject
                          </button>
                        </>
                      ) : (
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
                          {hasServerInvitation && (
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
                      )}
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
