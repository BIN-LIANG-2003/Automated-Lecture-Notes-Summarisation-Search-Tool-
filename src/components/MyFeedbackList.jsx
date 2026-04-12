import { getFeedbackStatusLabel, getFeedbackTypeLabel } from '../lib/feedback.js';

const formatDateLabel = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString();
};

export default function MyFeedbackList({
  items = [],
  loading = false,
  error = '',
  selectedId = 0,
  onSelectItem,
  onRefresh,
}) {
  if (loading) {
    return <p className="muted tiny">Loading your feedback...</p>;
  }

  if (error) {
    return (
      <div className="studyhub-feedback-empty is-error" role="alert">
        <strong>Could not load feedback</strong>
        <p>{error}</p>
        <button type="button" className="btn" onClick={onRefresh}>
          Try Again
        </button>
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="studyhub-feedback-empty">
        <strong>No feedback yet</strong>
        <p>Send a bug report, feature request, or usability note when something needs attention.</p>
      </div>
    );
  }

  return (
    <div className="studyhub-feedback-list" role="list">
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          className={`studyhub-feedback-list-item${Number(selectedId) === Number(item.id) ? ' active' : ''}`}
          onClick={() => onSelectItem?.(item)}
          role="listitem"
        >
          <span className={`studyhub-feedback-status status-${item.status}`}>
            {getFeedbackStatusLabel(item.status)}
          </span>
          <strong>{item.title || 'Untitled feedback'}</strong>
          <small>
            {getFeedbackTypeLabel(item.type)} · {item.priority || 'medium'} · Updated {formatDateLabel(item.updated_at)}
          </small>
          <p>{item.latest_public_update || 'No public update yet.'}</p>
        </button>
      ))}
    </div>
  );
}
