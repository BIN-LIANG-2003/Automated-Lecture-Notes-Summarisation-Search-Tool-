import { authFetch } from './authFetch.js';

const parseJson = async (response) => {
  const rawText = await response.text().catch(() => '');
  let payload = {};
  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = {};
    }
  }
  if (!response.ok) {
    const fallback = response.status
      ? `Request failed (${response.status})`
      : 'Request failed';
    throw new Error(String(payload?.error || payload?.message || fallback).trim());
  }
  return payload;
};

export async function fetchFriendSummary(authToken = '') {
  const response = await authFetch('/api/friends/summary', {}, { authToken });
  return parseJson(response);
}

export async function sendFriendRequest(payload = {}, authToken = '') {
  const response = await authFetch('/api/friends/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, { authToken });
  return parseJson(response);
}

export async function respondFriendRequest(requestId, action, authToken = '') {
  const response = await authFetch(`/api/friends/requests/${encodeURIComponent(requestId)}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  }, { authToken });
  return parseJson(response);
}

export async function sendFriendMessage(recipientUsername, body, authToken = '') {
  const response = await authFetch('/api/friends/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_username: recipientUsername, body }),
  }, { authToken });
  return parseJson(response);
}

export async function fetchFriendShareDocuments({
  username = '',
  workspaceId = '',
  authToken = '',
  limit = 100,
} = {}) {
  const params = new URLSearchParams({
    username,
    include_meta: '1',
    include_facets: '0',
    limit: String(Math.max(1, Math.min(200, Number(limit) || 100))),
    offset: '0',
    sort: 'newest',
  });
  if (workspaceId) params.set('workspace_id', workspaceId);
  const response = await authFetch(`/api/documents?${params.toString()}`, {}, { authToken });
  return parseJson(response);
}

export async function sendFriendFileShare({
  recipientUsername = '',
  documentId = '',
  note = '',
} = {}, authToken = '') {
  const response = await authFetch('/api/friends/file-shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient_username: recipientUsername,
      document_id: documentId,
      note,
    }),
  }, { authToken });
  return parseJson(response);
}

export async function respondFriendFileShare(notificationId, action, authToken = '', options = {}) {
  const targetWorkspaceId = String(options.targetWorkspaceId || options.workspaceId || '').trim();
  const response = await authFetch(`/api/friends/file-shares/${encodeURIComponent(notificationId)}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      ...(targetWorkspaceId ? { target_workspace_id: targetWorkspaceId } : {}),
    }),
  }, { authToken });
  return parseJson(response);
}

export async function markFriendItemsRead(payload = {}, authToken = '') {
  const response = await authFetch('/api/friends/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, { authToken });
  return parseJson(response);
}
