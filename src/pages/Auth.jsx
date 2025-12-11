import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { GoogleLogin } from '@react-oauth/google'; // 1. 引入组件
import { jwtDecode } from "jwt-decode"; // 1. 引入解码工具

export default function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState('login');
  
  const loginFormRef = useRef(null);
  const signupFormRef = useRef(null);
  const wrapperRef = useRef(null);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [signupData, setSignupData] = useState({
    username: '',
    email: '',
    password: '',
    confirm: ''
  });

  const existingUser = localStorage.getItem('username');

  const subtitle =
    mode === 'signup'
      ? 'Create a new account to manage your notes.'
      : existingUser
        ? 'You are already signed in.'
        : 'Welcome back! Please sign in to continue.';

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
        localStorage.setItem('username', data.username);
        localStorage.setItem('loginAt', new Date().toISOString());
        navigate('/');
      } else {
        alert(data.error || 'Google login failed');
      }
    } catch (error) {
      console.error('Google login error:', error);
      alert('Failed to process Google login.');
    }
  };
  // ------------------------------------

  const handleLogin = async (event) => {
    event.preventDefault();
    if (!loginUsername.trim() || !loginPassword.trim()) {
      alert('Please enter username/email and password.');
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
        localStorage.setItem('username', data.username);
        localStorage.setItem('loginAt', new Date().toISOString());
        navigate('/');
      } else {
        alert(data.error || 'Login failed');
      }
    } catch (error) {
      console.error('Login error:', error);
      alert('Network error. Is the backend running?');
    }
  };

  const handleSignup = async (event) => {
    event.preventDefault();
    const { username, email, password, confirm } = signupData;
    
    if (!username.trim() || !email.trim() || !password || !confirm) {
      alert('Please complete all fields.');
      return;
    }
    if (password.length < 6) {
      alert('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      alert('Passwords do not match.');
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
        alert('Account created! Please sign in.');
        setMode('login');
        setLoginUsername(username.trim());
        setSignupData({ username: '', email: '', password: '', confirm: '' });
      } else {
        alert(data.error || 'Registration failed');
      }
    } catch (error) {
      console.error('Signup error:', error);
      alert('Network error. Is the backend running?');
    }
  };

  return (
    <div className="login-body">
      <main className="login-card container" role="main">
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
              onChange={(event) => setLoginUsername(event.target.value)}
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

            {/* === Google Login Button Section === */}
            <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '100%', height: '1px', background: 'rgba(255,255,255,0.1)', position: 'relative' }}>
                <span style={{ position: 'absolute', top: '-10px', left: '50%', transform: 'translateX(-50%)', background: '#161b22', padding: '0 10px', color: '#8b949e', fontSize: '12px' }}>
                  OR
                </span>
              </div>
              
              <div style={{ marginTop: '10px' }}>
                <GoogleLogin
                  onSuccess={handleGoogleSuccess}
                  onError={() => {
                    console.log('Login Failed');
                    alert('Google Login Failed');
                  }}
                  theme="filled_black" 
                  shape="pill"         
                  width="280"          
                />
              </div>
            </div>
            {/* ================================== */}

            <p className="muted tiny" style={{ marginTop: '15px' }}>
              No account yet?{' '}
              <button type="button" id="goto-signup" className="linklike" onClick={() => setMode('signup')}>
                Create one
              </button>
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