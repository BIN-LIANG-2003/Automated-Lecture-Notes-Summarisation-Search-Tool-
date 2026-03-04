export default function UiFeedbackLayer({
  toastState,
  confirmDialogState,
  onDismissToast,
  onCloseConfirmDialog,
}) {
  return (
    <>
      {confirmDialogState?.open && (
        <div
          className="notion-modal-backdrop"
          role="presentation"
          onClick={() => onCloseConfirmDialog?.(false)}
        >
          <section
            className="notion-modal-card notion-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="confirm-dialog-title">{confirmDialogState.title}</h3>
            {confirmDialogState.description && (
              <p className="notion-confirm-description">{confirmDialogState.description}</p>
            )}
            <div className="notion-confirm-actions">
              <button
                type="button"
                className={`btn${confirmDialogState.danger ? ' btn-delete' : ' btn-primary'}`}
                onClick={() => onCloseConfirmDialog?.(true)}
              >
                {confirmDialogState.confirmLabel}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => onCloseConfirmDialog?.(false)}
              >
                {confirmDialogState.cancelLabel}
              </button>
            </div>
          </section>
        </div>
      )}

      {toastState?.open && (
        <div className="notion-toast-stack" role="status" aria-live="polite">
          <div className={`notion-toast notion-toast-${toastState.tone || 'info'}`}>
            <span>{toastState.message}</span>
            <button
              type="button"
              className="notion-toast-close"
              onClick={onDismissToast}
              aria-label="Close notification"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </>
  );
}

