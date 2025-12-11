import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

export default function AuthMenu({ isLoggedIn, onSignOut }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const username = localStorage.getItem('username') || 'Account';

  useEffect(() => {
    const handleClick = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setOpen(false);
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

  return (
    <div className={`user-menu ${open ? 'open' : ''}`} ref={wrapperRef}>
      <button
        type="button"
        className="user-button"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => setOpen((prev) => !prev)}
      >
        {username}
      </button>
      <div className="dropdown" role="menu" hidden={!open}>
        <button type="button" className="dropdown-item" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
