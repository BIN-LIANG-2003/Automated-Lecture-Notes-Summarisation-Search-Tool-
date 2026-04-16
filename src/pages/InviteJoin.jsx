import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { authFetch } from '../lib/authFetch.js';
import { readStoredAuthSession } from '../lib/authSession.js';

const statusLabel = (status) => {
  if (status === 'pending') return 'Ready to join';
  if (status === 'requested') return 'Ready to join';
  if (status === 'approved') return 'Joined';
  if (status === 'rejected') return 'Rejected';
  if (status === 'expired') return 'Expired';
  if (status === 'cancelled') return 'Cancelled';
  return status || 'Unknown status';
};

export default function InviteJoinPage() {
  const { token } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const acceptingRef = useRef(false);

  const currentAuthSession = readStoredAuthSession();
  const authToken = currentAuthSession.authToken;
  const username = authToken ? currentAuthSession.username : '';
  const email = authToken ? currentAuthSession.email : '';
  const returnPath = `${location.pathname}${location.search}${location.hash}`;

  const fetchInvitation = useCallback(async () => {
    if (!token) {
      setError('Invalid invitation.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const query = username ? `?username=${encodeURIComponent(username)}` : '';
      const res = await authFetch(`/api/invitations/${encodeURIComponent(token)}${query}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to load invitation');
      setData(payload);
    } catch (err) {
      setError(err.message || 'Failed to load invitation');
    } finally {
      setLoading(false);
    }
  }, [token, username]);

  useEffect(() => {
    fetchInvitation();
  }, [fetchInvitation]);

  const canSubmit = useMemo(() => {
    if (!username) return false;
    if (!data) return false;
    return Boolean(data.can_request && ['pending', 'requested'].includes(data.status));
  }, [username, data]);
  const hasActiveWorkspaceAccess = Boolean(
    username &&
      data?.status === 'approved' &&
      data?.viewer_is_active_member === true &&
      data?.can_open_workspace === true
  );
  const approvedWithoutActiveAccess = Boolean(
    username && data?.status === 'approved' && data?.viewer_is_active_member === false
  );

  const handleRequestJoin = useCallback(async () => {
    if (!username || !token) return;
    if (acceptingRef.current) return;
    acceptingRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      const res = await authFetch(`/api/invitations/${encodeURIComponent(token)}/request-join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to join workspace');
      if (payload && typeof payload === 'object') {
        setData(payload);
      } else {
        await fetchInvitation();
      }
    } catch (err) {
      setError(err.message || 'Failed to join workspace');
    } finally {
      setSubmitting(false);
      acceptingRef.current = false;
    }
  }, [fetchInvitation, token, username]);

  useEffect(() => {
    if (!canSubmit || submitting) return;
    handleRequestJoin();
  }, [canSubmit, handleRequestJoin, submitting]);

  const openInvitedWorkspace = useCallback(() => {
    const workspaceId = String(data?.workspace_id || '').trim();
    if (!workspaceId) return;
    navigate('/', {
      replace: true,
      state: {
        preferredWorkspaceId: workspaceId,
        showFiles: true,
        fromInvite: true,
      },
    });
  }, [data?.workspace_id, navigate]);

  useEffect(() => {
    if (!hasActiveWorkspaceAccess) return;
    openInvitedWorkspace();
  }, [hasActiveWorkspaceAccess, openInvitedWorkspace]);

  return (
    <main className="container document-detail" role="main">
      <button className="btn document-detail-back" type="button" onClick={() => navigate('/')}>
        ← Back to Home
      </button>

      <article className="document-detail-card invite-join-card">
        <header className="invite-join-head">
          <div>
            <p className="auth-kicker">StudyHub Invite</p>
            <h1>Workspace Invitation</h1>
          </div>
        </header>
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
              Status:{' '}
              <strong>
                {approvedWithoutActiveAccess ? 'No active access' : statusLabel(data.status)}
              </strong>
            </p>
            <p className="muted">This invitation lets the invited account join the workspace directly.</p>

            {!username && (
              <div className="invite-join-actions">
                <Link
                  className="btn btn-primary"
                  to="/login"
                  state={{
                    from: returnPath,
                    prefillEmail: data.email || '',
                  }}
                >
                  Sign in
                </Link>
                <p className="muted invite-join-inline-note">
                  Sign in first, then this invitation will add the workspace to your account.
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
                  <p className="muted">Joining this workspace...</p>
                )}
                {approvedWithoutActiveAccess && (
                  <p className="muted" role="alert">
                    This invitation was already used, but this account no longer has access to the workspace.
                  </p>
                )}
                {hasActiveWorkspaceAccess && (
                  <div className="invite-join-actions">
                    <p className="muted">Workspace joined. Opening the shared workspace...</p>
                    <button type="button" className="btn btn-primary" onClick={openInvitedWorkspace}>
                      Open Workspace
                    </button>
                  </div>
                )}
                {canSubmit && (
                  <button type="button" className="btn btn-primary" onClick={handleRequestJoin} disabled={submitting}>
                    {submitting ? 'Joining...' : 'Join Workspace'}
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
