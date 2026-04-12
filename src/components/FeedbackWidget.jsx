import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import FeedbackModal from './FeedbackModal.jsx';
import { readStoredAuthSession } from '../lib/authSession.js';

export default function FeedbackWidget({
  workspaceId = '',
  documentId = '',
  enabled = true,
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [manualOpen, setManualOpen] = useState(false);
  const session = readStoredAuthSession();
  const feedbackIdFromUrl = useMemo(() => {
    const params = new URLSearchParams(location.search || '');
    return Number(params.get('feedback')) || 0;
  }, [location.search]);
  const isOpen = Boolean(manualOpen || feedbackIdFromUrl);
  const isAuthenticated = Boolean(enabled && session.isAuthenticated);

  if (!isAuthenticated) return null;

  const closeModal = () => {
    setManualOpen(false);
    if (feedbackIdFromUrl) {
      navigate(location.pathname || '/', { replace: true });
    }
  };

  return (
    <>
      <button
        type="button"
        className="studyhub-feedback-trigger"
        onClick={() => setManualOpen(true)}
      >
        Feedback
      </button>
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
      />
    </>
  );
}
