const SESSION_STORAGE_KEYS = ['username', 'email', 'loginAt', 'preferences_json'];
const LEGACY_SESSION_STORAGE_KEYS = ['auth_token'];
const PERSISTED_AUTH_SESSION_KEY = 'studyhub-auth-session';
const REMEMBER_AUTH_PREF_KEY = 'studyhub-remember-auth';
const PERSISTED_AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_AUTH_TOKEN = '__studyhub_cookie_session__';

export const isCookieAuthToken = (value = '') => String(value || '').trim() === COOKIE_AUTH_TOKEN;

const readJsonSafely = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const readSessionOnly = () => {
  const username = String(sessionStorage.getItem('username') || '').trim();
  const email = String(sessionStorage.getItem('email') || '').trim();
  const loginAt = String(sessionStorage.getItem('loginAt') || '').trim();
  const preferences = readJsonSafely(sessionStorage.getItem('preferences_json') || '') || {};
  return {
    username,
    email,
    authToken: username ? COOKIE_AUTH_TOKEN : '',
    loginAt,
    preferences,
    cookieBacked: Boolean(username),
    isAuthenticated: Boolean(username),
  };
};

const emptyAuthSession = () => ({
  username: '',
  email: '',
  authToken: '',
  loginAt: '',
  preferences: {},
  expiresAt: '',
  cookieBacked: false,
  isAuthenticated: false,
});

const resolvePersistedExpiry = (parsed, loginAt) => {
  const explicitExpiresAt = String(parsed?.expiresAt || parsed?.expires_at || '').trim();
  if (explicitExpiresAt) return explicitExpiresAt;
  const loginTime = Date.parse(loginAt || '');
  if (!Number.isFinite(loginTime)) return '';
  return new Date(loginTime + PERSISTED_AUTH_SESSION_TTL_MS).toISOString();
};

const persistedSessionExpired = (expiresAt) => {
  const expiresTime = Date.parse(expiresAt || '');
  return Number.isFinite(expiresTime) && expiresTime <= Date.now();
};

const writeSessionStorage = ({ username = '', email = '', loginAt = '', preferences = {} } = {}) => {
  const safeUsername = String(username || '').trim();
  const safeEmail = String(email || '').trim();
  const safeLoginAt = String(loginAt || '').trim() || new Date().toISOString();
  sessionStorage.setItem('username', safeUsername);
  sessionStorage.setItem('email', safeEmail);
  sessionStorage.setItem('loginAt', safeLoginAt);
  sessionStorage.setItem('preferences_json', JSON.stringify(preferences && typeof preferences === 'object' ? preferences : {}));
};

export function readPersistedAuthSession() {
  const raw = String(localStorage.getItem(PERSISTED_AUTH_SESSION_KEY) || '').trim();
  const parsed = raw ? readJsonSafely(raw) : null;
  if (!parsed || typeof parsed !== 'object') {
    return emptyAuthSession();
  }
  const username = String(parsed.username || '').trim();
  const email = String(parsed.email || '').trim();
  const loginAt = String(parsed.loginAt || parsed.login_at || '').trim();
  const expiresAt = resolvePersistedExpiry(parsed, loginAt);
  if (persistedSessionExpired(expiresAt)) {
    localStorage.removeItem(PERSISTED_AUTH_SESSION_KEY);
    return emptyAuthSession();
  }
  const preferences = parsed.preferences && typeof parsed.preferences === 'object' ? parsed.preferences : {};
  return {
    username,
    email,
    authToken: COOKIE_AUTH_TOKEN,
    loginAt,
    preferences,
    expiresAt,
    cookieBacked: true,
    isAuthenticated: Boolean(username),
  };
}

export function hydrateStoredAuthSession() {
  const current = readSessionOnly();
  if (current.isAuthenticated) return current;

  const persisted = readPersistedAuthSession();
  if (!persisted.isAuthenticated) return current;

  writeSessionStorage(persisted);
  return readSessionOnly();
}

export function readStoredAuthSession() {
  return hydrateStoredAuthSession();
}

export function getRememberAuthPreference() {
  const stored = String(localStorage.getItem(REMEMBER_AUTH_PREF_KEY) || '').trim();
  if (stored === '0') return false;
  if (stored === '1') return true;
  return readPersistedAuthSession().isAuthenticated;
}

export function setRememberAuthPreference(remember) {
  localStorage.setItem(REMEMBER_AUTH_PREF_KEY, remember ? '1' : '0');
}

export function storeAuthSession({ username = '', email = '', remember = false, preferences = {} } = {}) {
  const safeUsername = String(username || '').trim();
  const safeEmail = String(email || '').trim();

  if (!safeUsername) {
    clearStoredAuthSession();
    return readStoredAuthSession();
  }

  const loginAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(loginAt) + PERSISTED_AUTH_SESSION_TTL_MS).toISOString();
  writeSessionStorage({
    username: safeUsername,
    email: safeEmail,
    loginAt,
    preferences,
  });
  setRememberAuthPreference(Boolean(remember));
  if (remember) {
    localStorage.setItem(
      PERSISTED_AUTH_SESSION_KEY,
      JSON.stringify({
        username: safeUsername,
        email: safeEmail,
        loginAt,
        expiresAt,
        cookieBacked: true,
        preferences,
      }),
    );
  } else {
    localStorage.removeItem(PERSISTED_AUTH_SESSION_KEY);
  }
  return readStoredAuthSession();
}

export function clearStoredAuthSession() {
  SESSION_STORAGE_KEYS.forEach((key) => sessionStorage.removeItem(key));
  LEGACY_SESSION_STORAGE_KEYS.forEach((key) => sessionStorage.removeItem(key));
  localStorage.removeItem(PERSISTED_AUTH_SESSION_KEY);
}

export async function fetchCurrentSession(authToken = '') {
  const safeToken = String(authToken || '').trim();
  const useCookieSession = !safeToken || isCookieAuthToken(safeToken);
  const headers = {};
  if (!useCookieSession) {
    headers.Authorization = `Bearer ${safeToken}`;
  }

  try {
    const response = await fetch('/api/auth/me', {
      headers,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: String(payload?.error || 'Failed to verify current session').trim(),
        networkError: false,
      };
    }
    return {
      ok: true,
      status: response.status,
      user: {
        username: String(payload?.username || '').trim(),
        email: String(payload?.email || '').trim(),
        authToken: COOKIE_AUTH_TOKEN,
        preferences: payload?.preferences && typeof payload.preferences === 'object' ? payload.preferences : {},
      },
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error?.message || 'Failed to verify current session',
      networkError: true,
    };
  }
}

export async function logoutCurrentSession(authToken = '') {
  const safeToken = String(authToken || '').trim();
  const useCookieSession = !safeToken || isCookieAuthToken(safeToken);
  const headers = {};
  if (!useCookieSession) {
    headers.Authorization = `Bearer ${safeToken}`;
  }

  try {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      headers,
    });
    const payload = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      error: String(payload?.error || '').trim(),
      skipped: false,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error?.message || 'Failed to sign out',
      skipped: false,
      networkError: true,
    };
  }
}
