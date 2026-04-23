import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  fetchFriendShareDocuments,
  fetchFriendSummary,
  markFriendItemsRead,
  respondFriendFileShare,
  respondFriendRequest,
  sendFriendFileShare,
  sendFriendMessage,
  sendFriendRequest,
} from '../lib/friends.js';

const EMPTY_SUMMARY = {
  user: {},
  friends: [],
  incoming_requests: [],
  outgoing_requests: [],
  messages: [],
  notifications: [],
  unread_count: 0,
};

const formatCount = (count) => {
  const safeCount = Number(count) || 0;
  if (safeCount > 99) return '99+';
  return String(safeCount);
};

const formatDateTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
};

const getNotificationMetadata = (notification) => (
  notification?.metadata && typeof notification.metadata === 'object'
    ? notification.metadata
    : {}
);

const getFileShareStatus = (notification) =>
  String(getNotificationMetadata(notification).status || 'pending').trim().toLowerCase();

const getMessageMetadata = (message) => (
  message?.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : {}
);

const isFileShareMessage = (message) =>
  String(message?.message_type || message?.messageType || '').trim() === 'friend_file_share';

const isFileShareNotification = (notification) =>
  String(notification?.type || '').trim() === 'friend_file_share' &&
  Boolean(getNotificationMetadata(notification).source_document_id);

const isPendingFileShareNotification = (notification) =>
  isFileShareNotification(notification) && getFileShareStatus(notification) === 'pending';

const normalizeShareDocument = (doc) => {
  const id = Number(doc?.id);
  const title = String(doc?.title || doc?.filename || '').trim();
  if (!Number.isFinite(id) || id <= 0 || !title) return null;
  return {
    id,
    title,
    fileType: String(doc?.file_type || doc?.fileType || '').trim().toUpperCase() || 'FILE',
    uploadedAt: doc?.uploaded_at || doc?.uploadedAt || '',
  };
};

const openNotificationLink = (linkUrl) => {
  const target = String(linkUrl || '').trim();
  if (!target || typeof window === 'undefined') return;
  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      if (url.origin === window.location.origin) {
        window.location.assign(`${url.pathname}${url.search}${url.hash}`);
        return;
      }
    } catch {
      // Fall through to opening external or malformed URLs in a separate tab.
    }
    window.open(target, '_blank', 'noopener,noreferrer');
    return;
  }
  window.location.assign(target);
};

export default function FriendsMessagesWidget({
  enabled = true,
  authToken = '',
  username = '',
  activeWorkspaceId = '',
  activeWorkspaceName = '',
  workspaces = [],
  variant = 'topbar',
  onOpenNotification,
  onFileShareAccepted,
  openRequestKey = 0,
  openRequestTab = 'friends',
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [activeTab, setActiveTab] = useState('friends');
  const [requestMode, setRequestMode] = useState('email');
  const [requestEmail, setRequestEmail] = useState('');
  const [requestUsername, setRequestUsername] = useState('');
  const [requestFriendCode, setRequestFriendCode] = useState('');
  const [requestNote, setRequestNote] = useState('');
  const [selectedFriend, setSelectedFriend] = useState('');
  const [messageDraft, setMessageDraft] = useState('');
  const [fileShareOpen, setFileShareOpen] = useState(false);
  const [fileShareDocuments, setFileShareDocuments] = useState([]);
  const [fileShareDocumentId, setFileShareDocumentId] = useState('');
  const [fileShareNote, setFileShareNote] = useState('');
  const [fileShareLoading, setFileShareLoading] = useState(false);
  const [fileShareError, setFileShareError] = useState('');
  const [receiveWorkspaceByNotification, setReceiveWorkspaceByNotification] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  const safeAuthToken = String(authToken || '').trim();
  const safeActiveWorkspaceId = String(activeWorkspaceId || '').trim();
  const isEnabled = Boolean(enabled && safeAuthToken && username);

  const loadSummary = useCallback(async ({ quiet = false } = {}) => {
    if (!isEnabled) return;
    if (!quiet) setLoading(true);
    setError('');
    try {
      const payload = await fetchFriendSummary(safeAuthToken);
      setSummary({
        ...EMPTY_SUMMARY,
        ...payload,
        friends: Array.isArray(payload?.friends) ? payload.friends : [],
        incoming_requests: Array.isArray(payload?.incoming_requests) ? payload.incoming_requests : [],
        outgoing_requests: Array.isArray(payload?.outgoing_requests) ? payload.outgoing_requests : [],
        messages: Array.isArray(payload?.messages) ? payload.messages : [],
        notifications: Array.isArray(payload?.notifications) ? payload.notifications : [],
      });
    } catch (err) {
      setError(err?.message || 'Messages could not load');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [isEnabled, safeAuthToken]);

  const loadShareDocuments = useCallback(async () => {
    if (!isEnabled || !safeActiveWorkspaceId) {
      setFileShareDocuments([]);
      return;
    }
    setFileShareLoading(true);
    setFileShareError('');
    try {
      const payload = await fetchFriendShareDocuments({
        username,
        workspaceId: safeActiveWorkspaceId,
        authToken: safeAuthToken,
      });
      const docs = (Array.isArray(payload?.items) ? payload.items : [])
        .map(normalizeShareDocument)
        .filter(Boolean);
      setFileShareDocuments(docs);
      setFileShareDocumentId((current) => (
        current && docs.some((doc) => String(doc.id) === String(current))
          ? current
          : String(docs[0]?.id || '')
      ));
    } catch (err) {
      setFileShareDocuments([]);
      setFileShareDocumentId('');
      setFileShareError(err?.message || 'Files could not load');
    } finally {
      setFileShareLoading(false);
    }
  }, [isEnabled, safeActiveWorkspaceId, safeAuthToken, username]);

  useEffect(() => {
    if (!isEnabled) return undefined;
    loadSummary({ quiet: true });
    const intervalMs = open ? 5000 : 15000;
    const timer = window.setInterval(() => {
      loadSummary({ quiet: true });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [isEnabled, loadSummary, open]);

  useEffect(() => {
    if (!open) return;
    loadSummary({ quiet: true });
  }, [loadSummary, open]);

  useEffect(() => {
    if (!open || !fileShareOpen) return;
    loadShareDocuments();
  }, [fileShareOpen, loadShareDocuments, open]);

  useEffect(() => {
    if (!openRequestKey) return;
    const requestedTab = ['friends', 'requests', 'site'].includes(openRequestTab)
      ? openRequestTab
      : 'friends';
    setActiveTab(requestedTab);
    setStatusMessage('');
    setError('');
    setOpen(true);
  }, [openRequestKey, openRequestTab]);

  useEffect(() => {
    if (!summary.friends.length) {
      setSelectedFriend('');
      return;
    }
    setSelectedFriend((current) => (
      current && summary.friends.some((friend) => friend.username === current)
        ? current
        : summary.friends[0].username
    ));
  }, [summary.friends]);

  useEffect(() => {
    setFileShareOpen(false);
    setFileShareNote('');
    setFileShareError('');
  }, [selectedFriend]);

  const selectedFriendRecord = useMemo(
    () => summary.friends.find((friend) => friend.username === selectedFriend) || null,
    [summary.friends, selectedFriend],
  );

  const selectedMessages = useMemo(
    () => summary.messages.filter((message) => message.peer_username === selectedFriend),
    [summary.messages, selectedFriend],
  );

  const receiveWorkspaceOptions = useMemo(() => (
    (Array.isArray(workspaces) ? workspaces : [])
      .map((workspace) => {
        const id = String(workspace?.id || '').trim();
        if (!id) return null;
        const settings = workspace?.settings && typeof workspace.settings === 'object'
          ? workspace.settings
          : {};
        const allowUploadsValue = settings.allow_uploads ?? settings.allowUploads;
        if (
          allowUploadsValue === false ||
          String(allowUploadsValue || '').trim().toLowerCase() === 'false'
        ) {
          return null;
        }
        const name = String(workspace?.name || '').trim() || 'Workspace';
        const owner = String(workspace?.owner_username || workspace?.ownerUsername || '').trim();
        const isShared = Boolean(owner && owner !== username);
        return {
          id,
          name: isShared ? `${name} - shared by ${owner}` : name,
        };
      })
      .filter(Boolean)
  ), [username, workspaces]);

  const defaultReceiveWorkspaceId = useMemo(() => {
    if (safeActiveWorkspaceId && receiveWorkspaceOptions.some((workspace) => workspace.id === safeActiveWorkspaceId)) {
      return safeActiveWorkspaceId;
    }
    return receiveWorkspaceOptions[0]?.id || '';
  }, [receiveWorkspaceOptions, safeActiveWorkspaceId]);

  const getReceiveWorkspaceId = useCallback((notification) => {
    const notificationKey = String(notification?.id || '');
    const selectedWorkspaceId = String(receiveWorkspaceByNotification[notificationKey] || '').trim();
    if (selectedWorkspaceId && receiveWorkspaceOptions.some((workspace) => workspace.id === selectedWorkspaceId)) {
      return selectedWorkspaceId;
    }
    return defaultReceiveWorkspaceId;
  }, [defaultReceiveWorkspaceId, receiveWorkspaceByNotification, receiveWorkspaceOptions]);

  useEffect(() => {
    if (!open || !selectedFriendRecord?.unread_count || !safeAuthToken) return;
    markFriendItemsRead({ peer_username: selectedFriendRecord.username }, safeAuthToken)
      .then((payload) => {
        if (payload?.summary) {
          setSummary({ ...EMPTY_SUMMARY, ...payload.summary });
        }
      })
      .catch(() => {});
  }, [open, safeAuthToken, selectedFriendRecord]);

  if (!isEnabled) return null;

  const unreadCount = Number(summary.unread_count) || 0;
  const currentFriendCode = String(summary.user?.friend_code || '').trim();

  const handleOpen = () => {
    setOpen(true);
    setStatusMessage('');
    setError('');
  };

  const handleCopyFriendCode = async () => {
    if (!currentFriendCode) return;
    try {
      await navigator.clipboard.writeText(currentFriendCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const handleSubmitFriendRequest = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    setStatusMessage('');
    try {
      const payload = requestMode === 'email'
        ? { mode: 'email', email: requestEmail, message: requestNote }
        : {
          mode: 'username',
          username: requestUsername,
          friend_code: requestFriendCode,
          message: requestNote,
        };
      const result = await sendFriendRequest(payload, safeAuthToken);
      if (result?.summary) setSummary({ ...EMPTY_SUMMARY, ...result.summary });
      setRequestEmail('');
      setRequestUsername('');
      setRequestFriendCode('');
      setRequestNote('');
      setStatusMessage(result?.message || 'Friend request sent.');
    } catch (err) {
      setError(err?.message || 'Friend request failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRespond = async (requestId, action) => {
    setSubmitting(true);
    setError('');
    setStatusMessage('');
    try {
      const result = await respondFriendRequest(requestId, action, safeAuthToken);
      if (result?.summary) setSummary({ ...EMPTY_SUMMARY, ...result.summary });
      setStatusMessage(result?.message || 'Request updated.');
      if (action === 'accept') setActiveTab('friends');
    } catch (err) {
      setError(err?.message || 'Request update failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendMessage = async (event) => {
    event.preventDefault();
    if (!selectedFriend || !messageDraft.trim()) return;
    setSubmitting(true);
    setError('');
    setStatusMessage('');
    try {
      const result = await sendFriendMessage(selectedFriend, messageDraft, safeAuthToken);
      if (result?.summary) setSummary({ ...EMPTY_SUMMARY, ...result.summary });
      setMessageDraft('');
    } catch (err) {
      setError(err?.message || 'Message failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendFileShare = async (event) => {
    event.preventDefault();
    if (!selectedFriend || !fileShareDocumentId) return;
    setSubmitting(true);
    setError('');
    setStatusMessage('');
    setFileShareError('');
    try {
      const result = await sendFriendFileShare({
        recipientUsername: selectedFriend,
        documentId: fileShareDocumentId,
        note: fileShareNote,
      }, safeAuthToken);
      if (result?.summary) setSummary({ ...EMPTY_SUMMARY, ...result.summary });
      setFileShareNote('');
      setFileShareOpen(false);
      setStatusMessage(result?.message || 'File share sent.');
    } catch (err) {
      setFileShareError(err?.message || 'File share failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRespondFileShare = async (notification, action, targetWorkspaceId = '') => {
    const notificationId = Number(notification?.id);
    if (!Number.isFinite(notificationId) || notificationId <= 0) return;
    setSubmitting(true);
    setError('');
    setStatusMessage('');
    try {
      const result = await respondFriendFileShare(
        notificationId,
        action,
        safeAuthToken,
        { targetWorkspaceId },
      );
      if (result?.summary) setSummary({ ...EMPTY_SUMMARY, ...result.summary });
      setStatusMessage(
        result?.message ||
          (action === 'accept' ? 'File added to your files.' : 'File share declined.')
      );
      if (action === 'accept') {
        if (typeof onFileShareAccepted === 'function') {
          await onFileShareAccepted(result);
        }
        setOpen(false);
      }
    } catch (err) {
      setError(err?.message || 'File share update failed');
    } finally {
      setSubmitting(false);
    }
  };

  const unreadNotificationIds = summary.notifications
    .filter((notification) => notification.is_unread)
    .map((notification) => notification.id)
    .filter(Boolean);

  const handleMarkNotificationsRead = async () => {
    if (!unreadNotificationIds.length) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await markFriendItemsRead({ notification_ids: unreadNotificationIds }, safeAuthToken);
      if (result?.summary) setSummary({ ...EMPTY_SUMMARY, ...result.summary });
      setStatusMessage('Website messages marked read.');
    } catch (err) {
      setError(err?.message || 'Could not mark messages read');
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenNotification = async (notification) => {
    const linkUrl = String(notification?.link_url || '').trim();
    if (!linkUrl) return;

    setSubmitting(true);
    setError('');
    setStatusMessage('');
    try {
      if (notification?.id && notification?.is_unread) {
        try {
          const result = await markFriendItemsRead(
            { notification_ids: [notification.id] },
            safeAuthToken
          );
          if (result?.summary) setSummary({ ...EMPTY_SUMMARY, ...result.summary });
        } catch (err) {
          setError(err?.message || 'Could not mark message read');
        }
      }

      const handled = typeof onOpenNotification === 'function'
        ? await onOpenNotification(notification)
        : false;
      setOpen(false);
      if (!handled) openNotificationLink(linkUrl);
    } catch (err) {
      setError(err?.message || 'Could not open message');
    } finally {
      setSubmitting(false);
    }
  };

  const modal = (
    <div className="studyhub-messages-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
      <section
        className="studyhub-messages-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="studyhub-messages-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="studyhub-messages-header">
          <div>
            <p className="studyhub-messages-kicker">Friends and messages</p>
            <h2 id="studyhub-messages-title">Messages</h2>
          </div>
          <button type="button" className="studyhub-messages-close" onClick={() => setOpen(false)} aria-label="Close messages">
            ×
          </button>
        </header>

        <div className="studyhub-friend-code-row">
          <div>
            <span>Your connection code</span>
            <strong>{currentFriendCode || 'Loading'}</strong>
          </div>
          <button type="button" className="btn" onClick={handleCopyFriendCode} disabled={!currentFriendCode}>
            {copied ? 'Copied' : 'Copy code'}
          </button>
        </div>

        <nav className="studyhub-messages-tabs" aria-label="Messages sections">
          <button
            type="button"
            className={activeTab === 'friends' ? 'is-active' : ''}
            onClick={() => setActiveTab('friends')}
          >
            Friends
          </button>
          <button
            type="button"
            className={activeTab === 'requests' ? 'is-active' : ''}
            onClick={() => setActiveTab('requests')}
          >
            Requests ({summary.incoming_requests.length})
          </button>
          <button
            type="button"
            className={activeTab === 'site' ? 'is-active' : ''}
            onClick={() => setActiveTab('site')}
          >
            Website ({unreadNotificationIds.length})
          </button>
        </nav>

        {(loading || error || statusMessage) && (
          <div className="studyhub-messages-status" role="status">
            {loading && <span>Loading messages...</span>}
            {error && <span className="is-error">{error}</span>}
            {statusMessage && <span>{statusMessage}</span>}
          </div>
        )}

        {activeTab === 'friends' && (
          <div className="studyhub-messages-grid">
            <aside className="studyhub-friends-list" aria-label="Friends">
              {summary.friends.length === 0 ? (
                <div className="studyhub-empty-state">
                  <strong>No friends yet</strong>
                  <span>Add someone by email, or ask them for their login name and connection code.</span>
                  <button type="button" className="btn" onClick={() => setActiveTab('requests')}>
                    Add Friend
                  </button>
                </div>
              ) : (
                summary.friends.map((friend) => (
                  <button
                    type="button"
                    key={friend.username}
                    className={`studyhub-friend-row${selectedFriend === friend.username ? ' is-active' : ''}`}
                    onClick={() => setSelectedFriend(friend.username)}
                  >
                    <span>
                      <strong>{friend.username}</strong>
                      <small>{friend.last_message?.body || friend.email || 'Friend'}</small>
                    </span>
                    {friend.unread_count > 0 && (
                      <em>{formatCount(friend.unread_count)}</em>
                    )}
                  </button>
                ))
              )}
            </aside>

            <section className="studyhub-chat-panel" aria-label="Friend chat">
              {selectedFriendRecord ? (
                <>
                  <div className="studyhub-chat-title">
                    <div>
                      <strong>{selectedFriendRecord.username}</strong>
                      <span>{selectedFriendRecord.email || 'StudyHub friend'}</span>
                    </div>
                    <button
                      type="button"
                      className="btn studyhub-share-file-toggle"
                      onClick={() => setFileShareOpen((current) => !current)}
                      disabled={!safeActiveWorkspaceId}
                      title={
                        safeActiveWorkspaceId
                          ? 'Share one of your uploaded files'
                          : 'Open a workspace before sharing files'
                      }
                    >
                      Share File
                    </button>
                  </div>
                  {fileShareOpen && (
                    <form className="studyhub-file-share-panel" onSubmit={handleSendFileShare}>
                      <div className="studyhub-file-share-head">
                        <strong>Send an uploaded file</strong>
                        <span>{activeWorkspaceName || 'Current workspace'}</span>
                      </div>
                      {fileShareLoading ? (
                        <p>Loading files...</p>
                      ) : fileShareDocuments.length === 0 ? (
                        <p>No files are available in this workspace yet.</p>
                      ) : (
                        <>
                          <label>
                            File
                            <select
                              value={fileShareDocumentId}
                              onChange={(event) => setFileShareDocumentId(event.target.value)}
                              required
                            >
                              {fileShareDocuments.map((doc) => (
                                <option key={doc.id} value={doc.id}>
                                  {doc.title} ({doc.fileType})
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Note
                            <input
                              type="text"
                              value={fileShareNote}
                              onChange={(event) => setFileShareNote(event.target.value)}
                              placeholder="Optional message"
                              maxLength={500}
                            />
                          </label>
                          {fileShareError && <span className="studyhub-file-share-error">{fileShareError}</span>}
                          <div className="studyhub-file-share-actions">
                            <button
                              type="button"
                              className="btn"
                              onClick={() => {
                                setFileShareOpen(false);
                                setFileShareNote('');
                                setFileShareError('');
                              }}
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              className="btn btn-primary"
                              disabled={submitting || !fileShareDocumentId}
                            >
                              Send File
                            </button>
                          </div>
                        </>
                      )}
                      {fileShareError && fileShareDocuments.length === 0 && (
                        <span className="studyhub-file-share-error">{fileShareError}</span>
                      )}
                    </form>
                  )}
                  <div className="studyhub-chat-messages">
                    {selectedMessages.length === 0 ? (
                      <div className="studyhub-empty-state">
                        <strong>No messages yet</strong>
                        <span>Start a private conversation with {selectedFriendRecord.username}.</span>
                      </div>
                    ) : (
                      selectedMessages.map((message) => {
                        const metadata = getMessageMetadata(message);
                        const fileTitle = String(metadata.document_title || '').trim();
                        const fileType = String(metadata.document_file_type || '').trim().toUpperCase();
                        const shareNote = String(metadata.note || '').trim();
                        return (
                          <article
                            key={message.id}
                            className={`studyhub-chat-bubble${message.direction === 'sent' ? ' is-sent' : ''}${isFileShareMessage(message) ? ' is-file-share' : ''}`}
                          >
                            {isFileShareMessage(message) ? (
                              <div className="studyhub-chat-file-card">
                                <small>{message.direction === 'sent' ? 'File sent' : 'File shared with you'}</small>
                                <strong>{fileTitle || message.body}</strong>
                                {fileType && <em>{fileType}</em>}
                                {shareNote && <p>{shareNote}</p>}
                              </div>
                            ) : (
                              <p>{message.body}</p>
                            )}
                            <span>{formatDateTime(message.created_at)}</span>
                          </article>
                        );
                      })
                    )}
                  </div>
                  <form className="studyhub-chat-form" onSubmit={handleSendMessage}>
                    <input
                      type="text"
                      value={messageDraft}
                      onChange={(event) => setMessageDraft(event.target.value)}
                      placeholder={`Message ${selectedFriendRecord.username}`}
                      maxLength={1000}
                    />
                    <button type="submit" className="btn btn-primary" disabled={submitting || !messageDraft.trim()}>
                      Send
                    </button>
                  </form>
                </>
              ) : (
                <div className="studyhub-empty-state">
                  <strong>Select a friend</strong>
                  <span>Your private messages will appear here.</span>
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === 'requests' && (
          <div className="studyhub-requests-panel">
            <form className="studyhub-add-friend-form" onSubmit={handleSubmitFriendRequest}>
              <div className="studyhub-request-mode">
                <button
                  type="button"
                  className={requestMode === 'email' ? 'is-active' : ''}
                  onClick={() => setRequestMode('email')}
                >
                  Email
                </button>
                <button
                  type="button"
                  className={requestMode === 'username' ? 'is-active' : ''}
                  onClick={() => setRequestMode('username')}
                >
                  Login name
                </button>
              </div>
              {requestMode === 'email' ? (
                <label>
                  Email
                  <input
                    type="email"
                    value={requestEmail}
                    onChange={(event) => setRequestEmail(event.target.value)}
                    placeholder="friend@example.com"
                    required
                  />
                </label>
              ) : (
                <div className="studyhub-add-friend-two-col">
                  <label>
                    Login name
                    <input
                      type="text"
                      value={requestUsername}
                      onChange={(event) => setRequestUsername(event.target.value)}
                      placeholder="alice"
                      required
                    />
                  </label>
                  <label>
                    Connection code
                    <input
                      type="text"
                      value={requestFriendCode}
                      onChange={(event) => setRequestFriendCode(event.target.value.toUpperCase())}
                      placeholder="ABCD2345"
                      required
                    />
                  </label>
                </div>
              )}
              <label>
                Note
                <textarea
                  value={requestNote}
                  onChange={(event) => setRequestNote(event.target.value)}
                  placeholder="Optional message"
                  maxLength={300}
                />
              </label>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                Add Friend
              </button>
            </form>

            <div className="studyhub-request-lists">
              <section>
                <h3>Incoming requests</h3>
                {summary.incoming_requests.length === 0 ? (
                  <p>No incoming requests.</p>
                ) : summary.incoming_requests.map((item) => (
                  <article className="studyhub-request-card" key={item.id}>
                    <div>
                      <strong>{item.requester_username}</strong>
                      <span>{item.message || 'Wants to add you as a friend.'}</span>
                      <small>{formatDateTime(item.created_at)}</small>
                    </div>
                    <div className="studyhub-request-actions">
                      <button type="button" className="btn btn-primary" onClick={() => handleRespond(item.id, 'accept')} disabled={submitting}>
                        Accept
                      </button>
                      <button type="button" className="btn" onClick={() => handleRespond(item.id, 'reject')} disabled={submitting}>
                        Reject
                      </button>
                    </div>
                  </article>
                ))}
              </section>
              <section>
                <h3>Pending sent</h3>
                {summary.outgoing_requests.length === 0 ? (
                  <p>No pending sent requests.</p>
                ) : summary.outgoing_requests.map((item) => (
                  <article className="studyhub-request-card" key={item.id}>
                    <div>
                      <strong>{item.target_username}</strong>
                      <span>{item.message || 'Waiting for a response.'}</span>
                      <small>{formatDateTime(item.created_at)}</small>
                    </div>
                  </article>
                ))}
              </section>
            </div>
          </div>
        )}

        {activeTab === 'site' && (
          <div className="studyhub-site-messages">
            <div className="studyhub-site-messages-toolbar">
              <strong>Website messages</strong>
              <button
                type="button"
                className="btn"
                onClick={handleMarkNotificationsRead}
                disabled={submitting || unreadNotificationIds.length === 0}
              >
                Mark all read
              </button>
            </div>
            {summary.notifications.length === 0 ? (
              <div className="studyhub-empty-state">
                <strong>No website messages</strong>
                <span>Friend updates, shared links, and workspace messages will appear here.</span>
              </div>
            ) : summary.notifications.map((notification) => {
              const metadata = getNotificationMetadata(notification);
              const fileShareStatus = getFileShareStatus(notification);
              const pendingFileShare = isPendingFileShareNotification(notification);
              const acceptedDocumentId = Number(metadata.accepted_document_id || 0);
              const receiveWorkspaceId = pendingFileShare ? getReceiveWorkspaceId(notification) : '';
              return (
                <article
                  key={notification.id}
                  className={`studyhub-site-message${notification.is_unread ? ' is-unread' : ''}`}
                >
                  <div>
                    <strong>{notification.title}</strong>
                    {notification.body && <p>{notification.body}</p>}
                    {isFileShareNotification(notification) && fileShareStatus !== 'pending' && (
                      <small>
                        {fileShareStatus === 'accepted'
                          ? 'Accepted and added to your files.'
                          : 'Declined.'}
                      </small>
                    )}
                    <small>{formatDateTime(notification.created_at)}</small>
                  </div>
                  <div className="studyhub-site-message-actions">
                    {pendingFileShare && (
                      <>
                        <label className="studyhub-file-share-receive">
                          <span>Save to workspace</span>
                          <select
                            value={receiveWorkspaceId}
                            onChange={(event) => {
                              const notificationKey = String(notification.id || '');
                              setReceiveWorkspaceByNotification((current) => ({
                                ...current,
                                [notificationKey]: event.target.value,
                              }));
                            }}
                            disabled={submitting || receiveWorkspaceOptions.length === 0}
                          >
                            {receiveWorkspaceOptions.map((workspace) => (
                              <option key={workspace.id} value={workspace.id}>
                                {workspace.name}
                              </option>
                            ))}
                          </select>
                          {receiveWorkspaceOptions.length === 0 && (
                            <small>No workspace can receive files right now.</small>
                          )}
                        </label>
                        <button
                          type="button"
                          className="studyhub-site-message-open"
                          onClick={() => handleRespondFileShare(notification, 'accept', receiveWorkspaceId)}
                          disabled={submitting || !receiveWorkspaceId}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="studyhub-site-message-open is-muted"
                          onClick={() => handleRespondFileShare(notification, 'reject')}
                          disabled={submitting}
                        >
                          Decline
                        </button>
                      </>
                    )}
                    {!pendingFileShare && acceptedDocumentId > 0 && (
                      <button
                        type="button"
                        className="studyhub-site-message-open"
                        onClick={async () => {
                          if (typeof onFileShareAccepted === 'function') {
                            await onFileShareAccepted({
                              document_id: acceptedDocumentId,
                              workspace_id: metadata.accepted_workspace_id || '',
                            });
                            setOpen(false);
                          }
                        }}
                        disabled={submitting || typeof onFileShareAccepted !== 'function'}
                      >
                        Open File
                      </button>
                    )}
                    {notification.link_url && (
                      <button
                        type="button"
                        className="studyhub-site-message-open"
                        onClick={() => handleOpenNotification(notification)}
                        disabled={submitting}
                      >
                        Open
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );

  return (
    <>
      <button
        type="button"
        className={`studyhub-messages-trigger${variant === 'topbar' ? ' studyhub-messages-trigger--topbar' : ''}`}
        onClick={handleOpen}
      >
        <span>Messages</span>
        {unreadCount > 0 && (
          <span className="studyhub-messages-badge" aria-label={`${unreadCount} unread`}>
            {formatCount(unreadCount)}
          </span>
        )}
      </button>
      {open && (typeof document !== 'undefined' ? createPortal(modal, document.body) : modal)}
    </>
  );
}
