export default function AccountSelectorModal({
  open,
  accounts,
  onSelectAccount,
  onRemoveAccount,
  onClose,
}) {
  if (!open || !Array.isArray(accounts) || !accounts.length) return null;

  return (
    <div
      className="auth-account-selector-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <section
        className="auth-account-selector-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-account-selector-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="auth-account-selector-title">Choose account</h3>
        <p className="muted tiny">Select a previous account to prefill username.</p>

        <ul className="auth-account-selector-list">
          {accounts.map((account) => {
            const key = String(account?.username || account?.email || '').trim();
            if (!key) return null;
            return (
              <li key={key}>
                <button
                  type="button"
                  className="auth-account-selector-item"
                  onClick={() => onSelectAccount?.(account)}
                >
                  <span className="auth-account-selector-avatar" aria-hidden="true">
                    {String(account?.username || account?.email || '?').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="auth-account-selector-meta">
                    <strong>{account?.username || account?.email}</strong>
                    <small>{account?.email || 'No email saved'}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="auth-account-selector-remove"
                  aria-label={`Remove ${account?.username || account?.email}`}
                  onClick={() => onRemoveAccount?.(account)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>

        <div className="auth-account-selector-actions">
          <button type="button" className="btn" onClick={onClose}>
            Use another account
          </button>
        </div>
      </section>
    </div>
  );
}
