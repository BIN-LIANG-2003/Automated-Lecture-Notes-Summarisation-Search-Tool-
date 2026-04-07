export default function SendNoteByEmailModal({
  open = false,
  onClose,
  onSubmit,
  recipientEmail = '',
  onRecipientEmailChange,
  message = '',
  onMessageChange,
  expiryDays = '',
  onExpiryDaysChange,
  isSubmitting = false,
  documentTitle = '',
  linkModeLabel = '',
}) {
  if (!open) return null;

  return (
    <div
      className="notion-modal-backdrop"
      role="presentation"
      onClick={() => {
        if (isSubmitting) return;
        onClose?.();
      }}
    >
      <section
        className="notion-modal-card notion-share-email-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-note-email-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="notion-summary-result-head">
          <div>
            <h3 id="send-note-email-title">Send Note by Email</h3>
            <p className="notion-settings-help">
              StudyHub will email a button that opens <strong>{documentTitle || 'this shared note'}</strong>.
              {linkModeLabel ? ` Access mode: ${linkModeLabel}.` : ''}
            </p>
          </div>
          <button
            type="button"
            className="notion-modal-close"
            onClick={() => {
              if (isSubmitting) return;
              onClose?.();
            }}
            aria-label="Close send note by email"
          >
            ×
          </button>
        </div>

        <form className="notion-share-email-form" onSubmit={onSubmit}>
          <label className="notion-share-email-field">
            <span>Recipient email</span>
            <input
              type="email"
              value={recipientEmail}
              onChange={(event) => onRecipientEmailChange?.(event.target.value)}
              placeholder="classmate@example.com"
              autoComplete="email"
              required
              autoFocus
              disabled={isSubmitting}
            />
          </label>

          <label className="notion-share-email-field">
            <span>Short message (optional)</span>
            <textarea
              rows={4}
              maxLength={500}
              value={message}
              onChange={(event) => onMessageChange?.(event.target.value)}
              placeholder="Optional note for your classmate."
              disabled={isSubmitting}
            />
          </label>

          <label className="notion-share-email-field notion-share-email-field-compact">
            <span>Expiry days (optional)</span>
            <input
              type="number"
              min="1"
              max="30"
              step="1"
              value={expiryDays}
              onChange={(event) => onExpiryDaysChange?.(event.target.value)}
              placeholder="Default workspace expiry"
              disabled={isSubmitting}
            />
          </label>

          <p className="notion-settings-help">
            The recipient will land on the existing shared-note route and keep the same access limits as a normal
            StudyHub share link.
          </p>

          <div className="notion-modal-actions">
            <button type="button" className="btn" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={isSubmitting || !String(recipientEmail || '').trim()}>
              {isSubmitting ? 'Sending...' : 'Send Email'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
