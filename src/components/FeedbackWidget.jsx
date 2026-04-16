import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import FeedbackModal from './FeedbackModal.jsx';
import { readStoredAuthSession } from '../lib/authSession.js';

export default function FeedbackWidget({
  workspaceId = '',
  documentId = '',
  enabled = true,
  variant = 'floating',
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [manualOpen, setManualOpen] = useState(false);
  const [successNotice, setSuccessNotice] = useState('');
  const successTimerRef = useRef(null);
  const session = readStoredAuthSession();
  const feedbackIdFromUrl = useMemo(() => {
    const params = new URLSearchParams(location.search || '');
    return Number(params.get('feedback')) || 0;
  }, [location.search]);
  const isOpen = Boolean(manualOpen || feedbackIdFromUrl);
  const isAuthenticated = Boolean(enabled && session.isAuthenticated);

  useEffect(() => () => {
    if (successTimerRef.current) {
      window.clearTimeout(successTimerRef.current);
    }
  }, []);

  if (!isAuthenticated) return null;

  const closeModal = () => {
    setManualOpen(false);
    if (feedbackIdFromUrl) {
      navigate(location.pathname || '/', { replace: true });
    }
  };

  const showSubmitSuccess = () => {
    closeModal();
    setSuccessNotice('Feedback submitted successfully.');
    if (successTimerRef.current) {
      window.clearTimeout(successTimerRef.current);
    }
    successTimerRef.current = window.setTimeout(() => {
      setSuccessNotice('');
      successTimerRef.current = null;
    }, 1000);
  };

  const modal = (
    <FeedbackModal
      open={isOpen}
      onClose={closeModal}
      initialFeedbackId={feedbackIdFromUrl}
      context={{
        pagePath: `${location.pathname}${location.search || ''}`,
        workspaceId,
        documentId,
      }}
      onOpenAdmin={() => {
        setManualOpen(false);
        navigate('/admin/feedback');
      }}
      onSubmitted={showSubmitSuccess}
    />
  );

  const successToast = successNotice ? (
    <div className="studyhub-feedback-success-toast" role="status" aria-live="polite">
      <div className="studyhub-feedback-success-toast-card">
        {successNotice}
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        className={`studyhub-feedback-trigger${
          variant === 'topbar' ? ' studyhub-feedback-trigger--topbar' : ''
        }`}
        onClick={() => setManualOpen(true)}
      >
        Feedback
      </button>
      {typeof document !== 'undefined' ? createPortal(modal, document.body) : modal}
      {successToast && (typeof document !== 'undefined' ? createPortal(successToast, document.body) : successToast)}
    </>
  );
}
