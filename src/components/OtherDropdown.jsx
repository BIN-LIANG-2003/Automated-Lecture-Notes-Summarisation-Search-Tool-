import { useEffect, useRef, useState } from 'react';

const items = [
  { id: 'whats-new', label: "What's New", icon: '🕑', action: () => alert("What's New: demo placeholder.") },
  { id: 'notifications', label: 'Notifications', icon: '🔔', action: () => alert('Notifications: demo placeholder.') },
  { id: 'settings', label: 'Settings', icon: '⚙️', action: () => alert('Settings: demo placeholder.') }
];

export default function OtherDropdown() {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const firstItemRef = useRef(null);

  useEffect(() => {
    const handleClick = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  useEffect(() => {
    if (open) {
      firstItemRef.current?.focus();
    }
  }, [open]);

  const toggle = () => setOpen((prev) => !prev);

  return (
    <div className={`other-dropdown ${open ? 'open' : ''}`} aria-label="Other menu" ref={wrapperRef}>
      <button
        className="other-toggle"
        aria-haspopup="true"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls="other-menu"
        onClick={toggle}
      >
        OTHER
        <svg className="chev" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>

      <div id="other-menu" className="other-menu" role="menu" hidden={!open}>
        {items.map((item, index) => (
          <button
            key={item.id}
            role="menuitem"
            className="other-item"
            onClick={() => {
              item.action();
              setOpen(false);
            }}
            ref={index === 0 ? firstItemRef : undefined}
          >
            <span className="icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
        <a className="other-item" role="menuitem" href="mailto:support@example.com" onClick={() => setOpen(false)}>
          <span className="icon">🛟</span>
          <span>Contact Support</span>
        </a>
      </div>
    </div>
  );
}
