export default function WorkspaceSettingsModal({
  open = false,
  workspaceActionLoading = false,
  onClose,
  workspaceSettingsTabs = [],
  workspaceSettingsTab = 'general',
  setWorkspaceSettingsTab,
  workspaceSettingsDraft,
  updateWorkspaceSettingsDraft,
  workspaceNameDraft = '',
  setWorkspaceNameDraft,
  onSaveWorkspaceSettings,
  minSidebarRecentLimit = 5,
  maxSidebarRecentLimit = 20,
  defaultSidebarRecentLimit = 10,
  sharePolicyPresets = [],
  activeSharePolicyPresetId = '',
  onClearWorkspaceDocuments,
  isLoggedIn = false,
  activeWorkspace = null,
  workspaceInsights = null,
}) {
  if (!open) return null;

  const insightItems = [
    {
      id: 'notes',
      label: 'Notes',
      value: Number(workspaceInsights?.totalNotes || 0),
    },
    {
      id: 'categories',
      label: 'Categories',
      value: Number(workspaceInsights?.categoryCount || 0),
    },
    {
      id: 'tags',
      label: 'Tags',
      value: Number(workspaceInsights?.tagCount || 0),
    },
    {
      id: 'members',
      label: 'Members',
      value: Number(workspaceInsights?.memberCount || 1),
    },
  ];

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
        className="notion-modal-card notion-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="workspace-settings-title">Workspace Settings</h3>
        <section className="notion-settings-summary" aria-label="Workspace summary">
          {insightItems.map((item) => (
            <article key={item.id} className="notion-settings-summary-card">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </article>
          ))}
        </section>
        <p className="notion-settings-help">
          Current policy: share links expire in {workspaceSettingsDraft.default_share_expiry_days} day(s), invite
          links expire in {workspaceSettingsDraft.default_invite_expiry_days} day(s), and sharing mode is{' '}
          <strong>{workspaceSettingsDraft.link_sharing_mode}</strong>.
        </p>
        <div className="notion-settings-layout">
          <nav className="notion-settings-nav" aria-label="Settings sections">
            {workspaceSettingsTabs.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`notion-settings-nav-item ${workspaceSettingsTab === item.id ? 'active' : ''}`}
                onClick={() => setWorkspaceSettingsTab?.(item.id)}
                disabled={workspaceActionLoading}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="notion-settings-pane">
            {workspaceSettingsTab === 'general' && (
              <section className="notion-settings-block">
                <h4>General</h4>
                <div className="notion-settings-row">
                  <label htmlFor="workspace-icon-input">Icon</label>
                  <input
                    id="workspace-icon-input"
                    type="text"
                    value={workspaceSettingsDraft.workspace_icon}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ workspace_icon: event.target.value })
                    }
                    placeholder="📚"
                    disabled={workspaceActionLoading}
                  />
                </div>
                <div className="notion-settings-row">
                  <label htmlFor="workspace-name-input">Workspace Name</label>
                  <input
                    id="workspace-name-input"
                    type="text"
                    value={workspaceNameDraft}
                    onChange={(event) => setWorkspaceNameDraft?.(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        if (!workspaceActionLoading) onSaveWorkspaceSettings?.();
                      }
                    }}
                    placeholder="Enter workspace name"
                    disabled={workspaceActionLoading}
                    autoFocus
                  />
                </div>
                <div className="notion-settings-row">
                  <label htmlFor="workspace-description-input">Description</label>
                  <textarea
                    id="workspace-description-input"
                    rows={2}
                    value={workspaceSettingsDraft.description}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ description: event.target.value })
                    }
                    placeholder="What this workspace is for"
                    disabled={workspaceActionLoading}
                  />
                </div>
              </section>
            )}

            {workspaceSettingsTab === 'defaults' && (
              <section className="notion-settings-block">
                <h4>Defaults</h4>
                <div className="notion-settings-row">
                  <label htmlFor="workspace-default-category-input">Default Category</label>
                  <input
                    id="workspace-default-category-input"
                    type="text"
                    value={workspaceSettingsDraft.default_category}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ default_category: event.target.value })
                    }
                    placeholder="Uncategorized"
                    disabled={workspaceActionLoading}
                  />
                </div>
                <label className="notion-checkbox-row">
                  <input
                    type="checkbox"
                    checked={workspaceSettingsDraft.auto_categorize}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ auto_categorize: event.target.checked })
                    }
                    disabled={workspaceActionLoading}
                  />
                  <span>Auto-categorize uploads</span>
                </label>
              </section>
            )}

            {workspaceSettingsTab === 'experience' && (
              <section className="notion-settings-block">
                <h4>Experience</h4>
                <div className="notion-settings-row">
                  <label htmlFor="workspace-default-home-tab-select">Default Landing Page</label>
                  <select
                    id="workspace-default-home-tab-select"
                    value={workspaceSettingsDraft.default_home_tab}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ default_home_tab: event.target.value })
                    }
                    disabled={workspaceActionLoading}
                  >
                    <option value="home">Home</option>
                    <option value="files">My Files</option>
                    <option value="ai">AI Assistant</option>
                  </select>
                </div>
                <div className="notion-settings-row">
                  <label htmlFor="workspace-recent-limit-input">Recent Notes in Sidebar</label>
                  <input
                    id="workspace-recent-limit-input"
                    type="number"
                    min={minSidebarRecentLimit}
                    max={maxSidebarRecentLimit}
                    value={workspaceSettingsDraft.recent_items_limit}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({
                        recent_items_limit: Number(event.target.value) || defaultSidebarRecentLimit,
                      })
                    }
                    disabled={workspaceActionLoading}
                  />
                </div>
                <p className="notion-settings-help">
                  This controls how many recent notes appear in the left sidebar.
                </p>
              </section>
            )}

            {workspaceSettingsTab === 'permissions' && (
              <section className="notion-settings-block">
                <h4>Permissions</h4>
                <label className="notion-checkbox-row">
                  <input
                    type="checkbox"
                    checked={workspaceSettingsDraft.allow_uploads}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ allow_uploads: event.target.checked })
                    }
                    disabled={workspaceActionLoading}
                  />
                  <span>Allow file uploads</span>
                </label>
                <label className="notion-checkbox-row">
                  <input
                    type="checkbox"
                    checked={workspaceSettingsDraft.allow_note_editing}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ allow_note_editing: event.target.checked })
                    }
                    disabled={workspaceActionLoading}
                  />
                  <span>Allow note editing (tags/category/content/PDF)</span>
                </label>
                <label className="notion-checkbox-row">
                  <input
                    type="checkbox"
                    checked={workspaceSettingsDraft.allow_ai_tools}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ allow_ai_tools: event.target.checked })
                    }
                    disabled={workspaceActionLoading}
                  />
                  <span>Allow AI assistant</span>
                </label>
                <label className="notion-checkbox-row">
                  <input
                    type="checkbox"
                    checked={workspaceSettingsDraft.allow_ocr}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ allow_ocr: event.target.checked })
                    }
                    disabled={workspaceActionLoading || !workspaceSettingsDraft.allow_ai_tools}
                  />
                  <span>Allow OCR image extraction</span>
                </label>
                <label className="notion-checkbox-row">
                  <input
                    type="checkbox"
                    checked={workspaceSettingsDraft.allow_export}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ allow_export: event.target.checked })
                    }
                    disabled={workspaceActionLoading}
                  />
                  <span>Allow summary export (copy / txt / email)</span>
                </label>
              </section>
            )}

            {workspaceSettingsTab === 'ai' && (
              <section className="notion-settings-block">
                <h4>AI Preferences</h4>
                <div className="notion-settings-row">
                  <label htmlFor="workspace-summary-length-select">Summary Length</label>
                  <select
                    id="workspace-summary-length-select"
                    value={workspaceSettingsDraft.summary_length}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ summary_length: event.target.value })
                    }
                    disabled={workspaceActionLoading}
                  >
                    <option value="short">Short</option>
                    <option value="medium">Medium</option>
                    <option value="long">Long</option>
                  </select>
                </div>
                <div className="notion-settings-row">
                  <label htmlFor="workspace-keyword-limit-input">Keyword Count</label>
                  <input
                    id="workspace-keyword-limit-input"
                    type="number"
                    min="3"
                    max="12"
                    value={workspaceSettingsDraft.keyword_limit}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ keyword_limit: Number(event.target.value) || 5 })
                    }
                    disabled={workspaceActionLoading}
                  />
                </div>
                <p className="notion-settings-help">
                  These options define default AI behavior. They apply to text summarization requests.
                </p>
              </section>
            )}

            {workspaceSettingsTab === 'access' && (
              <section className="notion-settings-block">
                <h4>Access & Invitations</h4>
                <div className="notion-settings-row">
                  <label>Share Policy Presets</label>
                  <div className="notion-settings-preset-grid">
                    {sharePolicyPresets.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className={`btn notion-settings-preset-btn ${
                          activeSharePolicyPresetId === preset.id ? 'active' : ''
                        }`}
                        onClick={() => updateWorkspaceSettingsDraft?.(preset.patch)}
                        disabled={workspaceActionLoading}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <p className="notion-settings-help">
                    One-click templates inspired by common sharing models (strict / team / public).
                  </p>
                </div>
                <div className="notion-settings-row">
                  <label htmlFor="workspace-link-mode-select">Link Sharing</label>
                  <select
                    id="workspace-link-mode-select"
                    value={workspaceSettingsDraft.link_sharing_mode}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ link_sharing_mode: event.target.value })
                    }
                    disabled={workspaceActionLoading}
                  >
                    <option value="restricted">Restricted</option>
                    <option value="workspace">Workspace Members</option>
                    <option value="public">Anyone With Link</option>
                  </select>
                </div>
                <div className="notion-settings-row">
                  <label htmlFor="workspace-share-expiry-input">Document Share Link Expiry (days)</label>
                  <input
                    id="workspace-share-expiry-input"
                    type="number"
                    min="1"
                    max="30"
                    value={workspaceSettingsDraft.default_share_expiry_days}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({
                        default_share_expiry_days: Number(event.target.value) || 7,
                      })
                    }
                    disabled={workspaceActionLoading}
                  />
                </div>
                <div className="notion-settings-row">
                  <label htmlFor="workspace-share-link-limit-input">Max Active Share Links Per Document</label>
                  <input
                    id="workspace-share-link-limit-input"
                    type="number"
                    min="1"
                    max="20"
                    value={workspaceSettingsDraft.max_active_share_links_per_document}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({
                        max_active_share_links_per_document: Number(event.target.value) || 5,
                      })
                    }
                    disabled={workspaceActionLoading}
                  />
                </div>
                <div className="notion-settings-row">
                  <label htmlFor="workspace-invite-expiry-input">Invitation Link Expiry (days)</label>
                  <input
                    id="workspace-invite-expiry-input"
                    type="number"
                    min="1"
                    max="30"
                    value={workspaceSettingsDraft.default_invite_expiry_days}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({
                        default_invite_expiry_days: Number(event.target.value) || 7,
                      })
                    }
                    disabled={workspaceActionLoading}
                  />
                </div>
                <p className="notion-settings-help">
                  Share links default to {workspaceSettingsDraft.default_share_expiry_days} day(s), max{' '}
                  {workspaceSettingsDraft.max_active_share_links_per_document} active link(s) per document. Invite
                  links default to {workspaceSettingsDraft.default_invite_expiry_days} day(s).
                </p>
                <label className="notion-checkbox-row">
                  <input
                    type="checkbox"
                    checked={workspaceSettingsDraft.allow_member_invites}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ allow_member_invites: event.target.checked })
                    }
                    disabled={workspaceActionLoading}
                  />
                  <span>Allow members to invite others</span>
                </label>
                <label className="notion-checkbox-row">
                  <input
                    type="checkbox"
                    checked={workspaceSettingsDraft.allow_member_share_management}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({
                        allow_member_share_management: event.target.checked,
                      })
                    }
                    disabled={workspaceActionLoading}
                  />
                  <span>Allow members to manage share links</span>
                </label>
                <label className="notion-checkbox-row">
                  <input
                    type="checkbox"
                    checked={workspaceSettingsDraft.auto_revoke_previous_share_links}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({
                        auto_revoke_previous_share_links: event.target.checked,
                      })
                    }
                    disabled={workspaceActionLoading}
                  />
                  <span>Auto revoke existing active links when creating a new one</span>
                </label>
              </section>
            )}

            {workspaceSettingsTab === 'danger' && (
              <section className="notion-settings-block notion-settings-danger">
                <h4>Danger Zone</h4>
                <p className="muted tiny">
                  Delete all notes in this workspace. This cannot be undone.
                </p>
                <button
                  type="button"
                  className="btn btn-delete"
                  onClick={onClearWorkspaceDocuments}
                  disabled={
                    workspaceActionLoading ||
                    !isLoggedIn ||
                    (isLoggedIn && activeWorkspace?.is_owner === false)
                  }
                >
                  Clear Workspace Notes
                </button>
              </section>
            )}
          </div>
        </div>
        <div className="notion-modal-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSaveWorkspaceSettings}
            disabled={workspaceActionLoading}
          >
            {workspaceActionLoading ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={workspaceActionLoading}
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}
