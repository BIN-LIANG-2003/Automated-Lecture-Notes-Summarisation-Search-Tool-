const SESSION_STORAGE_KEYS = ['username', 'email', 'auth_token', 'loginAt'];

export function readStoredAuthSession() {
  const username = String(sessionStorage.getItem('username') || '').trim();
  const email = String(sessionStorage.getItem('email') || '').trim();
  const authToken = String(sessionStorage.getItem('auth_token') || '').trim();
  const loginAt = String(sessionStorage.getItem('loginAt') || '').trim();
  return {
    username,
    email,
    authToken,
    loginAt,
    isAuthenticated: Boolean(username && authToken),
  };
}

export function storeAuthSession({ username = '', email = '', authToken = '' } = {}) {
  const safeUsername = String(username || '').trim();
  const safeEmail = String(email || '').trim();
  const safeToken = String(authToken || '').trim();

  if (!safeUsername || !safeToken) {
    clearStoredAuthSession();
    return readStoredAuthSession();
  }

  sessionStorage.setItem('username', safeUsername);
  sessionStorage.setItem('email', safeEmail);
  sessionStorage.setItem('auth_token', safeToken);
  sessionStorage.setItem('loginAt', new Date().toISOString());
  return readStoredAuthSession();
}

export function clearStoredAuthSession() {
  SESSION_STORAGE_KEYS.forEach((key) => sessionStorage.removeItem(key));
}

export async function fetchCurrentSession(authToken = '') {
  const safeToken = String(authToken || '').trim();
  if (!safeToken) {
    return { ok: false, status: 401, error: 'Missing auth token', networkError: false };
  }

  try {
    const response = await window.fetch('/api/auth/me', {
      headers: {
        Authorization: `Bearer ${safeToken}`,
      },
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
        authToken: safeToken,
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
  if (!safeToken) {
    return { ok: true, skipped: true };
  }

  try {
    const response = await window.fetch('/api/auth/logout', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${safeToken}`,
      },
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
