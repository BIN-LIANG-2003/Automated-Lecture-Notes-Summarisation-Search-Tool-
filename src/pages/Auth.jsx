import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { GoogleLogin } from '@react-oauth/google'; // 1. 引入组件
import { jwtDecode } from "jwt-decode"; // 1. 引入解码工具
import UiFeedbackLayer from '../components/UiFeedbackLayer.jsx';
import AccountSelectorModal from '../components/AccountSelectorModal.jsx';
import { useUiFeedback } from '../hooks/useUiFeedback.js';
import {
  loadAccountHistory,
  removeAccountFromHistory,
  saveAccountToHistory,
} from '../lib/accountHistory.js';

export default function AuthPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState('login');
  const {
    toastState,
    confirmDialogState,
    showToast,
    dismissToast,
    closeConfirmDialog,
  } = useUiFeedback();
  
  const loginFormRef = useRef(null);
  const signupFormRef = useRef(null);
  const wrapperRef = useRef(null);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [accountHistory, setAccountHistory] = useState(() => loadAccountHistory());
  const [showAccountSelector, setShowAccountSelector] = useState(true);
  const [signupData, setSignupData] = useState({
    username: '',
    email: '',
    password: '',
    confirm: ''
  });

  const existingUser = sessionStorage.getItem('username');
  const existingToken = sessionStorage.getItem('auth_token');

  const subtitle =
    mode === 'signup'
      ? 'Create a new account to manage your notes.'
        : existingUser && existingToken
        ? 'You are already signed in.'
        : 'Welcome back! Please sign in to continue.';
  const shouldShowAccountSelector =
    mode === 'login' &&
    showAccountSelector &&
    !existingUser &&
    !existingToken &&
    accountHistory.length > 0;

  useEffect(() => {
    document.body.classList.add('auth-light-body');
    return () => document.body.classList.remove('auth-light-body');
  }, []);

  useEffect(() => {
    const resize = () => {
      const active = mode === 'login' ? loginFormRef.current : signupFormRef.current;
      if (active && wrapperRef.current) {
        wrapperRef.current.style.height = `${active.scrollHeight}px`;
      }
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [mode]);

  useEffect(() => {
    const active = mode === 'login' ? loginFormRef.current : signupFormRef.current;
    active?.querySelector('input')?.focus();
  }, [mode]);

  useEffect(() => {
    if (!shouldShowAccountSelector) return;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setShowAccountSelector(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [shouldShowAccountSelector]);

  useEffect(() => {
    const prefillUsername = String(location.state?.prefillUsername || '').trim();
    const prefillEmail = String(location.state?.prefillEmail || '').trim();
    const prefillValue = prefillUsername || prefillEmail;
    if (!prefillValue) return;

    setMode('login');
    setLoginUsername(prefillValue);
    setLoginPassword('');
    setShowAccountSelector(false);

    window.requestAnimationFrame(() => {
      const passwordInput = document.getElementById('login-password');
      if (passwordInput instanceof HTMLElement) {
        passwordInput.focus();
      }
    });
  }, [location.state]);

  const rememberAccount = ({ username, email = '', avatar = '' }) => {
    const safeUsername = String(username || '').trim();
    if (!safeUsername) return;
    const next = saveAccountToHistory({
      username: safeUsername,
      email: String(email || '').trim(),
      avatar: String(avatar || '').trim(),
    });
    setAccountHistory(next);
  };

  const handleSelectAccountFromHistory = (account) => {
    const nextUsername = String(account?.username || account?.email || '').trim();
    if (!nextUsername) return;
    setMode('login');
    setLoginUsername(nextUsername);
    setLoginPassword('');
    setShowAccountSelector(false);
    window.requestAnimationFrame(() => {
      const passwordInput = document.getElementById('login-password');
      if (passwordInput instanceof HTMLElement) {
        passwordInput.focus();
      }
    });
  };

  const handleRemoveAccountFromHistory = (account) => {
    const key = String(account?.username || account?.email || '').trim();
    if (!key) return;
    const next = removeAccountFromHistory(key);
    setAccountHistory(next);
  };

  // --- 新增：处理 Google 登录成功 ---
  const handleGoogleSuccess = async (credentialResponse) => {
    try {
      const token = credentialResponse.credential;
      const decoded = jwtDecode(token);
      console.log("Google User:", decoded);

      // 注意：这里使用您代码中原有的 IP 地址
      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          token: token,
          email: decoded.email,
          name: decoded.name 
        })
      });

      const data = await res.json();

      if (res.ok) {
        sessionStorage.setItem('username', data.username);
        sessionStorage.setItem('email', data.email || decoded.email || '');
        if (data.auth_token) sessionStorage.setItem('auth_token', data.auth_token);
        else sessionStorage.removeItem('auth_token');
        sessionStorage.setItem('loginAt', new Date().toISOString());
        rememberAccount({
          username: data.username,
          email: data.email || decoded.email || '',
          avatar: decoded.picture || '',
        });
        navigate('/');
      } else {
        showToast(data.error || 'Google login failed', 'error');
      }
    } catch (error) {
      console.error('Google login error:', error);
      showToast('Failed to process Google login.', 'error');
    }
  };
  // ------------------------------------

  const handleLogin = async (event) => {
    event.preventDefault();
    if (!loginUsername.trim() || !loginPassword.trim()) {
      showToast('Please enter username/email and password.', 'warning');
      return;
    }

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: loginUsername.trim(),
          password: loginPassword
        })
      });

      const data = await response.json();

      if (response.ok) {
        sessionStorage.setItem('username', data.username);
        sessionStorage.setItem('email', data.email || (loginUsername.includes('@') ? loginUsername.trim() : ''));
        if (data.auth_token) sessionStorage.setItem('auth_token', data.auth_token);
        else sessionStorage.removeItem('auth_token');
        sessionStorage.setItem('loginAt', new Date().toISOString());
        rememberAccount({
          username: data.username,
          email: data.email || (loginUsername.includes('@') ? loginUsername.trim() : ''),
        });
        navigate('/');
      } else {
        showToast(data.error || 'Login failed', 'error');
      }
    } catch (error) {
      console.error('Login error:', error);
      showToast('Network error. Is the backend running?', 'error');
    }
  };

  const handleSignup = async (event) => {
    event.preventDefault();
    const { username, email, password, confirm } = signupData;
    
    if (!username.trim() || !email.trim() || !password || !confirm) {
      showToast('Please complete all fields.', 'warning');
      return;
    }
    if (password.length < 6) {
      showToast('Password must be at least 6 characters.', 'warning');
      return;
    }
    if (password !== confirm) {
      showToast('Passwords do not match.', 'warning');
      return;
    }

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          email: email.trim(),
          password: password
        })
      });

      const data = await response.json();

      if (response.ok) {
        showToast('Account created! Please sign in.', 'success');
        setMode('login');
        setLoginUsername(username.trim());
        setSignupData({ username: '', email: '', password: '', confirm: '' });
      } else {
        showToast(data.error || 'Registration failed', 'error');
      }
    } catch (error) {
      console.error('Signup error:', error);
      showToast('Network error. Is the backend running?', 'error');
    }
  };

  return (
    <div className="login-body">
      <main className="login-card container" role="main">
        <AccountSelectorModal
          open={shouldShowAccountSelector}
          accounts={accountHistory}
          onSelectAccount={handleSelectAccountFromHistory}
          onRemoveAccount={handleRemoveAccountFromHistory}
          onClose={() => setShowAccountSelector(false)}
        />
        <Link to="/" className="back-home-btn" aria-label="Back to home">
          ⌂ Home
        </Link>
        <img src="/logo.png" alt="StudyHub Logo" className="login-logo" width="84" height="84" />

        <h1 id="auth-title">{mode === 'signup' ? 'Create account' : 'Sign in'}</h1>
        <p id="auth-subtitle" className="muted">
          {subtitle}
        </p>

        <div id="auth-forms" className="auth-forms" aria-live="polite" ref={wrapperRef}>
          {/* ----- 登录表单 ----- */}
          <form
            id="login-form"
            className={`auth-form ${mode === 'login' ? 'active' : ''}`}
            ref={loginFormRef}
            onSubmit={handleLogin}
            noValidate
          >
            <label htmlFor="login-username">Username or email</label>
            <input
              type="text"
              id="login-username"
              placeholder="Username or email"
              required
              autoComplete="username"
              value={loginUsername}
              onChange={(event) => {
                setLoginUsername(event.target.value);
                if (showAccountSelector) setShowAccountSelector(false);
              }}
            />

            <PasswordField
              id="login-password"
              label="Password"
              placeholder="Password"
              value={loginPassword}
              onChange={setLoginPassword}
              autoComplete="current-password"
            />

            <button type="submit" className="btn btn-primary login-btn">
              Sign in
            </button>

            <div className="auth-social">
              <div className="auth-divider" role="presentation">
                <span>OR</span>
              </div>

              <div className="auth-google-wrap">
                <GoogleLogin
                  onSuccess={handleGoogleSuccess}
                  onError={() => {
                    console.log('Login Failed');
                    showToast('Google Login Failed', 'error');
                  }}
                  theme="outline"
                  shape="pill"
                  width="260"
                />
              </div>
            </div>
            {/* ================================== */}

            <p className="muted tiny" style={{ marginTop: '15px' }}>
              No account yet?{' '}
              <button type="button" id="goto-signup" className="linklike" onClick={() => setMode('signup')}>
                Create one
              </button>
              {accountHistory.length > 0 && (
                <>
                  {' '}·{' '}
                  <button
                    type="button"
                    className="linklike"
                    onClick={() => {
                      setMode('login');
                      setShowAccountSelector(true);
                    }}
                  >
                    Choose saved account
                  </button>
                </>
              )}
            </p>
          </form>

          {/* ----- 注册表单 ----- */}
          <form
            id="signup-form"
            className={`auth-form ${mode === 'signup' ? 'active' : ''}`}
            ref={signupFormRef}
            onSubmit={handleSignup}
            noValidate
          >
            <label htmlFor="su-username">Username</label>
            <input
              type="text"
              id="su-username"
              placeholder="e.g. alice"
              required
              value={signupData.username}
              onChange={(event) => setSignupData((prev) => ({ ...prev, username: event.target.value }))}
            />

            <label htmlFor="su-email">Email</label>
            <input
              type="email"
              id="su-email"
              placeholder="name@example.com"
              required
              autoComplete="email"
              value={signupData.email}
              onChange={(event) => setSignupData((prev) => ({ ...prev, email: event.target.value }))}
            />

            <PasswordField
              id="su-password"
              label="Password"
              placeholder="At least 6 characters"
              value={signupData.password}
              onChange={(value) => setSignupData((prev) => ({ ...prev, password: value }))}
              autoComplete="new-password"
            />

            <PasswordField
              id="su-password2"
              label="Confirm password"
              placeholder="Re-enter password"
              value={signupData.confirm}
              onChange={(value) => setSignupData((prev) => ({ ...prev, confirm: value }))}
              autoComplete="new-password"
              confirm
            />

            <button type="submit" className="btn btn-primary">
              Create account
            </button>
            <p className="muted tiny">
              Already have an account?{' '}
              <button type="button" id="goto-login" className="linklike" onClick={() => setMode('login')}>
                Back to sign in
              </button>
            </p>
          </form>
        </div>
      </main>
      <UiFeedbackLayer
        toastState={toastState}
        confirmDialogState={confirmDialogState}
        onDismissToast={dismissToast}
        onCloseConfirmDialog={closeConfirmDialog}
      />
    </div>
  );
}

function PasswordField({ id, label, placeholder, value, onChange, autoComplete, confirm, minLength = 6 }) {
  const [visible, setVisible] = useState(false);

  const release = () => setVisible(false);

  const handlePointerDown = (event) => {
    event.preventDefault();
    setVisible(true);
    window.addEventListener('pointerup', release, { once: true });
    window.addEventListener('pointercancel', release, { once: true });
    window.addEventListener('blur', release, { once: true });
  };

  const handleKeyDown = (event) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      setVisible(true);
    }
  };

  const handleKeyUp = (event) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      setVisible(false);
    }
  };

  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="field-with-toggle">
        <input
          type={visible ? 'text' : 'password'}
          id={id}
          placeholder={placeholder}
          required
          minLength={minLength}
          autoComplete={autoComplete}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="toggle-visibility"
          aria-label={
            visible
              ? confirm
                ? 'Release to hide confirm password'
                : 'Release to hide password'
              : confirm
                ? 'Show confirm password'
                : 'Show password'
          }
          aria-pressed={visible ? 'true' : 'false'}
          onPointerDown={handlePointerDown}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onBlur={() => setVisible(false)}
        >
          <svg className="icon-eye" viewBox="0 0 24 24">
            <path d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z" />
          </svg>
          <svg className="icon-eye-off" viewBox="0 0 24 24">
            <path d="M3 3l18 18M10.6 6.2A10.4 10.4 0 0 1 12 6c7 0 10 7 10 7a16.7 16.7 0 0 1-5.5 5.5M7.2 8.6A16.8 16.8 0 0 0 2 13s3 7 10 7c1.1 0 2.2-.2 3.2-.5" />
          </svg>
        </button>
      </div>
    </>
  );
}
