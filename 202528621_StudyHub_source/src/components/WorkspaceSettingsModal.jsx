import { useRef, useState } from 'react';
import WorkspaceIcon, { isWorkspaceImageIcon } from './WorkspaceIcon.jsx';

const MAX_WORKSPACE_ICON_UPLOAD_BYTES = 256 * 1024;
const WORKSPACE_ICON_UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

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
  sidebarDensityOptions = [],
  accentColorPresets = [],
  onClearWorkspaceDocuments,
  onDeleteWorkspace,
  onLeaveWorkspace,
  isLoggedIn = false,
  activeWorkspace = null,
  workspaceInsights = null,
  userNotificationPreferences = null,
  userNotificationPreferencesSaving = false,
  onChangeEmailNotifications,
}) {
  const workspaceIconFileRef = useRef(null);
  const [workspaceIconUploadError, setWorkspaceIconUploadError] = useState('');

  const workspaceIconValue = String(workspaceSettingsDraft?.workspace_icon || '').trim();
  const workspaceIconIsImage = isWorkspaceImageIcon(workspaceIconValue);
  const handleWorkspaceIconFileChange = (event) => {
    const file = event.target?.files?.[0] || null;
    if (event.target) event.target.value = '';
    if (!file) return;
    if (!WORKSPACE_ICON_UPLOAD_TYPES.has(file.type)) {
      setWorkspaceIconUploadError('Upload a PNG, JPG, WebP, or GIF image.');
      return;
    }
    if (file.size > MAX_WORKSPACE_ICON_UPLOAD_BYTES) {
      setWorkspaceIconUploadError('Use an image smaller than 256 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '').trim();
      if (!isWorkspaceImageIcon(result)) {
        setWorkspaceIconUploadError('This image could not be used as a workspace icon.');
        return;
      }
      setWorkspaceIconUploadError('');
      updateWorkspaceSettingsDraft?.({ workspace_icon: result });
    };
    reader.onerror = () => {
      setWorkspaceIconUploadError('This image could not be read.');
    };
    reader.readAsDataURL(file);
  };

  if (!open) return null;

  const enabledNotificationCount = [
    workspaceSettingsDraft.notify_upload_events,
    workspaceSettingsDraft.notify_summary_events,
    workspaceSettingsDraft.notify_sharing_events,
  ].filter(Boolean).length;
  const totalNotes = Number(workspaceInsights?.totalNotes) || 0;
  const isWorkspaceOwner = activeWorkspace?.is_owner !== false;
  const sharedWorkspaceView = isLoggedIn && !isWorkspaceOwner;
  const visibleWorkspaceSettingsTabs = sharedWorkspaceView
    ? [{ id: 'danger', label: 'Shared Workspace', description: 'Remove this workspace from your account.' }]
    : workspaceSettingsTabs;
  const safeWorkspaceSettingsTab = visibleWorkspaceSettingsTabs.some((item) => item.id === workspaceSettingsTab)
    ? workspaceSettingsTab
    : visibleWorkspaceSettingsTabs[0]?.id || 'general';
  const activeTabMeta =
    visibleWorkspaceSettingsTabs.find((item) => item.id === safeWorkspaceSettingsTab) ||
    visibleWorkspaceSettingsTabs[0] ||
    null;
  const ownerOnlyDisabled = workspaceActionLoading || (isLoggedIn && !isWorkspaceOwner);
  const emailNotificationsEnabled =
    userNotificationPreferences?.emailNotificationsEnabled !== false;

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
              {sharedWorkspaceView
                ? 'Remove this shared workspace from your account. The owner and other members keep access.'
                : isWorkspaceOwner
                ? 'Manage how this workspace looks, who can collaborate, and how alerts are delivered.'
                : 'View this workspace configuration or leave the shared workspace from your account.'}
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

        <div className={`notion-settings-layout${sharedWorkspaceView ? ' notion-settings-layout-single' : ''}`}>
          {!sharedWorkspaceView && (
            <nav className="notion-settings-nav" aria-label="Settings sections">
              {visibleWorkspaceSettingsTabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`notion-settings-nav-item ${safeWorkspaceSettingsTab === item.id ? 'active' : ''}`}
                  onClick={() => setWorkspaceSettingsTab?.(item.id)}
                  disabled={workspaceActionLoading}
                >
                  <strong>{item.label}</strong>
                  <span>{item.description}</span>
                </button>
              ))}
            </nav>
          )}

          <div className="notion-settings-pane">
            <div className="notion-settings-pane-head">
              <p className="notion-settings-kicker">{activeTabMeta?.label || 'Settings'}</p>
              <p className="notion-settings-subtitle">{activeTabMeta?.description || ''}</p>
            </div>

            {safeWorkspaceSettingsTab === 'general' && (
              <>
                <section className="notion-settings-block">
                  <h4>Identity</h4>
                  <div className="notion-settings-row">
                    <label htmlFor="workspace-icon-input">Icon</label>
                    <div className="notion-workspace-icon-editor">
                      <WorkspaceIcon
                        value={workspaceIconValue}
                        fallback={workspaceNameDraft || activeWorkspace?.name || 'W'}
                        large
                      />
                      <div className="notion-workspace-icon-controls">
                        <input
                          id="workspace-icon-input"
                          type="text"
                          value={workspaceIconIsImage ? '' : workspaceIconValue}
                          onChange={(event) => {
                            setWorkspaceIconUploadError('');
                            updateWorkspaceSettingsDraft?.({ workspace_icon: event.target.value });
                          }}
                          placeholder={workspaceIconIsImage ? 'Image icon selected' : '📚'}
                          disabled={ownerOnlyDisabled}
                        />
                        <div className="notion-workspace-icon-actions">
                          <button
                            type="button"
                            className="btn"
                            onClick={() => workspaceIconFileRef.current?.click()}
                            disabled={ownerOnlyDisabled}
                          >
                            Upload Image
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => {
                              setWorkspaceIconUploadError('');
                              updateWorkspaceSettingsDraft?.({ workspace_icon: '📚' });
                            }}
                            disabled={ownerOnlyDisabled}
                          >
                            Reset
                          </button>
                        </div>
                        <input
                          ref={workspaceIconFileRef}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          className="visually-hidden"
                          onChange={handleWorkspaceIconFileChange}
                          disabled={ownerOnlyDisabled}
                        />
                        <p className="notion-settings-help">
                          Use an emoji or upload a PNG, JPG, WebP, or GIF under 256 KB.
                        </p>
                        {workspaceIconUploadError && (
                          <p className="notion-settings-error">{workspaceIconUploadError}</p>
                        )}
                      </div>
                    </div>
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
                      disabled={ownerOnlyDisabled}
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
                      disabled={ownerOnlyDisabled}
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
                      disabled={ownerOnlyDisabled}
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
                        disabled={ownerOnlyDisabled}
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

            {safeWorkspaceSettingsTab === 'experience' && (
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
                      disabled={ownerOnlyDisabled}
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
                      disabled={ownerOnlyDisabled}
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
                      disabled={ownerOnlyDisabled}
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
                      disabled={ownerOnlyDisabled}
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
                      disabled={ownerOnlyDisabled}
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
                      disabled={ownerOnlyDisabled}
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
                      disabled={ownerOnlyDisabled}
                    />
                    <span>Show recent uploads and summary activity blocks</span>
                  </label>
                </section>
              </>
            )}

            {safeWorkspaceSettingsTab === 'notifications' && (
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
                      disabled={ownerOnlyDisabled}
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
                      disabled={ownerOnlyDisabled}
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
                      disabled={ownerOnlyDisabled}
                    />
                    <span>Show success toasts for invites and share links</span>
                  </label>
                </section>

                <section className="notion-settings-block">
                  <h4>Your email reminders</h4>
                  <label className="notion-checkbox-row">
                    <input
                      type="checkbox"
                      checked={emailNotificationsEnabled}
                      onChange={(event) => onChangeEmailNotifications?.(event.target.checked)}
                      disabled={!isLoggedIn || userNotificationPreferencesSaving}
                    />
                    <span>Send email reminders for messages and workspace updates</span>
                  </label>
                  <p className="notion-settings-help">
                    Turn this off to keep these updates inside Messages. Account verification and emails you send manually still work.
                  </p>
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
                    <span className="notion-summary-chip">
                      Email reminders {emailNotificationsEnabled ? 'on' : 'off'}
                    </span>
                  </div>
                </section>
              </>
            )}

            {safeWorkspaceSettingsTab === 'permissions' && (
              <section className="notion-settings-block">
                <h4>Member capabilities</h4>
                <label className="notion-checkbox-row">
                  <input
                    type="checkbox"
                    checked={workspaceSettingsDraft.allow_uploads}
                    onChange={(event) =>
                      updateWorkspaceSettingsDraft?.({ allow_uploads: event.target.checked })
                    }
                    disabled={ownerOnlyDisabled}
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
                    disabled={ownerOnlyDisabled}
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
                    disabled={ownerOnlyDisabled}
                  />
                  <span>Allow summary export (copy / txt / email)</span>
                </label>
              </section>
            )}

            {safeWorkspaceSettingsTab === 'ai' && (
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
                    disabled={ownerOnlyDisabled}
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
                    disabled={ownerOnlyDisabled}
                  />
                </div>
                <p className="notion-settings-help">
                  These values become the default behavior whenever a summary request is triggered inside the workspace.
                </p>
              </section>
            )}

            {safeWorkspaceSettingsTab === 'danger' && (
              <section className="notion-settings-block notion-settings-danger">
                <h4>{isWorkspaceOwner ? 'Danger Zone' : 'Remove Workspace'}</h4>
                {isWorkspaceOwner ? (
                  <>
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
                      {`${totalNotes} note${totalNotes === 1 ? '' : 's'} will be removed if you delete this workspace.`}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="muted tiny">
                      Remove this shared workspace from your account. This does not delete the workspace or its notes for other members.
                    </p>
                    <div className="notion-settings-danger-actions">
                      <button
                        type="button"
                        className="btn btn-delete"
                        onClick={onLeaveWorkspace}
                        disabled={workspaceActionLoading || !isLoggedIn}
                      >
                        Remove Workspace
                      </button>
                    </div>
                    <p className="muted tiny notion-settings-danger-note">
                      You can rejoin later only if the owner sends a new invitation.
                    </p>
                  </>
                )}
              </section>
            )}
          </div>
        </div>

        <div className="notion-modal-actions">
          {!sharedWorkspaceView && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSaveWorkspaceSettings}
              disabled={ownerOnlyDisabled}
            >
              {workspaceActionLoading ? 'Saving...' : 'Save changes'}
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={workspaceActionLoading}
          >
            {sharedWorkspaceView ? 'Close' : 'Cancel'}
          </button>
        </div>
      </section>
    </div>
  );
}
