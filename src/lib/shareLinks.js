import { authFetch } from './authFetch.js';

export const isActiveShareLink = (item) =>
  String(item?.status || '').trim().toLowerCase() === 'active' &&
  !Boolean(item?.is_expired ?? item?.isExpired);

const toPositiveDocId = (value) => {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : 0;
};

const readJsonSafely = async (response) => response.json().catch(() => ({}));

export async function listDocumentShareLinks(docId, { username = '' } = {}) {
  const safeDocId = toPositiveDocId(docId);
  const safeUsername = String(username || '').trim();
  if (!safeDocId || !safeUsername) return [];

  const params = new URLSearchParams({ username: safeUsername });
  const response = await authFetch(`/api/documents/${safeDocId}/share-links?${params.toString()}`);
  const payload = await readJsonSafely(response);
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load share links');
  }
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function listWorkspaceShareLinks(workspaceId, { username = '', limit = 100 } = {}) {
  const safeWorkspaceId = String(workspaceId || '').trim();
  const safeUsername = String(username || '').trim();
  if (!safeWorkspaceId || !safeUsername) return [];

  const params = new URLSearchParams({
    username: safeUsername,
    limit: String(Number(limit) || 100),
  });
  const response = await authFetch(
    `/api/workspaces/${encodeURIComponent(safeWorkspaceId)}/share-links?${params.toString()}`
  );
  const payload = await readJsonSafely(response);
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load share links');
  }
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function createDocumentShareLink(docId, { username = '', expiryDays = 7 } = {}) {
  const safeDocId = toPositiveDocId(docId);
  const safeUsername = String(username || '').trim();
  const safeExpiryDays = Number(expiryDays) || 7;

  const response = await authFetch(`/api/documents/${safeDocId}/share-links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: safeUsername,
      expiry_days: safeExpiryDays,
    }),
  });
  const payload = await readJsonSafely(response);
  if (!response.ok) {
    const activeCount = Number(payload?.active_count);
    const maxCount = Number(payload?.max_active_share_links_per_document);
    if (response.status === 409 && Number.isFinite(activeCount) && Number.isFinite(maxCount)) {
      throw new Error(
        `Share link limit reached (${activeCount}/${maxCount}). Revoke old links or enable auto-revoke.`
      );
    }
    throw new Error(payload.error || 'Failed to create share link');
  }

  const shareUrl = payload.token
    ? `${window.location.origin}/#/shared/${payload.token}`
    : String(payload.share_url || '').trim();
  if (!shareUrl) {
    throw new Error('Failed to create share link');
  }

  return {
    payload,
    shareUrl,
  };
}

export async function sendDocumentShareLinkEmail(
  docId,
  {
    username = '',
    recipientEmail = '',
    message = '',
    expiryDays = '',
  } = {},
) {
  const safeDocId = toPositiveDocId(docId);
  const safeUsername = String(username || '').trim();
  const safeRecipientEmail = String(recipientEmail || '').trim();
  const safeMessage = String(message || '').trim();
  const payload = {
    username: safeUsername,
    recipient_email: safeRecipientEmail,
    message: safeMessage,
  };
  if (String(expiryDays ?? '').trim() !== '') {
    payload.expiry_days = Number(expiryDays) || 7;
  }

  const response = await authFetch(`/api/documents/${safeDocId}/email-share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await readJsonSafely(response);
  if (!response.ok) {
    throw new Error(result.error || 'Failed to send note by email');
  }
  return result;
}

export async function revokeDocumentShareLink(docId, shareLinkId, { username = '' } = {}) {
  const safeDocId = toPositiveDocId(docId);
  const safeShareLinkId = toPositiveDocId(shareLinkId);
  const response = await authFetch(`/api/documents/${safeDocId}/share-links/${safeShareLinkId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: String(username || '').trim() }),
  });
  const payload = await readJsonSafely(response);
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to revoke share link');
  }
  return payload;
}

export async function deleteDocumentShareLink(docId, shareLinkId, { username = '' } = {}) {
  const safeDocId = toPositiveDocId(docId);
  const safeShareLinkId = toPositiveDocId(shareLinkId);
  const response = await authFetch(`/api/documents/${safeDocId}/share-links/${safeShareLinkId}/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: String(username || '').trim() }),
  });
  const payload = await readJsonSafely(response);
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to delete share link');
  }
  return payload;
}

export async function deleteInactiveDocumentShareLinks(docId, { username = '' } = {}) {
  const safeDocId = toPositiveDocId(docId);
  const response = await authFetch(`/api/documents/${safeDocId}/share-links/inactive`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: String(username || '').trim() }),
  });
  const payload = await readJsonSafely(response);
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to delete inactive share links');
  }
  return payload;
}

export async function deleteInactiveWorkspaceShareLinks(workspaceId, { username = '' } = {}) {
  const safeWorkspaceId = String(workspaceId || '').trim();
  const response = await authFetch(`/api/workspaces/${encodeURIComponent(safeWorkspaceId)}/share-links/inactive`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: String(username || '').trim() }),
  });
  const payload = await readJsonSafely(response);
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to delete inactive share links');
  }
  return payload;
}

export async function revokeAllDocumentShareLinks(docId, { username = '' } = {}) {
  const safeDocId = toPositiveDocId(docId);
  const response = await authFetch(`/api/documents/${safeDocId}/share-links`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: String(username || '').trim() }),
  });
  const payload = await readJsonSafely(response);
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to revoke all share links');
  }
  return payload;
}

export async function revokeAllWorkspaceShareLinks(workspaceId, { username = '' } = {}) {
  const safeWorkspaceId = String(workspaceId || '').trim();
  const response = await authFetch(`/api/workspaces/${encodeURIComponent(safeWorkspaceId)}/share-links`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: String(username || '').trim() }),
  });
  const payload = await readJsonSafely(response);
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to revoke all share links');
  }
  return payload;
}
