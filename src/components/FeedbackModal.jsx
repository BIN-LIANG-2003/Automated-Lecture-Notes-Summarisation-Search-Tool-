import { useEffect, useMemo, useState } from 'react';
import FeedbackDetailPanel from './FeedbackDetailPanel.jsx';
import MyFeedbackList from './MyFeedbackList.jsx';
import {
  FEEDBACK_PRIORITIES,
  FEEDBACK_TYPES,
  findSimilarFeedback,
  getMyFeedback,
  listMyFeedback,
  loadFeedbackConfig,
  submitFeedback,
} from '../lib/feedback.js';

const DEFAULT_FORM = {
  type: 'bug_report',
  title: '',
  description: '',
  priority: 'medium',
};

export default function FeedbackModal({
  open = false,
  onClose,
  context = {},
  initialFeedbackId = 0,
  onOpenAdmin,
  onSubmitted,
}) {
  const [activeTab, setActiveTab] = useState('submit');
  const [form, setForm] = useState(DEFAULT_FORM);
  const [config, setConfig] = useState({ support_email: 'hello@studies-hub.com', is_admin: false });
  const [items, setItems] = useState([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState('');
  const [selectedItem, setSelectedItem] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitMessage, setSubmitMessage] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [similarItems, setSimilarItems] = useState([]);
  const [similarLoading, setSimilarLoading] = useState(false);

  const supportEmail = config.support_email || 'hello@studies-hub.com';
  const titleLongEnough = form.title.trim().length >= 8;

  const contextPreview = useMemo(() => {
    const parts = [];
    if (context.workspaceId) parts.push(`Workspace ${context.workspaceId}`);
    if (context.documentId) parts.push(`Document ${context.documentId}`);
    parts.push(context.pagePath || window.location.hash || '/');
    return parts.join(' · ');
  }, [context.documentId, context.pagePath, context.workspaceId]);

  const loadMine = async ({ focusId = 0 } = {}) => {
    setItemsLoading(true);
    setItemsError('');
    try {
      const payload = await listMyFeedback();
      const nextItems = Array.isArray(payload.items) ? payload.items : [];
      setItems(nextItems);
      setConfig((prev) => ({
        ...prev,
        support_email: payload.support_email || prev.support_email,
        is_admin: Boolean(payload.is_admin),
      }));
      const targetId = Number(focusId) || Number(selectedItem?.id) || 0;
      if (targetId) {
        const match = nextItems.find((item) => Number(item.id) === targetId);
        if (match) {
          await selectItem(match);
        }
      }
    } catch (error) {
      setItemsError(error?.message || 'Failed to load feedback');
    } finally {
      setItemsLoading(false);
    }
  };

  const selectItem = async (item) => {
    if (!item?.id) return;
    setDetailLoading(true);
    try {
      const payload = await getMyFeedback(item.id);
      setSelectedItem(payload.item || item);
    } catch (error) {
      setItemsError(error?.message || 'Failed to load feedback detail');
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadFeedbackConfig()
      .then((payload) => {
        if (cancelled) return;
        setConfig({
          support_email: payload.support_email || 'hello@studies-hub.com',
          is_admin: Boolean(payload.is_admin),
        });
      })
      .catch(() => {});
    setActiveTab(initialFeedbackId ? 'mine' : 'submit');
    void loadMine({ focusId: Number(initialFeedbackId) || 0 });
    return () => {
      cancelled = true;
    };
  }, [open, initialFeedbackId]);

  useEffect(() => {
    if (!open || activeTab !== 'submit' || !titleLongEnough) {
      setSimilarItems([]);
      setSimilarLoading(false);
      return () => {};
    }
    let cancelled = false;
    setSimilarLoading(true);
    const timeoutId = window.setTimeout(() => {
      findSimilarFeedback(form.title)
        .then((payload) => {
          if (cancelled) return;
          setSimilarItems(Array.isArray(payload.items) ? payload.items.slice(0, 3) : []);
        })
        .catch(() => {
          if (!cancelled) setSimilarItems([]);
        })
        .finally(() => {
          if (!cancelled) setSimilarLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [activeTab, form.title, open, titleLongEnough]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitError('');
    setSubmitMessage('');
    setSubmitLoading(true);
    try {
      const payload = await submitFeedback({
        ...form,
        page_path: context.pagePath || window.location.hash || '/',
        workspace_id: context.workspaceId || '',
        document_id: context.documentId || null,
      });
      setForm(DEFAULT_FORM);
      setSimilarItems([]);
      if (typeof onSubmitted === 'function') {
        onSubmitted(payload);
      } else {
        setSubmitMessage('Feedback submitted successfully.');
      }
    } catch (error) {
      setSubmitError(error?.message || 'Failed to submit feedback');
    } finally {
      setSubmitLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div className="notion-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="notion-modal-card studyhub-feedback-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="studyhub-feedback-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="studyhub-feedback-head">
          <div>
            <span className="studyhub-feedback-kicker">Private feedback center</span>
            <h3 id="studyhub-feedback-title">Help improve StudyHub</h3>
            <p>Send private feedback to the project owner and track updates here.</p>
          </div>
          <button type="button" className="notion-modal-close" onClick={onClose} aria-label="Close feedback">
            ×
          </button>
        </div>

        <div className="studyhub-feedback-tabs" role="tablist" aria-label="Feedback tabs">
          <button
            type="button"
            className={activeTab === 'submit' ? 'active' : ''}
            onClick={() => setActiveTab('submit')}
            role="tab"
            aria-selected={activeTab === 'submit'}
          >
            Submit Feedback
          </button>
          <button
            type="button"
            className={activeTab === 'mine' ? 'active' : ''}
            onClick={() => {
              setActiveTab('mine');
              void loadMine();
            }}
            role="tab"
            aria-selected={activeTab === 'mine'}
          >
            My Feedback
          </button>
          {config.is_admin && (
            <button type="button" className="studyhub-feedback-admin-link" onClick={onOpenAdmin}>
              Admin Inbox
            </button>
          )}
        </div>

        {activeTab === 'submit' ? (
          <form className="studyhub-feedback-form" onSubmit={handleSubmit}>
            <div className="studyhub-feedback-grid">
              <label className="notion-share-email-field">
                <span>Type</span>
                <select
                  value={form.type}
                  onChange={(event) => setForm((prev) => ({ ...prev, type: event.target.value }))}
                  disabled={submitLoading}
                >
                  {FEEDBACK_TYPES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="notion-share-email-field">
                <span>Priority</span>
                <select
                  value={form.priority}
                  onChange={(event) => setForm((prev) => ({ ...prev, priority: event.target.value }))}
                  disabled={submitLoading}
                >
                  {FEEDBACK_PRIORITIES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="notion-share-email-field">
              <span>Title</span>
              <input
                type="text"
                value={form.title}
                onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
                placeholder="Short summary of the issue or idea"
                maxLength={160}
                required
                disabled={submitLoading}
              />
            </label>

            {!!titleLongEnough && (
              <div className="studyhub-feedback-similar" aria-live="polite">
                <strong>Similar feedback</strong>
                {similarLoading && <p className="muted tiny">Checking similar open feedback...</p>}
                {!similarLoading && similarItems.length > 0 && (
                  <ul>
                    {similarItems.map((item) => (
                      <li key={item.id}>
                        <div>
                          {item.is_own ? (
                            <button
                              type="button"
                              onClick={() => {
                                setActiveTab('mine');
                                void selectItem(item);
                              }}
                            >
                              {item.title}
                            </button>
                          ) : (
                            <span className="studyhub-feedback-similar-title">{item.title}</span>
                          )}
                          {item.preview && <p>{item.preview}</p>}
                        </div>
                        <span>{item.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {!similarLoading && !similarItems.length && (
                  <p className="muted tiny">No similar open feedback found.</p>
                )}
              </div>
            )}

            <label className="notion-share-email-field">
              <span>Description</span>
              <textarea
                rows={7}
                value={form.description}
                onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                placeholder="What happened? What did you expect? Add steps, page, or document context if useful."
                maxLength={5000}
                required
                disabled={submitLoading}
              />
            </label>

            <p className="studyhub-feedback-context">Context captured: {contextPreview}</p>
            {submitError && <p className="studyhub-feedback-alert is-error" role="alert">{submitError}</p>}
            {submitMessage && <p className="studyhub-feedback-alert is-success">{submitMessage}</p>}

            <div className="notion-modal-actions">
              <button type="submit" className="btn btn-primary" disabled={submitLoading}>
                {submitLoading ? 'Submitting...' : 'Submit Feedback'}
              </button>
              <button type="button" className="btn" onClick={onClose} disabled={submitLoading}>
                Close
              </button>
            </div>
          </form>
        ) : (
          <div className="studyhub-feedback-mine">
            {selectedItem ? (
              <>
                {detailLoading && <p className="muted tiny">Refreshing detail...</p>}
                <FeedbackDetailPanel item={selectedItem} onBack={() => setSelectedItem(null)} />
              </>
            ) : (
              <MyFeedbackList
                items={items}
                loading={itemsLoading}
                error={itemsError}
                onRefresh={() => loadMine()}
                onSelectItem={selectItem}
              />
            )}
          </div>
        )}

        <footer className="studyhub-feedback-footer">
          Need direct help? <a href={`mailto:${supportEmail}`}>Email {supportEmail}</a>
        </footer>
      </section>
    </div>
  );
}
