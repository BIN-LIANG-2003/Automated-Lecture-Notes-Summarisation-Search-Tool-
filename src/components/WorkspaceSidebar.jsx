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
  onDownloadRecentDocument,
  downloadingRecentDocId,
}) {
  const activeWorkspaceLabel = activeWorkspace?.name || `${accountName}'s Workspace`;
  const activeWorkspaceIcon = getWorkspaceIconLabel(activeWorkspace, accountName);
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
                      <button
                        type="button"
                        className="notion-sidebar-doc-download"
                        onClick={() => onDownloadRecentDocument?.(doc)}
                        disabled={Number(downloadingRecentDocId) === Number(doc.id)}
                      >
                        {Number(downloadingRecentDocId) === Number(doc.id) ? 'Downloading...' : 'Download'}
                      </button>
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
