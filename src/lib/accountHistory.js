export const ACCOUNT_HISTORY_KEY = 'auth-account-history-v1';
const MAX_HISTORY_ITEMS = 5;

const normalizeHistoryEntry = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const username = String(raw.username || '').trim();
  const email = String(raw.email || '').trim();
  const avatar = String(raw.avatar || '').trim();
  const lastLogin = String(raw.lastLogin || raw.last_login || '').trim();
  if (!username && !email) return null;
  return {
    username,
    email,
    avatar,
    lastLogin: lastLogin || new Date().toISOString(),
  };
};

export const loadAccountHistory = () => {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(ACCOUNT_HISTORY_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeHistoryEntry(item))
      .filter(Boolean)
      .slice(0, MAX_HISTORY_ITEMS);
  } catch (err) {
    console.warn('Failed to load account history from localStorage', err);
    return [];
  }
};

export const persistAccountHistory = (entries) => {
  if (typeof window === 'undefined') return;
  const normalized = Array.isArray(entries)
    ? entries
        .map((item) => normalizeHistoryEntry(item))
        .filter(Boolean)
        .slice(0, MAX_HISTORY_ITEMS)
    : [];
  localStorage.setItem(ACCOUNT_HISTORY_KEY, JSON.stringify(normalized));
};

export const saveAccountToHistory = (entry) => {
  const normalized = normalizeHistoryEntry(entry);
  if (!normalized) return loadAccountHistory();

  const history = loadAccountHistory();
  const dedupeKey = normalized.username || normalized.email;
  const next = [
    { ...normalized, lastLogin: new Date().toISOString() },
    ...history.filter((item) => (item.username || item.email) !== dedupeKey),
  ].slice(0, MAX_HISTORY_ITEMS);

  persistAccountHistory(next);
  return next;
};

export const removeAccountFromHistory = (key) => {
  const safeKey = String(key || '').trim();
  if (!safeKey) return loadAccountHistory();
  const next = loadAccountHistory().filter(
    (item) => item.username !== safeKey && item.email !== safeKey
  );
  persistAccountHistory(next);
  return next;
};
