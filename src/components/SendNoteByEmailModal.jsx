export default function SendNoteByEmailModal({
  open = false,
  mode = 'send',
  onClose,
  onSubmit,
  onSendAnother,
  onCopyLink,
  onManageLinksOpen,
  onBackToSend,
  recipientEmail = '',
  onRecipientEmailChange,
  message = '',
  onMessageChange,
  expiryDays = '',
  onExpiryDaysChange,
  isSubmitting = false,
  documentTitle = '',
  linkModeLabel = '',
  successResult = null,
  successExpiryLabel = '',
  manageLinksContent = null,
  canManageLinks = false,
  shareLinksCount = 0,
}) {
  if (!open) return null;

  const safeMode = ['send', 'manage', 'success'].includes(mode) ? mode : 'send';
  const sentRecipient = String(successResult?.recipient_email || recipientEmail || '').trim();
  const sentExpiry = String(successExpiryLabel || '').trim();
  const sentShareUrl = String(
    successResult?.share?.share_url ||
    successResult?.shareUrl ||
    ''
  ).trim();
  const modalTitle = safeMode === 'manage'
    ? 'Manage Links'
    : safeMode === 'success'
      ? 'Note Sent'
      : 'Send Note';

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
            <h3 id="send-note-email-title">{modalTitle}</h3>
            <p className="notion-settings-help">
              {safeMode === 'manage'
                ? 'Review, copy, revoke, or delete existing shared-note links.'
                : <>StudyHub emails a button that opens <strong>{documentTitle || 'this shared note'}</strong>.</>}
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

        {safeMode === 'success' ? (
          <div className="notion-share-email-success">
            <div className="notion-share-email-success-card" role="status">
              <span className="document-share-pill success">Email sent</span>
              <h4>{sentRecipient ? `Sent to ${sentRecipient}` : 'Shared note email sent.'}</h4>
              <p>
                The recipient can open the note from the email button
                {sentExpiry ? ` until ${sentExpiry}` : ''}.
              </p>
            </div>
            <div className="notion-modal-actions notion-share-email-success-actions">
              <button
                type="button"
                className="btn"
                onClick={onCopyLink}
                disabled={!sentShareUrl}
                title={sentShareUrl ? 'Copy the shared note link' : 'No share link was returned'}
              >
                Copy Link
              </button>
              {canManageLinks && (
                <button type="button" className="btn" onClick={onManageLinksOpen}>
                  Manage Links
                </button>
              )}
              <button type="button" className="btn" onClick={onSendAnother}>
                Send Another
              </button>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : safeMode === 'manage' ? (
          <div className="notion-share-email-manage-mode">
            {canManageLinks && manageLinksContent ? (
              manageLinksContent
            ) : (
              <p className="muted tiny">Share-link management is not available for this note.</p>
            )}
            <div className="notion-modal-actions notion-share-email-manage-actions">
              <button type="button" className="btn" onClick={onBackToSend} disabled={isSubmitting}>
                Back to Send
              </button>
              <button type="button" className="btn btn-primary" onClick={onClose} disabled={isSubmitting}>
                Done
              </button>
            </div>
          </div>
        ) : (
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
              The recipient lands on the existing shared-note route and keeps the same access limits as a normal
              StudyHub share link.
            </p>

            <div className="notion-modal-actions">
              {canManageLinks && (
                <button type="button" className="btn" onClick={onManageLinksOpen} disabled={isSubmitting}>
                  {`Manage Links${shareLinksCount ? ` (${shareLinksCount})` : ''}`}
                </button>
              )}
              <button type="button" className="btn" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={isSubmitting || !String(recipientEmail || '').trim()}>
                {isSubmitting ? 'Sending...' : 'Send Email'}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
