import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

const statusLabel = (status) => {
  if (status === 'pending') return 'Pending request';
  if (status === 'requested') return 'Requested, awaiting approval';
  if (status === 'approved') return 'Approved';
  if (status === 'rejected') return 'Rejected';
  if (status === 'expired') return 'Expired';
  if (status === 'cancelled') return 'Cancelled';
  return status || 'Unknown status';
};

export default function InviteJoinPage() {
  const { token } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);

  const authToken = sessionStorage.getItem('auth_token') || '';
  const username = authToken ? (sessionStorage.getItem('username') || '') : '';
  const email = authToken ? (sessionStorage.getItem('email') || '') : '';

  const fetchInvitation = async () => {
    if (!token) {
      setError('Invalid invitation link.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const query = username ? `?username=${encodeURIComponent(username)}` : '';
      const res = await fetch(`/api/invitations/${encodeURIComponent(token)}${query}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to load invitation');
      setData(payload);
    } catch (err) {
      setError(err.message || 'Failed to load invitation');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInvitation();
  }, [token, username]);

  const canSubmit = useMemo(() => {
    if (!username) return false;
    if (!data) return false;
    if (data.status === 'requested' && data.requested_username === username) return false;
    return Boolean(data.can_request && data.status === 'pending');
  }, [username, data]);

  const handleRequestJoin = async () => {
    if (!username || !token) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/invitations/${encodeURIComponent(token)}/request-join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to request to join');
      await fetchInvitation();
    } catch (err) {
      setError(err.message || 'Failed to request to join');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="container document-detail" role="main">
      <button className="btn" type="button" onClick={() => navigate('/')}>
        ← Back to Home
      </button>

      <article className="document-detail-card" style={{ marginTop: '16px' }}>
        <h1 style={{ marginTop: 0 }}>Workspace Invitation</h1>
        {loading && <p className="muted">Loading invitation details...</p>}
        {!loading && error && (
          <p className="muted" role="alert">
            {error}
          </p>
        )}

        {!loading && !error && data && (
          <>
            <p>
              Workspace: <strong>{data.workspace_name || 'Unnamed Workspace'}</strong>
            </p>
            <p>
              Invited email: <strong>{data.email || '-'}</strong>
            </p>
            <p>
              Status: <strong>{statusLabel(data.status)}</strong>
            </p>
            <p className="muted">This invitation requires owner approval before it becomes active.</p>

            {!username && (
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <Link className="btn btn-primary" to="/login">
                  Sign in
                </Link>
                <p className="muted" style={{ margin: 0 }}>
                  Sign in first, then return to this invitation link to submit your join request.
                </p>
              </div>
            )}

            {username && (
              <>
                <p className="muted">
                  Current account: <strong>{username}</strong>
                  {email ? ` (${email})` : ''}
                </p>
                {data.mismatch_reason && (
                  <p className="muted" role="alert">
                    {data.mismatch_reason}
                  </p>
                )}
                {data.status === 'requested' && data.requested_username === username && (
                  <p className="muted">You have already requested to join. Please wait for owner approval.</p>
                )}
                {data.status === 'approved' && (
                  <p className="muted">Your request was approved. Refresh Home to see the new workspace.</p>
                )}
                {canSubmit && (
                  <button type="button" className="btn btn-primary" onClick={handleRequestJoin} disabled={submitting}>
                    {submitting ? 'Submitting...' : 'Request to Join Workspace'}
                  </button>
                )}
              </>
            )}
          </>
        )}
      </article>
    </main>
  );
}
