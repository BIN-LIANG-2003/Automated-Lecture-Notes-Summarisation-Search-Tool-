import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

const statusLabel = (status) => {
  if (status === 'pending') return '待申请';
  if (status === 'requested') return '已申请，等待确认';
  if (status === 'approved') return '已通过';
  if (status === 'rejected') return '已拒绝';
  if (status === 'expired') return '已过期';
  if (status === 'cancelled') return '已取消';
  return status || '未知状态';
};

export default function InviteJoinPage() {
  const { token } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);

  const username = sessionStorage.getItem('username') || '';
  const email = sessionStorage.getItem('email') || '';

  const fetchInvitation = async () => {
    if (!token) {
      setError('邀请链接无效。');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const query = username ? `?username=${encodeURIComponent(username)}` : '';
      const res = await fetch(`/api/invitations/${encodeURIComponent(token)}${query}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || '加载邀请失败');
      setData(payload);
    } catch (err) {
      setError(err.message || '加载邀请失败');
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
      if (!res.ok) throw new Error(payload.error || '申请加入失败');
      await fetchInvitation();
    } catch (err) {
      setError(err.message || '申请加入失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="container document-detail" role="main">
      <button className="btn" type="button" onClick={() => navigate('/')}>
        ← 返回首页
      </button>

      <article className="document-detail-card" style={{ marginTop: '16px' }}>
        <h1 style={{ marginTop: 0 }}>工作空间邀请</h1>
        {loading && <p className="muted">正在加载邀请信息...</p>}
        {!loading && error && (
          <p className="muted" role="alert">
            {error}
          </p>
        )}

        {!loading && !error && data && (
          <>
            <p>
              工作空间：<strong>{data.workspace_name || '未命名空间'}</strong>
            </p>
            <p>
              邀请邮箱：<strong>{data.email || '-'}</strong>
            </p>
            <p>
              状态：<strong>{statusLabel(data.status)}</strong>
            </p>
            <p className="muted">此邀请需要空间拥有者确认后才会生效。</p>

            {!username && (
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <Link className="btn btn-primary" to="/login">
                  去登录
                </Link>
                <p className="muted" style={{ margin: 0 }}>
                  登录后再回到该邀请链接，即可提交加入申请。
                </p>
              </div>
            )}

            {username && (
              <>
                <p className="muted">
                  当前账号：<strong>{username}</strong>
                  {email ? `（${email}）` : ''}
                </p>
                {data.mismatch_reason && (
                  <p className="muted" role="alert">
                    {data.mismatch_reason}
                  </p>
                )}
                {data.status === 'requested' && data.requested_username === username && (
                  <p className="muted">你已经提交加入申请，请等待空间拥有者确认。</p>
                )}
                {data.status === 'approved' && (
                  <p className="muted">申请已通过，刷新首页即可看到新工作空间。</p>
                )}
                {canSubmit && (
                  <button type="button" className="btn btn-primary" onClick={handleRequestJoin} disabled={submitting}>
                    {submitting ? '提交中...' : '申请加入工作空间'}
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

