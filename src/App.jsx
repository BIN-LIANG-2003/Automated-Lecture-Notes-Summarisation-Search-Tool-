import React, { Suspense, lazy, useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';

const loadHomePage = () => import('./pages/Home.jsx');
const loadAuthPage = () => import('./pages/Auth.jsx');
const loadDocumentDetailPage = () => import('./pages/DocumentDetail.jsx');
const loadInviteJoinPage = () => import('./pages/InviteJoin.jsx');

const HomePage = lazy(loadHomePage);
const AuthPage = lazy(loadAuthPage);
const DocumentDetail = lazy(loadDocumentDetailPage);
const InviteJoinPage = lazy(loadInviteJoinPage);

const preloadedRoutes = new Set();

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('StudyHub render error:', error, info);
  }

  clearLocalStateAndReload = () => {
    try {
      localStorage.removeItem('studyhub-saved-views-v1');
      localStorage.removeItem('workspaceStateByAccount');
      localStorage.removeItem('accounts');
      sessionStorage.clear();
    } catch {
      // Ignore storage failures.
    }
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app-error-boundary" role="alert">
        <h1>Something Went Wrong</h1>
        <p>The page hit a runtime error and could not render.</p>
        <pre>{String(this.state.error?.message || this.state.error || 'Unknown error')}</pre>
        <div className="app-error-actions">
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button type="button" onClick={this.clearLocalStateAndReload}>
            Clear Local Data And Reload
          </button>
        </div>
      </div>
    );
  }
}

const prefetchRouteByPath = (path) => {
  const safePath = String(path || '').trim();
  if (!safePath) return;
  if (safePath.startsWith('/document/') || safePath.startsWith('/shared/')) {
    if (preloadedRoutes.has('document')) return;
    preloadedRoutes.add('document');
    loadDocumentDetailPage().catch(() => {});
    return;
  }
  if (safePath.startsWith('/login')) {
    if (preloadedRoutes.has('auth')) return;
    preloadedRoutes.add('auth');
    loadAuthPage().catch(() => {});
    return;
  }
  if (safePath.startsWith('/invite/')) {
    if (preloadedRoutes.has('invite')) return;
    preloadedRoutes.add('invite');
    loadInviteJoinPage().catch(() => {});
  }
};

const toPathFromHashHref = (href) => {
  const raw = String(href || '').trim();
  if (!raw) return '';
  const hashIndex = raw.indexOf('#');
  if (hashIndex < 0) return '';
  const hashValue = raw.slice(hashIndex + 1);
  if (!hashValue) return '';
  return hashValue.startsWith('/') ? hashValue : `/${hashValue}`;
};

export default function App() {
  useEffect(() => {
    const nativeFetch = window.fetch.bind(window);
    let authFailureHandling = false;
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

    const clearAuthSession = (message) => {
      if (authFailureHandling) return;
      authFailureHandling = true;
      sessionStorage.removeItem('username');
      sessionStorage.removeItem('email');
      sessionStorage.removeItem('auth_token');
      sessionStorage.removeItem('loginAt');
      window.dispatchEvent(
        new CustomEvent('studyhub-auth-expired', {
          detail: { message: message || 'Session expired. Please sign in again.' },
        })
      );
      if (window.location.hash !== '#/login') {
        window.location.hash = '/login';
      }
      window.setTimeout(() => {
        authFailureHandling = false;
      }, 300);
    };

    window.fetch = async (input, init = {}) => {
      const token = sessionStorage.getItem('auth_token') || '';
      const resolvedUrl = resolveRequestUrl(input);
      const requestUrl = resolvedUrl?.href || (typeof input === 'string' ? input : String(input?.url || ''));
      const isSameOriginApiRequest = Boolean(
        resolvedUrl &&
        resolvedUrl.origin === window.location.origin &&
        resolvedUrl.pathname.startsWith('/api/')
      );
      const isRelativeApiRequest = !resolvedUrl && String(requestUrl).startsWith('/api/');
      const isApiRequest = isSameOriginApiRequest || isRelativeApiRequest;
      const requestPath = resolvedUrl?.pathname || requestUrl;
      const isAuthEndpoint = isApiRequest && String(requestPath).startsWith('/api/auth/');
      const headers = new Headers(init?.headers || {});
      if (token && isApiRequest && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
      }

      const response = await nativeFetch(input, { ...init, headers });
      if (!token || !isApiRequest || isAuthEndpoint) return response;

      if (response.status === 401 || response.status === 403) {
        let errorText = '';
        try {
          const payload = await response.clone().json();
          errorText = String(payload?.error || '').trim();
        } catch {
          errorText = '';
        }
        const lowered = errorText.toLowerCase();
        const isTokenFailure = response.status === 401 || lowered.includes('auth token');
        if (isTokenFailure) {
          clearAuthSession(errorText || 'Session expired. Please sign in again.');
        }
      }
      return response;
    };

    return () => {
      window.fetch = nativeFetch;
    };
  }, []);

  useEffect(() => {
    const idlePrefetch = () => {
      prefetchRouteByPath('/login');
      prefetchRouteByPath('/invite/demo');
      prefetchRouteByPath('/document/demo');
    };

    const win = window;
    let idleHandle = 0;
    let timeoutHandle = 0;
    if (typeof win.requestIdleCallback === 'function') {
      idleHandle = win.requestIdleCallback(idlePrefetch, { timeout: 1200 });
    } else {
      timeoutHandle = win.setTimeout(idlePrefetch, 900);
    }

    return () => {
      if (idleHandle && typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle) {
        win.clearTimeout(timeoutHandle);
      }
    };
  }, []);

  useEffect(() => {
    const onPointerOver = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest?.('a[href]');
      if (!anchor) return;
      const path = toPathFromHashHref(anchor.getAttribute('href') || '');
      if (!path) return;
      prefetchRouteByPath(path);
    };

    const onTouchStart = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest?.('a[href]');
      if (!anchor) return;
      const path = toPathFromHashHref(anchor.getAttribute('href') || '');
      if (!path) return;
      prefetchRouteByPath(path);
    };

    document.addEventListener('mouseover', onPointerOver, true);
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });

    return () => {
      document.removeEventListener('mouseover', onPointerOver, true);
      document.removeEventListener('touchstart', onTouchStart, true);
    };
  }, []);

  return (
    <HashRouter>
      <AppErrorBoundary>
        <Suspense fallback={<div className="auth-page">Loading...</div>}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/login" element={<AuthPage />} />
            <Route path="/document/:docId" element={<DocumentDetail />} />
            <Route path="/shared/:shareToken" element={<DocumentDetail />} />
            <Route path="/invite/:token" element={<InviteJoinPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AppErrorBoundary>
    </HashRouter>
  );
}
