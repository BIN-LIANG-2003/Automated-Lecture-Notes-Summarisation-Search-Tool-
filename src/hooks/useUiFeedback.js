import { useEffect, useRef, useState } from 'react';

const DEFAULT_TOAST_STATE = { open: false, message: '', tone: 'info' };
const DEFAULT_CONFIRM_DIALOG_STATE = {
  open: false,
  title: '',
  description: '',
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  danger: false,
};

export function useUiFeedback({ toastDurationMs = 3600 } = {}) {
  const [toastState, setToastState] = useState(DEFAULT_TOAST_STATE);
  const [confirmDialogState, setConfirmDialogState] = useState(DEFAULT_CONFIRM_DIALOG_STATE);
  const toastTimerRef = useRef(null);
  const confirmResolverRef = useRef(null);

  const closeConfirmDialog = (confirmed) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmDialogState(DEFAULT_CONFIRM_DIALOG_STATE);
    if (typeof resolver === 'function') {
      resolver(Boolean(confirmed));
    }
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      if (typeof confirmResolverRef.current === 'function') {
        confirmResolverRef.current(false);
        confirmResolverRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key !== 'Escape') return;
      if (!confirmDialogState.open) return;
      closeConfirmDialog(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [confirmDialogState.open]);

  const showToast = (message, tone = 'info') => {
    const nextMessage = String(message || '').trim();
    if (!nextMessage) return;
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToastState({ open: true, message: nextMessage, tone });
    toastTimerRef.current = window.setTimeout(() => {
      setToastState((prev) => ({ ...prev, open: false }));
      toastTimerRef.current = null;
    }, Math.max(1200, Number(toastDurationMs) || 3600));
  };

  const dismissToast = () => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToastState((prev) => ({ ...prev, open: false }));
  };

  const requestConfirmation = ({
    title,
    description = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
  }) =>
    new Promise((resolve) => {
      if (typeof confirmResolverRef.current === 'function') {
        confirmResolverRef.current(false);
      }
      confirmResolverRef.current = resolve;
      setConfirmDialogState({
        open: true,
        title: String(title || '').trim() || 'Please confirm',
        description: String(description || '').trim(),
        confirmLabel: String(confirmLabel || '').trim() || 'Confirm',
        cancelLabel: String(cancelLabel || '').trim() || 'Cancel',
        danger: Boolean(danger),
      });
    });

  return {
    toastState,
    confirmDialogState,
    showToast,
    dismissToast,
    requestConfirmation,
    closeConfirmDialog,
  };
}
