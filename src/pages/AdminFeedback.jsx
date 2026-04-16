import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import AdminFeedbackTable from '../components/AdminFeedbackTable.jsx';
import FeedbackDetailPanel from '../components/FeedbackDetailPanel.jsx';
import UiFeedbackLayer from '../components/UiFeedbackLayer.jsx';
import { useUiFeedback } from '../hooks/useUiFeedback.js';
import {
  FEEDBACK_PRIORITIES,
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  addInternalFeedbackNote,
  addPublicFeedbackReply,
  getAdminFeedback,
  listAdminFeedback,
  updateAdminFeedback,
} from '../lib/feedback.js';

const DEFAULT_FILTERS = {
  q: '',
  status: '',
  type: '',
  priority: '',
};

export default function AdminFeedbackPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedItem, setSelectedItem] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [statusDraft, setStatusDraft] = useState('new');
  const [assignedDraft, setAssignedDraft] = useState('');
  const [labelsDraft, setLabelsDraft] = useState('');
  const [publicReplyDraft, setPublicReplyDraft] = useState('');
  const [internalNoteDraft, setInternalNoteDraft] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const inboxLoadedOnceRef = useRef(false);
  const detailRequestSeqRef = useRef(0);
  const {
    toastState,
    confirmDialogState,
    showToast,
    dismissToast,
    closeConfirmDialog,
  } = useUiFeedback();

  const deepLinkFeedbackId = useMemo(() => {
    const params = new URLSearchParams(location.search || '');
    return Number(params.get('feedback')) || 0;
  }, [location.search]);

  const loadInbox = async (nextFilters = filters) => {
    setLoading(true);
    setError('');
    try {
      const payload = await listAdminFeedback({ ...nextFilters, limit: 60, offset: 0 });
      setItems(Array.isArray(payload.items) ? payload.items : []);
      setTotal(Number(payload.total) || 0);
    } catch (err) {
      setError(err?.message || 'Failed to load admin feedback');
    } finally {
      setLoading(false);
    }
  };

  const selectItem = async (itemOrId) => {
    const feedbackId = Number(itemOrId?.id || itemOrId) || 0;
    if (!feedbackId) return;
    const requestSeq = detailRequestSeqRef.current + 1;
    detailRequestSeqRef.current = requestSeq;
    setSelectedItem(null);
    setPublicReplyDraft('');
    setInternalNoteDraft('');
    setDetailLoading(true);
    try {
      const payload = await getAdminFeedback(feedbackId);
      if (detailRequestSeqRef.current !== requestSeq) return;
      const item = payload.item;
      setSelectedItem(item);
      setStatusDraft(item?.status || 'new');
      setAssignedDraft(item?.assigned_to || '');
      setLabelsDraft(item?.labels || '');
    } catch (err) {
      if (detailRequestSeqRef.current !== requestSeq) return;
      showToast(err?.message || 'Failed to load feedback detail', 'error');
    } finally {
      if (detailRequestSeqRef.current === requestSeq) {
        setDetailLoading(false);
      }
    }
  };

  const returnToInbox = () => {
    detailRequestSeqRef.current += 1;
    setSelectedItem(null);
    setDetailLoading(false);
    setPublicReplyDraft('');
    setInternalNoteDraft('');
    if (deepLinkFeedbackId) {
      navigate('/admin/feedback', { replace: true });
    }
  };

  useEffect(() => {
    const nextFilters = { ...filters };
    const delay = inboxLoadedOnceRef.current ? 250 : 0;
    inboxLoadedOnceRef.current = true;
    const timeoutId = window.setTimeout(() => {
      void loadInbox(nextFilters);
    }, delay);
    return () => window.clearTimeout(timeoutId);
  }, [filters.q, filters.status, filters.type, filters.priority]);

  useEffect(() => {
    if (deepLinkFeedbackId) {
      void selectItem(deepLinkFeedbackId);
    }
  }, [deepLinkFeedbackId]);

  const saveAdminFields = async () => {
    if (!selectedItem?.id) return;
    setActionLoading(true);
    try {
      const payload = await updateAdminFeedback(selectedItem.id, {
        status: statusDraft,
        assigned_to: assignedDraft,
        labels: labelsDraft,
      });
      setSelectedItem(payload.item);
      showToast('Feedback updated.', 'success');
      void loadInbox();
    } catch (err) {
      showToast(err?.message || 'Failed to update feedback', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const submitPublicReply = async () => {
    if (!selectedItem?.id || !publicReplyDraft.trim()) return;
    setActionLoading(true);
    try {
      const payload = await addPublicFeedbackReply(selectedItem.id, publicReplyDraft);
      setSelectedItem(payload.item);
      setPublicReplyDraft('');
      showToast('Public reply added and user notification attempted.', 'success');
      void loadInbox();
    } catch (err) {
      showToast(err?.message || 'Failed to add public reply', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const submitInternalNote = async () => {
    if (!selectedItem?.id || !internalNoteDraft.trim()) return;
    setActionLoading(true);
    try {
      const payload = await addInternalFeedbackNote(selectedItem.id, internalNoteDraft);
      setSelectedItem(payload.item);
      setInternalNoteDraft('');
      showToast('Internal note added.', 'success');
      void loadInbox();
    } catch (err) {
      showToast(err?.message || 'Failed to add internal note', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const showingDetail = detailLoading || Boolean(selectedItem);

  return (
    <main className="studyhub-admin-page" role="main">
      <header className="studyhub-admin-feedback-head">
        <div>
          <span className="studyhub-feedback-kicker">Admin only</span>
          <h1>Feedback Inbox</h1>
          <p>Review private StudyHub feedback, reply publicly, and keep internal notes separate.</p>
        </div>
        <Link className="btn" to="/">
          Back to StudyHub
        </Link>
      </header>

      <section className={`studyhub-admin-feedback-layout${showingDetail ? ' is-detail-view' : ' is-list-view'}`}>
        {!showingDetail && (
          <div className="studyhub-admin-feedback-list-panel">
            <div className="studyhub-admin-feedback-filters">
              <input
                type="search"
                value={filters.q}
                onChange={(event) => setFilters((prev) => ({ ...prev, q: event.target.value }))}
                placeholder="Search feedback"
                aria-label="Search feedback"
              />
              <select
                value={filters.status}
                onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value }))}
                aria-label="Filter by status"
              >
                <option value="">All statuses</option>
                {FEEDBACK_STATUSES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <select
                value={filters.type}
                onChange={(event) => setFilters((prev) => ({ ...prev, type: event.target.value }))}
                aria-label="Filter by type"
              >
                <option value="">All types</option>
                {FEEDBACK_TYPES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <select
                value={filters.priority}
                onChange={(event) => setFilters((prev) => ({ ...prev, priority: event.target.value }))}
                aria-label="Filter by priority"
              >
                <option value="">All priorities</option>
                {FEEDBACK_PRIORITIES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="muted tiny">{total} feedback item{total === 1 ? '' : 's'}</p>
            <AdminFeedbackTable
              items={items}
              loading={loading}
              error={error}
              selectedId={selectedItem?.id}
              onSelectItem={selectItem}
            />
          </div>
        )}

        {showingDetail && (
          <aside className="studyhub-admin-feedback-detail-panel">
            <div className="studyhub-admin-feedback-detail-top">
              <button type="button" className="btn studyhub-admin-feedback-back" onClick={returnToInbox}>
                Back to inbox
              </button>
              {selectedItem?.id && <span className="muted tiny">Feedback #{selectedItem.id}</span>}
            </div>
            {detailLoading && <p className="muted tiny" aria-live="polite">Loading detail...</p>}
            {selectedItem && (
              <>
                <FeedbackDetailPanel item={selectedItem} admin />
                <section className="studyhub-admin-feedback-controls">
                  <div className="studyhub-admin-actions-head">
                    <div>
                      <h3>Actions</h3>
                      <p>Update the request, reply to the user, or keep a private note.</p>
                    </div>
                  </div>

                  <div className="studyhub-admin-triage-grid" aria-label="Feedback triage">
                    <label className="notion-share-email-field">
                      <span>Status</span>
                      <select value={statusDraft} onChange={(event) => setStatusDraft(event.target.value)}>
                        {FEEDBACK_STATUSES.map((item) => (
                          <option key={item.value} value={item.value}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="notion-share-email-field">
                      <span>Owner</span>
                      <input
                        type="text"
                        value={assignedDraft}
                        onChange={(event) => setAssignedDraft(event.target.value)}
                        placeholder="Username"
                      />
                    </label>
                    <label className="notion-share-email-field">
                      <span>Labels</span>
                      <input
                        type="text"
                        value={labelsDraft}
                        onChange={(event) => setLabelsDraft(event.target.value)}
                        placeholder="triage, sprint-1"
                      />
                    </label>
                    <button type="button" className="btn btn-primary" onClick={saveAdminFields} disabled={actionLoading}>
                      Save Status
                    </button>
                  </div>

                  <div className="studyhub-admin-response-grid">
                    <div className="studyhub-admin-response-card">
                      <label className="notion-share-email-field">
                        <span>Reply to user</span>
                        <textarea
                          rows={4}
                          value={publicReplyDraft}
                          onChange={(event) => setPublicReplyDraft(event.target.value)}
                          placeholder="Write a reply the user can see."
                        />
                      </label>
                      <button
                        type="button"
                        className="btn"
                        onClick={submitPublicReply}
                        disabled={actionLoading || !publicReplyDraft.trim()}
                      >
                        Send reply
                      </button>
                    </div>

                    <div className="studyhub-admin-response-card">
                      <label className="notion-share-email-field">
                        <span>Private note</span>
                        <textarea
                          rows={4}
                          value={internalNoteDraft}
                          onChange={(event) => setInternalNoteDraft(event.target.value)}
                          placeholder="Only admins can see this."
                        />
                      </label>
                      <button
                        type="button"
                        className="btn"
                        onClick={submitInternalNote}
                        disabled={actionLoading || !internalNoteDraft.trim()}
                      >
                        Save note
                      </button>
                    </div>
                  </div>
                </section>
              </>
            )}
          </aside>
        )}
      </section>

      <UiFeedbackLayer
        toastState={toastState}
        confirmDialogState={confirmDialogState}
        onDismissToast={dismissToast}
        onCloseConfirmDialog={closeConfirmDialog}
      />
    </main>
  );
}
