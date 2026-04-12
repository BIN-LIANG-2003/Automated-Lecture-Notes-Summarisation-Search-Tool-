import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
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
    setDetailLoading(true);
    try {
      const payload = await getAdminFeedback(feedbackId);
      const item = payload.item;
      setSelectedItem(item);
      setStatusDraft(item?.status || 'new');
      setAssignedDraft(item?.assigned_to || '');
      setLabelsDraft(item?.labels || '');
    } catch (err) {
      showToast(err?.message || 'Failed to load feedback detail', 'error');
    } finally {
      setDetailLoading(false);
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

      <section className="studyhub-admin-feedback-layout">
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

        <aside className="studyhub-admin-feedback-detail-panel">
          {detailLoading && <p className="muted tiny">Loading detail...</p>}
          {!selectedItem && !detailLoading && (
            <div className="studyhub-feedback-empty">
              <strong>Select feedback</strong>
              <p>Choose an item to review its timeline and respond.</p>
            </div>
          )}
          {selectedItem && (
            <>
              <FeedbackDetailPanel item={selectedItem} admin />
              <section className="studyhub-admin-feedback-controls">
                <h3>Admin actions</h3>
                <div className="studyhub-feedback-grid">
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
                    <span>Assigned to</span>
                    <input
                      type="text"
                      value={assignedDraft}
                      onChange={(event) => setAssignedDraft(event.target.value)}
                      placeholder="Optional username"
                    />
                  </label>
                </div>
                <label className="notion-share-email-field">
                  <span>Internal labels</span>
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

                <label className="notion-share-email-field">
                  <span>Public reply</span>
                  <textarea
                    rows={4}
                    value={publicReplyDraft}
                    onChange={(event) => setPublicReplyDraft(event.target.value)}
                    placeholder="Visible to the submitting user and emailed to them."
                  />
                </label>
                <button
                  type="button"
                  className="btn"
                  onClick={submitPublicReply}
                  disabled={actionLoading || !publicReplyDraft.trim()}
                >
                  Add Public Reply
                </button>

                <label className="notion-share-email-field">
                  <span>Internal note</span>
                  <textarea
                    rows={4}
                    value={internalNoteDraft}
                    onChange={(event) => setInternalNoteDraft(event.target.value)}
                    placeholder="Admin-only note. Not emailed to user."
                  />
                </label>
                <button
                  type="button"
                  className="btn"
                  onClick={submitInternalNote}
                  disabled={actionLoading || !internalNoteDraft.trim()}
                >
                  Add Internal Note
                </button>
              </section>
            </>
          )}
        </aside>
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
