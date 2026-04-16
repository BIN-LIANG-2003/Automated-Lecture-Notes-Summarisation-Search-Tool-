import { getFeedbackStatusLabel, getFeedbackTypeLabel } from '../lib/feedback.js';

const formatDateLabel = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
};

const eventLabel = (event, admin) => {
  const type = String(event?.event_type || '').trim();
  if (type === 'submitted') return 'Received';
  if (type === 'status_changed') {
    return `Status changed to ${getFeedbackStatusLabel(event?.new_status)}`;
  }
  if (type === 'public_reply') return 'Reply sent';
  if (type === 'user_follow_up') return admin ? 'User follow-up' : 'Your follow-up';
  if (type === 'internal_note') return 'Private note';
  if (type === 'email_failed') return 'Email failed';
  return type || 'Update';
};

const shouldShowEvent = (event, admin) => {
  const type = String(event?.event_type || '').trim();
  if (type === 'email_sent') return false;
  if (!admin && event?.visibility === 'internal') return false;
  return true;
};

const eventMessage = (event) => {
  const type = String(event?.event_type || '').trim();
  const message = String(event?.message || '').trim();
  if (type === 'submitted' && message.toLowerCase() === 'feedback submitted.') {
    return '';
  }
  return message;
};

export default function FeedbackDetailPanel({
  item,
  onBack,
  admin = false,
  followUpDraft = '',
  followUpLoading = false,
  followUpError = '',
  closeLoading = false,
  closeError = '',
  onFollowUpDraftChange,
  onSubmitFollowUp,
  onCloseFeedback,
}) {
  if (!item) return null;
  const events = Array.isArray(item.events) ? item.events.filter((event) => shouldShowEvent(event, admin)) : [];
  const isClosed = item.status === 'closed';
  const canSendFollowUp = !admin && !isClosed && typeof onSubmitFollowUp === 'function';
  const canCloseFeedback = !admin && !isClosed && typeof onCloseFeedback === 'function';

  return (
    <section className="studyhub-feedback-detail" aria-label="Feedback detail">
      {onBack && (
        <button type="button" className="btn studyhub-feedback-back" onClick={onBack}>
          Back to list
        </button>
      )}

      <div className="studyhub-feedback-detail-head">
        <div>
          <span className={`studyhub-feedback-status status-${item.status}`}>
            {getFeedbackStatusLabel(item.status)}
          </span>
          <h3>{item.title || 'Untitled feedback'}</h3>
          <p>
            {getFeedbackTypeLabel(item.type)} · {String(item.priority || 'medium')} priority
          </p>
        </div>
      </div>

      <div className="studyhub-feedback-description">
        {item.description || 'No description provided.'}
      </div>

      {admin && (
        <dl className="studyhub-feedback-admin-meta">
          <div>
            <dt>User</dt>
            <dd>{item.username || '-'}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{item.user_email_snapshot || '-'}</dd>
          </div>
          <div>
            <dt>Assigned</dt>
            <dd>{item.assigned_to || '-'}</dd>
          </div>
        </dl>
      )}

      <div className="studyhub-feedback-timeline">
        <h4>Timeline</h4>
        {events.length ? (
          <ol>
            {events.map((event) => {
              const message = eventMessage(event);
              return (
                <li
                  key={event.id || `${event.event_type}-${event.created_at}`}
                  className={event.visibility === 'internal' ? 'is-internal' : ''}
                >
                  <div>
                    <strong>{eventLabel(event, admin)}</strong>
                    <span>{formatDateLabel(event.created_at)}</span>
                  </div>
                  {message && <p>{message}</p>}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="muted tiny">No timeline updates yet.</p>
        )}
      </div>

      {canSendFollowUp && (
        <form className="studyhub-feedback-followup" onSubmit={onSubmitFollowUp}>
          <label className="notion-share-email-field">
            <span>Continue this feedback</span>
            <textarea
              rows={4}
              value={followUpDraft}
              onChange={(event) => onFollowUpDraftChange?.(event.target.value)}
              placeholder="Add more details, answer the admin, or explain what still needs attention."
              maxLength={3000}
              disabled={followUpLoading}
            />
          </label>
          {followUpError && <p className="studyhub-feedback-alert is-error" role="alert">{followUpError}</p>}
          <div className="studyhub-feedback-followup-actions">
            <button type="submit" className="btn btn-primary" disabled={followUpLoading || !followUpDraft.trim()}>
              {followUpLoading ? 'Sending...' : 'Send follow-up'}
            </button>
            <span className="muted tiny">Your update stays in this timeline, and the project owner can reply here.</span>
          </div>
        </form>
      )}

      {!admin && (
        <div className={`studyhub-feedback-resolution${isClosed ? ' is-closed' : ''}`}>
          <div>
            <strong>{isClosed ? 'Feedback closed' : 'Issue solved?'}</strong>
            <p>
              {isClosed
                ? 'The project owner will see this feedback as completed.'
                : 'Close this feedback when you feel the issue has been handled.'}
            </p>
          </div>
          {canCloseFeedback && (
            <button type="button" className="btn" onClick={onCloseFeedback} disabled={closeLoading}>
              {closeLoading ? 'Closing...' : 'End feedback'}
            </button>
          )}
          {closeError && <p className="studyhub-feedback-alert is-error" role="alert">{closeError}</p>}
        </div>
      )}
    </section>
  );
}
