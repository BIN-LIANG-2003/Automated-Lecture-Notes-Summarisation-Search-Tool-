import { getFeedbackStatusLabel, getFeedbackTypeLabel } from '../lib/feedback.js';

const formatDateLabel = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
};

export default function AdminFeedbackTable({
  items = [],
  loading = false,
  error = '',
  selectedId = 0,
  onSelectItem,
}) {
  if (loading) {
    return <p className="muted tiny">Loading feedback inbox...</p>;
  }
  if (error) {
    return <p className="studyhub-feedback-alert is-error" role="alert">{error}</p>;
  }
  if (!items.length) {
    return (
      <div className="studyhub-feedback-empty">
        <strong>No feedback matches this view</strong>
        <p>New private feedback submissions will appear here.</p>
      </div>
    );
  }
  return (
    <div className="studyhub-admin-feedback-table" role="table" aria-label="Admin feedback inbox">
      <div className="studyhub-admin-feedback-row is-head" role="row">
        <span>Feedback</span>
        <span>Status</span>
        <span>Priority</span>
        <span>User</span>
        <span>Updated</span>
      </div>
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          className={`studyhub-admin-feedback-row${Number(selectedId) === Number(item.id) ? ' active' : ''}`}
          onClick={() => onSelectItem?.(item)}
          role="row"
        >
          <span>
            <strong>{item.title || 'Untitled feedback'}</strong>
            <small>{getFeedbackTypeLabel(item.type)}</small>
          </span>
          <span className={`studyhub-feedback-status status-${item.status}`}>
            {getFeedbackStatusLabel(item.status)}
          </span>
          <span>{item.priority || 'medium'}</span>
          <span>{item.username || '-'}</span>
          <span>{formatDateLabel(item.updated_at)}</span>
        </button>
      ))}
    </div>
  );
}
