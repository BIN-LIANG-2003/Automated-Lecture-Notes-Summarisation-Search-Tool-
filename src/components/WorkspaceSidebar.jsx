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

export default function WorkspaceSidebar({
  mobileSidebarOpen,
  onCloseMobileSidebar,
  workspaceMenuOpen,
  workspaceMenuRef,
  onToggleWorkspaceMenu,
  activeWorkspace,
  accountName,
  getWorkspaceIconLabel,
  isLoggedIn,
  workspaceMemberCount,
  pendingRequestCount,
  onOpenWorkspaceSettings,
  canOpenWorkspaceSettings,
  onOpenWorkspaceInvite,
  canOpenWorkspaceInvite,
  accountEmail,
  onOpenAccountManager,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onCreateWorkspace,
  workspaceBusy,
  onAuthAction,
  workspaceInviteOpen,
  workspaceInviteDraft,
  onChangeWorkspaceInviteDraft,
  workspaceActionLoading,
  onInviteMembers,
  inviteCopied,
  onCopyInviteLink,
  onCopyInviteMessage,
  workspaceInviteLink,
  latestInviteDelivery,
  trustedInviteDomains,
  defaultInviteExpiryDays,
  inviteItems,
  onResendInvitation,
  onReviewInvitation,
  onRemoveInvite,
  homeActive,
  filesActive,
  aiActive,
  aiDisabled,
  onGoHome,
  onGoFiles,
  onGoAI,
  showStarredSection,
  starredDocs,
  activeDocId,
  starredDragId,
  onStarredDragStart,
  onStarredDrop,
  onStarredDragEnd,
  onOpenStarredNote,
  onToggleStarredNote,
  showRecentSection,
  recentMenuRef,
  recentDocs,
  sidebarMenuDocId,
  onToggleSidebarMenu,
  onOpenRecentDocument,
  username,
}) {
  const activeWorkspaceLabel = activeWorkspace?.name || `${accountName}'s Workspace`;
  const activeWorkspaceIcon = getWorkspaceIconLabel(activeWorkspace, accountName);
  const inviteDeliverySummary = summarizeInviteDelivery(latestInviteDelivery);
  const inviteOpenCount = Array.isArray(inviteItems) ? inviteItems.length : 0;

  return (
    <aside
      className={`notion-sidebar${mobileSidebarOpen ? ' is-open' : ''}`}
      aria-label="Left navigation"
    >
      <div className="notion-sidebar-mobile-head">
        <div>
          <strong>{activeWorkspaceLabel}</strong>
          <p>{isLoggedIn ? 'Workspace navigation' : 'Guest navigation'}</p>
        </div>
        <button
          type="button"
          className="notion-mobile-close-btn"
          onClick={onCloseMobileSidebar}
          aria-label="Close navigation"
        >
          ×
        </button>
      </div>
      <div className={`notion-workspace-picker ${workspaceMenuOpen ? 'open' : ''}`} ref={workspaceMenuRef}>
        <button
          type="button"
          className="notion-workspace-trigger"
          aria-expanded={workspaceMenuOpen ? 'true' : 'false'}
          aria-controls="workspace-account-menu"
          onClick={onToggleWorkspaceMenu}
        >
          <span className="notion-workspace-trigger-main">
            <span className="notion-avatar" aria-hidden="true">
              {activeWorkspaceIcon}
            </span>
            <span className="notion-workspace-trigger-label">{activeWorkspaceLabel}</span>
          </span>
          <span className="notion-workspace-trigger-chevron" aria-hidden="true">
            ▾
          </span>
        </button>

        <section
          id="workspace-account-menu"
          className="notion-account-panel"
          aria-label="Workspace account"
          hidden={!workspaceMenuOpen}
        >
          <div className="notion-space-head">
            <div className="notion-avatar notion-avatar-large" aria-hidden="true">
              {activeWorkspaceIcon}
            </div>
            <div>
              <strong>{activeWorkspaceLabel}</strong>
              <p>
                {isLoggedIn
                  ? `${activeWorkspace?.plan || 'Free'} · ${workspaceMemberCount || 1} member${
                      workspaceMemberCount === 1 ? '' : 's'
                    }${pendingRequestCount ? ` · ${pendingRequestCount} pending` : ''}`
                  : 'Guest mode'}
              </p>
            </div>
          </div>

          <div className="notion-account-tools">
            <button
              type="button"
              className="notion-chip-btn"
              onClick={onOpenWorkspaceSettings}
              disabled={!canOpenWorkspaceSettings}
            >
              Settings
            </button>
            <button
              type="button"
              className="notion-chip-btn"
              onClick={onOpenWorkspaceInvite}
              disabled={!canOpenWorkspaceInvite}
            >
              Invite Members
            </button>
          </div>

          <div className="notion-account-email-row">
            <span>{accountEmail || 'No email set'}</span>
            <button
              type="button"
              className="notion-ellipsis-btn"
              aria-label="More account actions"
              onClick={onOpenAccountManager}
            >
              ...
            </button>
          </div>

          {(workspaces || []).map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className={`notion-space-switch ${workspace.id === activeWorkspaceId ? 'active' : ''}`}
              onClick={() => onSelectWorkspace(workspace.id)}
              disabled={workspaceBusy}
            >
              <span className="notion-space-switch-main">
                <span className="notion-avatar" aria-hidden="true">
                  {getWorkspaceIconLabel(workspace, workspace.name || accountName)}
                </span>
                <span>{workspace.name}</span>
              </span>
              <span aria-hidden="true">{workspace.id === activeWorkspaceId ? '✓' : ''}</span>
            </button>
          ))}

          <button
            type="button"
            className="notion-plus-link"
            onClick={onCreateWorkspace}
            disabled={workspaceBusy}
          >
            + New Workspace
          </button>

          <div className="notion-account-divider" />

          <button type="button" className="notion-account-link" onClick={onOpenAccountManager}>
            Add Another Account
          </button>
          <button type="button" className="notion-account-link" onClick={onAuthAction}>
            {isLoggedIn ? 'Sign Out' : 'Sign In'}
          </button>

          {workspaceInviteOpen && (
            <section className="notion-inline-panel notion-invite-panel" aria-label="Invite members">
              <div className="notion-invite-panel-head">
                <div>
                  <h3>Invite Members</h3>
                  <p>
                    {isLoggedIn
                      ? 'Paste email addresses, send invitations, and track who still needs approval.'
                      : 'Guest mode only saves local invite targets. Sign in to send real invitation emails.'}
                  </p>
                </div>
                <span className="notion-summary-chip">{inviteOpenCount} open</span>
              </div>

              <div className="notion-invite-meta-pills" aria-label="Invite rules">
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

              <p className="notion-inline-panel-help">
                Invitees must sign in with the same email address that was invited before they can request access.
              </p>

              <label htmlFor="invite-email-input" className="sr-only">
                Invite email
              </label>
              <textarea
                id="invite-email-input"
                rows={3}
                value={workspaceInviteDraft}
                onChange={(event) => onChangeWorkspaceInviteDraft(event.target.value)}
                placeholder="alice@school.edu, bob@school.edu"
                disabled={workspaceActionLoading}
              />
              <div className="notion-inline-panel-actions">
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

              {inviteOpenCount > 0 ? (
                <ul className="notion-inline-list notion-invite-list">
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
                                onClick={() => onReviewInvitation(invite, 'approve')}
                                disabled={workspaceActionLoading}
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                className="notion-inline-list-remove"
                                onClick={() => onReviewInvitation(invite, 'reject')}
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
                                onClick={() => onRemoveInvite(invite)}
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
                <span className="notion-sidebar-empty">No open invitations yet</span>
              )}
            </section>
          )}
        </section>
      </div>

      <nav className="notion-nav" aria-label="Main menu">
        <button type="button" className={`notion-nav-item ${homeActive ? 'active' : ''}`} onClick={onGoHome}>
          <span aria-hidden="true">⌂</span>
          <span>Home</span>
        </button>
        <button type="button" className={`notion-nav-item ${filesActive ? 'active' : ''}`} onClick={onGoFiles}>
          <span aria-hidden="true">📄</span>
          <span>My Files</span>
        </button>
        <button
          type="button"
          className={`notion-nav-item ${aiActive ? 'active' : ''}`}
          onClick={onGoAI}
          disabled={aiDisabled}
          title={aiDisabled ? 'AI is disabled in workspace settings' : undefined}
        >
          <span aria-hidden="true">✨</span>
          <span>AI Assistant</span>
        </button>
      </nav>

      {showStarredSection && (
        <section className="notion-sidebar-group" aria-labelledby="starred-group-title">
          <h2 id="starred-group-title">Starred</h2>
          <div className="notion-sidebar-list">
            {starredDocs.length ? (
              starredDocs.map((entry) => {
                const entryId = Number(entry.id) || 0;
                const active = Number(activeDocId) === entryId;
                return (
                  <div
                    key={`starred-${entryId}`}
                    className={`notion-sidebar-doc-row ${active ? 'active' : ''}${
                      starredDragId === entryId ? ' dragging' : ''
                    }`}
                    draggable
                    onDragStart={() => onStarredDragStart(entryId)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      onStarredDrop(entryId);
                    }}
                    onDragEnd={onStarredDragEnd}
                  >
                    <button type="button" className="notion-sidebar-doc" onClick={() => onOpenStarredNote(entry)}>
                      <span className="notion-sidebar-doc-prefix notion-sidebar-doc-prefix-star" aria-hidden="true">
                        ★
                      </span>
                      <span className="notion-sidebar-doc-label">{entry.title}</span>
                    </button>
                    <div className="notion-sidebar-doc-actions">
                      <button
                        type="button"
                        className="notion-sidebar-doc-more notion-sidebar-doc-unstar"
                        aria-label={`Remove ${entry.title} from Starred`}
                        title="Remove from Starred"
                        onClick={() => onToggleStarredNote(entry)}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })
            ) : (
              <span className="notion-sidebar-empty">No starred notes yet</span>
            )}
          </div>
        </section>
      )}

      {showRecentSection && (
        <section className="notion-sidebar-group" aria-labelledby="recent-group-title" ref={recentMenuRef}>
          <h2 id="recent-group-title">Recent</h2>
          <div className="notion-sidebar-list">
            {recentDocs.length ? (
              recentDocs.map((doc) => (
                <div
                  key={doc.id}
                  className={`notion-sidebar-doc-row ${Number(activeDocId) === Number(doc.id) ? 'active' : ''} ${
                    sidebarMenuDocId === doc.id ? 'menu-open' : ''
                  }`}
                >
                  <button
                    type="button"
                    className="notion-sidebar-doc"
                    onClick={() => onOpenRecentDocument(doc)}
                  >
                    <span className="notion-sidebar-doc-prefix" aria-hidden="true">
                      {Number(activeDocId) === Number(doc.id) ? '›' : '📄'}
                    </span>
                    <span className="notion-sidebar-doc-label">{doc.title}</span>
                  </button>

                  <div className="notion-sidebar-doc-actions">
                    <button
                      type="button"
                      className="notion-sidebar-doc-more"
                      aria-label={`${doc.title} more actions`}
                      aria-expanded={sidebarMenuDocId === doc.id ? 'true' : 'false'}
                      onClick={() => onToggleSidebarMenu(doc.id)}
                    >
                      ⋯
                    </button>

                    {sidebarMenuDocId === doc.id && (
                      <a
                        className="notion-sidebar-doc-download"
                        href={`/api/documents/${doc.id}/file${
                          username ? `?username=${encodeURIComponent(username)}` : ''
                        }`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => onToggleSidebarMenu(null)}
                      >
                        Download
                      </a>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <span className="notion-sidebar-empty">No recent items</span>
            )}
          </div>
        </section>
      )}
    </aside>
  );
}
