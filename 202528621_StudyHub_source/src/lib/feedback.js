import { authFetch } from './authFetch.js';

const readJsonSafely = async (response) => response.json().catch(() => ({}));

export const FEEDBACK_TYPES = [
  { value: 'bug_report', label: 'Bug report' },
  { value: 'feature_request', label: 'Feature request' },
  { value: 'login_account', label: 'Login & account' },
  { value: 'upload_ocr', label: 'Upload & OCR' },
  { value: 'sharing_email', label: 'Sharing & email' },
  { value: 'performance', label: 'Performance' },
  { value: 'ui_usability', label: 'UI & usability' },
  { value: 'other', label: 'Other' },
];

export const FEEDBACK_PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export const FEEDBACK_STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'in_review', label: 'In review' },
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

export const ADMIN_FEEDBACK_STATUSES = FEEDBACK_STATUSES.filter((item) => item.value !== 'closed');

export function getFeedbackTypeLabel(value) {
  return FEEDBACK_TYPES.find((item) => item.value === value)?.label || 'Other';
}

export function getFeedbackStatusLabel(value) {
  return FEEDBACK_STATUSES.find((item) => item.value === value)?.label || 'New';
}

async function requestJson(path, init = {}) {
  const response = await authFetch(path, init);
  const payload = await readJsonSafely(response);
  if (!response.ok) {
    throw new Error(payload.error || 'Feedback request failed');
  }
  return payload;
}

export async function loadFeedbackConfig() {
  return requestJson('/api/feedback/config');
}

export async function submitFeedback(payload) {
  return requestJson('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

export async function listMyFeedback() {
  return requestJson('/api/feedback/mine');
}

export async function getMyFeedback(feedbackId) {
  return requestJson(`/api/feedback/${encodeURIComponent(feedbackId)}`);
}

export async function addFeedbackFollowUp(feedbackId, message) {
  return requestJson(`/api/feedback/${encodeURIComponent(feedbackId)}/follow-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

export async function closeFeedback(feedbackId) {
  return requestJson(`/api/feedback/${encodeURIComponent(feedbackId)}/close`, {
    method: 'POST',
  });
}

export async function findSimilarFeedback(query) {
  const params = new URLSearchParams({ q: String(query || '').trim() });
  return requestJson(`/api/feedback/similar?${params.toString()}`);
}

export async function listAdminFeedback(filters = {}) {
  const params = new URLSearchParams();
  ['q', 'status', 'type', 'priority', 'limit', 'offset'].forEach((key) => {
    const value = filters[key];
    if (String(value ?? '').trim()) params.set(key, String(value).trim());
  });
  return requestJson(`/api/admin/feedback${params.toString() ? `?${params.toString()}` : ''}`);
}

export async function getAdminFeedback(feedbackId) {
  return requestJson(`/api/admin/feedback/${encodeURIComponent(feedbackId)}`);
}

export async function updateAdminFeedback(feedbackId, payload) {
  return requestJson(`/api/admin/feedback/${encodeURIComponent(feedbackId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

export async function addPublicFeedbackReply(feedbackId, message) {
  return requestJson(`/api/admin/feedback/${encodeURIComponent(feedbackId)}/public-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

export async function addInternalFeedbackNote(feedbackId, message) {
  return requestJson(`/api/admin/feedback/${encodeURIComponent(feedbackId)}/internal-note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}
