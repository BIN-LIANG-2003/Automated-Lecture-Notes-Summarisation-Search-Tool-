const formatDomains = (value) =>
  String(value || '')
    .split(/,\s*/)
    .map((item) => item.trim())
    .filter(Boolean);

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
  documentsLayoutOptions = [],
  documentsSortOptions = [],
  documentsPageSizeOptions = [],
  sidebarDensityOptions = [],
  accentColorPresets = [],
  sharePolicyPresets = [],
  activeSharePolicyPresetId = '',
  onClearWorkspaceDocuments,
  onDeleteWorkspace,
  isLoggedIn = false,
  activeWorkspace = null,
  workspaceInsights = null,
}) {
  if (!open) return null;

  const trustedDomains = formatDomains(workspaceSettingsDraft.allowed_email_domains);
  const activeTabMeta =
    workspaceSettingsTabs.find((item) => item.id === workspaceSettingsTab) || workspaceSettingsTabs[0] || null;
  const enabledNotificationCount = [
    workspaceSettingsDraft.notify_upload_events,
    workspaceSettingsDraft.notify_summary_events,
    workspaceSettingsDraft.notify_sharing_events,
  ].filter(Boolean).length;
  const totalNotes = Number(workspaceInsights?.totalNotes) || 0;
  const ownerOnlyDisabled = workspaceActionLoading || !isLoggedIn || activeWorkspace?.is_owner === false;

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
        <header className="notion-settings-header">
          <div>
            <h3 id="workspace-settings-title">Workspace Settings</h3>
            <p className="notion-settings-subtitle">
              Manage how this workspace looks, who can collaborate, and what defaults new study flows start with.
            </p>
          </div>
          <button
            type="button"
            className="notion-modal-close"
            onClick={() => {
              if (workspaceActionLoading) return;
              onClose?.();
            }}
            aria-label="Close workspace settings"
          >
            ×
          </button>
        </header>

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
                <strong>{item.label}</strong>
                <span>{item.description}</span>
              </button>
            ))}
          </nav>

          <div className="notion-settings-pane">
            <div className="notion-settings-pane-head">
              <p className="notion-settings-kicker">{activeTabMeta?.label || 'Settings'}</p>
              <p className="notion-settings-subtitle">{activeTabMeta?.description || ''}</p>
            </div>

            {workspaceSettingsTab === 'general' && (
              <>
                <section className="notion-settings-block">
                  <h4>Identity</h4>
                  <div className="notion-settings-row">
                    <label htmlFor="workspace-icon-input">Icon</label>
                    <input
                      id="workspace-icon-input"
                      type="text"
                      value={workspaceSettingsDraft.workspace_icon}
                      onChange={(event) => updateWorkspaceSettingsDraft?.({ workspace_icon: event.target.value })}
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
                      rows={3}
                      value={workspaceSettingsDraft.description}
                      onChange={(event) => updateWorkspaceSettingsDraft?.({ description: event.target.value })}
                      placeholder="What this workspace is for"
                      disabled={workspaceActionLoading}
                    />
                  </div>
                </section>

                <section className="notion-settings-block">
                  <h4>Visual style</h4>
                  <div className="notion-settings-row">
                    <label htmlFor="workspace-accent-input">Accent Color</label>
                    <input
                      id="workspace-accent-input"
                      type="text"
                      value={workspaceSettingsDraft.accent_color}
                      onChange={(event) => updateWorkspaceSettingsDraft?.({ accent_color: event.target.value })}
                      placeholder="#2f76e8"
                      disabled={workspaceActionLoading}
                    />
                  </div>
                  <div className="notion-settings-color-grid" role="group" aria-label="Accent color presets">
                    {accentColorPresets.map((preset) => (
                      <button
                        key={preset.value}
                        type="button"
                        className={`notion-settings-color-swatch${
                          workspaceSettingsDraft.accent_color === preset.value ? ' active' : ''
                        }`}
                        onClick={() => updateWorkspaceSettingsDraft?.({ accent_color: preset.value })}
                        disabled={workspaceActionLoading}
                        title={preset.label}
                        style={{ background: preset.value }}
                      >
                        <span>{preset.label}</span>
                      </button>
                    ))}
                  </div>
                  <p className="notion-settings-help">
                    The accent color updates major buttons, active navigation states, and overview highlights.
                  </p>
                </section>
              </>
            )}

            {workspaceSettingsTab === 'defaults' && (
              <>
                <section className="notion-settings-block">
                  <h4>Organization defaults</h4>
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
                    <span>Auto-categorize uploads when category is empty</span>
                  </label>
                </section>

                <section className="notion-settings-block">
                  <h4>File view defaults</h4>
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
                      <option value="home">Home overview</option>
                      <option value="files">My Files</option>
                      <option value="ai">AI Assistant</option>
                    </select>
                  </div>
                  <div className="notion-settings-row">
                    <label htmlFor="workspace-default-layout-select">Default Files Layout</label>
                    <select
                      id="workspace-default-layout-select"
                      value={workspaceSettingsDraft.default_documents_layout}
                      onChange={(event) =>
                        updateWorkspaceSettingsDraft?.({ default_documents_layout: event.target.value })
                      }
                      disabled={workspaceActionLoading}
                    >
                      {documentsLayoutOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="notion-settings-row">
                    <label htmlFor="workspace-default-sort-select">Default Files Sort</label>
                    <select
                      id="workspace-default-sort-select"
                      value={workspaceSettingsDraft.default_documents_sort}
                      onChange={(event) =>
                        updateWorkspaceSettingsDraft?.({ default_documents_sort: event.target.value })
                      }
                      disabled={workspaceActionLoading}
                    >
                      {documentsSortOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="notion-settings-row">
                    <label htmlFor="workspace-default-page-size-select">Default Files Per Page</label>
                    <select
                      id="workspace-default-page-size-select"
                      value={workspaceSettingsDraft.default_documents_page_size}
                      onChange={(event) =>
                        updateWorkspaceSettingsDraft?.({
                          default_documents_page_size: Number(event.target.value) || 20,
                        })
                      }
                      disabled={workspaceActionLoading}
                    >
                      {documentsPageSizeOptions.map((size) => (
                        <option key={`page-size-${size}`} value={size}>
                          {size}
                        </option>
                      ))}
                    </select>
                  </div>
                </section>
              </>
            )}

            {workspaceSettingsTab === 'experience' && (
              <>
                <section className="notion-settings-block">
                  <h4>Sidebar behavior</h4>
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
                  <div className="notion-settings-row">
                    <label htmlFor="workspace-sidebar-density-select">Sidebar Density</label>
                    <select
                      id="workspace-sidebar-density-select"
                      value={workspaceSettingsDraft.sidebar_density}
                      onChange={(event) =>
                        updateWorkspaceSettingsDraft?.({ sidebar_density: event.target.value })
                      }
                      disabled={workspaceActionLoading}
                    >
                      {sidebarDensityOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className="notion-checkbox-row">
                    <input
                      type="checkbox"
                      checked={workspaceSettingsDraft.show_starred_section}
                      onChange={(event) =>
                        updateWorkspaceSettingsDraft?.({ show_starred_section: event.target.checked })
                      }
                      disabled={workspaceActionLoading}
                    />
                    <span>Show Starred section in sidebar</span>
                  </label>
                  <label className="notion-checkbox-row">
                    <input
                      type="checkbox"
                      checked={workspaceSettingsDraft.show_recent_section}
                      onChange={(event) =>
                        updateWorkspaceSettingsDraft?.({ show_recent_section: event.target.checked })
                      }
                      disabled={workspaceActionLoading}
                    />
                    <span>Show Recent section in sidebar</span>
                  </label>
                </section>

                <section className="notion-settings-block">
                  <h4>Overview widgets</h4>
                  <label className="notion-checkbox-row">
                    <input
                      type="checkbox"
                      checked={workspaceSettingsDraft.show_quick_actions}
                      onChange={(event) =>
                        updateWorkspaceSettingsDraft?.({ show_quick_actions: event.target.checked })
                      }
                      disabled={workspaceActionLoading}
                    />
                    <span>Show quick actions panel on the overview page</span>
                  </label>
                  <label className="notion-checkbox-row">
                    <input
                      type="checkbox"
                      checked={workspaceSettingsDraft.show_usage_chart}
                      onChange={(event) =>
                        updateWorkspaceSettingsDraft?.({ show_usage_chart: event.target.checked })
                      }
                      disabled={workspaceActionLoading}
                    />
                    <span>Show usage chart on the overview page</span>
                  </label>
                  <label className="notion-checkbox-row">
                    <input
                      type="checkbox"
                      checked={workspaceSettingsDraft.show_recent_activity}
                      onChange={(event) =>
                        updateWorkspaceSettingsDraft?.({ show_recent_activity: event.target.checked })
                      }
                      disabled={workspaceActionLoading}
                    />
                    <span>Show recent uploads and summary activity blocks</span>
                  </label>
                </section>
              </>
            )}

            {workspaceSettingsTab === 'notifications' && (
              <>
                <section className="notion-settings-block">
                  <h4>In-app notifications</h4>
                  <label className="notion-checkbox-row">
                    <input
                      type="checkbox"
                      checked={workspaceSettingsDraft.notify_upload_events}
                      onChange={(event) =>
                        updateWorkspaceSettingsDraft?.({ notify_upload_events: event.target.checked })
                      }
                      disabled={workspaceActionLoading}
                    />
                    <span>Show success toasts for uploads</span>
                  </label>
                  <label className="notion-checkbox-row">
                    <input
                      type="checkbox"
                      checked={workspaceSettingsDraft.notify_summary_events}
                      onChange={(event) =>
                        updateWorkspaceSettingsDraft?.({ notify_summary_events: event.target.checked })
                      }
                      disabled={workspaceActionLoading}
                    />
                    <span>Show success toasts for AI summaries and summary history actions</span>
                  </label>
                  <label className="notion-checkbox-row">
                    <input
                      type="checkbox"
                      checked={workspaceSettingsDraft.notify_sharing_events}
                      onChange={(event) =>
                        updateWorkspaceSettingsDraft?.({ notify_sharing_events: event.target.checked })
                      }
                      disabled={workspaceActionLoading}
                    />
                    <span>Show success toasts for invites and share links</span>
                  </label>
                </section>

                <section className="notion-settings-block">
                  <h4>Preview</h4>
                  <p className="notion-settings-help">
                    Warning and error messages always stay on so important failures are still visible.
                  </p>
                  <div className="notion-settings-inline-pills" aria-label="Notification summary">
                    <span className="notion-summary-chip">Enabled {enabledNotificationCount}/3</span>
                    <span className="notion-summary-chip">
                      Summary {workspaceSettingsDraft.notify_summary_events ? 'on' : 'off'}
                    </span>
                    <span className="notion-summary-chip">
                      Uploads {workspaceSettingsDraft.notify_upload_events ? 'on' : 'off'}
                    </span>
                    <span className="notion-summary-chip">
                      Sharing {workspaceSettingsDraft.notify_sharing_events ? 'on' : 'off'}
                    </span>
                  </div>
                </section>
              </>
            )}

            {workspaceSettingsTab === 'permissions' && (
              <section className="notion-settings-block">
                <h4>Member capabilities</h4>
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
                  <span>Allow note editing (category, tags, content, PDF)</span>
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
              <>
                <section className="notion-settings-block">
                  <h4>AI access</h4>
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
                </section>

                <section className="notion-settings-block">
                  <h4>Summary defaults</h4>
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
                    These values become the default behavior whenever a summary request is triggered inside the workspace.
                  </p>
                </section>
              </>
            )}

            {workspaceSettingsTab === 'access' && (
              <>
                <section className="notion-settings-block">
                  <h4>Sharing templates</h4>
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
                    Presets are inspired by common collaboration models: strict ownership, classroom balance, and open sharing.
                  </p>
                </section>

                <section className="notion-settings-block">
                  <h4>Invitations and trusted domains</h4>
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
                      checked={workspaceSettingsDraft.restrict_invites_to_domains}
                      onChange={(event) =>
                        updateWorkspaceSettingsDraft?.({ restrict_invites_to_domains: event.target.checked })
                      }
                      disabled={workspaceActionLoading}
                    />
                    <span>Restrict invitations to trusted email domains</span>
                  </label>
                  <div className="notion-settings-row">
                    <label htmlFor="workspace-domain-list-input">Trusted Domains</label>
                    <textarea
                      id="workspace-domain-list-input"
                      rows={2}
                      value={workspaceSettingsDraft.allowed_email_domains}
                      onChange={(event) =>
                        updateWorkspaceSettingsDraft?.({ allowed_email_domains: event.target.value })
                      }
                      placeholder="school.edu, club.org"
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
                    {trustedDomains.length
                      ? `Trusted domains: ${trustedDomains.join(', ')}`
                      : 'No trusted domains configured. Leave the toggle off if invites should remain open to any valid email.'}
                  </p>
                </section>

                <section className="notion-settings-block">
                  <h4>Link sharing</h4>
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
              </>
            )}

            {workspaceSettingsTab === 'danger' && (
              <section className="notion-settings-block notion-settings-danger">
                <h4>Danger Zone</h4>
                <p className="muted tiny">
                  Permanently delete notes or remove this entire workspace. These actions cannot be undone.
                </p>
                <div className="notion-settings-danger-actions">
                  <button
                    type="button"
                    className="btn btn-delete"
                    onClick={onClearWorkspaceDocuments}
                    disabled={ownerOnlyDisabled}
                  >
                    Clear Workspace Notes
                  </button>
                  <button
                    type="button"
                    className="btn btn-delete"
                    onClick={onDeleteWorkspace}
                    disabled={ownerOnlyDisabled}
                  >
                    Delete Workspace
                  </button>
                </div>
                <p className="muted tiny notion-settings-danger-note">
                  {activeWorkspace?.is_owner === false
                    ? 'Only the workspace owner can use these actions.'
                    : `${totalNotes} note${totalNotes === 1 ? '' : 's'} will be removed if you delete this workspace.`}
                </p>
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
            {workspaceActionLoading ? 'Saving...' : 'Save changes'}
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
