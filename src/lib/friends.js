import { authFetch } from './authFetch.js';

const parseJson = async (response) => {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload?.error || payload?.message || 'Request failed').trim());
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

export async function markFriendItemsRead(payload = {}, authToken = '') {
  const response = await authFetch('/api/friends/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, { authToken });
  return parseJson(response);
}
