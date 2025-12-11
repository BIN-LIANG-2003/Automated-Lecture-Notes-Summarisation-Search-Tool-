import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

const SETTINGS_ITEMS = [
  { id: 'public', label: '公开资料', icon: '👤', active: true },
  { id: 'account', label: '帐户', icon: '⚙️' },
  { id: 'appearance', label: '外观', icon: '🎨' },
  { id: 'accessibility', label: '无障碍', icon: '🦾' },
  { id: 'notifications', label: '通知', icon: '🔔' },
];

export default function AuthMenu({ isLoggedIn, onSignOut }) {
  const [open, setOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const wrapperRef = useRef(null);
  const username = localStorage.getItem('username') || 'Account';

  useEffect(() => {
    const handleClick = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setOpen(false);
        setShowSettings(false);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  if (!isLoggedIn) {
    return (
      <Link to="/login">
        Sign in
      </Link>
    );
  }

  const toggleMenu = () => {
    setOpen((prev) => {
      if (prev) setShowSettings(false);
      return !prev;
    });
  };

  return (
    <div className={`user-menu ${open ? 'open' : ''}`} ref={wrapperRef}>
      <button
        type="button"
        className="user-button"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        onClick={toggleMenu}
      >
        {username}
      </button>
      <div className="dropdown" role="menu" hidden={!open}>
        <button
          type="button"
          className="dropdown-item settings-toggle"
          aria-expanded={showSettings ? 'true' : 'false'}
          onClick={() => setShowSettings((prev) => !prev)}
        >
          <span>Settings</span>
          <span className="settings-chevron" aria-hidden="true">
            {showSettings ? '▴' : '▾'}
          </span>
        </button>

        {showSettings && (
          <div className="settings-panel" role="group" aria-label="Settings">
            {SETTINGS_ITEMS.map((item) => (
              <div
                key={item.id}
                className={`settings-item ${item.active ? 'active' : ''}`}
                role="menuitem"
                tabIndex={0}
              >
                <span className="settings-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span className="settings-label-cn">{item.label}</span>
              </div>
            ))}
          </div>
        )}

        <button type="button" className="dropdown-item" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
