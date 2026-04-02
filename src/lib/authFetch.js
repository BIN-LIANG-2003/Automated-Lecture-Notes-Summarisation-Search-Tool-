const resolveRequestUrl = (input) => {
  try {
    if (typeof input === 'string') {
      return new URL(input, window.location.origin);
    }
    if (input instanceof Request) {
      return new URL(input.url, window.location.origin);
    }
    if (input && typeof input.url === 'string') {
      return new URL(input.url, window.location.origin);
    }
  } catch {
    return null;
  }
  return null;
};

const mergeHeaders = (input, headers = {}) => {
  const nextHeaders = input instanceof Request
    ? new Headers(input.headers || {})
    : new Headers();
  new Headers(headers || {}).forEach((value, key) => {
    nextHeaders.set(key, value);
  });
  return nextHeaders;
};

const readStoredAuthToken = () => {
  try {
    return String(sessionStorage.getItem('auth_token') || '').trim();
  } catch {
    return '';
  }
};

export function buildAuthHeaders(input, headers = {}, { authToken = '' } = {}) {
  const nextHeaders = mergeHeaders(input, headers);
  const safeToken = String(authToken || readStoredAuthToken()).trim();
  if (safeToken && !nextHeaders.has('Authorization')) {
    nextHeaders.set('Authorization', `Bearer ${safeToken}`);
  }
  return nextHeaders;
}

export async function authFetch(input, init = {}, options = {}) {
  const resolvedUrl = resolveRequestUrl(input);
  const requestUrl = resolvedUrl?.href || (typeof input === 'string' ? input : String(input?.url || ''));
  const isSameOriginApiRequest = Boolean(
    resolvedUrl &&
    resolvedUrl.origin === window.location.origin &&
    resolvedUrl.pathname.startsWith('/api/')
  );
  const isRelativeApiRequest = !resolvedUrl && String(requestUrl).startsWith('/api/');
  const requestBody = Object.prototype.hasOwnProperty.call(init || {}, 'body') ? init.body : undefined;
  const headers = isSameOriginApiRequest || isRelativeApiRequest
    ? buildAuthHeaders(input, init?.headers, options)
    : mergeHeaders(input, init?.headers);

  // Let the browser generate the multipart boundary for FormData bodies.
  if (typeof FormData !== 'undefined' && requestBody instanceof FormData) {
    headers.delete('Content-Type');
  }

  if (input instanceof Request) {
    return fetch(new Request(input, { ...init, headers }));
  }
  return fetch(input, { ...init, headers });
}
